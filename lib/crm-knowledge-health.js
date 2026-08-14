'use strict';

const db = require('./db');
const {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  CRM_KNOWLEDGE_AUTO_PROCESS_AFTER,
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

function isOutsideAutoProcessWindow(evidence) {
  return Number(evidence?.ts || 0) > 0
    && Number(evidence.ts) < CRM_KNOWLEDGE_AUTO_PROCESS_AFTER;
}

// Receipt match for coverage. Current-pipeline mode requires the live pipeline
// version. Grandfather mode accepts any pipeline version (including missing
// stamps from older writers) when the source_revision matches the live raw
// revision. Receipts without a source_revision never grandfather — freeze by
// auto-process window covers that historical corpus instead.
function receiptMatchesEvidence(row, evidence, { anyPipelineVersion = false } = {}) {
  if (!row || !evidence) return false;
  if (row.source_kind !== evidence.source_kind
    || String(row.source_id) !== String(evidence.source_id)) return false;
  const payload = parseJson(row.payload);
  if (!payload.source_revision || payload.source_revision !== evidence.revision_hash) return false;
  if (anyPipelineVersion) return true;
  return payload.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION;
}

function latestMatchingReceipt(rows, evidence, stage, { anyPipelineVersion = false } = {}) {
  let latest = null;
  let latestIsCurrentPipeline = false;
  for (const row of rows) {
    if (row.stage !== stage) continue;
    if (!receiptMatchesEvidence(row, evidence, { anyPipelineVersion })) continue;
    const payload = parseJson(row.payload);
    const isCurrent = payload.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION;
    const order = Number(row.receipt_order || row.rowid || 0);
    const latestOrder = Number(latest?.receipt_order || latest?.rowid || 0);
    if (!latest) {
      latest = row;
      latestIsCurrentPipeline = isCurrent;
      continue;
    }
    // Prefer a current-pipeline receipt over an older pipeline for the same
    // revision, even if the older row is newer by wall clock (should not happen).
    if (isCurrent && !latestIsCurrentPipeline) {
      latest = row;
      latestIsCurrentPipeline = true;
      continue;
    }
    if (isCurrent === latestIsCurrentPipeline
      && (Number(row.created_at || 0) > Number(latest.created_at || 0)
        || (Number(row.created_at || 0) === Number(latest.created_at || 0) && order > latestOrder))) {
      latest = row;
      latestIsCurrentPipeline = isCurrent;
    }
  }
  return latest;
}

function latestCurrentReceipt(rows, evidence, stage) {
  return latestMatchingReceipt(rows, evidence, stage, { anyPipelineVersion: false });
}

function outcomeMatchesEvidence(row, evidence, { anyPipelineVersion = false } = {}) {
  if (!row || !evidence) return false;
  if (row.source_kind !== evidence.source_kind
    || String(row.source_id) !== String(evidence.source_id)) return false;
  if (row.source_revision !== evidence.revision_hash) return false;
  if (anyPipelineVersion) return true;
  return row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION;
}

function parseOutcomePayload(row) {
  return parseJson(row?.payload);
}

/**
 * Source-level stage failures (triage/duplicate outages) are superseded once a
 * later non-error receipt exists for that stage. Candidate projection errors
 * remain active until terminal disposition.
 */
function isActiveOutcomeError(row, evidence, receiptRows, { anyPipelineVersion = false } = {}) {
  if (!row || row.disposition !== 'error') return false;
  const payload = parseOutcomePayload(row);
  const reason = String(row.reason || '');
  if (!payload.source_level) return true;

  if (String(payload.source_stage || '') === 'triage_error' || /source_triage_failed/i.test(reason)) {
    const triage = latestMatchingReceipt(receiptRows, evidence, 'crm_source_triage', { anyPipelineVersion });
    return !triage || ERROR_STATUSES.has(String(triage.status || '').toLowerCase());
  }
  if (
    /duplicate_review/i.test(String(payload.source_stage || ''))
    || /duplicate_review_failed/i.test(reason)
  ) {
    const duplicate = latestMatchingReceipt(receiptRows, evidence, 'crm_duplicate_reviewed', { anyPipelineVersion });
    return !duplicate || ERROR_STATUSES.has(String(duplicate.status || '').toLowerCase());
  }
  return true;
}

function computeSourceCoverageState(evidence, receiptRows, outcomeRows, { anyPipelineVersion = false } = {}) {
  const triage = latestMatchingReceipt(receiptRows, evidence, 'crm_source_triage', { anyPipelineVersion });
  if (!triage) return { state: 'incomplete', reason: 'not_triaged_for_current_revision' };
  if (ERROR_STATUSES.has(triage.status)) return { state: 'error', reason: 'triage_error' };
  if (WARNING_STATUSES.has(triage.status)) return { state: 'review', reason: 'triage_review' };

  const triagePayload = parseJson(triage.payload);
  const actionReceipt = latestMatchingReceipt(receiptRows, evidence, 'crm_action_projected', { anyPipelineVersion });
  if (!actionReceipt) return { state: 'incomplete', reason: 'action_projection_missing' };
  if (ERROR_STATUSES.has(actionReceipt.status)) return { state: 'error', reason: 'action_projection_error' };

  const candidates = Array.isArray(triagePayload.candidate_actions) ? triagePayload.candidate_actions : [];
  const sourceOutcomes = outcomeRows.filter(row => outcomeMatchesEvidence(row, evidence, { anyPipelineVersion }));
  // Source-level stage outages (e.g. OpenRouter 402 during triage) must not
  // poison health after a later successful receipt for that stage. Candidate-
  // level projection errors still block until terminalised.
  const activeOutcomeErrors = sourceOutcomes.filter(row => (
    row.disposition === 'error'
    && isActiveOutcomeError(row, evidence, receiptRows, { anyPipelineVersion })
  ));
  if (activeOutcomeErrors.length) return { state: 'error', reason: 'action_outcome_error' };
  const sourceLevelReview = sourceOutcomes.some(row => {
    if (row.disposition !== 'review') return false;
    const payload = parseJson(row.payload);
    // A prior duplicate_review_missing_target gate is not terminal once
    // synthesis has progressed (done/skipped) on the current revision.
    if (payload.source_level === true && String(payload.source_stage || '') === 'duplicate_review_gate') {
      const synthesis = latestMatchingReceipt(receiptRows, evidence, 'crm_knowledge_synthesised', { anyPipelineVersion });
      if (synthesis && !ERROR_STATUSES.has(String(synthesis.status || '').toLowerCase())
        && !WARNING_STATUSES.has(String(synthesis.status || '').toLowerCase())) {
        return false;
      }
    }
    return payload.source_level === true || payload.non_creatable === true && !payload.candidate;
  });
  if (sourceLevelReview) return { state: 'review', reason: 'source_level_action_review' };
  if (sourceOutcomes.some(row => {
    if (row.disposition !== 'review') return false;
    // Uncertain same-chat resolutions stay in the action queue, but they must
    // not make the answering message look like an unfinished source.
    return !parseJson(row.payload).chat_resolution;
  })) return { state: 'review', reason: 'action_outcome_review' };
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
  const duplicate = latestMatchingReceipt(receiptRows, evidence, 'crm_duplicate_reviewed', { anyPipelineVersion });
  if (duplicate && ERROR_STATUSES.has(duplicate.status)) return { state: 'error', reason: 'duplicate_review_error' };

  const needsSynthesis = Boolean(triagePayload.should_synthesise);
  if (!needsSynthesis) return { state: 'complete', reason: 'triage_no_durable_knowledge' };
  const synthesis = latestMatchingReceipt(receiptRows, evidence, 'crm_knowledge_synthesised', { anyPipelineVersion });
  if (!synthesis) return { state: 'incomplete', reason: 'knowledge_synthesis_missing' };
  if (ERROR_STATUSES.has(synthesis.status)) return { state: 'error', reason: 'knowledge_synthesis_error' };
  if (WARNING_STATUSES.has(synthesis.status)) return { state: 'review', reason: 'knowledge_synthesis_review' };
  return { state: 'complete', reason: synthesis.status || 'knowledge_synthesis_done' };
}

function sourceCoverageState(evidence, receiptRows, outcomeRows) {
  const current = computeSourceCoverageState(evidence, receiptRows, outcomeRows, { anyPipelineVersion: false });
  if (current.state === 'complete') return current;

  // Same source revision completed under an earlier pipeline version stays
  // complete. Version bumps improve the forward path; they must not re-bill
  // OpenRouter for the entire historical corpus.
  if (current.state === 'incomplete') {
    const prior = computeSourceCoverageState(evidence, receiptRows, outcomeRows, { anyPipelineVersion: true });
    if (prior.state === 'complete') {
      return { state: 'complete', reason: 'grandfathered_prior_pipeline' };
    }
  }

  // Evidence older than the auto-process window is frozen for automatic work.
  // Manual source-scoped replay can still re-enter a frozen source deliberately.
  if (isOutsideAutoProcessWindow(evidence)) {
    return {
      state: 'complete',
      reason: 'legacy_frozen_outside_auto_process_window',
      frozen_from: current.state,
      frozen_reason: current.reason,
    };
  }

  return current;
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
  // Health summary counts every receipt for the live revision, including prior
  // pipeline stamps that grandfather completion, so operators see real coverage
  // rather than only the current pipeline version's partial reprocess.
  const currentRows = allRows.filter(row => {
    const item = byEvidence.get(`${row.source_kind}\u0000${row.source_id}`);
    if (!item) return false;
    const payload = parseJson(row.payload);
    if (!payload.source_revision) return false;
    return payload.source_revision === item.revision_hash;
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
    return item
      && !isOutsideAutoProcessWindow(item)
      && row.source_revision === item.revision_hash
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
    .filter(row => {
      const item = byEvidence.get(`${row.source_kind}\u0000${row.source_id}`);
      return item && !isOutsideAutoProcessWindow(item);
    })
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
        && !isOutsideAutoProcessWindow(item)
        && row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
        && row.source_revision === item.revision_hash;
    }).length,
  };
}

module.exports = {
  CRM_KNOWLEDGE_STAGES,
  CRM_KNOWLEDGE_AUTO_PROCESS_AFTER,
  getCrmKnowledgeHealth,
  // Kept public so read-only replay/audit tools can evaluate exactly the same
  // source coverage state as the health view without reimplementing semantics.
  isExcludedEvidence,
  isOutsideAutoProcessWindow,
  latestCurrentReceipt,
  sourceCoverageState,
  _test: {
    latestReceiptRows,
    statusBucket,
    summariseKnowledgeReceipts,
    sourceCoverageState,
    computeSourceCoverageState,
    isOutsideAutoProcessWindow,
  },
};
