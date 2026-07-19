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
