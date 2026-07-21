'use strict';

/**
 * LLM suggestion engine — advisory only, never acts.
 *
 * A daily suggestion_run job executes each registered suggester: gather
 * cross-domain data from compiled knowledge and source-backed CRM context,
 * call OpenRouter, INSERT OR IGNORE
 * suggestion rows (dedup_key makes re-runs free). Suggestions expire after
 * 14 days and wait in Hub for review. Accepting one creates a task and only
 * then promotes the accepted rationale into knowledge; nothing is ever booked
 * or scheduled automatically.
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
const { indexSource } = require('./retrieval');
const { upsertAtom, setStatus } = require('./atoms');
const { formatSuggestionLessons, recordSuggestionOutcome } = require('./suggestion-learning');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const EXPIRY_DAYS = 14;
const CONTACT_BATCH_SIZE = 12;
function now() { return Math.floor(Date.now() / 1000); }

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

const DIRECT_RELEVANCE_BASES = new Set([
  'destination_offer',
  'travel_utility',
  'known_need',
  'known_preference',
  'commitment_conflict',
]);
const SALIENCE_ADMISSION_CONTRACT = `Pipeline admission contract (this supersedes any earlier output schema while preserving the configured task and safety rules):
- Return ONLY JSON using this exact shape: {"suggestions":[{"title":"short actionable headline","body":"2-3 grounded sentences","signal_ids":["opportunity signal ids"],"relevance_window":"YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD or null","confidence":0.0,"action_required":true,"relevance_basis":"destination_offer|travel_utility|known_need|known_preference|commitment_conflict","causal_connection":"one sentence stating exactly how context changes the offer value"}]}
- Each suggestion must include action_required=true, relevance_basis set to one of destination_offer|travel_utility|known_need|known_preference|commitment_conflict, and a causal_connection explaining exactly how the context changes the offer's value.
- Reject coincidental timing: being away, busy, or on a trip before expiry does not make an unrelated offer relevant.
- Software limits and automatic account benefits are not travel offers. Existing product usage is evidence of access, not a reason to promote that product.
- A dedicated/fixed IP is not a travel-privacy benefit unless evidence shows a stable-identity, allowlisting, or hosting need.
- Suggestions that omit these fields are discarded by the pipeline.`;

function tokenUsageContext(user) {
  try {
    const { buildTokenBurnSummary } = require('./token-burn');
    const usage = buildTokenBurnSummary(user);
    return [
      `Imported usage window: ${usage.firstDate || '?'} to ${usage.lastDate || '?'}`,
      `Codex/OpenAI usage: ${Number(usage.codex || 0)} tokens`,
      `API usage: ${Number(usage.api || 0)} tokens`,
      `Live Hub model usage: ${Number(usage.liveExact || 0)} tokens`,
      `OpenRouter live requests: ${Number(usage.openRouterLive?.requests || 0)}`,
    ].join('\n');
  } catch (err) {
    return `Token-usage context unavailable: ${err.message}`;
  }
}

function declaredKnowledgeContext(user) {
  try {
    const rows = db.hub().prepare(`
      SELECT subject_label, predicate, value
      FROM knowledge_atoms
      WHERE user = ? AND status = 'active' AND derived_by = 'manual'
      ORDER BY updated_at DESC
      LIMIT 40
    `).all(user);
    return rows.map(row => `- [${row.subject_label} / ${row.predicate}] ${row.value}`).join('\n') || '(none)';
  } catch (err) {
    return `(unavailable: ${err.message})`;
  }
}

function isAdmissibleOpportunitySuggestion(suggestion) {
  if (suggestion?.action_required !== true) return false;
  if (!DIRECT_RELEVANCE_BASES.has(String(suggestion.relevance_basis || '').trim())) return false;
  return String(suggestion.causal_connection || '').trim().length >= 12;
}

function isActionableOpportunitySignal(signal) {
  return signal?.details?.action_required === true
    && String(signal.details.required_action || '').trim().length >= 3;
}

function buildOpportunitySuggestionEmail(rows) {
  const suggestions = (rows || []).filter(row => row?.domain === 'opportunity');
  if (!suggestions.length) return null;
  const suggestionText = suggestions.map(s => [
    s.title,
    '',
    s.body,
    '',
    `Suggestion #${s.short_code}`,
  ].join('\n')).join('\n\n---\n\n');
  const hubUrl = String(process.env.HUB_URL || 'https://dchat.mclellan.scot').replace(/\/$/, '');
  const text = `${suggestionText}\n\n---\n\nReview in the Hub: ${hubUrl}/crm/suggestions\nChoose Create task, Not this time, Dismiss, or Wrong. Each choice improves future suggestions.`;
  return { subject: 'Suggestion from CRM', text };
}

async function emailOpportunitySuggestions(user, rows) {
  const message = buildOpportunitySuggestionEmail(rows);
  if (!message) return { sent: 0 };
  const to = process.env.CRM_SUGGESTION_EMAIL
    || process.env.WORK_BRIEF_EMAIL
    || process.env.SYSTEM_REPORT_EMAIL
    || 'douglas@mclellan.scot';
  const { sendEmail } = require('./gmail');
  await sendEmail(user, to, message.subject, message.text);
  return { sent: rows.filter(row => row?.domain === 'opportunity').length, to };
}

async function compileOpportunitySuggestionAtom(user, suggestion, signalIds, synthesis, { index = indexSource } = {}) {
  if (!suggestion || !signalIds?.length) return null;
  const value = [
    suggestion.body,
    synthesis.causal_connection ? `Causal connection: ${synthesis.causal_connection}` : '',
    synthesis.relevance_window ? `Relevance window: ${synthesis.relevance_window}` : '',
  ].filter(Boolean).join(' | ').slice(0, 1800);
  const atom = {
    subjectKind: 'opportunity',
    subjectLabel: String(suggestion.title || 'Relevant offer').replace(/^Opportunity radar:\s*/i, ''),
    predicate: 'relevant_offer',
    value,
    confidence: Math.max(0.7, Math.min(0.99, Number(synthesis.confidence) || 0.75)),
    status: 'active',
    derivedBy: 'suggestion_opportunity',
  };
  let atomId = upsertAtom(user, {
    ...atom,
    sourceRef: { kind: 'suggestion', id: suggestion.id },
  });
  for (const signalId of signalIds) {
    atomId = upsertAtom(user, {
      ...atom,
      sourceRef: { kind: 'opportunity_signal', id: signalId },
    }) || atomId;
  }
  if (atomId) {
    try {
      await index(user, 'atom', atomId, `${atom.subjectLabel} ${atom.predicate} ${value}`);
    } catch (err) {
      console.warn(`[suggestions] relevant-offer atom indexing failed ${atomId}:`, err.message);
    }
  }
  return atomId;
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
    'SELECT MAX(short_code) AS max FROM suggestions WHERE user = ?'
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
    evidence ? JSON.stringify(evidence) : null,
    nextSuggestionCode(user), dedupKey, now() + EXPIRY_DAYS * 86400
  );
  if (!result.changes) return null;
  return hub.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
}

