'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { categoriseLines } = require('../lib/system-report');

test('subsystem failures are also classified as errors', () => {
  const categories = categoriseLines([
    "Jun 11 node[1]: [email] classify error for message abc: bad response",
    "Jun 11 node[1]: [agentmail] failed def: null response",
  ]);
  assert.equal(categories.email.length, 1);
  assert.equal(categories.agentmail.length, 1);
  assert.equal(categories.errors.length, 2);
});

test('punycode warning pairs collapse into one useful summary', () => {
  const categories = categoriseLines([
    "Jun 11 node[1]: (node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
    "Jun 11 node[1]: (Use `node --trace-deprecation ...` to show where the warning was created)",
    "Jun 11 node[2]: (node:2) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
    "Jun 11 node[2]: (Use `node --trace-deprecation ...` to show where the warning was created)",
  ]);
  assert.deepEqual(categories.errors, [
    'DeprecationWarning [DEP0040]: node-fetch loaded deprecated punycode (2 occurrences)',
  ]);
});

test('ordinary prose containing warning is not treated as an error', () => {
  const categories = categoriseLines([
    '[newsletter] extracted topics from "A warning to Washington"',
  ]);
  assert.equal(categories.errors.length, 0);
  assert.equal(categories.newsletter.length, 1);
});
