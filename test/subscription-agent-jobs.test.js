'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { completeRemoteCrossEntitySynthesis } = require('../lib/knowledge-synthesis');

test('remote cross-entity completion retains prior insights for a valid empty result', () => {
  const result = completeRemoteCrossEntitySynthesis({ user: 'test-user', atoms: [] }, '{"insights":[]}');
  assert.equal(result.retained, true);
  assert.equal(result.reason, 'no_valid_insights');
});
