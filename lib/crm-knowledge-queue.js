'use strict';

/**
 * Queue one canonical CRM knowledge-engine pass.
 *
 * Ordinary jobs remain one global source scan. A requested source repair is a
 * distinct, narrowly-scoped job: it must not be swallowed by an unrelated
 * global pass (nor by a different requested source), but repeated requests
 * for the exact same canonical source reuse their in-flight job.
 */

const db = require('./db');
const { uuid } = require('./id');
const { CRM_KNOWLEDGE_PIPELINE_VERSION } = require('./source-evidence');

function queueCrmKnowledgeEngine({
  user,
  sourceKind = null,
  sourceId = null,
  requestedBy = 'crm-knowledge-request',
  runAt = null,
} = {}, database = null) {
  const hub = database || db.hub();
  const normalisedUser = user ? String(user).trim() : null;
  let normalisedSourceKind = sourceKind ? String(sourceKind).trim() : null;
  let normalisedSourceId = sourceId ? String(sourceId).trim() : null;
  if (Boolean(normalisedSourceKind) !== Boolean(normalisedSourceId)) {
    // This helper is also used by older internal library callers that passed
    // only a source kind (notably the compatibility atoms backfill). A partial
    // pair has never identified a canonical source, so preserve the normal
    // global-worker behavior rather than rejecting or inventing a target.
    // The replay CLI validates paired flags before it reaches this helper.
    normalisedSourceKind = null;
    normalisedSourceId = null;
  }
  if (normalisedSourceKind && !normalisedUser) {
    throw new Error('A source-scoped CRM knowledge job requires a user');
  }
  // Scoped replays are always immediate. A global successor may request a
  // delayed run, while the same BEGIN IMMEDIATE transaction still enforces
  // its singleton semantics across processes.
  const scheduledRunAt = !normalisedSourceKind && runAt !== null && runAt !== '' && Number.isFinite(Number(runAt))
    ? Math.floor(Number(runAt))
    : null;
  const payload = {
    user: normalisedUser,
    source_kind: normalisedSourceKind,
    source_id: normalisedSourceId,
    pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
    requested_by: String(requestedBy || 'crm-knowledge-request'),
  };

  // BEGIN IMMEDIATE prevents two concurrent route/Mycelium callers from both
  // observing an empty queue and inserting a duplicate job.
  const enqueue = hub.transaction(() => {
    const existing = normalisedSourceKind
      ? hub.prepare(`
        SELECT id, status
        FROM system_jobs
        WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
          AND json_extract(payload, '$.user') = ?
          AND json_extract(payload, '$.source_kind') = ?
          AND json_extract(payload, '$.source_id') = ?
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
                 run_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(normalisedUser, normalisedSourceKind, normalisedSourceId)
      : hub.prepare(`
        SELECT id, status
        FROM system_jobs
        WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
          AND json_extract(payload, '$.source_kind') IS NULL
          AND json_extract(payload, '$.source_id') IS NULL
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
                 run_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get();
    if (existing) {
      return {
        queued: true,
        existing: true,
        jobId: existing.id,
        status: existing.status,
        payload,
      };
    }

    const id = uuid();
    hub.prepare(`
      INSERT INTO system_jobs (id, type, payload, run_at, status, source)
      VALUES (?, 'crm_knowledge_engine', ?, COALESCE(?, unixepoch()), 'pending', ?)
    `).run(id, JSON.stringify(payload), scheduledRunAt, requestedBy || 'crm-knowledge-request');
    return {
      queued: true,
      existing: false,
      jobId: id,
      status: 'pending',
      payload,
    };
  });

  return enqueue.immediate();
}

module.exports = { queueCrmKnowledgeEngine };
