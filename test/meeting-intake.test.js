'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isNonPersonEntityName,
  normalizeActionRegister,
  speakerReviewForTranscript,
  applySpeakerMap,
} = require('../lib/meeting-intake');

test('meeting intake treats project and company labels as non-person entities', () => {
  const context = {
    projects: [{ slug: 'm365-rollout', name: 'M365 Rollout' }],
    companies: [{ name: 'Beacon Hospital' }],
  };

  assert.equal(isNonPersonEntityName(context, 'M365 Rollout'), true);
  assert.equal(isNonPersonEntityName(context, 'm365-rollout'), true);
  assert.equal(isNonPersonEntityName(context, 'Beacon Hospital'), true);
  assert.equal(isNonPersonEntityName(context, 'Alec Hirst'), false);
});

test('meeting intake detects Krisp pipe-format placeholder speakers', () => {
  const review = speakerReviewForTranscript([
    'Douglas McLellan | 09:02',
    'Thanks.',
    'Speaker 2 | 09:20',
    'I will circulate the persona matrix today.',
  ].join('\n'));

  assert.equal(review.speakers.length, 1);
  assert.equal(review.speakers[0].label, 'Speaker 2');
  assert.match(review.speakers[0].samples[0], /I will circulate/);
});

test('meeting intake keeps unknown-owner actions in an action register', () => {
  const context = {
    contacts: [{ name: 'Douglas McLellan', aliases: '[]' }],
    projects: [{ slug: 'm365-rollout', name: 'M365 Rollout' }],
  };

  const actions = normalizeActionRegister({
    crm_updates: [{
      subject: 'Speaker 2',
      matched_contact: null,
      type: 'action',
      text: 'Circulate the application/persona matrix by end of day.',
      project_slug: 'm365-rollout',
      due_date: '2026-06-29',
      google_task: false,
    }],
  }, context, context.projects[0]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].owner, 'Speaker 2');
  assert.equal(actions[0].task, 'Circulate the application/persona matrix by end of day.');
  assert.equal(actions[0].project_slug, 'm365-rollout');
});

test('applySpeakerMap rewrites Krisp pipe-format labels and legacy colon labels', () => {
  const krisp = '## Krisp Notes\nSpeaker 1 | 00:00\nHello.\nDouglas McLellan | 00:27\nHi.\nSpeaker 1 | 00:53\nBye.';
  const resolved = applySpeakerMap(krisp, { 'Speaker 1': 'Jane Whelan' });
  assert.equal(resolved.includes('Jane Whelan | 00:00'), true);
  assert.equal(resolved.includes('Jane Whelan | 00:53'), true);
  assert.equal(resolved.includes('Speaker 1'), false);

  const legacy = 'Speaker 2: old style\nSpeaker 2 - dashed';
  const legacyResolved = applySpeakerMap(legacy, { 'Speaker 2': 'Rob' });
  assert.equal(legacyResolved, 'Rob: old style\nRob: dashed');

  const midLine = 'He said Speaker 1 | is a label';
  assert.equal(applySpeakerMap(midLine, { 'Speaker 1': 'X' }), midLine);
});
