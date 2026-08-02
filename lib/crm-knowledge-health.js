'use strict';

const db = require('./db');
const {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  listSourceEvidence,
  isCanonicalEvidenceExcluded,
} = require('./source-evidence');

const CRM_KNOWLEDGE_STAGES = [
  { key: 'crm_source_triage', label: 'Source triage' },
  { key: 'crm_duplicate_reviewed', label: 'Duplicate review' },
  { key: 'crm_knowledge_synthesised', label: 'Knowledge synthesis' },
  { key: 'crm_action_projected', label: 'Action projection' },
];

const STAGE_KEYS = new Set(CRM_KNOWLEDGE_STAGES.map(stage => stage.key));
const ERROR_STATUSES = new Set(['error', 'fail']);
const WARNING_STATUSES = new Set(['warn', 'uncertain', 'review', 'pending']);
const SKIPPED_STATUSES = new Set(['skipped', 'already_synthesised']);
const ACTION_TERMINAL = new Set([
  'task_created', 'event_created', 'task_and_event_created',
  'existing_open_task', 'fyi', 'dismissed',
]);

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

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
    if (!previous
      || Number(row.created_at) > Number(previous.created_at)
      || (Number(row.created_at) === Number(previous.created_at) && rowOrder > previousOrder)) {
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
  const currentErrors = latest.filter(row => statusBucket(row.status) === 'errors')
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const erroredSourceCount = new Set(currentErrors.map(row => `${row.source_kind}\u0000${row.source_id}`)).size;
  return {
    stages: CRM_KNOWLEDGE_STAGES.map(stage => byStage.get(stage.key)).filter(stage => stage.total > 0),
    currentErrors,
    erroredSourceCount,
  };
}

function evidenceKey(evidence) {
  return `${evidence.source_kind}\u0000${evidence.source_id}`;
}

function isExcludedEvidence(evidence) {
  return isCanonicalEvidenceExcluded(evidence);
}

function latestCurrentReceipt(rows, evidence, stage) {
  let latest = null;
  for (const row of rows) {
    if (row.stage !== stage) continue;
    if (row.source_kind !== evidence.source_kind
      || String(row.source_id) !== String(evidence.source_id)) continue;
    const payload = parseJson(row.payload);
    if (payload.pipeline_version !== CRM_KNOWLEDGE_PIPELINE_VERSION
      || payload.source_revision !== evidence.revision_hash) continue;
    const order = Number(row.receipt_order || row.rowid || 0);
    const latestOrder = Number(latest?.receipt_order || latest?.rowid || 0);
    if (!latest
      || Number(row.created_at || 0) > Number(latest.created_at || 0)
      || (Number(row.created_at || 0) === Number(latest.created_at || 0) && order > latestOrder)) {
      latest = row;
    }
  }
  return latest;
}

function sourceCoverageState(evidence, receiptRows, outcomeRows) {
  const triage = latestCurrentReceipt(receiptRows, evidence, 'crm_source_triage');
  if (!triage) return { state: 'incomplete', reason: 'not_triaged_for_current_revision' };
  if (ERROR_STATUSES.has(triage.status)) return { state: 'error', reason: 'triage_error' };
  if (WARNING_STATUSES.has(triage.status)) return { state: 'review', reason: 'triage_review' };

  const triagePayload = parseJson(triage.payload);
  const actionReceipt = latestCurrentReceipt(receiptRows, evidence, 'crm_action_projected');
  if (!actionReceipt) return { state: 'incomplete', reason: 'action_projection_missing' };
  if (ERROR_STATUSES.has(actionReceipt.status)) return { state: 'error', reason: 'action_projection_error' };

  const candidates = Array.isArray(triagePayload.candidate_actions) ? triagePayload.candidate_actions : [];
  const sourceOutcomes = outcomeRows.filter(row =>
    row.source_kind === evidence.source_kind
      && row.source_id === evidence.source_id
      && row.source_revision === evidence.revision_hash
      && row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
  );
  if (sourceOutcomes.some(row => row.disposition === 'error')) return { state: 'error', reason: 'action_outcome_error' };
  const sourceLevelReview = sourceOutcomes.some(row => {
    if (row.disposition !== 'review') return false;
    const payload = parseJson(row.payload);
    return payload.source_level === true || payload.non_creatable === true && !payload.candidate;
  });
  if (sourceLevelReview) return { state: 'review', reason: 'source_level_action_review' };
  if (sourceOutcomes.some(row => row.disposition === 'review')) return { state: 'review', reason: 'action_outcome_review' };
  if (sourceOutcomes.some(row => row.disposition === 'pending_task' || row.disposition === 'pending_event')) {
    return { state: 'incomplete', reason: 'action_side_effect_pending' };
  }
  if (candidates.length) {
    const expected = new Set(candidates.map(candidate => candidate.candidate_key).filter(Boolean));
    const complete = new Set(sourceOutcomes.filter(row => ACTION_TERMINAL.has(row.disposition)).map(row => row.action_key));
    if (!expected.size || [...expected].some(key => !complete.has(key))) {
      return { state: 'incomplete', reason: 'candidate_without_terminal_outcome' };
    }
  }
  // A concurrent loser may write a warning receipt after another worker has
  // already reached durable terminal outcomes.  Terminal outcome rows are the
  // authority for external effects, so do not leave the source falsely sick.
  if (WARNING_STATUSES.has(actionReceipt.status)) {
    if (!candidates.length) return { state: 'review', reason: 'action_projection_review' };
    // Candidate outcomes above have already proved every candidate terminal.
  }

  // Duplicate review is informative but optional for coverage.  If it failed,
  // health still fails visibly even though actions were allowed to continue.
  const duplicate = latestCurrentReceipt(receiptRows, evidence, 'crm_duplicate_reviewed');
  if (duplicate && ERROR_STATUSES.has(duplicate.status)) return { state: 'error', reason: 'duplicate_review_error' };

  const needsSynthesis = Boolean(triagePayload.should_synthesise);
  if (!needsSynthesis) return { state: 'complete', reason: 'triage_no_durable_knowledge' };
  const synthesis = latestCurrentReceipt(receiptRows, evidence, 'crm_knowledge_synthesised');
  if (!synthesis) return { state: 'incomplete', reason: 'knowledge_synthesis_missing' };
  if (ERROR_STATUSES.has(synthesis.status)) return { state: 'error', reason: 'knowledge_synthesis_error' };
  if (WARNING_STATUSES.has(synthesis.status)) return { state: 'review', reason: 'knowledge_synthesis_review' };
  return { state: 'complete', reason: synthesis.status || 'knowledge_synthesis_done' };
}