function listOpenSuggestions(user) {
  return db.hub().prepare(`
    SELECT * FROM suggestions
    WHERE user = ? AND domain IN ('opportunity', 'travel', 'contact')
      AND status = 'open' AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `).all(user, now());
}

function listSuggestions(user) {
  return db.hub().prepare(`
    SELECT s.*,
      (SELECT sf.user_reason FROM suggestion_feedback sf
       WHERE sf.user = s.user AND sf.suggestion_id = s.id
       ORDER BY sf.created_at DESC LIMIT 1) AS feedback_reason,
      (SELECT sl.rule FROM suggestion_feedback sf
       JOIN suggestion_lessons sl ON sl.id = sf.lesson_id
       WHERE sf.user = s.user AND sf.suggestion_id = s.id
       ORDER BY sf.created_at DESC LIMIT 1) AS learned_rule,
      (SELECT sf.outcome FROM suggestion_feedback sf
       WHERE sf.user = s.user AND sf.suggestion_id = s.id
       ORDER BY sf.created_at DESC LIMIT 1) AS feedback_outcome,
      (SELECT sf.quality_score FROM suggestion_feedback sf
       WHERE sf.user = s.user AND sf.suggestion_id = s.id
       ORDER BY sf.created_at DESC LIMIT 1) AS feedback_score
    FROM suggestions s
    WHERE s.user = ? AND s.domain IN ('opportunity', 'travel', 'contact')
    ORDER BY COALESCE(s.short_code, 0) DESC, s.created_at DESC
  `).all(user);
}

