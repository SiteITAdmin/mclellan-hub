'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapWithConcurrency } = require('../lib/concurrency');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mapWithConcurrency preserves input order', async () => {
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
    await delay(n % 2 ? 5 : 1); // vary completion order
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
});

test('mapWithConcurrency never exceeds the concurrency limit', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 4, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(5);
    inFlight -= 1;
  });
  assert.ok(maxInFlight <= 4, `max in-flight ${maxInFlight} exceeded limit 4`);
  assert.ok(maxInFlight > 1, 'expected real parallelism, work ran serially');
});

test('mapWithConcurrency on empty input returns empty array without calling fn', async () => {
  let called = false;
  const out = await mapWithConcurrency([], 5, async () => { called = true; });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('mapWithConcurrency runs all items when limit exceeds length', async () => {
  const out = await mapWithConcurrency([10, 20], 10, async (n) => n + 1);
  assert.deepEqual(out, [11, 21]);
});