function getCrmKnowledgeHealth(user) {
  const stagePlaceholders = CRM_KNOWLEDGE_STAGES.map(() => '?').join(',');
  const allRows = db.hub().prepare(`
    SELECT rowid AS receipt_order, id, stage, status, source_kind, source_id,
           summary, payload, model_key, model_id, created_at
    FROM knowledge_receipts
    WHERE user = ? AND stage IN (${stagePlaceholders})
    ORDER BY created_at DESC, rowid DESC
  `).all(user, ...CRM_KNOWLEDGE_STAGES.map(stage => stage.key));
  const evidence = listSourceEvidence(user).filter(item => !isExcludedEvidence(item));
  const byEvidence = new Map(evidence.map(item => [evidenceKey(item), item]));
  const currentRows = allRows.filter(row => {
    const item = byEvidence.get(`${row.source_kind}\u0000${row.source_id}`);
    if (!item) return false;
    const payload = parseJson(row.payload);
    return payload.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
      && payload.source_revision === item.revision_hash;
  });
  const summary = summariseKnowledgeReceipts(currentRows);
  const outcomeRows = db.hub().prepare('SELECT * FROM crm_action_outcomes WHERE user = ?').all(user);
  const coverage = { eligible: evidence.length, completed: 0, incomplete: 0, review: 0, errors: 0, sources: [] };
  for (const item of evidence) {
    const state = sourceCoverageState(item, currentRows, outcomeRows);
    if (state.state === 'complete') coverage.completed += 1;
    else if (state.state === 'error') coverage.errors += 1;
    else if (state.state === 'review') coverage.review += 1;
    else coverage.incomplete += 1;
    coverage.sources.push({
      source_kind: item.source_kind,
      source_id: item.source_id,
      source_revision: item.revision_hash,
      completeness: item.completeness,
      ...state,
    });
  }
  coverage.currentVersionCompleted = coverage.completed;
  coverage.coveragePercent = coverage.eligible ? Math.round((coverage.completed / coverage.eligible) * 100) : 100;

  const outcomeErrors = outcomeRows.filter(row => {
    const item = byEvidence.get(`${row.source_kind}\u0000${row.source_id}`);
    return item && row.source_revision === item.revision_hash
      && row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
      && row.disposition === 'error';
  }).map(row => ({
    id: row.id,
    stage: 'crm_action_projected',
    status: 'error',
    source_kind: row.source_kind,
    source_id: row.source_id,
    summary: row.reason,
    payload: row.payload,
    created_at: row.updated_at,
  }));
  const currentErrors = [...summary.currentErrors, ...outcomeErrors]
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const erroredSourceCount = new Set(currentErrors.map(row => `${row.source_kind}\u0000${row.source_id}`)).size;
  return {
    ...summary,
    currentErrors,
    erroredSourceCount,
    coverage,
    reviewSourceCount: coverage.review,
    incompleteSourceCount: coverage.incomplete,
    actionQueue: outcomeRows.filter(row => {
      const item = byEvidence.get(`${row.source_kind}\u0000${row.source_id}`);
      return ['review', 'error', 'pending_task', 'pending_event'].includes(row.disposition)
        && item
        && row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
        && row.source_revision === item.revision_hash;
    }).length,
  };
}

module.exports = {
  CRM_KNOWLEDGE_STAGES,
  getCrmKnowledgeHealth,
  // Kept public so read-only replay/audit tools can evaluate exactly the same
  // source coverage state as the health view without reimplementing semantics.
  isExcludedEvidence,
  latestCurrentReceipt,
  sourceCoverageState,
  _test: {
    latestReceiptRows,
    statusBucket,
    summariseKnowledgeReceipts,
    sourceCoverageState,
  },
};
