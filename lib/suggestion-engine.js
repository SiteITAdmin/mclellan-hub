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

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders, taskCodeForFeature } = require('./openrouter-attribution');
const { getSystemModelId } = require('./settings');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EXPIRY_DAYS = 14;
function now() { return Math.floor(Date.now() / 1000); }

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

async function llmJson(user, feature, prompt) {
  const model = getSystemModelId('suggestions', 'system', 'google/gemini-2.5-flash');
  const taskCode = taskCodeForFeature(feature, TASK_CODES.SUGGESTIONS);
  const started = Date.now();
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: openRouterHeaders(taskCode),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature, modelKey: feature, fallbackModelId: model, data,
    taskCode,
    durationMs: Date.now() - started,
  });
  const raw = data.choices[0].message.content;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
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
  return listOpenSuggestions(user).slice(0, 5).map(s =>
    `• #${s.short_code} [${s.domain}] ${s.title} _(accept ${s.short_code} · dismiss ${s.short_code} · why ${s.short_code})_`);
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

  const prompt = `Extract flight price information from this Skyscanner alert email. Return ONLY JSON:
{"prices": [{"route": "ORIGIN-DESTINATION (IATA codes if shown, else City-City)", "window_start": "YYYY-MM-DD or null", "window_end": "YYYY-MM-DD or null", "price": number, "currency": "EUR|GBP|USD"}]}

Rules: only prices explicitly stated in the email; route as "DUB-EDI" style; window dates are the travel dates the price refers to; empty array if no concrete prices.

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

  const prompt = `Today is ${dublinTodayIso()}. You advise Douglas (based in Dublin) on flight booking timing. Suggestions only — never instructions to book automatically.

UPCOMING CALENDAR EVENTS (next 120 days):
${calendarEvents.map(e => `- ${e.date} ${e.summary}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(none)'}

CRM NOTES MENTIONING TRAVEL:
${travelFacts.map(f => `- [${f.contact_name}] ${f.fact}`).join('\n') || '(none)'}

FLIGHTS ALREADY BOOKED:
${bookedFlights.map(f => `- ${f.flight_date} ${f.direction} (${f.flight_number})`).join('\n') || '(none)'}

FLIGHT PRICE OBSERVATIONS (from Skyscanner alerts, oldest first):
${pricePoints.map(p => `- ${p.route} ${p.travel_window_start || '?'}→${p.travel_window_end || '?'}: ${p.price} ${p.currency} (seen ${new Date(p.observed_at * 1000).toISOString().slice(0, 10)})`).join('\n') || '(none)'}

Identify travel that looks PLANNED BUT UNBOOKED (calendar events or notes implying travel with no matching booked flight in that window). Where price observations exist for a relevant route, advise on booking timing using the price trend and the rule of thumb that ~6 weeks before travel is often the cheapest point. Only suggest things grounded in the data above.

Return ONLY JSON:
{"suggestions": [{"title": "short actionable headline", "body": "2-3 sentences: what you noticed, the price trend if known, and the timing recommendation", "route": "XXX-YYY or null", "window_start": "YYYY-MM-DD or null"}]}

Maximum 3 suggestions. Empty array if nothing is genuinely worth flagging.`;

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

  const prompt = `You suggest LinkedIn post topics for Douglas McLellan, a senior technology leader in Ireland (M365, AI strategy, healthcare IT, operational leadership). Today is ${dublinTodayIso()}.

RECENT SIGNALS (RSS articles + newsletter topics, last 14 days):
${articles.map(a => `- ${a.title}`).join('\n')}
${topics.map(t => `- [${t.category || 'misc'}] ${t.headline}`).join('\n')}

TOPICS HE ALREADY POSTED ABOUT (do not repeat):
${recentPosts.map(p => `- ${p.topic}`).join('\n') || '(none)'}

Pick the 1-2 strongest themes where multiple signals converge and a post would showcase his expertise. Return ONLY JSON:
{"suggestions": [{"title": "the post topic in one line", "body": "2 sentences: why this theme is timely and what angle he should take"}]}

Empty array if nothing stands out.`;

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

const SUGGESTERS = { travel: runTravelSuggester, content: runContentSuggester };

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
