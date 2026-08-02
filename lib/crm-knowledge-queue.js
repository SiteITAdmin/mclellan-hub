'use strict';

/**
 * Queue one canonical CRM knowledge-engine pass.
 *
 * The engine is a global source scanner today, so a document/task request is
 * represented as metadata on the job rather than as a second worker path.  A
 * pending or running job is reused; callers must not stack one job per
 * Mycelium tick or button press.
 */

const db = require('./db');
const { uuid } = require('./id');
const { CRM_KNOWLEDGE_PIPELINE_VERSION } = require('./source-evidence');

function queueCrmKnowledgeEngine({
  user,
  sourceKind = null,
  sourceId = null,
  requestedBy = 'crm-knowledge-request',
} = {}, database = null) {
  const hub = database || db.hub();
  const payload = {
    user: user ? String(user) : null,
    source_kind: sourceKind ? String(sourceKind) : null,
    source_id: sourceId ? String(sourceId) : null,
    pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
    requested_by: String(requestedBy || 'crm-knowledge-request'),
  };

  // BEGIN IMMEDIATE prevents two concurrent route/Mycelium callers from both
  // observing an empty queue and inserting a duplicate job.
  const enqueue = hub.transaction(() => {
    const existing = hub.prepare(`
      SELECT id, status
      FROM system_jobs
      WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
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
      VALUES (?, 'crm_knowledge_engine', ?, unixepoch(), 'pending', ?)
    `).run(id, JSON.stringify(payload), requestedBy || 'crm-knowledge-request');
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
