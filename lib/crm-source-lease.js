'use strict';

/**
 * The source-processing lease.
 *
 * One durable, token-scoped lease encloses the whole pipeline for each
 * (user, source kind/id, revision, pipeline version). It is heartbeated while
 * work runs, may be reclaimed only after expiry, and is checked again after
 * every model response and every provider await before anything may write a
 * receipt, atom, or external effect.
 *
 * The invariant worth stating plainly: a stale worker's token can never finish
 * or overwrite its replacement's lease. If ownership is lost mid-call the
 * pending outbox row is deliberately left intact for reconciliation, because a
 * late worker publishing a terminal result is how one email becomes two tasks.
 *
 * Extracted from crm-knowledge-engine.js as shared infrastructure — see
 * lib/crm-receipts.js for why.
 */

const db = require('./db');
const { uuid } = require('./id');
const { CRM_KNOWLEDGE_PIPELINE_VERSION } = require('./source-evidence');

const SOURCE_PROCESSING_LEASE_SECONDS = 10 * 60;

function now() { return Math.floor(Date.now() / 1000); }

function claimSourceProcessingLease(user, evidence, { leaseSeconds = SOURCE_PROCESSING_LEASE_SECONDS } = {}) {
  const hub = db.hub();
  const claimedAt = now();
  const token = uuid();
  const expiresAt = claimedAt + Math.max(1, Number(leaseSeconds) || SOURCE_PROCESSING_LEASE_SECONDS);
  const existing = hub.prepare(`
    SELECT * FROM crm_source_processing_leases
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ? AND pipeline_version = ?
  `).get(user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION);
  const changed = hub.prepare(`
    INSERT INTO crm_source_processing_leases
      (user, source_kind, source_id, source_revision, pipeline_version, lease_token,
       status, claimed_at, heartbeat_at, expires_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, NULL)
    ON CONFLICT(user, source_kind, source_id, source_revision, pipeline_version) DO UPDATE SET
      lease_token = excluded.lease_token,
      status = 'processing',
      claimed_at = excluded.claimed_at,
      heartbeat_at = excluded.heartbeat_at,
      expires_at = excluded.expires_at,
      last_error = NULL
    WHERE crm_source_processing_leases.expires_at <= excluded.claimed_at
  `).run(
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION,
    token, claimedAt, claimedAt, expiresAt,
  ).changes;
  if (changed) {
    return {
      claimed: true,
      token,
      reclaimed_stale: Boolean(existing && Number(existing.expires_at || 0) <= claimedAt),
      expires_at: expiresAt,
    };
  }
  const held = hub.prepare(`
    SELECT * FROM crm_source_processing_leases
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ? AND pipeline_version = ?
  `).get(user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION);
  return { claimed: false, token: null, held_by: held?.lease_token || null, expires_at: held?.expires_at || null };
}

function finishSourceProcessingLease(user, evidence, token, { status = 'done', error = null } = {}) {
  if (!token) return false;
  return db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET status = ?, heartbeat_at = ?, expires_at = ?, last_error = ?
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND lease_token = ?
  `).run(
    status, now(), now(), error ? String(error).slice(0, 2000) : null,
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, token,
  ).changes === 1;
}

function refreshSourceProcessingLease(user, evidence, token, { leaseSeconds = SOURCE_PROCESSING_LEASE_SECONDS } = {}) {
  if (!token) return false;
  const heartbeatAt = now();
  const expiresAt = heartbeatAt + Math.max(1, Number(leaseSeconds) || SOURCE_PROCESSING_LEASE_SECONDS);
  return db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET heartbeat_at = ?, expires_at = ?
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND lease_token = ? AND status = 'processing'
  `).run(
    heartbeatAt, expiresAt,
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, token,
  ).changes === 1;
}

function sourceProcessingLeaseLostError() {
  const error = new Error('source_processing_lease_lost');
  error.code = 'SOURCE_PROCESSING_LEASE_LOST';
  return error;
}

function sourceProcessingLeaseHeldError() {
  const error = new Error('This source is already being processed; wait for it to finish before approving this action');
  error.code = 'SOURCE_PROCESSING_LEASE_HELD';
  return error;
}

function isSourceProcessingLeaseLostError(error) {
  return error?.code === 'SOURCE_PROCESSING_LEASE_LOST'
    || String(error?.message || error) === 'source_processing_lease_lost';
}

function startSourceProcessingLeaseHeartbeat(user, evidence, token, leaseOptions = {}) {
  const leaseSeconds = Math.max(1, Number(leaseOptions.leaseSeconds) || SOURCE_PROCESSING_LEASE_SECONDS);
  // The timer is intentionally unref'ed: a healthy process should not stay
  // alive merely to renew a source claim.  The synchronous guard below still
  // renews and verifies ownership immediately before model/provider stages.
  const intervalMs = Math.max(25, Math.floor((leaseSeconds * 1000) / 3));
  let lost = false;
  const renew = () => {
    if (!refreshSourceProcessingLease(user, evidence, token, { leaseSeconds })) lost = true;
    return !lost;
  };
  const timer = setInterval(renew, intervalMs);
  timer.unref?.();
  return {
    assertOwned() {
      if (!renew()) throw sourceProcessingLeaseLostError();
      return true;
    },
    stop() { clearInterval(timer); },
  };
}

module.exports = {
  SOURCE_PROCESSING_LEASE_SECONDS,
  claimSourceProcessingLease,
  finishSourceProcessingLease,
  refreshSourceProcessingLease,
  sourceProcessingLeaseLostError,
  sourceProcessingLeaseHeldError,
  isSourceProcessingLeaseLostError,
  startSourceProcessingLeaseHeartbeat,
};
