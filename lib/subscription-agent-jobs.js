'use strict';

// Durable pull queue for subscription work. The VPS prepares source-backed
// evidence packages; the Mac mini claims them and returns only model output.
// Generic features store raw output for the waiter; named synthesis features
// keep their specialised complete handlers.

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');
const { isKnownFeature, resolveFeatureRunner } = require('./feature-runners');

// Version Old's briefing features had bespoke complete handlers; after the
// retool every job is raw output for a waiter.
const SPECIAL_COMPLETE = new Set();

const STALE_SEC = 15 * 60;
const DEFAULT_WAIT_POLL_MS = 1500;

function enabled() {
  return process.env.SUBSCRIPTION_AGENT_WORKER_ENABLED === '1'
    || process.env.SUBSCRIPTION_AGENT_WORKER_ENABLED === 'true';
}

function secretConfigured() {
  return !!String(process.env.SUBSCRIPTION_AGENT_WORKER_SECRET || '').trim();
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function recoverStaleClaims(ts = now()) {
  return db.hub().prepare(`
    UPDATE subscription_agent_jobs
       SET status = 'pending', claim_token = NULL, claimed_at = NULL, claimed_by = NULL,
           error = COALESCE(error || ' | ', '') || 'claim expired; re-queued', updated_at = ?
     WHERE status = 'claimed' AND claimed_at < ?
  `).run(ts, ts - STALE_SEC).changes;
}

function featureAllowed(feature) {
  if (SPECIAL_COMPLETE.has(feature)) return true;
  if (isKnownFeature(feature)) return true;
  // Generic model-object / model-text jobs use the feature key from the caller.
  return /^[a-z0-9][a-z0-9_./-]{0,80}$/i.test(String(feature || ''));
}

function enqueue({ feature, dedupeKey, payload, mode = null }) {
  if (!featureAllowed(feature)) throw new Error(`Unsupported subscription feature: ${feature}`);
  const hub = db.hub();
  const key = String(dedupeKey || '').slice(0, 160);
  if (!key) throw new Error('subscription job dedupeKey is required');

  const existing = hub.prepare(`
    SELECT id, status FROM subscription_agent_jobs
     WHERE feature = ? AND dedupe_key = ? AND status IN ('pending', 'claimed')
     ORDER BY created_at DESC LIMIT 1
  `).get(feature, key);
  if (existing) return { queued: true, existing: true, jobId: existing.id, status: existing.status };

  const id = uuid();
  const ts = now();
  const body = { ...(payload || {}), mode: mode || payload?.mode || (SPECIAL_COMPLETE.has(feature) ? 'apply' : 'raw_output') };
  // The choices on /models ride with the job; lane 1 also fills the old single-model
  // fields so a worker that predates lanes still runs the main choice.
  const route = require('./model-routes').forJob(feature, body);
  if (route?.lanes.length) {
    const [main] = route.lanes;
    Object.assign(body, { fn: route.fn, lanes: route.lanes, runner: main.runner, model: main.model, effort: main.effort });
  }
  // Bound packet size — never enqueue unbounded corpus dumps.
  const serialised = JSON.stringify(body);
  // A banking screenshot or set of listing photos travels as base64 inside the packet.
  const cap = ['crm_money_read', 'crm_house_photos'].includes(feature) ? 4_500_000 : 1_500_000;
  if (serialised.length > cap) {
    throw new Error(`subscription job payload too large (${serialised.length} bytes; max ${cap / 1e6}MB)`);
  }
  hub.prepare(`INSERT INTO subscription_agent_jobs
    (id, feature, dedupe_key, payload, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, feature, key, serialised, ts, ts);
  return { queued: true, existing: false, jobId: id, status: 'pending' };
}

// Priority tiers for the single-lane Mac worker (lower claims first):
// 10 = interactive (site chat, Search ask, on-demand reports)
// 20 = time-critical morning (today's meeting prep, 06:45 narrative digests)
// 30 = fresh capture & immediate actions (new sources, follow-ups, promises, task sizing)
// 50 = enrichment & background (task/job help, standings, briefing, money, house, boox, connections)
function priorityFor(feature, payload = null) {
  const f = String(feature || '');
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  if (f === 'chat' || f === 'hub_chat' || f.startsWith('hub_chat_')) return 10;
  if (f === 'crm_ask' || meta.ask) return 10;
  if (f === 'crm_report' && !meta.digest) return 10;
  if (f === 'crm_house_daft_fetch' || f === 'crm_house_daft_sold') return 12;
  if (f === 'crm_house_photos') return 15;
  if (f === 'crm_meeting_prep' || meta.meeting) return 20;
  if (f === 'crm_report' && meta.digest) return 20;
  if (f === 'crm_atomise' && !meta.isHistory && (meta.sourceId || meta.followups || meta.promiseClassify || meta.promiseCheck || meta.taskLength)) return 30;
  return 50;
}

function hasHighPriorityPending(maxPriority = 29) {
  const rows = db.hub().prepare(`SELECT feature, payload FROM subscription_agent_jobs WHERE status='pending'`).all();
  for (const r of rows) {
    if (priorityFor(r.feature, safeJson(r.payload)) <= maxPriority) return true;
  }
  return false;
}

function claim({ workerId = 'mac', limit = 1, maxPriority = null, minPriority = null, available = null, capabilities = null } = {}) {
  const hub = db.hub();
  const ts = now();
  require('./model-routes').seen(workerId, available, ts);
  recoverStaleClaims(ts);
  const jobs = [];
  const maxP = Number.isFinite(Number(maxPriority)) && Number(maxPriority) > 0 ? Number(maxPriority) : null;
  const minP = Number.isFinite(Number(minPriority)) && Number(minPriority) > 0 ? Number(minPriority) : null;
  const capSet = new Set((Array.isArray(capabilities) ? capabilities : []).map(c => String(c || '').trim().toLowerCase()).filter(Boolean));
  // One job at a time by default — no uncontrolled parallel corpus processing.
  const take = Math.max(1, Math.min(1, Number(limit) || 1));
  for (let n = 0; n < take; n++) {
    let candidates = hub.prepare(`SELECT * FROM subscription_agent_jobs WHERE status='pending' ORDER BY created_at LIMIT 50`).all()
      .map(row => {
        const payload = safeJson(row.payload);
        return { row, payload, prio: priorityFor(row.feature, payload) };
      })
      .filter(c => {
        const reqCap = String(c.payload?.requiresWorkerCapability || '').trim().toLowerCase();
        return !reqCap || capSet.has(reqCap);
      });
    if (maxP !== null) candidates = candidates.filter(c => c.prio <= maxP);
    if (minP !== null) candidates = candidates.filter(c => c.prio >= minP);
    if (!candidates.length) break;
    candidates.sort((a, b) => a.prio - b.prio || a.row.created_at - b.row.created_at);
    const row = candidates[0].row;
    const token = uuid();
    const changed = hub.prepare(`
      UPDATE subscription_agent_jobs
         SET status='claimed', claim_token=?, claimed_at=?, claimed_by=?, attempts=attempts+1, updated_at=?
       WHERE id=? AND status='pending'
    `).run(token, ts, String(workerId).slice(0, 80), ts, row.id).changes;
    if (!changed) continue;
    jobs.push({ id: row.id, feature: row.feature, claim_token: token, payload: JSON.parse(row.payload) });
  }
  return { ok: true, jobs };
}

function claimed(id, token) {
  const row = db.hub().prepare(`SELECT * FROM subscription_agent_jobs WHERE id=?`).get(String(id || ''));
  if (!row) return { ok: false, status: 404, error: 'job not found' };
  if (row.status !== 'claimed' || !token || row.claim_token !== String(token)) {
    return { ok: false, status: 403, error: 'invalid or expired claim' };
  }
  return { ok: true, row };
}

function getJob(jobId) {
  const row = db.hub().prepare(`SELECT * FROM subscription_agent_jobs WHERE id=?`).get(String(jobId || ''));
  if (!row) return null;
  return {
    id: row.id,
    feature: row.feature,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    result: row.result_json ? safeJson(row.result_json) : null,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { raw: s }; }
}

async function complete({ jobId, claimToken, output, meta = null }) {
  const loaded = claimed(jobId, claimToken);
  if (!loaded.ok) return loaded;
  const { row } = loaded;
  const payload = JSON.parse(row.payload);
  const mode = payload.mode || (SPECIAL_COMPLETE.has(row.feature) ? 'apply' : 'raw_output');

  void mode;
  const result = {
    output: String(output || ''),
    meta: meta || null,
    feature: row.feature,
    completed_at: now(),
  };

  db.hub().prepare(`
    UPDATE subscription_agent_jobs
       SET status='completed', claim_token=NULL, completed_at=?, updated_at=?, result_json=?, error=NULL
     WHERE id=? AND claim_token=?
  `).run(now(), now(), JSON.stringify(result), row.id, String(claimToken));
  return { ok: true, jobId: row.id, result };
}

function fail({ jobId, claimToken, error }) {
  const loaded = claimed(jobId, claimToken);
  if (!loaded.ok) return loaded;
  const ts = now();
  const attempts = Number(loaded.row.attempts || 1);
  const feature = loaded.row.feature;
  const payload = safeJson(loaded.row.payload);
  const runner = resolveFeatureRunner(feature);
  const overrideAttempts = Number(payload?.maxAttempts);
  const maxAttempts = Number.isInteger(overrideAttempts) && overrideAttempts >= 1
    ? overrideAttempts
    : Math.max(1, Number(runner.retries || 2));
  const status = attempts >= maxAttempts ? 'failed' : 'pending';
  db.hub().prepare(`
    UPDATE subscription_agent_jobs
       SET status=?, claim_token=NULL, claimed_at=NULL, claimed_by=NULL, completed_at=?, updated_at=?, error=?
     WHERE id=? AND claim_token=?
  `).run(
    status,
    status === 'failed' ? ts : null,
    ts,
    String(error || 'worker failed').slice(0, 1000),
    loaded.row.id,
    String(claimToken),
  );
  return { ok: true, jobId: loaded.row.id, status };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enqueue a raw-output job and wait for the Mac worker (or a local force-run).
 * Retries reuse the same immutable packet (same dedupe key / payload).
 * Never broadens scope and never falls back to OpenRouter.
 */
async function enqueueAndWait({
  feature,
  systemPrompt,
  userPrompt,
  timeoutMs,
  meta = null,
  dedupeKey = null,
} = {}) {
  const runner = resolveFeatureRunner(feature);
  const limit = timeoutMs || runner.timeoutMs || 180000;
  const key = dedupeKey || `wait:${feature}:${crypto.createHash('sha256')
    .update(String(systemPrompt || '') + '\0' + String(userPrompt || ''))
    .digest('hex')
    .slice(0, 40)}`;

  const payload = {
    mode: 'raw_output',
    systemPrompt: String(systemPrompt || ''),
    userPrompt: String(userPrompt || ''),
    meta: meta || null,
    runner: runner.runner,
    model: runner.model,
    effort: runner.effort,
    tier: runner.tier,
    maxInputChars: runner.maxInputChars,
    maxEvidenceRecords: runner.maxEvidenceRecords,
  };

  const queued = enqueue({ feature, dedupeKey: key, payload, mode: 'raw_output' });
  const started = Date.now();

  while (Date.now() - started < limit) {
    const job = getJob(queued.jobId);
    if (!job) throw new Error(`subscription job ${queued.jobId} disappeared`);
    if (job.status === 'completed') {
      const output = job.result?.output;
      if (output == null || output === '') throw new Error(`subscription job ${queued.jobId} completed with empty output`);
      return {
        text: String(output),
        runner: job.result?.meta?.runner || runner.runner,
        model: job.result?.meta?.model || runner.model,
        effort: job.result?.meta?.effort || runner.effort,
        tier: runner.tier,
        durationMs: Date.now() - started,
        jobId: queued.jobId,
        remote: true,
      };
    }
    if (job.status === 'failed') {
      throw new Error(job.error || `subscription job ${queued.jobId} failed`);
    }
    await sleep(DEFAULT_WAIT_POLL_MS);
  }
  throw new Error(`subscription job ${queued.jobId} timed out after ${limit}ms waiting for Mac worker`);
}

async function enqueueWorkerTask({ feature, dedupeKey, payload, timeoutMs = 35000, pollMs = 500 } = {}) {
  const queued = enqueue({ feature, dedupeKey, payload: { ...(payload || {}), maxAttempts: payload?.maxAttempts ?? 1 }, mode: 'raw_output' });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = getJob(queued.jobId);
    if (!job) throw new Error(`worker job ${queued.jobId} disappeared`);
    if (job.status === 'completed') {
      return { output: String(job.result?.output || ''), meta: job.result?.meta || null, jobId: queued.jobId };
    }
    if (job.status === 'failed') {
      throw new Error(job.error || `worker job ${queued.jobId} failed`);
    }
    await sleep(pollMs);
  }
  throw new Error(`Home worker did not answer within ${Math.round(timeoutMs / 1000)}s — check dev-server fast worker and try again.`);
}

function queueStats() {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT status, COUNT(*) AS n FROM subscription_agent_jobs GROUP BY status
  `).all();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = r.n;
  const pending = hub.prepare(
    "SELECT COUNT(*) AS n FROM subscription_agent_jobs WHERE status IN ('pending','claimed')"
  ).get().n;
  return { byStatus, pending };
}

module.exports = {
  enabled,
  secretConfigured,
  enqueue,
  claim,
  complete,
  fail,
  recoverStaleClaims,
  getJob,
  enqueueAndWait,
  enqueueWorkerTask,
  queueStats,
  priorityFor,
  hasHighPriorityPending,
  SPECIAL_COMPLETE,
  featureAllowed,
};
