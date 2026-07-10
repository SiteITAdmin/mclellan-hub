'use strict';

/**
 * LLM suggestion engine — advisory only, never acts.
 *
 * A daily suggestion_run job executes each registered suggester: gather
 * cross-domain data with plain SQL, call OpenRouter, INSERT OR IGNORE
 * suggestion rows (dedup_key makes re-runs free). Suggestions expire after
 * 14 days and wait in Hub for review. Accepting one creates a task; nothing is
 * ever booked or scheduled automatically.
 *
 * Also owns Skyscanner price-alert extraction (called from email-processor)
 * since the travel suggester consumes those price points.
 */

const db = require('./db');
const { uuid } = require('./id');
const { TASK_CODES, taskCodeForFeature } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { activeOpportunitySignals } = require('./opportunity-engine');
const { semanticSearch } = require('./retrieval');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EXPIRY_DAYS = 14;
function now() { return Math.floor(Date.now() / 1000); }

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function llmJson(user, feature, prompt) {
  const model = getSystemModelId('suggestions', 'system', 'google/gemini-2.5-flash');
  return requestModelObject({
    modelId: model,
    messages: [{ role: 'user', content: prompt }],
    user,
    feature,
    modelKey: feature,
    taskCode: taskCodeForFeature(feature, TASK_CODES.SUGGESTIONS),
    temperature: 0.2,
    defaults: {},
    label: `${feature} response`,
  });
}

// ── Suggestion CRUD ───────────────────────────────────────────────────────────

function nextSuggestionCode(user) {
  const row = db.hub().prepare(
    "SELECT MAX(short_code) AS max FROM suggestions WHERE user = ? AND status = 'open'"
  ).get(user);
  return (row?.max || 0) + 1;
}

function createSuggestion(user, { domain, title, body, evidence = null, dedupKey = null }) {
  if (!title || !body) return null;
  const hub = db.hub();
  const id = uuid();
  const result = hub.prepare(`
    INSERT OR IGNORE INTO suggestions
      (id, user, domain, title, body, evidence, status, short_code, dedup_key, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
  `).run(
    id, user, domain, String(title).slice(0, 200), String(body).slice(0, 1500),
    evidence ? JSON.stringify(evidence).slice(0, 4000) : null,
    nextSuggestionCode(user), dedupKey, now() + EXPIRY_DAYS * 86400
  );
  if (!result.changes) return null;
  return hub.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
}

function listOpenSuggestions(user) {
  return db.hub().prepare(`
    SELECT * FROM suggestions
    WHERE user = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `).all(user, now());
}

function findSuggestionByCode(user, code) {
  return db.hub().prepare(`
    SELECT * FROM suggestions WHERE user = ? AND short_code = ? AND status = 'open'
    ORDER BY created_at DESC LIMIT 1
  `).get(user, parseInt(code, 10));
}

function expireSuggestions(user) {
  db.hub().prepare(
    "UPDATE suggestions SET status = 'expired' WHERE user = ? AND status = 'open' AND expires_at <= ?"
  ).run(user, now());
}

async function acceptSuggestion(user, code) {
  const s = findSuggestionByCode(user, code);
  if (!s) return { ok: false, message: `No open suggestion #${code}.` };
  db.hub().prepare("UPDATE suggestions SET status = 'accepted' WHERE id = ?").run(s.id);
  let taskMsg = '';
  try {
    const { createTask } = require('./google-tasks');
    await createTask(user, {
      title: s.title,
      notes: s.body,
      source: 'suggestion',
      sourceId: s.id,
    });
    taskMsg = ' Task created.';
  } catch (err) {
    taskMsg = ` (Task creation failed: ${err.message})`;
  }
  return { ok: true, message: `✅ Suggestion #${s.short_code} accepted: ${s.title}.${taskMsg}` };
}

