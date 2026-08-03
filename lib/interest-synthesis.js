'use strict';

/**
 * Interest radar (synthesis).
 *
 * Joins the dots between what Douglas was just part of (recent meeting
 * intakes) and what he is walking into (upcoming meetings and calendar), asks
 * the model which work topics he is actively engaged with, and compiles the
 * answer into interest atoms plus a small presentation cache that the work
 * daily brief reads. A transcript mentioning an invitation to cyber security
 * training plus the training in Monday's calendar becomes an active interest
 * in "cyber security in Microsoft 365", which pulls stories into the brief.
 *
 * No new tables: atoms are the knowledge substrate; crm_context holds the
 * compiled radar view. Interests that stop being reconfirmed by new signals
 * fade out through the normal atom decay cycle.
 */

const db = require('./db');
const { chatText } = require('./chat-completions');
const { uuid } = require('./id');
const { upsertAtom } = require('./atoms');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES } = require('./openrouter-attribution');
const { PROMPTS } = require('./prompts');

const RADAR_CONTEXT_KEY = 'interest_radar';
const SIGNAL_DAYS_BACK = 14;
const SIGNAL_DAYS_FORWARD = 14;
// An interest the synthesis has not reconfirmed in this window stops steering
// the brief, even though its atom lives on in the knowledge layer.
const RADAR_FRESH_DAYS = 45;

function dublinDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400 * 1000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function gatherInterestSignals(user) {
  const hub = db.hub();
  const sinceEpoch = Math.floor(Date.now() / 1000) - SIGNAL_DAYS_BACK * 86400;
  const signals = [];

  for (const r of hub.prepare(`
    SELECT id, title, summary, created_at FROM meeting_intakes
     WHERE user = ? AND created_at >= ? AND status != 'failed'
     ORDER BY created_at DESC LIMIT 20
  `).all(user, sinceEpoch)) {
    signals.push({
      id: `meeting_intake:${r.id}`,
      kind: 'meeting_intake',
      refId: r.id,
      label: `Recent meeting: ${r.title || 'untitled'}`,
      detail: String(r.summary || '').slice(0, 600),
    });
  }

  for (const r of hub.prepare(`
    SELECT id, title, meeting_date, meeting_time, notes FROM meetings
     WHERE user = ? AND meeting_date >= ? AND meeting_date <= ?
     ORDER BY meeting_date ASC LIMIT 20
  `).all(user, dublinDate(0), dublinDate(SIGNAL_DAYS_FORWARD))) {
    signals.push({
      id: `meeting:${r.id}`,
      kind: 'meeting',
      refId: r.id,
      label: `Upcoming (${r.meeting_date}${r.meeting_time ? ' ' + r.meeting_time.slice(0, 5) : ''}): ${r.title}`,
      detail: String(r.notes || '').slice(0, 300),
    });
  }

  return signals;
}

// Live Google Calendar events add anything not yet synced into the meetings
// table (e.g. an invitation accepted this morning). Failure is fine — the
// radar still runs on the local signals.
async function gatherCalendarSignals(user) {
  try {
    const { fetchCalendarEvents } = require('./crm');
    const events = await fetchCalendarEvents(user, { daysForward: SIGNAL_DAYS_FORWARD });
    return (events || []).slice(0, 20).map((e, i) => ({
      id: `calendar:${e.id || i}`,
      kind: 'calendar',
      refId: e.id || String(i),
      label: `Calendar (${e.date}${e.time ? ' ' + e.time : ''}): ${e.summary || '(untitled)'}`,
      detail: String(e.notes || '').slice(0, 300),
    }));
  } catch (err) {
    console.warn('[interest-radar] calendar fetch skipped:', err.message);
    return [];
  }
}

function parseTopics(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed.topics) ? parsed.topics.filter(t => t && t.topic) : [];
  } catch {
    return [];
  }
}

const SIGNAL_TOKEN_STOPWORDS = new Set([
  'about', 'active', 'around', 'calendar', 'clear', 'confirm', 'confirms',
  'douglas', 'entry', 'from', 'into', 'meeting', 'meetings', 'recent', 'scheduled',
  'signal', 'signals', 'task', 'tasks', 'that', 'this', 'topic', 'training',
  'upcoming', 'with', 'work',
]);

function signalTokens(text) {
  return new Set(String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 4 && !SIGNAL_TOKEN_STOPWORDS.has(t)));
}

function topicSignalIds(topic) {
  const keys = ['signal_ids', 'signalIds', 'source_signal_ids', 'sourceSignalIds'];
  const ids = [];
  for (const key of keys) {
    if (Array.isArray(topic[key])) ids.push(...topic[key]);
  }
  if (Array.isArray(topic.signals)) {
    for (const s of topic.signals) ids.push(typeof s === 'string' ? s : s?.id);
  }
  return ids.map(id => String(id || '').trim()).filter(Boolean);
}