function findSuggestionByCode(user, code) {
  return db.hub().prepare(`
    SELECT * FROM suggestions
    WHERE user = ? AND short_code = ? AND status = 'open'
      AND domain IN ('opportunity', 'travel', 'contact')
    ORDER BY created_at DESC LIMIT 1
  `).get(user, parseInt(code, 10));
}

function expireSuggestions(user) {
  db.hub().prepare(
    "UPDATE suggestions SET status = 'expired' WHERE user = ? AND status = 'open' AND expires_at <= ?"
  ).run(user, now());
}

function relevanceWindowEnd(value) {
  const dates = String(value || '').match(/\d{4}-\d{2}-\d{2}/g) || [];
  return dates.length ? dates[dates.length - 1] : null;
}

function retireExpiredOpportunityKnowledge(user) {
  const today = dublinTodayIso();
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id, evidence FROM suggestions
    WHERE user = ? AND domain = 'opportunity'
  `).all(user);
  let retired = 0;
  for (const row of rows) {
    let evidence = {};
    try { evidence = JSON.parse(row.evidence || '{}'); } catch (_) {}
    const end = relevanceWindowEnd(evidence.relevanceWindow);
    if (!end || end >= today) continue;
    retired += hub.prepare(`
      UPDATE knowledge_atoms
      SET status = 'retired', updated_at = unixepoch()
      WHERE user = ? AND derived_by = 'suggestion_opportunity'
        AND status = 'active' AND source_refs LIKE ?
    `).run(user, `%${row.id}%`).changes;
  }
  return retired;
}

async function acceptSuggestion(user, code) {
  const s = findSuggestionByCode(user, code);
  if (!s) return { ok: false, message: `No open suggestion #${code}.` };
  return acceptSuggestionRow(user, s);
}

async function acceptSuggestionById(user, id, options = {}) {
  const s = db.hub().prepare(
    `SELECT * FROM suggestions
     WHERE id = ? AND user = ? AND status = 'open'
       AND domain IN ('opportunity', 'travel', 'contact')`
  ).get(id, user);
  if (!s) return { ok: false, notFound: true, message: 'No open suggestion found.' };
  return acceptSuggestionRow(user, s, options);
}

async function acceptSuggestionRow(user, s, {
  createTaskFn = null,
  promote = promoteAcceptedSuggestion,
} = {}) {
  let task;
  try {
    const create = createTaskFn || require('./google-tasks').createTask;
    const evidence = parseSuggestionEvidence(s);
    task = await create(user, {
      title: s.title,
      notes: s.body,
      source: 'suggestion',
      sourceId: s.id,
      contactId: s.domain === 'contact' ? evidence.contactId || null : null,
    });
  } catch (err) {
    return { ok: false, message: `Could not create the task: ${err.message}` };
  }

  const outcome = recordSuggestionOutcome(user, s.id, 'accepted');
  if (!outcome.ok) {
    return {
      ok: false,
      message: 'The task was created, but the suggestion outcome could not be recorded.',
      taskCreated: Boolean(task),
    };
  }

  let knowledgeAtomId = null;
  let warning = null;
  try {
    knowledgeAtomId = await promote(user, s);
  } catch (err) {
    warning = `The task was created, but the accepted rationale was not added to knowledge: ${err.message}`;
    console.error(`[suggestions] accepted suggestion promotion failed ${s.id}:`, err.message);
  }

  return {
    ok: true,
    message: `Suggestion #${s.short_code} accepted. ${task ? 'Task created.' : 'The task already existed.'}`,
    taskCreated: Boolean(task),
    knowledgeAtomId,
    warning,
  };
}

function dismissSuggestion(user, code) {
  const s = findSuggestionByCode(user, code);
  if (!s) return { ok: false, message: `No open suggestion #${code}.` };
  const result = recordSuggestionOutcome(user, s.id, 'dismissed');
  return result.ok
    ? { ...result, message: `🗑 Suggestion #${s.short_code} dismissed.` }
    : result;
}

function dismissSuggestionById(user, id) {
  const result = recordSuggestionOutcome(user, id, 'dismissed');
  return result.ok ? { ...result, message: 'Suggestion dismissed.' } : result;
}

function notThisTimeSuggestionById(user, id) {
  const result = recordSuggestionOutcome(user, id, 'not_this_time');
  return result.ok
    ? { ...result, message: 'Suggestion closed as Not this time.' }
    : result;
}

