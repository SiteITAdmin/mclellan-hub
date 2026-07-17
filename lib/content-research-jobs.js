'use strict';

// Remote content-research job queue for the Mac pull-worker.
// VPS enqueues when CONTENT_RESEARCH_DRIVER=mac; the always-on Mac mini
// claims jobs, runs Grok+last30days locally, and posts suggestions back.

const db = require('./db');
const { uuid } = require('./id');
const { replaceSuggestions, normalizeTone, researchViaWebSearch } = require('./content-research-core');

const VALID_STATUS = new Set(['pending', 'claimed', 'completed', 'failed', 'fallback']);

function claimStaleSec() {
  const n = Number(process.env.CONTENT_RESEARCH_CLAIM_STALE_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 45 * 60;
}

function fallbackAfterSec() {
  const n = Number(process.env.CONTENT_RESEARCH_FALLBACK_AFTER_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2 * 60 * 60;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function workerSecretConfigured() {
  return !!String(process.env.CONTENT_RESEARCH_WORKER_SECRET || '').trim();
}

function useMacWorkerDriver() {
  return process.env.CONTENT_RESEARCH_DRIVER === 'mac';
}

function ensureTable() {
  // Table is created in db.js init; this is a no-op safety for tests that
  // import this module before hub() migrations run.
  db.hub();
}

function parseTopicContext(raw) {
  if (!raw) return { description: '', searchQuery: '' };
  if (typeof raw === 'object') {
    return {
      description: String(raw.description || '').trim().slice(0, 600),
      searchQuery: String(raw.searchQuery || '').trim().slice(0, 300),
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      description: String(parsed?.description || '').trim().slice(0, 600),
      searchQuery: String(parsed?.searchQuery || '').trim().slice(0, 300),
    };
  } catch {
    return { description: '', searchQuery: '' };
  }
}

function serializeTopicContext(ctx) {
  const description = String(ctx?.description || '').trim().slice(0, 600);
  const searchQuery = String(ctx?.searchQuery || '').trim().slice(0, 300);
  if (!description && !searchQuery) return null;
  return JSON.stringify({ description, searchQuery });
}

function rowToJob(row) {
  if (!row) return null;
  const topicContext = parseTopicContext(row.topic_context);
  return {
    id: row.id,
    user: row.user,
    plan_date: row.plan_date,
    topic: row.topic,
    tone: row.tone,
    limit_n: row.limit_n,
    topic_context: topicContext,
    description: topicContext.description,
    searchQuery: topicContext.searchQuery,
    status: row.status,
    claim_token: row.claim_token || null,
    claimed_at: row.claimed_at || null,
    claimed_by: row.claimed_by || null,
    completed_at: row.completed_at || null,
    error: row.error || null,
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Recover claims whose worker died mid-run; re-queue as pending. */
function recoverStaleClaims({ now = nowSec() } = {}) {
  ensureTable();
  const hub = db.hub();
  const cutoff = now - claimStaleSec();
  const result = hub.prepare(`
    UPDATE content_research_jobs
    SET status = 'pending',
        claim_token = NULL,
        claimed_at = NULL,
        claimed_by = NULL,
        error = COALESCE(error, '') || CASE WHEN error IS NULL OR error = '' THEN '' ELSE ' | ' END || 'claim expired; re-queued',
        updated_at = ?
    WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?
  `).run(now, cutoff);
  return { requeued: result.changes };
}

/**
 * Enqueue research for the Mac worker. Idempotent while a pending/claimed
 * job already exists for the same user+date+topic+tone.
 */
function enqueueContentResearchJob(user, {
  planDate,
  topic,
  tone = 'professional',
  limit = 3,
  topicContext = null,
  description = '',
  searchQuery = '',
} = {}) {
  ensureTable();
  const hub = db.hub();
  const cleanUser = String(user || '').trim();
  const cleanDate = String(planDate || '').slice(0, 10);
  const cleanTopic = String(topic || '').trim().slice(0, 80);
  const cleanTone = normalizeTone(tone);
  const limitN = Math.max(1, Math.min(10, Number(limit) || 3));
  const ctxJson = serializeTopicContext(topicContext || { description, searchQuery });

  if (!cleanUser || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate) || !cleanTopic) {
    return { ok: false, error: 'invalid user/date/topic' };
  }

  const existing = hub.prepare(`
    SELECT * FROM content_research_jobs
    WHERE user = ? AND plan_date = ? AND topic = ? AND tone = ?
      AND status IN ('pending', 'claimed')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(cleanUser, cleanDate, cleanTopic, cleanTone);

  if (existing) {
    // Backfill topic_context on an already-queued job if it was enqueued
    // before taxonomy context was available.
    if (ctxJson && !existing.topic_context) {
      hub.prepare(`
        UPDATE content_research_jobs SET topic_context = ?, updated_at = ?
        WHERE id = ?
      `).run(ctxJson, nowSec(), existing.id);
    }
    return { ok: true, queued: true, jobId: existing.id, existing: true, status: existing.status };
  }

  const id = uuid();
  const ts = nowSec();
  hub.prepare(`
    INSERT INTO content_research_jobs
      (id, user, plan_date, topic, tone, limit_n, topic_context, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, cleanUser, cleanDate, cleanTopic, cleanTone, limitN, ctxJson, ts, ts);

  return { ok: true, queued: true, jobId: id, existing: false, status: 'pending' };
}

/**
 * Claim up to `limit` oldest pending jobs for the Mac worker.
 */
function claimContentResearchJobs({ workerId = 'mac', limit = 1, now = nowSec() } = {}) {
  ensureTable();
  recoverStaleClaims({ now });
  const hub = db.hub();
  const take = Math.max(1, Math.min(10, Number(limit) || 1));
  const claimed = [];

  const claimOne = hub.transaction(() => {
    const row = hub.prepare(`
      SELECT * FROM content_research_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `).get();
    if (!row) return null;
    const token = uuid();
    hub.prepare(`
      UPDATE content_research_jobs
      SET status = 'claimed',
          claim_token = ?,
          claimed_at = ?,
          claimed_by = ?,
          attempts = attempts + 1,
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(token, now, String(workerId || 'mac').slice(0, 80), now, row.id);
    const updated = hub.prepare('SELECT * FROM content_research_jobs WHERE id = ?').get(row.id);
    return updated;
  });

  for (let i = 0; i < take; i++) {
    const row = claimOne();
    if (!row) break;
    // Don't send claim_token twice in two fields — include it once for the worker.
    claimed.push(rowToJob(row));
  }

  return { ok: true, jobs: claimed };
}

function loadClaimedJob(jobId, claimToken) {
  ensureTable();
  const hub = db.hub();
  const row = hub.prepare('SELECT * FROM content_research_jobs WHERE id = ?').get(String(jobId || ''));
  if (!row) return { ok: false, error: 'job not found', status: 404 };
  if (row.status !== 'claimed') return { ok: false, error: `job is ${row.status}, not claimed`, status: 409 };
  if (!claimToken || row.claim_token !== String(claimToken)) {
    return { ok: false, error: 'invalid claim_token', status: 403 };
  }
  return { ok: true, row };
}

function completeContentResearchJob({ jobId, claimToken, suggestions = [] } = {}) {
  const loaded = loadClaimedJob(jobId, claimToken);
  if (!loaded.ok) return loaded;
  const { row } = loaded;
  const list = Array.isArray(suggestions) ? suggestions : [];
  if (!list.length) {
    return { ok: false, error: 'suggestions array required', status: 400 };
  }

  const normalized = list.slice(0, Math.max(1, row.limit_n || 3)).map((s) => ({
    id: s.id || uuid(),
    plan_date: row.plan_date,
    topic: row.topic,
    tone: row.tone,
    title: String(s.title || '').trim().slice(0, 120),
    summary: String(s.summary || '').trim().slice(0, 400),
    source_url: s.source_url || null,
    source_title: s.source_title || null,
    source_provider: s.source_provider || 'grok+last30days',
    source_json: typeof s.source_json === 'string' ? s.source_json : JSON.stringify(s.source_json || s),
    researched_at: s.researched_at || nowSec(),
  })).filter((s) => s.title);

  if (!normalized.length) {
    return { ok: false, error: 'no valid suggestions (each needs a title)', status: 400 };
  }

  const ts = nowSec();
  const hub = db.hub();
  const tx = hub.transaction(() => {
    const count = replaceSuggestions(row.user, {
      planDate: row.plan_date,
      topic: row.topic,
      tone: row.tone,
      suggestions: normalized,
    });
    hub.prepare(`
      UPDATE content_research_jobs
      SET status = 'completed',
          claim_token = NULL,
          completed_at = ?,
          error = NULL,
          result_json = ?,
          updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_token = ?
    `).run(ts, JSON.stringify({ count, titles: normalized.map((s) => s.title) }), ts, row.id, String(claimToken));
    return count;
  });
  const count = tx();
  return { ok: true, count, jobId: row.id };
}

function failContentResearchJob({ jobId, claimToken, error = 'worker failed' } = {}) {
  const loaded = loadClaimedJob(jobId, claimToken);
  if (!loaded.ok) return loaded;
  const { row } = loaded;
  const ts = nowSec();
  const msg = String(error || 'worker failed').slice(0, 1000);
  const hub = db.hub();

  // After 3 attempts leave failed so fallback can take over; otherwise re-queue.
  const nextStatus = (row.attempts || 1) >= 3 ? 'failed' : 'pending';
  hub.prepare(`
    UPDATE content_research_jobs
    SET status = ?,
        claim_token = NULL,
        claimed_at = NULL,
        claimed_by = NULL,
        error = ?,
        completed_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
        updated_at = ?
    WHERE id = ? AND status = 'claimed' AND claim_token = ?
  `).run(nextStatus, msg, nextStatus, ts, ts, row.id, String(claimToken));

  return { ok: true, jobId: row.id, status: nextStatus };
}

/**
 * Pending/failed jobs older than the fallback window get the thin web-search
 * path so Douglas still gets suggestions if the Mac is offline.
 */
async function fallbackStaleRemoteJobs({ now = nowSec() } = {}) {
  ensureTable();
  recoverStaleClaims({ now });
  const hub = db.hub();
  const cutoff = now - fallbackAfterSec();
  const rows = hub.prepare(`
    SELECT * FROM content_research_jobs
    WHERE status IN ('pending', 'failed')
      AND created_at < ?
    ORDER BY created_at ASC
    LIMIT 20
  `).all(cutoff);

  const results = [];
  for (const row of rows) {
    try {
      const web = await researchViaWebSearch(row.user, {
        planDate: row.plan_date,
        topic: row.topic,
        tone: row.tone,
        limit: row.limit_n || 3,
      });
      const ts = nowSec();
      hub.prepare(`
        UPDATE content_research_jobs
        SET status = 'fallback',
            claim_token = NULL,
            completed_at = ?,
            error = ?,
            result_json = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        ts,
        `web fallback after ${fallbackAfterSec()}s without Mac completion`,
        JSON.stringify({ count: web.count, provider: web.provider || 'web' }),
        ts,
        row.id,
      );
      results.push({ id: row.id, ok: true, count: web.count, driver: 'web_fallback' });
    } catch (err) {
      console.error('[content-research-jobs] fallback failed for', row.id, err.message);
      results.push({ id: row.id, ok: false, error: err.message });
    }
  }
  return { ok: true, processed: results.length, results };
}

/** Open (pending/claimed) research jobs for a user, for the Plan page's
 *  "Researching…" indicators and status polling. */
function openJobsForUser(user) {
  ensureTable();
  return db.hub().prepare(`
    SELECT id, plan_date, topic, tone, status, created_at
    FROM content_research_jobs
    WHERE user = ? AND status IN ('pending', 'claimed')
    ORDER BY created_at ASC
  `).all(String(user || ''));
}

function recordWorkerHeartbeat({ workerId = 'mac', detail = null } = {}) {
  ensureTable();
  const hub = db.hub();
  const payload = JSON.stringify({
    worker_id: String(workerId || 'mac').slice(0, 80),
    at: nowSec(),
    detail: detail || null,
  });
  const existing = hub.prepare(
    "SELECT id FROM crm_context WHERE user = 'system' AND key = 'content_research_worker_heartbeat'"
  ).get();
  if (existing) {
    hub.prepare('UPDATE crm_context SET value = ? WHERE id = ?').run(payload, existing.id);
  } else {
    hub.prepare(
      "INSERT INTO crm_context (id, user, key, value) VALUES (?, 'system', 'content_research_worker_heartbeat', ?)"
    ).run(uuid(), payload);
  }
  return { ok: true };
}

function getWorkerHeartbeat() {
  ensureTable();
  const hub = db.hub();
  const row = hub.prepare(
    "SELECT value, created_at FROM crm_context WHERE user = 'system' AND key = 'content_research_worker_heartbeat'"
  ).get();
  if (!row) return null;
  try {
    return { ...JSON.parse(row.value), updated_at: row.created_at };
  } catch {
    return { raw: row.value, updated_at: row.created_at };
  }
}

function jobStats({ now = nowSec() } = {}) {
  ensureTable();
  const hub = db.hub();
  const since = now - 48 * 3600;
  const byStatus = {};
  for (const r of hub.prepare(`
    SELECT status, COUNT(*) AS n FROM content_research_jobs
    WHERE created_at >= ? GROUP BY status
  `).all(since)) {
    byStatus[r.status] = r.n;
  }
  const pending = hub.prepare(
    "SELECT COUNT(*) AS n FROM content_research_jobs WHERE status IN ('pending','claimed')"
  ).get().n;
  const heartbeat = getWorkerHeartbeat();
  return { byStatus, pending, heartbeat, claimStaleSec: claimStaleSec(), fallbackAfterSec: fallbackAfterSec() };
}

/** Health warnings for the daily system report (empty array = healthy). */
function contentResearchHealthWarnings({ now = nowSec() } = {}) {
  if (!useMacWorkerDriver()) return [];
  const warnings = [];
  if (!workerSecretConfigured()) {
    warnings.push('Content research (mac driver): CONTENT_RESEARCH_WORKER_SECRET is not set — Mac worker cannot claim jobs');
  }
  const stats = jobStats({ now });
  const hb = stats.heartbeat;
  if (!hb?.at) {
    warnings.push('Content research (mac driver): Mac worker has never heartbeated — install/run content-research-worker on the Mac mini');
  } else if (now - hb.at > 30 * 60) {
    const mins = Math.round((now - hb.at) / 60);
    warnings.push(`Content research (mac driver): Mac worker last heartbeat ${mins}m ago — worker may be down`);
  }
  const oldPending = db.hub().prepare(`
    SELECT COUNT(*) AS n FROM content_research_jobs
    WHERE status IN ('pending','claimed') AND created_at < ?
  `).get(now - fallbackAfterSec()).n;
  if (oldPending > 0) {
    warnings.push(`Content research: ${oldPending} job(s) still open past fallback window — check Mac worker / fallback path`);
  }
  return warnings;
}

module.exports = {
  useMacWorkerDriver,
  workerSecretConfigured,
  openJobsForUser,
  enqueueContentResearchJob,
  claimContentResearchJobs,
  completeContentResearchJob,
  failContentResearchJob,
  recoverStaleClaims,
  fallbackStaleRemoteJobs,
  recordWorkerHeartbeat,
  getWorkerHeartbeat,
  jobStats,
  contentResearchHealthWarnings,
  claimStaleSec,
  fallbackAfterSec,
};
