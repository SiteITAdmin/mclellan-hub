'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/crm-knowledge-health');

test('knowledge health uses the latest receipt for each source and stage', () => {
  const health = _test.summariseKnowledgeReceipts([
    { receipt_order: 1, stage: 'crm_source_triage', source_kind: 'email_summary', source_id: 'a', status: 'error', created_at: 10 },
    { receipt_order: 2, stage: 'crm_source_triage', source_kind: 'email_summary', source_id: 'a', status: 'done', created_at: 20 },
    { receipt_order: 3, stage: 'crm_source_triage', source_kind: 'email_summary', source_id: 'b', status: 'skipped', created_at: 20 },
    { receipt_order: 4, stage: 'crm_source_triage', source_kind: 'email_summary', source_id: 'c', status: 'already_synthesised', created_at: 20 },
    { receipt_order: 5, stage: 'agent:capo:knowledge', source_kind: 'hub_module', source_id: 'knowledge', status: 'pass', created_at: 30 },
  ]);

  assert.deepEqual(health.stages[0], {
    stage: 'crm_source_triage',
    label: 'Source triage',
    last_at: 20,
    total: 3,
    processed: 1,
    skipped: 2,
    warnings: 0,
    errors: 0,
  });
  assert.equal(health.erroredSourceCount, 0);
});

test('knowledge health separates classified outcomes, warnings, and real errors', () => {
  const health = _test.summariseKnowledgeReceipts([
    { receipt_order: 1, stage: 'crm_duplicate_reviewed', source_kind: 'document', source_id: 'a', status: 'new', created_at: 10 },
    { receipt_order: 2, stage: 'crm_duplicate_reviewed', source_kind: 'document', source_id: 'b', status: 'duplicate', created_at: 11 },
    { receipt_order: 3, stage: 'crm_duplicate_reviewed', source_kind: 'document', source_id: 'c', status: 'uncertain', created_at: 12 },
    { receipt_order: 4, stage: 'crm_duplicate_reviewed', source_kind: 'document', source_id: 'd', status: 'error', created_at: 13 },
  ]);

  assert.deepEqual(health.stages[0], {
    stage: 'crm_duplicate_reviewed',
    label: 'Duplicate review',
    last_at: 13,
    total: 4,
    processed: 2,
    skipped: 0,
    warnings: 1,
    errors: 1,
  });
  assert.equal(health.currentErrors[0].source_id, 'd');
  assert.equal(health.erroredSourceCount, 1);
});

test('terminal action outcomes override a concurrent warning projection receipt', () => {
  const evidence = { source_kind: 'email_summary', source_id: 'source-1', revision_hash: 'revision-1' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'revision-1', ...value,
  });
  const state = _test.sourceCoverageState(evidence, [
    {
      receipt_order: 1, stage: 'crm_source_triage', source_kind: 'email_summary', source_id: 'source-1',
      status: 'done', created_at: 1,
      payload: payload({ should_synthesise: false, candidate_actions: [{ candidate_key: 'action-1' }] }),
    },
    {
      receipt_order: 2, stage: 'crm_action_projected', source_kind: 'email_summary', source_id: 'source-1',
      status: 'review', created_at: 2, payload: payload({}),
    },
  ], [
    {
      source_kind: 'email_summary', source_id: 'source-1', source_revision: 'revision-1',
      pipeline_version: 'crm-evidence-actions-v2', action_key: 'action-1', disposition: 'task_created', payload: '{}',
    },
  ]);
  assert.deepEqual(state, { state: 'complete', reason: 'triage_no_durable_knowledge' });
});

test('coverage is incomplete after a crash immediately following triage', () => {
  const evidence = { source_kind: 'document', source_id: 'crash-after-triage', revision_hash: 'rev-crash' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'rev-crash', ...value,
  });
  const state = _test.sourceCoverageState(evidence, [{
    receipt_order: 1, stage: 'crm_source_triage', source_kind: 'document', source_id: 'crash-after-triage',
    status: 'done', created_at: 1,
    payload: payload({ should_synthesise: false, candidate_actions: [] }),
  }], []);
  assert.deepEqual(state, { state: 'incomplete', reason: 'action_projection_missing' });
});

