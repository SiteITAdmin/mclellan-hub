'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  actionTaskKey,
  normalizeActionTasks,
} = require('../lib/agentmail-processor');

test('AgentMail supports several distinct actions from one digest', () => {
  assert.deepEqual(normalizeActionTasks({
    action_tasks: [
      { title: 'Confirm the PST repository', evidence: 'Nick asked for confirmation.' },
      { title: 'Investigate the protected Excel files' },
      { title: 'Confirm the PST repository' },
    ],
  }), [
    { title: 'Confirm the PST repository', evidence: 'Nick asked for confirmation.' },
    { title: 'Investigate the protected Excel files', evidence: '' },
  ]);
});

test('AgentMail remains compatible with the old single-action response', () => {
  assert.deepEqual(normalizeActionTasks({
    action_task: 'Reply to Alan',
  }), [
    { title: 'Reply to Alan', evidence: '' },
  ]);
});

test('AgentMail action keys are stable for task deduplication', () => {
  assert.equal(actionTaskKey(' Confirm the PST repository! '), 'confirm-the-pst-repository');
});