function dismissSuggestion(user, code) {
  const s = findSuggestionByCode(user, code);
  if (!s) return { ok: false, message: `No open suggestion #${code}.` };
  db.hub().prepare("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").run(s.id);
  return { ok: true, message: `🗑 Suggestion #${s.short_code} dismissed.` };
}

function whySuggestion(user, code) {
  const s = db.hub().prepare(
    'SELECT * FROM suggestions WHERE user = ? AND short_code = ? ORDER BY created_at DESC LIMIT 1'
  ).get(user, parseInt(code, 10));
  if (!s) return { ok: false, message: `No suggestion #${code}.` };
  let evidence = '';
  try {
    const parsed = JSON.parse(s.evidence || 'null');
    evidence = parsed ? JSON.stringify(parsed, null, 2).slice(0, 2500) : '_No evidence stored._';
  } catch { evidence = s.evidence || '_No evidence stored._'; }
  return { ok: true, message: `*#${s.short_code} ${s.title}*\n${s.body}\n\n*Evidence:*\n${evidence}` };
}

// Briefing section lines
function briefingSuggestionLines(user) {
  const rows = listOpenSuggestions(user).sort((a, b) => {
    const pa = a.domain === 'opportunity' ? 1 : 0;
    const pb = b.domain === 'opportunity' ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.created_at || 0) - (a.created_at || 0);
  });
  return rows.slice(0, 5).map(s => {
    const prefix = s.domain === 'opportunity' ? 'Opportunity radar' : s.domain;
    const bodyHint = s.domain === 'opportunity'
      ? ` — ${String(s.body || '').split(/[.!?]\s/)[0].slice(0, 180)}`
      : '';
    return `• #${s.short_code} [${prefix}] ${s.title}${bodyHint} _(accept ${s.short_code} · dismiss ${s.short_code} · why ${s.short_code})_`;
  });
}

// ── Skyscanner price extraction (called from email-processor) ─────────────────

function isSkyscannerEmail(email) {
  return /skyscanner/i.test(email.fromEmail || '');
}

async function extractTravelPrices(user, email) {
  if (!isSkyscannerEmail(email)) return 0;
  const hub = db.hub();
  const already = hub.prepare(
    'SELECT 1 FROM travel_price_points WHERE gmail_message_id = ? LIMIT 1'
  ).get(email.id);
  if (already) return 0;

  const prompt = `${getSystemPrompt('travel_price_extract', 'system', PROMPTS.travel_price_extract)}

Subject: ${email.subject}
Body:
${String(email.bodyText || '').slice(0, 4000)}`;

  const parsed = await llmJson(user, 'travel-price-extract', prompt);
  const prices = Array.isArray(parsed.prices) ? parsed.prices : [];
  let inserted = 0;
  const ins = hub.prepare(`
    INSERT OR IGNORE INTO travel_price_points
      (id, user, route, travel_window_start, travel_window_end, price, currency, source, gmail_message_id, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'skyscanner', ?, ?)
  `);
  for (const p of prices) {
    if (!p.route || typeof p.price !== 'number' || p.price <= 0) continue;
    inserted += ins.run(
      uuid(), user, String(p.route).toUpperCase().slice(0, 60),
      p.window_start || null, p.window_end || null,
      p.price, p.currency || 'EUR', email.id, email.receivedAt || now()
    ).changes;
  }
  return inserted;
}

// ── Suggesters ────────────────────────────────────────────────────────────────

