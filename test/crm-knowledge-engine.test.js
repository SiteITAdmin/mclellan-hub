'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/crm-knowledge-engine');
const { PROMPTS } = require('../lib/prompts');

test('completed tasks are terminal and cannot project replacement tasks', () => {
  assert.equal(
    _test.actionProjectionBlockReason('completed_task', null),
    'completed_task_is_terminal',
  );
});

test('high-confidence duplicate reviews block action projection', () => {
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.92,
    }),
    'duplicate_review_duplicate',
  );
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.6,
    }),
    null,
  );
});

test('task history exposes authoritative human state to action synthesis', () => {
  assert.equal(_test.taskState({ status: 'needsAction', deleted_at: 1 }), 'deleted');
  assert.equal(_test.taskState({ status: 'wrong', deleted_at: 1 }), 'wrong');
  assert.equal(_test.taskState({ status: 'completed', deleted_at: null }), 'completed');
  assert.match(PROMPTS.crm_action_projection, /deleted, and wrong task states as authoritative human decisions/);
  assert.match(_test.ACTION_STATE_GUARD, /authoritative human decisions/);
});
