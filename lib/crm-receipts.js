'use strict';

/**
 * Stage receipts for the CRM knowledge pipeline.
 *
 * Every stage records what it decided, using which source revision, under
 * which pipeline version. These receipts are the audit trail behind
 * /crm/knowledge and the reason a replay can tell "already done correctly"
 * apart from "never ran" — a distinction the engine gets wrong the moment it
 * reads a receipt written for a different revision of the same source.
 *
 * Extracted from crm-knowledge-engine.js, which had grown to ~2,900 lines with
 * every stage sharing file-local helpers. Pulling the shared infrastructure out
 * first makes each stage's real dependencies explicit imports instead of
 * invisible proximity, which is what a later stage split needs.
 */

const db = require('./db');
const { uuid } = require('./id');
const { CRM_KNOWLEDGE_PIPELINE_VERSION } = require('./source-evidence');

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

// A simple latest-row helper, kept for legacy callers that predate revision
// awareness. New code almost always wants currentSourceReceipt instead.
function sourceReceipt(user, sourceKind, sourceId, stage) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(user, sourceKind, sourceId, stage);
}

function writeReceipt(user, sourceKind, sourceId, stage, {
  status = 'done',
  summary = '',
  payload = {},
  modelKey = null,
  modelId = null,
  sourceRevision = null,
  pipelineVersion = CRM_KNOWLEDGE_PIPELINE_VERSION,
} = {}) {
  const receiptPayload = {
    ...(payload && typeof payload === 'object' ? payload : { value: payload }),
    pipeline_version: pipelineVersion,
    source_revision: sourceRevision,
  };
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, sourceKind, sourceId, stage, status, summary || null,
    JSON.stringify(receiptPayload), modelKey, modelId, now()
  );
  return id;
}

function receiptForCurrentSource(row, evidence) {
  if (!row) return false;
  const payload = parseJson(row.payload);
  return payload.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
    && payload.source_revision === evidence.revision_hash;
}

// Recovery must find the newest receipt for this exact raw revision: a source
// can change and later return to an earlier revision, so "most recent row" is
// not the same question as "most recent row that judged what we are looking at".
function currentSourceReceipt(user, evidence, stage) {
  const rows = db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, evidence.source_kind, evidence.source_id, stage);
  return rows.find(row => receiptForCurrentSource(row, evidence)) || null;
}

module.exports = {
  sourceReceipt,
  writeReceipt,
  receiptForCurrentSource,
  currentSourceReceipt,
};
