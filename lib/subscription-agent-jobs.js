'use strict';

// Durable pull queue for subscription work. The VPS prepares source-backed
// evidence packages; the Mac mini claims them and returns only model output.
// Generic features store raw output for the waiter; named synthesis features
// keep their specialised complete handlers.

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');
const { isKnownFeature, resolveFeatureRunner } = require('./feature-runners');

const SPECIAL_COMPLETE = new Set([
  'nakai_daily_briefing',
  'm365_daily_briefing',
  'us_block_special_briefing',
  'newsletter_digest_briefing',
  'nakai_briefing_quality_review',
  'cross_entity_synthesis',
]);

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
  // Bound packet size — never enqueue unbounded corpus dumps.
  const serialised = JSON.stringify(body);
  if (serialised.length > 1_500_000) {
    throw new Error(`subscription job payload too large (${serialised.length} bytes; max 1.5MB)`);
  }
  hub.prepare(`INSERT INTO subscription_agent_jobs
    (id, feature, dedupe_key, payload, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, feature, key, serialised, ts, ts);
  return { queued: true, existing: false, jobId: id, status: 'pending' };
}

function claim({ workerId = 'mac', limit = 1 } = {}) {
  const hub = db.hub();
  const ts = now();
  recoverStaleClaims(ts);
  const jobs = [];
  // One job at a time by default — no uncontrolled parallel corpus processing.
  const take = Math.max(1, Math.min(1, Number(limit) || 1));
  for (let n = 0; n < take; n++) {
    const row = hub.prepare(`SELECT * FROM subscription_agent_jobs WHERE status='pending' ORDER BY created_at LIMIT 1`).get();
    if (!row) break;
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
  let result;

  if (mode === 'raw_output' || !SPECIAL_COMPLETE.has(row.feature)) {
    result = {
      output: String(output || ''),
      meta: meta || null,
      feature: row.feature,
      completed_at: now(),
    };
  } else if (row.feature === 'cross_entity_synthesis') {
    result = require('./knowledge-synthesis').completeRemoteCrossEntitySynthesis(payload, output);
  } else if (row.feature === 'nakai_briefing_quality_review') {
    result = await require('../scripts/review-nakai-briefing-quality').completeReview(payload, output);
  } else if (row.feature === 'm365_daily_briefing') {
    result = await require('../scripts/build-m365-daily-briefing').completeRemoteM365DailyBriefing(payload, output);
  } else if (row.feature === 'newsletter_digest_briefing') {
    result = await require('../scripts/build-newsletter-digest-briefing').completeRemoteNewsletterDigestBriefing(payload, output);
  } else if (row.feature === 'us_block_special_briefing') {
    result = await require('../scripts/build-us-block-special-briefing').completeRemoteUSBlockSpecialBriefing(payload, output);
  } else {
    result = await require('../scripts/build-nakai-daily-briefing').completeRemoteNakaiDailyBriefing(payload, output);
  }

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
  const runner = resolveFeatureRunner(feature);
  const maxAttempts = Math.max(1, Number(runner.retries || 2));
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
  queueStats,
  SPECIAL_COMPLETE,
  featureAllowed,
};
