'use strict';

/**
 * Read-side CRM activity + content dashboard.
 *
 * Every number here is derived from evidence the Hub already captures: the
 * `knowledge_receipts` ingest ledger (stage `source_admitted`, written by
 * every ingester at capture), the CRM pipeline receipts, the compiled
 * `knowledge_atoms`, and the raw content families (email, documents,
 * meetings, tasks, messaging, RSS, intel). Nothing is written; this is a view
 * over existing compiled layers, so there is no schema change and no fact to
 * go stale.
 */

const db = require('./db');
const { admissionHealth } = require('./source-admission');
const { effectHealth } = require('./effect-gate');
const { getCrmKnowledgeHealth } = require('./crm-knowledge-health');

const DAY = 86400;
const STAGE_FUNNEL = [
  { key: 'source_admitted', label: 'Ingested' },
  { key: 'crm_source_triage', label: 'Source triage' },
  { key: 'crm_duplicate_reviewed', label: 'Duplicate review' },
  { key: 'crm_knowledge_synthesised', label: 'Knowledge synthesis' },
  { key: 'crm_action_projected', label: 'Action projection' },
  { key: 'external_effect', label: 'External effects (tasks)' },
];

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function dublinDayKey(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * DAY * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function statusBucket(status) {
  if (['error', 'fail'].includes(status)) return 'errors';
  if (['warn', 'uncertain', 'review', 'pending'].includes(status)) return 'warnings';
  if (['skipped', 'already_synthesised'].includes(status)) return 'skipped';
  return 'processed';
}

function count(hub, sql, ...params) {
  try {
    const row = hub.prepare(sql).get(...params);
    return Number(row?.n || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * Daily ingest trend: `source_admitted` receipts bucketed by Dublin calendar
 * day over the last `days` days. Only the latest admission per source counts
 * in each day, so a repaired source is not double counted.
 */
function ingestTrend(user, days = 14) {
  const hub = db.hub();
  const since = now() - days * DAY;
  const rows = hub.prepare(`
    SELECT created_at, source_kind, source_id, status, payload
    FROM knowledge_receipts
    WHERE user = ? AND stage = 'source_admitted' AND created_at >= ?
    ORDER BY created_at ASC
  `).all(user, since);

  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(dublinDayKey(i));

  const byDay = new Map(dayKeys.map(key => [key, {
    day: key,
    captured: 0, complete: 0, incomplete: 0, unreadable: 0, excluded: 0,
    ingesters: {},
  }]));

  // Latest admission per (day, source_kind, source_id).
  const latestByDay = new Map();
  for (const row of rows) {
    const day = new Date(row.created_at * 1000)
      .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
    if (!byDay.has(day)) continue;
    const key = `${day}\u0000${row.source_kind}\u0000${row.source_id}`;
    const prev = latestByDay.get(key);
    if (!prev || Number(row.created_at) > Number(prev.created_at)) latestByDay.set(key, row);
  }

  for (const row of latestByDay.values()) {
    const day = new Date(row.created_at * 1000)
      .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
    const entry = byDay.get(day);
    const payload = parseJson(row.payload);
    const ingester = String(payload.ingester || 'unknown');
    entry.captured += 1;
    if (row.status === 'error') entry.unreadable += 1;
    else if (payload.excluded) entry.excluded += 1;
    else if (payload.complete) entry.complete += 1;
    else entry.incomplete += 1;
    entry.ingesters[ingester] = (entry.ingesters[ingester] || 0) + 1;
  }

  return [...byDay.values()];
}

/**
 * Pipeline funnel across every receipt stage. CRM stages and admission are
 * source-scoped (latest receipt per source); external effects are counted per
 * effect row, since each one is a distinct task-creation attempt.
 */
function pipelineFunnel(user) {
  const hub = db.hub();
  const stages = STAGE_FUNNEL.map(stage => ({
    key: stage.key,
    label: stage.label,
    total: 0, processed: 0, skipped: 0, warnings: 0, errors: 0, last_at: null,
  }));
  const byKey = new Map(stages.map(stage => [stage.key, stage]));
  const placeholders = STAGE_FUNNEL.map(() => '?').join(',');
  const rows = hub.prepare(`
    SELECT stage, source_kind, source_id, status, created_at, payload
    FROM knowledge_receipts
    WHERE user = ? AND stage IN (${placeholders})
    ORDER BY created_at ASC
  `).all(user, ...STAGE_FUNNEL.map(stage => stage.key));

  const latestByStage = new Map();
  for (const row of rows) {
    const isEffect = row.stage === 'external_effect';
    if (isEffect) continue; // external effects count every row
    const key = `${row.stage}\u0000${row.source_kind}\u0000${row.source_id}`;
    const prev = latestByStage.get(key);
    if (!prev || Number(row.created_at) > Number(prev.created_at)) latestByStage.set(key, row);
  }
  for (const row of latestByStage.values()) {
    const stage = byKey.get(row.stage);
    stage.total += 1;
    stage[statusBucket(row.status)] += 1;
    stage.last_at = Math.max(Number(stage.last_at || 0), Number(row.created_at || 0)) || null;
  }

  // External effects: every row, bucketed by status and by origin.
  const effectStage = byKey.get('external_effect');
  const effectByOrigin = new Map();
  for (const row of rows) {
    if (row.stage !== 'external_effect') continue;
    const payload = parseJson(row.payload);
    effectStage.total += 1;
    effectStage[statusBucket(row.status)] += 1;
    effectStage.last_at = Math.max(Number(effectStage.last_at || 0), Number(row.created_at || 0)) || null;
    const origin = String(payload.origin || 'unknown');
    const entry = effectByOrigin.get(origin) || { origin, created: 0, refused: 0, failed: 0 };
    if (payload.outcome === 'created') entry.created += 1;
    else if (payload.outcome === 'refused') entry.refused += 1;
    else entry.failed += 1;
    effectByOrigin.set(origin, entry);
  }
  effectStage.effectOrigins = [...effectByOrigin.values()]
    .sort((a, b) => b.created - a.created);

  return stages.filter(stage => stage.total > 0 || stage.key === 'external_effect');
}

function contentInventory(user) {
  const hub = db.hub();
  const emails = {
    received: count(hub, `SELECT COUNT(*) AS n FROM email_summaries WHERE user = ? AND direction = 'received'`, user),
    sent: count(hub, `SELECT COUNT(*) AS n FROM email_summaries WHERE user = ? AND direction = 'sent'`, user),
  };
  const inbound = hub.prepare(
    `SELECT source, COUNT(*) AS n FROM inbound_email_records WHERE user = ? GROUP BY source`
  ).all(user);
  const meetings = hub.prepare(
    `SELECT source, COUNT(*) AS n FROM meetings WHERE user = ? GROUP BY source`
  ).all(user);
  const intakes = hub.prepare(
    `SELECT status, COUNT(*) AS n FROM meeting_intakes WHERE user = ? GROUP BY status`
  ).all(user);
  const messaging = hub.prepare(
    `SELECT platform, COUNT(*) AS n FROM messaging_messages WHERE user = ? GROUP BY platform`
  ).all(user);
  const linkedin = hub.prepare(
    `SELECT status, COUNT(*) AS n FROM linkedin_posts WHERE user = ? GROUP BY status`
  ).all(user);

  return {
    emails,
    inbound: inbound.map(r => ({ source: r.source, n: r.n })),
    documents: count(hub, `SELECT COUNT(*) AS n FROM documents WHERE user = ?`, user),
    meetings: meetings.map(r => ({ source: r.source, n: r.n })),
    intakes: intakes.map(r => ({ status: r.status, n: r.n })),
    messaging: messaging.map(r => ({ platform: r.platform, n: r.n })),
    rssArticles: count(hub, `SELECT COUNT(*) AS n FROM rss_articles WHERE user = ?`, user),
    intelItems: count(hub, `SELECT COUNT(*) AS n FROM intel_items WHERE user = ?`, user),
    flights: count(hub, `SELECT COUNT(*) AS n FROM flights WHERE user = ?`, user),
    linkedin: linkedin.map(r => ({ status: r.status, n: r.n })),
    debriefSessions: count(hub, `SELECT COUNT(*) AS n FROM debrief_sessions WHERE user = ?`, user),
  };
}

function peopleOverview(user) {
  const hub = db.hub();
  const contacts = count(hub, `SELECT COUNT(*) AS n FROM contacts WHERE user = ?`, user);
  const companies = count(hub, `SELECT COUNT(*) AS n FROM companies WHERE user = ?`, user);
  const attendeeLinks = count(hub, `
    SELECT COUNT(*) AS n
    FROM meeting_attendees ma JOIN meetings m ON m.id = ma.meeting_id
    WHERE m.user = ?
  `, user);
  const peopleMet = count(hub, `
    SELECT COUNT(*) AS n FROM (
      SELECT DISTINCT ma.contact_id
      FROM meeting_attendees ma JOIN meetings m ON m.id = ma.meeting_id
      WHERE m.user = ? AND m.source = 'calendar'
    )
  `, user);
  const upcoming = hub.prepare(`
    SELECT id, title, meeting_date, meeting_time, duration_mins, location, company_id
    FROM meetings
    WHERE user = ? AND meeting_date >= ?
    ORDER BY meeting_date ASC, meeting_time ASC
    LIMIT 8
  `).all(user, dublinDayKey(0));
  return { contacts, companies, attendeeLinks, peopleMet, upcoming };
}

function taskOverview(user) {
  const hub = db.hub();
  const byStatus = hub.prepare(`
    SELECT status, COUNT(*) AS n FROM google_tasks
    WHERE user = ? AND deleted_at IS NULL
    GROUP BY status
  `).all(user);
  const totals = byStatus.reduce((acc, r) => {
    acc[r.status] = r.n;
    acc.total += r.n;
    return acc;
  }, { total: 0 });
  return { byStatus, totals };
}

function knowledgeOverview(user) {
  const hub = db.hub();
  const byStatus = hub.prepare(`
    SELECT status, COUNT(*) AS n FROM knowledge_atoms WHERE user = ? GROUP BY status
  `).all(user);
  const bySubject = hub.prepare(`
    SELECT subject_kind, COUNT(*) AS n FROM knowledge_atoms WHERE user = ? GROUP BY subject_kind
  `).all(user);
  const health = getCrmKnowledgeHealth(user);
  return { byStatus, bySubject, health };
}

function buildCrmActivity(user) {
  const ingest = admissionHealth(user, { sinceSeconds: DAY });
  const effects = effectHealth(user, { sinceSeconds: DAY });
  const today = dublinDayKey(0);
  const content = contentInventory(user);

  // Today's meetings count (calendar-day, from the meetings cache).
  const todayMeetings = content.meetings.length
    ? count(db.hub(), `
        SELECT COUNT(*) AS n FROM meetings WHERE user = ? AND meeting_date = ?
      `, user, today)
    : 0;

  return {
    user,
    today,
    ingest,
    effects,
    trend: ingestTrend(user, 14),
    funnel: pipelineFunnel(user),
    content,
    todayMeetings,
    people: peopleOverview(user),
    tasks: taskOverview(user),
    knowledge: knowledgeOverview(user),
  };
}

module.exports = { buildCrmActivity, ingestTrend, pipelineFunnel, contentInventory, peopleOverview, taskOverview, knowledgeOverview };
