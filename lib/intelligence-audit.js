'use strict';

const db = require('./db');
const { uuid } = require('./id');

function startExtractionRun({ user, documentId, method = 'ai', requestedModelId = null }) {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO intel_extraction_runs
      (id, user, document_id, method, requested_model_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, user, documentId, method, requestedModelId);
  return id;
}

function finishExtractionRun(id, {
  status = 'complete',
  actualModelId = null,
  attemptCount = 1,
  itemCount = 0,
  tokensIn = 0,
  tokensOut = 0,
  costUsd = 0,
  durationMs = null,
  error = null,
} = {}) {
  db.hub().prepare(`
    UPDATE intel_extraction_runs
       SET status = ?,
           actual_model_id = ?,
           attempt_count = ?,
           item_count = ?,
           tokens_in = ?,
           tokens_out = ?,
           cost_usd = ?,
           duration_ms = ?,
           error = ?,
           completed_at = unixepoch()
     WHERE id = ?
  `).run(
    status, actualModelId, attemptCount, itemCount,
    tokensIn, tokensOut, costUsd, durationMs,
    error ? String(error).slice(0, 1000) : null,
    id
  );
}

function listIngestionAudit(user, { limit = 100, sourceKind = '', status = '', model = '' } = {}) {
  const conditions = ['d.user = ?'];
  const params = [user];
  const auditConditions = [];
  const auditParams = [];
  if (sourceKind) {
    conditions.push('d.source_kind = ?');
    params.push(sourceKind);
  }
  if (status) {
    auditConditions.push('audit.resolved_status = ?');
    auditParams.push(status);
  }
  if (model) {
    auditConditions.push('audit.resolved_model_id = ?');
    auditParams.push(model);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const auditWhere = auditConditions.length
    ? `WHERE ${auditConditions.join(' AND ')}`
    : '';

  return db.hub().prepare(`
    SELECT *
      FROM (
        SELECT d.id, d.source_kind, d.title, d.sender_name, d.sender_email,
               d.published_at, d.created_at, length(COALESCE(d.content_text, '')) AS source_chars,
               s.name AS source_name, s.match_type, s.match_value,
               COUNT(i.id) AS item_count,
               COALESCE(SUM(length(COALESCE(i.content_text, ''))), 0) AS output_chars,
               MIN(i.extracted_at) AS first_extracted_at,
               MAX(i.extracted_at) AS last_extracted_at,
               MAX(i.extraction_method) AS extraction_method,
               MAX(i.extraction_model_id) AS item_model_id,
               MAX(i.extraction_model_label) AS item_model_label,
               r.id AS run_id, r.method AS run_method, r.status AS run_status,
               r.requested_model_id, r.actual_model_id, r.attempt_count,
               r.tokens_in, r.tokens_out, r.cost_usd, r.duration_ms,
               r.error, r.started_at, r.completed_at,
               COALESCE(r.status,
                 CASE WHEN COUNT(i.id) > 0 THEN 'complete' ELSE 'stored' END
               ) AS resolved_status,
               COALESCE(r.actual_model_id, r.requested_model_id,
                 MAX(i.extraction_model_id), ''
               ) AS resolved_model_id,
               COALESCE(r.started_at, MAX(i.extracted_at), d.created_at) AS audit_at
          FROM intel_documents d
          LEFT JOIN intel_sources s ON s.id = d.source_id
          LEFT JOIN intel_items i ON i.document_id = d.id
          LEFT JOIN intel_extraction_runs r ON r.id = (
            SELECT rr.id FROM intel_extraction_runs rr
             WHERE rr.document_id = d.id
             ORDER BY rr.started_at DESC, rr.id DESC LIMIT 1
          )
         WHERE ${conditions.join(' AND ')}
         GROUP BY d.id
      ) audit
     ${auditWhere}
     ORDER BY audit.audit_at DESC
     LIMIT ?
  `).all(...params, ...auditParams, safeLimit);
}

function getIngestionAudit(user, documentId) {
  const document = db.hub().prepare(`
    SELECT d.*, length(d.content_text) AS source_chars,
           s.name AS source_name, s.match_type, s.match_value,
           s.briefing_priority
      FROM intel_documents d
      LEFT JOIN intel_sources s ON s.id = d.source_id
     WHERE d.id = ? AND d.user = ?
  `).get(documentId, user);
  if (!document) return null;

  const items = db.hub().prepare(`
    SELECT id, title, summary, content_text, item_type, category,
           entities_json, themes_json, source_url, published_at, selected,
           extraction_model_id, extraction_model_label, extraction_method,
           extracted_at, created_at
      FROM intel_items
     WHERE document_id = ? AND user = ?
     ORDER BY created_at, id
  `).all(documentId, user);
  const runs = db.hub().prepare(`
    SELECT * FROM intel_extraction_runs
     WHERE document_id = ? AND user = ?
     ORDER BY started_at DESC
  `).all(documentId, user);
  return { document, items, runs };
}

module.exports = {
  startExtractionRun,
  finishExtractionRun,
  listIngestionAudit,
  getIngestionAudit,
};