function parseSuggestionEvidence(suggestion) {
  try { return JSON.parse(suggestion?.evidence || '{}') || {}; }
  catch (_) { return {}; }
}

async function compileAcceptedContactSuggestionAtom(user, suggestion, { index = indexSource } = {}) {
  const evidence = parseSuggestionEvidence(suggestion);
  if (!evidence.contactId || !evidence.contactName) return null;
  const atomId = upsertAtom(user, {
    subjectKind: 'contact',
    subjectId: evidence.contactId,
    subjectLabel: evidence.contactName,
    predicate: 'accepted_outreach_reason',
    value: `${suggestion.title}: ${suggestion.body}`.slice(0, 1800),
    sourceRef: { kind: 'suggestion', id: suggestion.id },
    confidence: 0.95,
    status: 'active',
    derivedBy: 'suggestion_contact_accepted',
  });
  if (atomId) {
    setStatus(atomId, 'active');
    try {
      await index(user, 'atom', atomId, `${evidence.contactName} accepted outreach reason ${suggestion.title} ${suggestion.body}`);
    } catch (err) {
      console.warn(`[suggestions] accepted contact atom indexing failed ${atomId}:`, err.message);
    }
  }
  return atomId;
}

async function promoteAcceptedSuggestion(user, suggestion) {
  if (suggestion.domain === 'contact') {
    return compileAcceptedContactSuggestionAtom(user, suggestion);
  }
  if (suggestion.domain === 'opportunity') {
    const evidence = parseSuggestionEvidence(suggestion);
    const signalIds = Array.isArray(evidence.signals)
      ? evidence.signals.map(signal => signal?.id).filter(Boolean)
      : [];
    const atomId = await compileOpportunitySuggestionAtom(user, suggestion, signalIds, {
      causal_connection: evidence.causalConnection,
      relevance_window: evidence.relevanceWindow,
      confidence: evidence.confidence,
    });
    if (atomId) setStatus(atomId, 'active');
    return atomId;
  }
  return null;
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
${pricePoints.map(p => `- ${p.route} ${p.travel_window_start || '?'}→${p.travel_window_end || '?'}: ${p.price} ${p.currency} (seen ${new Date(p.observed_at * 1000).toISOString().slice(0, 10)})`).join('\n') || '(none)'}${formatSuggestionLessons(user, 'travel')}`;

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

function contactSuggestionCandidates(user) {
  return db.hub().prepare(`
    SELECT c.id, c.name, c.notes, c.last_contacted_at,
      group_concat(
        co.name || CASE
          WHEN cc.role IS NOT NULL AND cc.role != '' THEN ' (' || cc.role || ')'
          ELSE ''
        END,
        '; '
      ) AS companies
    FROM contacts c
    LEFT JOIN contact_companies cc ON cc.contact_id = c.id
    LEFT JOIN companies co ON co.id = cc.company_id
    WHERE c.user = ?
      AND c.id NOT LIKE 'self-%'
      AND NOT EXISTS (
        SELECT 1 FROM google_tasks t
        WHERE t.user = c.user AND t.contact_id = c.id
          AND t.status = 'needsAction' AND t.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM suggestions s
        WHERE s.user = c.user AND s.domain = 'contact' AND s.status = 'open'
          AND s.dedup_key LIKE 'contact-reason:' || c.id || ':%'
      )
    GROUP BY c.id
    ORDER BY c.name
  `).all(user);
}

function contactContextPacket(user, contact) {
  const hub = db.hub();
  const atoms = hub.prepare(`
    SELECT id, predicate, value, source_refs, confidence
    FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'contact' AND subject_id = ? AND status = 'active'
    ORDER BY confidence DESC, updated_at DESC LIMIT 14
  `).all(user, contact.id);
  const meetings = hub.prepare(`
    SELECT m.id, m.title, m.meeting_date, m.notes
    FROM meeting_attendees ma
    JOIN meetings m ON m.id = ma.meeting_id
    WHERE ma.contact_id = ? AND m.user = ?
    ORDER BY m.meeting_date DESC LIMIT 5
  `).all(contact.id, user);
  const completedTasks = hub.prepare(`
    SELECT id, title, notes, completed_at
    FROM google_tasks
    WHERE user = ? AND contact_id = ? AND status != 'needsAction'
      AND deleted_at IS NULL
    ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 5
  `).all(user, contact.id);
  const sources = [];
  if (contact.companies) sources.push({ key: 'profile:companies', text: contact.companies });
  if (contact.notes) sources.push({ key: 'profile:notes', text: String(contact.notes).slice(0, 800) });
  if (contact.last_contacted_at) {
    sources.push({
      key: 'profile:last-contacted',
      text: new Date(contact.last_contacted_at * 1000).toISOString().slice(0, 10),
    });
  }
  for (const atom of atoms) {
    sources.push({ key: `atom:${atom.id}`, text: `${atom.predicate}: ${atom.value}`.slice(0, 800) });
  }
  for (const meeting of meetings) {
    sources.push({
      key: `meeting:${meeting.id}`,
      text: `${meeting.meeting_date} ${meeting.title}${meeting.notes ? ` — ${meeting.notes}` : ''}`.slice(0, 800),
    });
  }
  for (const task of completedTasks) {
    sources.push({
      key: `task:${task.id}`,
      text: `${task.title}${task.notes ? ` — ${task.notes}` : ''}`.slice(0, 800),
    });
  }
  return { id: contact.id, name: contact.name, sources: sources.slice(0, 24) };
}

function fallbackContactProposal(contact) {
  const anchor = contact.sources[0] || null;
  if (anchor) {
    return {
      contact_id: contact.id,
      title: 'Revisit a known thread',
      reason: `The Hub's clearest current thread for ${contact.name} is: ${anchor.text}. Reaching out could test whether that context is still current and whether it creates a useful next conversation.`,
      suggested_action: `Refer to that thread and ask ${contact.name} what has changed since it was captured.`,
      source_keys: [anchor.key],
      uses_hypothesis: true,
      hypothesis: 'The stored thread may still be relevant, but the Hub has no fresh evidence that it is.',
      confidence: 0.45,
    };
  }
  return {
    contact_id: contact.id,
    title: 'Re-establish the thread',
    reason: `The Hub has too little current evidence to identify a specific shared thread with ${contact.name}. A light-touch check-in would refresh the relationship and reveal what is currently useful to them.`,
    suggested_action: `Ask ${contact.name} what they are focused on now and whether an introduction, idea, or practical help would be useful.`,
    source_keys: [],
    uses_hypothesis: true,
    hypothesis: 'There may be a useful reason to reconnect, but the Hub does not yet have evidence of what it is.',
    confidence: 0.35,
  };
}