async function runTravelSuggester(user) {
  const hub = db.hub();
  const pricePoints = hub.prepare(`
    SELECT route, travel_window_start, travel_window_end, price, currency, observed_at
    FROM travel_price_points
    WHERE user = ? AND observed_at > ? ORDER BY route, observed_at ASC
  `).all(user, now() - 60 * 86400);

  let calendarEvents = [];
  try {
    const { fetchCalendarEvents } = require('./crm');
    calendarEvents = await fetchCalendarEvents(user, { daysForward: 120 });
  } catch (err) {
    console.warn('[suggestions] calendar fetch failed:', err.message);
  }
  const travelFacts = hub.prepare(`
    SELECT f.fact, c.name AS contact_name FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status IN ('active','follow_up')
      AND (f.fact LIKE '%travel%' OR f.fact LIKE '%trip%' OR f.fact LIKE '%flight%' OR f.fact LIKE '%visit%')
    ORDER BY f.created_at DESC LIMIT 15
  `).all(user);
  const bookedFlights = hub.prepare(
    "SELECT flight_number, direction, flight_date FROM flights WHERE user = ? AND flight_date >= ? ORDER BY flight_date"
  ).all(user, dublinTodayIso());

  // No signal → no LLM call
  if (!pricePoints.length && !calendarEvents.length && !travelFacts.length) return [];

  const prompt = `${getSystemPrompt('suggestion_travel', 'system', PROMPTS.suggestion_travel)}

Today is ${dublinTodayIso()}.

UPCOMING CALENDAR EVENTS (next 120 days):
${calendarEvents.map(e => `- ${e.date} ${e.summary}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(none)'}

CRM NOTES MENTIONING TRAVEL:
${travelFacts.map(f => `- [${f.contact_name}] ${f.fact}`).join('\n') || '(none)'}

FLIGHTS ALREADY BOOKED:
${bookedFlights.map(f => `- ${f.flight_date} ${f.direction} (${f.flight_number})`).join('\n') || '(none)'}

FLIGHT PRICE OBSERVATIONS (from Skyscanner alerts, oldest first):
${pricePoints.map(p => `- ${p.route} ${p.travel_window_start || '?'}→${p.travel_window_end || '?'}: ${p.price} ${p.currency} (seen ${new Date(p.observed_at * 1000).toISOString().slice(0, 10)})`).join('\n') || '(none)'}`;

  const parsed = await llmJson(user, 'suggestion-travel', prompt);
  const created = [];
  for (const s of (parsed.suggestions || []).slice(0, 3)) {
    const dedupKey = `travel:${s.route || 'general'}:${s.window_start || dublinTodayIso().slice(0, 7)}`;
    const row = createSuggestion(user, {
      domain: 'travel',
      title: s.title,
      body: s.body,
      evidence: {
        pricePoints: pricePoints.filter(p => !s.route || p.route === s.route).slice(-10),
        calendarEvents: calendarEvents.slice(0, 10).map(e => `${e.date} ${e.summary}`),
        bookedFlights,
      },
      dedupKey,
    });
    if (row) created.push(row);
  }
  return created;
}

async function runContentSuggester(user) {
  const hub = db.hub();
  const articles = hub.prepare(`
    SELECT title FROM rss_articles WHERE user = ? AND published_at > ?
    ORDER BY published_at DESC LIMIT 30
  `).all(user, now() - 14 * 86400);
  const topics = hub.prepare(`
    SELECT title AS headline, category FROM intel_items WHERE user = ? AND published_at > ?
    ORDER BY published_at DESC LIMIT 30
  `).all(user, now() - 14 * 86400);
  const recentPosts = hub.prepare(
    'SELECT topic FROM linkedin_posts WHERE user = ? ORDER BY created_at DESC LIMIT 10'
  ).all(user);

  if (articles.length + topics.length < 5) return [];

  const prompt = `${getSystemPrompt('suggestion_content', 'system', PROMPTS.suggestion_content)}

Today is ${dublinTodayIso()}.

RECENT SIGNALS (RSS articles + newsletter topics, last 14 days):
${articles.map(a => `- ${a.title}`).join('\n')}
${topics.map(t => `- [${t.category || 'misc'}] ${t.headline}`).join('\n')}

TOPICS HE ALREADY POSTED ABOUT (do not repeat):
${recentPosts.map(p => `- ${p.topic}`).join('\n') || '(none)'}`;

  const parsed = await llmJson(user, 'suggestion-content', prompt);
  const created = [];
  for (const s of (parsed.suggestions || []).slice(0, 2)) {
    const slug = String(s.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const row = createSuggestion(user, {
      domain: 'content',
      title: s.title,
      body: s.body,
      evidence: { articles: articles.slice(0, 15).map(a => a.title), topics: topics.slice(0, 15).map(t => t.headline) },
      dedupKey: `content:${slug}`,
    });
    if (row) created.push(row);
  }
  return created;
}

function signalBrief(signal) {
  return [
    signal.title,
    signal.summary,
    signal.actor ? `actor: ${signal.actor}` : '',
    signal.geography ? `geography: ${signal.geography}` : '',
    signal.currency ? `currency: ${signal.currency}` : '',
    signal.valid_from ? `valid from: ${signal.valid_from}` : '',
    signal.valid_until ? `valid until: ${signal.valid_until}` : '',
  ].filter(Boolean).join(' | ');
}

function parseSearchPlan(parsed, signals) {
  const validIds = new Set(signals.map(s => s.id));
  const raw = Array.isArray(parsed.plans) ? parsed.plans : [];
  const plans = [];
  for (const plan of raw) {
    const signalId = String(plan.signal_id || '').trim();
    if (!validIds.has(signalId)) continue;
    const queries = Array.isArray(plan.queries)
      ? plan.queries.map(q => String(q || '').trim()).filter(Boolean).slice(0, 4)
      : [];
    const questions = Array.isArray(plan.questions)
      ? plan.questions.map(q => String(q || '').trim()).filter(Boolean).slice(0, 5)
      : [];
    if (queries.length || questions.length) plans.push({ signalId, queries, questions });
  }
  return plans;
}

async function planSalienceSearch(user, signals) {
  const prompt = `${getSystemPrompt('salience_search_plan', 'system', PROMPTS.salience_search_plan)}

Today is ${dublinTodayIso()}.

SIGNALS:
${signals.map(s => `- [${s.id}] ${signalBrief(s)}`).join('\n')}`;
  const parsed = await llmJson(user, 'salience-search-plan', prompt);
  return parseSearchPlan(parsed, signals);
}

async function retrieveSalienceContext(user, signals) {
  let plans = [];
  try {
    plans = await planSalienceSearch(user, signals);
  } catch (err) {
    console.warn('[suggestions] salience search planning failed:', err.message);
  }
  const byId = new Map(signals.map(signal => [signal.id, {
    signalId: signal.id,
    questions: [],
    queries: [],
    hits: [],
  }]));

  const fallbackPlans = signals.map(signal => ({
    signalId: signal.id,
    questions: ['What current plans, calendar events, preferences, or prior evidence make this signal relevant or irrelevant?'],
    queries: [
      signalBrief(signal),
      `${signal.title} Douglas calendar travel plans preferences already handled`,
    ],
  }));
  for (const plan of plans.length ? plans : fallbackPlans) {
    const context = byId.get(plan.signalId);
    if (!context) continue;
    context.questions = plan.questions || [];
    context.queries = plan.queries || [];
    const seen = new Set();
    for (const query of context.queries.slice(0, 4)) {
      try {
        const hits = await semanticSearch(user, query, 6, {
          sourceKinds: ['atom', 'email_summary', 'meeting_intake', 'document', 'completed_task'],
          minScore: 0.12,
        });
        for (const hit of hits) {
          const key = `${hit.source_kind}:${hit.source_id}:${hit.chunk_index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          context.hits.push({
            query,
            source_kind: hit.source_kind,
            source_id: hit.source_id,
            score: Number(hit.score.toFixed(3)),
            text: String(hit.chunk_text || '').slice(0, 500),
          });
        }
      } catch (err) {
        console.warn('[suggestions] salience semantic search failed:', err.message);
      }
    }
    context.hits = context.hits.slice(0, 12);
  }
  return [...byId.values()];
}

