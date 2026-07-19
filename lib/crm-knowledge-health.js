'use strict';

const db = require('./db');

const CRM_KNOWLEDGE_STAGES = [
  { key: 'crm_source_triage', label: 'Source triage' },
  { key: 'crm_duplicate_reviewed', label: 'Duplicate review' },
  { key: 'crm_knowledge_synthesised', label: 'Knowledge synthesis' },
  { key: 'crm_action_projected', label: 'Action projection' },
];

const STAGE_KEYS = new Set(CRM_KNOWLEDGE_STAGES.map(stage => stage.key));
const ERROR_STATUSES = new Set(['error', 'fail']);
const WARNING_STATUSES = new Set(['warn', 'uncertain']);
const SKIPPED_STATUSES = new Set(['skipped', 'already_synthesised']);

function statusBucket(status) {
  if (ERROR_STATUSES.has(status)) return 'errors';
  if (WARNING_STATUSES.has(status)) return 'warnings';
  if (SKIPPED_STATUSES.has(status)) return 'skipped';
  return 'processed';
}

function latestReceiptRows(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!STAGE_KEYS.has(row.stage)) continue;
    const key = `${row.stage}\u0000${row.source_kind}\u0000${row.source_id}`;
    const previous = latest.get(key);
    const rowOrder = Number(row.receipt_order || row.rowid || 0);
    const previousOrder = Number(previous?.receipt_order || previous?.rowid || 0);
    if (
      !previous
      || Number(row.created_at) > Number(previous.created_at)
      || (Number(row.created_at) === Number(previous.created_at) && rowOrder > previousOrder)
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function summariseKnowledgeReceipts(rows) {
  const latest = latestReceiptRows(rows);
  const byStage = new Map(CRM_KNOWLEDGE_STAGES.map(stage => [stage.key, {
    stage: stage.key,
    label: stage.label,
    last_at: null,
    total: 0,
    processed: 0,
    skipped: 0,
    warnings: 0,
    errors: 0,
  }]));

  for (const row of latest) {
    const summary = byStage.get(row.stage);
    summary.total += 1;
    summary[statusBucket(row.status)] += 1;
    summary.last_at = Math.max(Number(summary.last_at || 0), Number(row.created_at || 0)) || null;
  }

  const currentErrors = latest
    .filter(row => statusBucket(row.status) === 'errors')
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const erroredSourceCount = new Set(
    currentErrors.map(row => `${row.source_kind}\u0000${row.source_id}`)
  ).size;

  return {
    stages: CRM_KNOWLEDGE_STAGES.map(stage => byStage.get(stage.key)).filter(stage => stage.total > 0),
    currentErrors,
    erroredSourceCount,
  };
}

function getCrmKnowledgeHealth(user) {
  const stagePlaceholders = CRM_KNOWLEDGE_STAGES.map(() => '?').join(',');
  const rows = db.hub().prepare(`
    SELECT rowid AS receipt_order, id, stage, status, source_kind, source_id,
           summary, payload, model_key, model_id, created_at
    FROM knowledge_receipts
    WHERE user = ? AND stage IN (${stagePlaceholders})
    ORDER BY created_at DESC, rowid DESC
  `).all(user, ...CRM_KNOWLEDGE_STAGES.map(stage => stage.key));
  return summariseKnowledgeReceipts(rows);
}

module.exports = {
  CRM_KNOWLEDGE_STAGES,
  getCrmKnowledgeHealth,
  _test: {
    latestReceiptRows,
    statusBucket,
    summariseKnowledgeReceipts,
  },
};
