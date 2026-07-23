'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/google-calendar');

test('toRfc3339 pads seconds onto the crm_action_projection prompt format', () => {
  // Discovered live: the Calendar API 400s on "YYYY-MM-DDTHH:MM" with no
  // seconds, which is exactly the format the model is asked to return.
  assert.equal(_test.toRfc3339('2026-07-24T13:30'), '2026-07-24T13:30:00');
});

test('toRfc3339 leaves an already-complete RFC3339 timestamp alone', () => {
  assert.equal(_test.toRfc3339('2026-07-24T13:30:00'), '2026-07-24T13:30:00');
  assert.equal(_test.toRfc3339('2026-07-24T13:30:00+01:00'), '2026-07-24T13:30:00+01:00');
});
