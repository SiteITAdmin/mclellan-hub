'use strict';

const { randomUUID } = require('crypto');
const db = require('./db');

function now() {
  return Math.floor(Date.now() / 1000);
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch (_) {
    return JSON.stringify({ error: 'payload_not_serializable' });
  }
}

function writeAgentReceipt({
  user = 'system',
  sourceKind,
  sourceId,
  stage,
  status = 'pass',
  summary = '',
  payload = {},
  modelKey = null,
  modelId = null,
} = {}) {
  if (!sourceKind) throw new Error('sourceKind is required');
  if (!sourceId) throw new Error('sourceId is required');
  if (!stage) throw new Error('stage is required');

  const id = randomUUID();
  db.hub().prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user,
    sourceKind,
    sourceId,
    stage,
    status,
    summary || null,
    safeJson(payload),
    modelKey,
    modelId,
    now(),
  );
  return id;
}

function latestAgentReceipts({ user = 'system', stages = [], limit = 20 } = {}) {
  const params = [user];
  let stageClause = "stage LIKE 'agent:%'";
  if (Array.isArray(stages) && stages.length) {
    stageClause = `stage IN (${stages.map(() => '?').join(',')})`;
    params.push(...stages);
  }
  params.push(limit);
  return db.hub().prepare(`
    SELECT *
    FROM knowledge_receipts
    WHERE user = ?
      AND ${stageClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params);
}

module.exports = {
  writeAgentReceipt,
  latestAgentReceipts,
};