function inferSupportingSignals(topic, signals) {
  const evidence = [topic.topic, topic.why].filter(Boolean).join(' ');
  const evidenceTokens = signalTokens(evidence);
  if (!evidenceTokens.size) return [];
  return signals
    .map(signal => {
      const text = `${signal.label || ''} ${signal.detail || ''}`;
      const tokens = signalTokens(text);
      let score = 0;
      for (const token of evidenceTokens) {
        if (tokens.has(token)) score++;
      }
      return { signal, score };
    })
    .filter(item => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => item.signal);
}

function supportingSignalsForTopic(topic, signals) {
  const byId = new Map(signals.map(s => [s.id, s]));
  const exact = topicSignalIds(topic).map(id => byId.get(id)).filter(Boolean);
  if (exact.length) return exact;
  return inferSupportingSignals(topic, signals);
}

async function synthesiseTopics(user, signals) {
  const signalText = signals
    .map(s => `[${s.id}] ${s.label}${s.detail ? ` — ${s.detail}` : ''}`)
    .join('\n');
  const raw = await chatText({
    feature: 'interest_synthesis',
    messages: [
      { role: 'system', content: getSystemPrompt('interest_synthesis', 'system', PROMPTS.interest_synthesis) },
      { role: 'user', content: `SIGNALS\n${signalText}` },
    ],
    user,
  });
  return parseTopics(raw);
}

// Pure writer — separated from the LLM call so it can be exercised with
// synthetic model output.
function applyInterestTopics(user, topics, signals) {
  const hub = db.hub();
  const compiled = [];

  for (const t of topics.slice(0, 5)) {
    const supporting = supportingSignalsForTopic(t, signals);
    const confidence = Math.min(0.95, Math.max(0.3, Number(t.confidence) || 0.6));
    let atomId = null;
    const refs = supporting.length ? supporting : [null];
    for (const s of refs) {
      atomId = upsertAtom(user, {
        subjectKind: 'interest',
        subjectLabel: 'work radar',
        predicate: 'active_interest',
        value: String(t.topic).trim(),
        confidence,
        derivedBy: 'interest_synthesis',
        sourceRef: s ? { kind: s.kind, id: s.refId } : null,
      }) || atomId;
    }
    compiled.push({
      atomId,
      topic: String(t.topic).trim(),
      why: String(t.why || '').trim(),
      signals: supporting.map(s => s.label),
    });
  }

  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, RADAR_CONTEXT_KEY, JSON.stringify({
    updatedAt: Math.floor(Date.now() / 1000),
    topics: compiled,
  }));

  return compiled;
}

// Radar as consumers see it: only interests whose atom is still active and
// recently reconfirmed. The cache supplies the human "why"; the atom supplies
// the freshness and confidence.
function getInterestRadar(user) {
  const hub = db.hub();
  const row = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?')
    .get(user, RADAR_CONTEXT_KEY);
  if (!row) return [];
  let cache;
  try { cache = JSON.parse(row.value); } catch { return []; }
  const freshCutoff = Math.floor(Date.now() / 1000) - RADAR_FRESH_DAYS * 86400;
  const out = [];
  for (const t of cache.topics || []) {
    const atom = t.atomId
      ? hub.prepare('SELECT status, confidence, last_confirmed FROM knowledge_atoms WHERE id = ?').get(t.atomId)
      : null;
    if (!atom || atom.status !== 'active' || atom.last_confirmed < freshCutoff) continue;
    out.push({ ...t, confidence: atom.confidence });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

async function runInterestSynthesis(user = 'douglas') {
  const signals = [...gatherInterestSignals(user), ...(await gatherCalendarSignals(user))];
  if (!signals.length) {
    console.log('[interest-radar] no signals in window — radar unchanged');
    return { signals: 0, topics: 0 };
  }
  const topics = await synthesiseTopics(user, signals);
  const compiled = applyInterestTopics(user, topics, signals);
  console.log(`[interest-radar] ${signals.length} signals → ${compiled.length} topic(s): ${compiled.map(t => t.topic).join('; ') || 'none'}`);
  return { signals: signals.length, topics: compiled.length };
}

module.exports = {
  gatherInterestSignals,
  gatherCalendarSignals,
  parseTopics,
  applyInterestTopics,
  getInterestRadar,
  runInterestSynthesis,
  RADAR_CONTEXT_KEY,
  RADAR_FRESH_DAYS,
};