test('coverage requires a terminal outcome for every triage candidate', () => {
  const evidence = { source_kind: 'document', source_id: 'missing-outcome', revision_hash: 'rev-outcome' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'rev-outcome', ...value,
  });
  const state = _test.sourceCoverageState(evidence, [
    {
      receipt_order: 1, stage: 'crm_source_triage', source_kind: 'document', source_id: 'missing-outcome',
      status: 'done', created_at: 1,
      payload: payload({ should_synthesise: false, candidate_actions: [{ candidate_key: 'candidate-1' }] }),
    },
    {
      receipt_order: 2, stage: 'crm_action_projected', source_kind: 'document', source_id: 'missing-outcome',
      status: 'done', created_at: 2, payload: payload({}),
    },
  ], []);
  assert.deepEqual(state, { state: 'incomplete', reason: 'candidate_without_terminal_outcome' });
});

test('coverage counts every semantic candidate when two asks share one source span', () => {
  const evidence = { source_kind: 'document', source_id: 'shared-span-actions', revision_hash: 'rev-shared-span' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'rev-shared-span', ...value,
  });
  const receipts = [
    {
      receipt_order: 1, stage: 'crm_source_triage', source_kind: 'document', source_id: 'shared-span-actions',
      status: 'done', created_at: 1,
      payload: payload({
        should_synthesise: false,
        candidate_actions: [{ candidate_key: 'send-pack' }, { candidate_key: 'book-review' }],
      }),
    },
    {
      receipt_order: 2, stage: 'crm_action_projected', source_kind: 'document', source_id: 'shared-span-actions',
      status: 'done', created_at: 2, payload: payload({}),
    },
  ];
  const oneOutcome = [{
    source_kind: 'document', source_id: 'shared-span-actions', source_revision: 'rev-shared-span',
    pipeline_version: 'crm-evidence-actions-v2', action_key: 'send-pack', disposition: 'task_created', payload: '{}',
  }];
  assert.deepEqual(
    _test.sourceCoverageState(evidence, receipts, oneOutcome),
    { state: 'incomplete', reason: 'candidate_without_terminal_outcome' },
  );
  assert.deepEqual(
    _test.sourceCoverageState(evidence, receipts, [...oneOutcome, {
      source_kind: 'document', source_id: 'shared-span-actions', source_revision: 'rev-shared-span',
      pipeline_version: 'crm-evidence-actions-v2', action_key: 'book-review', disposition: 'task_created', payload: '{}',
    }]),
    { state: 'complete', reason: 'triage_no_durable_knowledge' },
  );
});

test('coverage requires synthesis when triage requests durable knowledge', () => {
  const evidence = { source_kind: 'document', source_id: 'missing-synthesis', revision_hash: 'rev-synthesis' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'rev-synthesis', ...value,
  });
  const state = _test.sourceCoverageState(evidence, [
    {
      receipt_order: 1, stage: 'crm_source_triage', source_kind: 'document', source_id: 'missing-synthesis',
      status: 'done', created_at: 1,
      payload: payload({ should_synthesise: true, candidate_actions: [] }),
    },
    {
      receipt_order: 2, stage: 'crm_action_projected', source_kind: 'document', source_id: 'missing-synthesis',
      status: 'done', created_at: 2, payload: payload({}),
    },
  ], []);
  assert.deepEqual(state, { state: 'incomplete', reason: 'knowledge_synthesis_missing' });
});

test('coverage is current only when action outcomes and requested synthesis are complete', () => {
  const evidence = { source_kind: 'document', source_id: 'fully-covered', revision_hash: 'rev-complete' };
  const payload = value => JSON.stringify({
    pipeline_version: 'crm-evidence-actions-v2', source_revision: 'rev-complete', ...value,
  });
  const state = _test.sourceCoverageState(evidence, [
    {
      receipt_order: 1, stage: 'crm_source_triage', source_kind: 'document', source_id: 'fully-covered',
      status: 'done', created_at: 1,
      payload: payload({ should_synthesise: true, candidate_actions: [{ candidate_key: 'candidate-1' }] }),
    },
    {
      receipt_order: 2, stage: 'crm_action_projected', source_kind: 'document', source_id: 'fully-covered',
      status: 'review', created_at: 2, payload: payload({}),
    },
    {
      receipt_order: 3, stage: 'crm_knowledge_synthesised', source_kind: 'document', source_id: 'fully-covered',
      status: 'done', created_at: 3, payload: payload({}),
    },
  ], [{
    source_kind: 'document', source_id: 'fully-covered', source_revision: 'rev-complete',
    pipeline_version: 'crm-evidence-actions-v2', action_key: 'candidate-1', disposition: 'task_created', payload: '{}',
  }]);
  assert.deepEqual(state, { state: 'complete', reason: 'done' });
});
