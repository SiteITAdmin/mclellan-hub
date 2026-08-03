'use strict';

/**
 * The external-effect gate.
 *
 * Reading fans out; writing must not. About a dozen call sites create Google
 * Tasks — the CRM engine, Mycelium, the suggestion engine, both email
 * processors, meeting intake, three route files, and a briefing build script.
 * Each was individually reasonable and none could see the others, which is how
 * on 3 August a briefing script turned Nakai's Rolling Watchlist into eight
 * tasks in Douglas's list and nothing noticed until he read them.
 *
 * The fix is not another wrapper that callers must remember to use — that
 * recreates the same problem, since nothing would oblige them. This records
 * from inside `createTask` itself, the one function every caller already goes
 * through, so a new call site is traced whether or not its author knew this
 * file existed.
 *
 * It deliberately does not block. A wrong refusal costs Douglas a task he
 * needed, which is worse than a task he has to delete; so the gate observes,
 * attributes, and escalates loudly, and leaves blocking to the boundary rules
 * that own the specific decision (isCanonicalEvidenceExcluded and friends).
 */

const db = require('./db');
const { uuid } = require('./id');

const EFFECT_STAGE = 'external_effect';
// One origin producing more than this many tasks inside the window is the
// flood signature: the Nakai incident was eight tasks from one briefing pass.
const FLOOD_THRESHOLD = 5;
const FLOOD_WINDOW_SECONDS = 120;

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * Record one attempted external effect. Never throws: an effect that happened
 * must not be lost because its receipt could not be written.
 */
function recordEffect(user, {
  effect = 'google_task',
  origin = null,
  source = 'manual',
  sourceId = null,
  title = '',
  outcome = 'created',
  reason = null,
  externalId = null,
} = {}) {
  try {
    const normalisedUser = String(user || '').trim();
    if (!normalisedUser) return null;
    // An undeclared origin falls back to the free-text `source` every caller
    // already passes, and is marked so the remaining callers stay visible
    // rather than being silently counted as attributed.
    const declared = Boolean(origin);
    const resolvedOrigin = String(origin || source || 'unknown');
    const id = uuid();
    db.hub().prepare(`
      INSERT INTO knowledge_receipts
        (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(
      id, normalisedUser, `effect:${effect}`, sourceId ? String(sourceId) : `${resolvedOrigin}:unsourced`,
      EFFECT_STAGE, outcome === 'created' ? 'done' : outcome === 'refused' ? 'skipped' : 'error',
      `${resolvedOrigin} ${outcome} ${effect}: ${String(title || '').slice(0, 120)}`,
      JSON.stringify({
        effect,
        origin: resolvedOrigin,
        origin_declared: declared,
        source: String(source || 'manual'),
        source_id: sourceId ? String(sourceId) : null,
        title: String(title || '').slice(0, 300),
        outcome,
        reason: reason ? String(reason).slice(0, 300) : null,
        external_id: externalId ? String(externalId) : null,
      }),
      now(),
    );
    return id;
  } catch (error) {
    console.error('[effect-gate] failed to record effect:', error.message);
    return null;
  }
}

/**
 * Has this origin just produced a burst of tasks? Returns null when it hasn't.
 * Called after the effect is recorded, so the current one is included.
 */
function detectFlood(user, origin, { windowSeconds = FLOOD_WINDOW_SECONDS, threshold = FLOOD_THRESHOLD } = {}) {
  try {
    const since = now() - Math.max(10, Number(windowSeconds) || FLOOD_WINDOW_SECONDS);
    const rows = db.hub().prepare(`
      SELECT payload FROM knowledge_receipts
      WHERE user = ? AND stage = ? AND created_at >= ?
    `).all(user, EFFECT_STAGE, since);
    const count = rows.filter(row => {
      const payload = parseJson(row.payload);
      return payload.origin === origin && payload.outcome === 'created';
    }).length;
    if (count <= threshold) return null;
    return { origin, count, windowSeconds };
  } catch (_) {
    return null;
  }
}

/**
 * Every external effect in the window, grouped by who caused it. This is what
 * makes "why did this task appear?" a question with one place to look.
 */
function effectHealth(user, { sinceSeconds = 86400, database = null } = {}) {
  const hub = database || db.hub();
  const since = now() - Math.max(60, Number(sinceSeconds) || 86400);
  const rows = hub.prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND stage = ? AND created_at >= ?
    ORDER BY created_at ASC
  `).all(user, EFFECT_STAGE, since);

  const byOrigin = new Map();
  let unattributed = 0;
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const key = String(payload.origin || 'unknown');
    if (!payload.origin_declared) unattributed += 1;
    const entry = byOrigin.get(key)
      || { origin: key, created: 0, refused: 0, failed: 0, declared: Boolean(payload.origin_declared), titles: [] };
    if (payload.outcome === 'created') {
      entry.created += 1;
      if (entry.titles.length < 5) entry.titles.push(payload.title);
    } else if (payload.outcome === 'refused') entry.refused += 1;
    else entry.failed += 1;
    byOrigin.set(key, entry);
  }

  const origins = [...byOrigin.values()].sort((a, b) => b.created - a.created);
  const totals = origins.reduce((acc, entry) => ({
    created: acc.created + entry.created,
    refused: acc.refused + entry.refused,
    failed: acc.failed + entry.failed,
  }), { created: 0, refused: 0, failed: 0 });

  return { since, totals, origins, unattributed };
}

module.exports = {
  EFFECT_STAGE,
  FLOOD_THRESHOLD,
  FLOOD_WINDOW_SECONDS,
  recordEffect,
  detectFlood,
  effectHealth,
};
