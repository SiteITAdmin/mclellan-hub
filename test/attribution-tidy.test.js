'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decideReview,
  decideTaskOwner,
  inferProjectSlug,
  isFalseEmployment,
} = require('../lib/attribution-tidy');

test('false Microsoft employment facts are retired, not re-homed', () => {
  assert.equal(isFalseEmployment({ predicate: 'works_at', value: 'Microsoft' }), true);
  assert.equal(isFalseEmployment({ predicate: 'works_at', value: 'Microsoft Teams' }), true);
  assert.equal(isFalseEmployment({ predicate: 'fact', value: 'Intune is part of the E3 package' }), false);
});

test('org facts inherit the meeting project or infer one from the claim', () => {
  assert.equal(inferProjectSlug(
    { predicate: 'fact', value: 'pilot user list for M365 Rollout confirmed' },
    { project_slug: 'm365-rollout' }
  ), 'm365-rollout');
  assert.equal(inferProjectSlug(
    { predicate: 'fact', value: 'There are currently 6 domain controllers' },
    { title: 'Entra Meeting' }
  ), 'ad-entra-rebuild-inc-hardware');
  assert.equal(inferProjectSlug(
    { predicate: 'fact', value: 'needs to make Power BI reports person-independent' },
    { title: 'Mobile recording' }
  ), 'powerbi-managment');
});

test('task-owner conflicts pick the doer, collapsing Jane to Jane Whelan', () => {
  assert.equal(decideTaskOwner({
    task: { title: 'Get approval to sign off the tool' },
    owners: [{ name: 'Jane' }, { name: 'Douglas McLellan' }, { name: 'Jane Whelan' }],
  }).owner, 'Jane Whelan');
  assert.equal(decideTaskOwner({
    task: { title: 'Confirm revised pilot build timeline and laptop delivery dates' },
  }).owner, 'Neil Midlane');
  assert.equal(decideTaskOwner({
    task: { title: 'Complete remaining shared mailbox imports and resolve failed PSTs' },
  }).owner, 'Nick Chin');
});

test('Nicola keeps the HLD-comments action; family assessment-bed is Douglas', () => {
  const hld = decideReview({
    target_kind: 'action_owner',
    verdict: 'correct_link',
    current_contact: { name: 'Nicola Wolfe' },
    proposed_contact_name: 'Douglas McLellan',
    task: { title: 'Confirm the HLD comments, close those that are resolved, and return the updated document.' },
    evidence_quote: 'So I was just going to say to my team, then we just have a quick meeting.',
  });
  assert.equal(hld.action, 'keep_current');

  const bed = decideReview({
    target_kind: 'projected_action_owner',
    verdict: 'correct_link',
    current_contact: { name: 'Lindsay NHS Fife' },
    proposed_contact_name: 'Douglas McLellan',
    task: { title: 'Request hospital social work referral for six-week care home assessment bed' },
    evidence_quote: 'I think that would be the main one to do I think',
  });
  assert.equal(bed.action, 'apply_correct_link');
  assert.equal(bed.contactName, 'Douglas McLellan');
});
