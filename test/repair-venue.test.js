'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  REPAIR_MAX_TURNS,
  grokCliModel,
  checkScope,
} = require('../lib/repair-venue');

test('self-repair uses the bounded local Grok CLI model', () => {
  assert.equal(REPAIR_MAX_TURNS, 12);
  assert.equal(grokCliModel('grok-4.5'), 'grok-4.5');
  assert.equal(grokCliModel('x-ai/grok-4.5'), 'grok-4.5');
  assert.throws(() => grokCliModel('google/gemini-2.5-pro-preview'), /must be Grok 4.5/);
});

test('self-repair still rejects an executor that makes no change', () => {
  const scope = checkScope({ constraints: { allowed_paths: ['lib/example.js'], forbidden: [] } }, []);
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /Grok made no changes/);
});
