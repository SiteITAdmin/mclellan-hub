'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isNonPersonEntityName } = require('../lib/meeting-intake');

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
