'use strict';

// Durable pull queue for subscription work. The VPS prepares source-backed
// synthesis packages; the Mac mini claims them and returns only model output.

const db = require('./db');
const { uuid } = require('./id');

const FEATURES = new Set(['nakai_daily_briefing', 'cross_entity_synthesis']);
const STALE_SEC = 15 * 60;

function enabled() { return process.env.SUBSCRIPTION_AGENT_WORKER_ENABLED === '1'; }
function secretConfigured() { return !!String(process.env.SUBSCRIPTION_AGENT_WORKER_SECRET || '').trim(); }
function now() { return Math.floor(Date.now() / 1000); }

function recoverStaleClaims(ts = now()) {
  return db.hub().prepare(`
    UPDATE subscription_agent_jobs
       SET status = 'pending', claim_token = NULL, claimed_at = NULL, claimed_by = NULL,
           error = COALESCE(error || ' | ', '') || 'claim expired; re-queued', updated_at = ?
     WHERE status = 'claimed' AND claimed_at < ?
  `).run(ts, ts - STALE_SEC).changes;
}

function enqueue({ feature, dedupeKey, payload }) {
  if (!FEATURES.has(feature)) throw new Error(`Unsupported subscription feature: ${feature}`);
  const hub = db.hub();
  const key = String(dedupeKey || '').slice(0, 160);
  if (!key) throw new Error('subscription job dedupeKey is required');
  const existing = hub.prepare(`
    SELECT id, status FROM subscription_agent_jobs
     WHERE feature = ? AND dedupe_key = ? AND status IN ('pending', 'claimed')
     ORDER BY created_at DESC LIMIT 1
  `).get(feature, key);
  if (existing) return { queued: true, existing: true, jobId: existing.id, status: existing.status };
  const id = uuid(); const ts = now();
  hub.prepare(`INSERT INTO subscription_agent_jobs
    (id, feature, dedupe_key, payload, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, feature, key, JSON.stringify(payload), ts, ts);
  return { queued: true, existing: false, jobId: id, status: 'pending' };
}

function claim({ workerId = 'mac', limit = 1 } = {}) {
  const hub = db.hub(); const ts = now(); recoverStaleClaims(ts);
  const jobs = []; const take = Math.max(1, Math.min(2, Number(limit) || 1));
  for (let n = 0; n < take; n++) {
    const row = hub.prepare(`SELECT * FROM subscription_agent_jobs WHERE status='pending' ORDER BY created_at LIMIT 1`).get();
    if (!row) break;
    const token = uuid();
    const changed = hub.prepare(`UPDATE subscription_agent_jobs SET status='claimed', claim_token=?, claimed_at=?, claimed_by=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'`)
      .run(token, ts, String(workerId).slice(0, 80), ts, row.id).changes;
    if (!changed) continue;
    jobs.push({ id: row.id, feature: row.feature, claim_token: token, payload: JSON.parse(row.payload) });
  }
  return { ok: true, jobs };
}

function claimed(id, token) {
  const row = db.hub().prepare(`SELECT * FROM subscription_agent_jobs WHERE id=?`).get(String(id || ''));
  if (!row) return { ok: false, status: 404, error: 'job not found' };
  if (row.status !== 'claimed' || !token || row.claim_token !== String(token)) return { ok: false, status: 403, error: 'invalid or expired claim' };
  return { ok: true, row };
}

async function complete({ jobId, claimToken, output }) {
  const loaded = claimed(jobId, claimToken); if (!loaded.ok) return loaded;
  const { row } = loaded; const payload = JSON.parse(row.payload);
  let result;
  if (row.feature === 'cross_entity_synthesis') {
    result = require('./knowledge-synthesis').completeRemoteCrossEntitySynthesis(payload, output);
  } else {
    result = await require('../scripts/build-nakai-daily-briefing').completeRemoteNakaiDailyBriefing(payload, output);
  }
  db.hub().prepare(`UPDATE subscription_agent_jobs SET status='completed', claim_token=NULL, completed_at=?, updated_at=?, result_json=?, error=NULL WHERE id=? AND claim_token=?`)
    .run(now(), now(), JSON.stringify(result), row.id, String(claimToken));
  return { ok: true, jobId: row.id, result };
}

function fail({ jobId, claimToken, error }) {
  const loaded = claimed(jobId, claimToken); if (!loaded.ok) return loaded;
  const ts = now(); const attempts = Number(loaded.row.attempts || 1);
  const status = attempts >= 3 ? 'failed' : 'pending';
  db.hub().prepare(`UPDATE subscription_agent_jobs SET status=?, claim_token=NULL, claimed_at=NULL, claimed_by=NULL, completed_at=?, updated_at=?, error=? WHERE id=? AND claim_token=?`)
    .run(status, status === 'failed' ? ts : null, ts, String(error || 'worker failed').slice(0, 1000), loaded.row.id, String(claimToken));
  return { ok: true, jobId: loaded.row.id, status };
}

module.exports = { enabled, secretConfigured, enqueue, claim, complete, fail, recoverStaleClaims };
