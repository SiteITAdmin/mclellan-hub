'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../scripts/build-nakai-daily-briefing');

test('daily briefing has a distinct bounded fallback model attempt', () => {
  const attempts = _test.briefingModelAttempts('z-ai/glm-5.2');

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(a => a.role), ['primary', 'fallback']);
  assert.equal(attempts[0].modelId, 'z-ai/glm-5.2');
  assert.equal(attempts[0].timeout, 180000);
  assert.equal(attempts[1].modelId, 'google/gemini-2.5-flash');
  assert.equal(attempts[1].timeout, 120000);
});

test('daily briefing does not repeat the same model as its own fallback', () => {
  const attempts = _test.briefingModelAttempts('google/gemini-2.5-flash');

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].role, 'primary');
});
