'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  actionTaskKey,
  agentmailFactLinks,
  followUpTaskSourceId,
  followUpTaskTitle,
  hasMailSubjectPrefix,
  isForcedWorkSender,
  normalizeActionTasks,
  rootSubject,
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

test('AgentMail follow-up tasks clean repeated forwarded subject prefixes', () => {
  assert.equal(rootSubject('Re: Fw: FW: Devices report'), 'Devices report');
  assert.equal(hasMailSubjectPrefix('Fw: Devices report'), true);
  assert.equal(hasMailSubjectPrefix('Devices report'), false);
});

test('AgentMail follow-up task titles include the specific owner fact', () => {
  assert.equal(
    followUpTaskTitle(
      { name: 'Alec Hirst', fact: 'Alec Hirst needs to confirm which devices are still assigned.' },
      'Fw: Devices report'
    ),
    'Follow up with Alec Hirst: Alec Hirst needs to confirm which devices are still assigned'
  );
});

test('AgentMail follow-up source ids dedupe repeated messages in the same chain', () => {
  const first = followUpTaskSourceId(
    { threadId: 'am-thread-123', subject: 'Fw: Devices report' },
    { name: 'Alec Hirst', fact: 'Alec needs to send the report.' }
  );
  const second = followUpTaskSourceId(
    { threadId: 'am-thread-456', subject: 'Re: Fw: Devices report' },
    { name: 'Alec Hirst', fact: 'Alec has not replied yet.' }
  );
  assert.equal(first, second);
});

test('AgentMail follow-up source ids fall back to root subject when thread id is unavailable', () => {
  const first = followUpTaskSourceId(
    { subject: 'Fw: Devices report' },
    { name: 'Alec Hirst' }
  );
  const second = followUpTaskSourceId(
    { subject: 'RE: Devices report' },
    { name: 'Alec Hirst' }
  );
  assert.equal(first, second);
});

test('AgentMail co-occurrence does not link unrelated contact facts', () => {
  assert.equal(agentmailFactLinks(), '[]');
});

test('Beacon emails from Douglas are always treated as work', () => {
  assert.equal(isForcedWorkSender('douglas.mclellan@beaconhospital.ie'), true);
  assert.equal(isForcedWorkSender(' Douglas.McLellan@BeaconHospital.ie '), true);
  assert.equal(isForcedWorkSender('newsletter@beaconhospital.ie'), false);
});