async function runOpportunitySuggester(user) {
  const signals = activeOpportunitySignals(user, { limit: 12 });
  if (!signals.length) return [];

  let calendarEvents = [];
  try {
    const { fetchCalendarEvents } = require('./crm');
    calendarEvents = await fetchCalendarEvents(user, { daysForward: 45 });
  } catch (err) {
    console.warn('[suggestions] opportunity calendar fetch failed:', err.message);
  }
  const salienceContexts = await retrieveSalienceContext(user, signals);

  const prompt = `${getSystemPrompt('suggestion_opportunity', 'system', PROMPTS.suggestion_opportunity)}

Today is ${dublinTodayIso()}.

ACTIVE OPPORTUNITY SIGNALS:
${signals.map(s => `- [${s.id}] ${signalBrief(s)}`).join('\n')}

UPCOMING CALENDAR (next 45 days):
${calendarEvents.map(e => `- ${e.date}${e.time ? ` ${e.time}` : ''} ${e.summary}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(none)'}

SALIENCE SEARCH CONTEXT:
${salienceContexts.map(ctx => [
  `Signal ${ctx.signalId}`,
  `Questions: ${ctx.questions.join(' | ') || '(none)'}`,
  `Queries: ${ctx.queries.join(' | ') || '(none)'}`,
  ...(ctx.hits.length
    ? ctx.hits.map(h => `- ${h.source_kind}/${h.source_id} score ${h.score}: ${h.text}`)
    : ['- no semantic context found']),
].join('\n')).join('\n\n')}`;

  const parsed = await llmJson(user, 'suggestion-opportunity', prompt);
  const byId = new Map(signals.map(s => [s.id, s]));
  const created = [];
  for (const s of (parsed.suggestions || []).slice(0, 3)) {
    const signalIds = Array.isArray(s.signal_ids) ? s.signal_ids.filter(id => byId.has(id)) : [];
    if (!signalIds.length) continue;
    const confidence = Number(s.confidence) || 0;
    if (confidence && confidence < 0.55) continue;
    const window = String(s.relevance_window || dublinTodayIso().slice(0, 7)).slice(0, 40);
    const dedupKey = `opportunity:${signalIds.sort().join('+')}:${window}`;
    const row = createSuggestion(user, {
      domain: 'opportunity',
      title: /^opportunity radar:/i.test(String(s.title || ''))
        ? s.title
        : `Opportunity radar: ${s.title}`,
      body: s.body,
      evidence: {
        signals: signalIds.map(id => byId.get(id)),
        calendarEvents: calendarEvents.slice(0, 20).map(e => ({
          date: e.date, time: e.time, summary: e.summary, location: e.location,
        })),
        salienceContexts: salienceContexts.filter(ctx => signalIds.includes(ctx.signalId)),
        confidence: confidence || null,
      },
      dedupKey,
    });
    if (row) created.push(row);
  }
  return created;
}

const SUGGESTERS = { travel: runTravelSuggester, content: runContentSuggester, opportunity: runOpportunitySuggester };

// ── Daily run ─────────────────────────────────────────────────────────────────

async function runSuggesters(user) {
  expireSuggestions(user);
  const created = [];
  for (const [name, fn] of Object.entries(SUGGESTERS)) {
    try {
      const rows = await fn(user);
      if (rows.length) console.log(`[suggestions] ${name}: ${rows.length} new for ${user}`);
      created.push(...rows);
    } catch (err) {
      console.error(`[suggestions] ${name} failed for ${user}:`, err.message);
    }
  }

  return created;
}

module.exports = {
  createSuggestion,
  listOpenSuggestions,
  findSuggestionByCode,
  acceptSuggestion,
  dismissSuggestion,
  whySuggestion,
  briefingSuggestionLines,
  expireSuggestions,
  extractTravelPrices,
  isSkyscannerEmail,
  runSuggesters,
  SUGGESTERS,
};