async function runContactSuggester(user, { synthesise = null } = {}) {
  const candidates = contactSuggestionCandidates(user);
  if (!candidates.length) return [];
  const packets = candidates.map(contact => contactContextPacket(user, contact));
  const created = [];
  const month = dublinTodayIso().slice(0, 7);
  const generate = synthesise || ((prompt) => llmJson(user, 'suggestion-contact', prompt));
  const proposals = new Map();
  const excludedContactIds = new Set();

  for (let offset = 0; offset < packets.length; offset += CONTACT_BATCH_SIZE) {
    const batch = packets.slice(offset, offset + CONTACT_BATCH_SIZE);
    const prompt = `${getSystemPrompt('suggestion_contact', 'system', PROMPTS.suggestion_contact)}

Today is ${dublinTodayIso()}.

CONTACT EVIDENCE PACKETS:
${JSON.stringify(batch, null, 2)}${formatSuggestionLessons(user, 'contact')}`;
    let parsed;
    try {
      parsed = await generate(prompt, batch);
    } catch (err) {
      const batchNumber = offset / CONTACT_BATCH_SIZE + 1;
      throw new Error(`Contact suggestion batch ${batchNumber} failed; no contact suggestions were created: ${err.message}`);
    }
    for (const item of (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])) {
      const contactId = String(item?.contact_id || '');
      if (batch.some(contact => contact.id === contactId)) proposals.set(contactId, item);
    }
    for (const item of (Array.isArray(parsed?.excluded_contacts) ? parsed.excluded_contacts : [])) {
      const contactId = String(item?.contact_id || '');
      if (batch.some(contact => contact.id === contactId)) excludedContactIds.add(contactId);
    }
  }

  for (const contact of packets) {
    if (excludedContactIds.has(contact.id)) continue;
    const fallback = fallbackContactProposal(contact);
    const proposal = proposals.get(contact.id) || fallback;
    const validSourceKeys = new Set(contact.sources.map(source => source.key));
    const selectedSourceKeys = Array.isArray(proposal.source_keys)
      ? proposal.source_keys.map(String).filter(key => validSourceKeys.has(key)).slice(0, 8)
      : [];
    const reason = String(proposal.reason || '').trim() || fallback.reason;
    const action = String(proposal.suggested_action || '').trim() || fallback.suggested_action;
    const hypothesis = String(proposal.hypothesis || '').trim();
    const usesHypothesis = proposal.uses_hypothesis === true || Boolean(hypothesis);
    const body = [
      reason,
      usesHypothesis ? `Exploratory hypothesis: ${hypothesis || 'The outreach angle is plausible, but not established as fact in the Hub.'}` : '',
      `Suggested next step: ${action}`,
    ].filter(Boolean).join('\n\n');
    const row = createSuggestion(user, {
      domain: 'contact',
      title: `Contact ${contact.name}: ${String(proposal.title || 'reconnect').trim()}`,
      body,
      evidence: {
        contactId: contact.id,
        contactName: contact.name,
        selectedSourceKeys,
        sources: contact.sources.filter(source => selectedSourceKeys.includes(source.key)),
        usesHypothesis,
        hypothesis: hypothesis || null,
        confidence: Number(proposal.confidence) || null,
        suggestedAction: action,
        knowledgeStatus: 'candidate_only_until_accepted',
      },
      dedupKey: `contact-reason:${contact.id}:${month}`,
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
  retireExpiredOpportunityKnowledge(user);
  // Legacy signals did not record whether Douglas actually had to do
  // anything. They are unsafe to re-advertise; only newly extracted,
  // explicitly actionable opportunities enter salience synthesis.
  const signals = activeOpportunitySignals(user, { limit: 12 })
    .filter(isActionableOpportunitySignal);
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

${SALIENCE_ADMISSION_CONTRACT}

Today is ${dublinTodayIso()}.

KNOWN PRODUCT USAGE (use this to avoid recommending access Douglas already has):
${tokenUsageContext(user)}

DECLARED KNOWLEDGE (high-confidence user context):
${declaredKnowledgeContext(user)}

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
].join('\n')).join('\n\n')}${formatSuggestionLessons(user, 'opportunity')}`;

  const parsed = await llmJson(user, 'suggestion-opportunity', prompt);
  const byId = new Map(signals.map(s => [s.id, s]));
  const created = [];
  const proposed = Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [];
  console.log(`[suggestions] opportunity model proposed ${proposed.length} suggestion(s) for ${user}`);
  for (const s of proposed) {
    if (!isAdmissibleOpportunitySuggestion(s)) {
      console.warn('[suggestions] rejected opportunity proposal missing causal admission fields:', JSON.stringify({
        title: String(s?.title || '').slice(0, 120),
        action_required: s?.action_required,
        relevance_basis: s?.relevance_basis,
        has_causal_connection: String(s?.causal_connection || '').trim().length >= 12,
      }));
      continue;
    }
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
        relevanceWindow: window,
        actionRequired: true,
        relevanceBasis: s.relevance_basis,
        causalConnection: s.causal_connection,
      },
      dedupKey,
    });
    if (row) created.push(row);
  }
  return created;
}

const SUGGESTERS = {
  travel: runTravelSuggester,
  contact: runContactSuggester,
  opportunity: runOpportunitySuggester,
};

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

  try {
    await emailOpportunitySuggestions(user, created);
  } catch (err) {
    console.error(`[suggestions] standalone email failed for ${user}:`, err.message);
  }

  return created;
}

module.exports = {
  createSuggestion,
  listSuggestions,
  listOpenSuggestions,
  findSuggestionByCode,
  acceptSuggestion,
  acceptSuggestionById,
  dismissSuggestion,
  dismissSuggestionById,
  notThisTimeSuggestionById,
  whySuggestion,
  buildOpportunitySuggestionEmail,
  compileOpportunitySuggestionAtom,
  compileAcceptedContactSuggestionAtom,
  promoteAcceptedSuggestion,
  emailOpportunitySuggestions,
  isActionableOpportunitySignal,
  isAdmissibleOpportunitySuggestion,
  relevanceWindowEnd,
  retireExpiredOpportunityKnowledge,
  expireSuggestions,
  extractTravelPrices,
  isSkyscannerEmail,
  contactSuggestionCandidates,
  contactContextPacket,
  runContactSuggester,
  runSuggesters,
  SUGGESTERS,
};
