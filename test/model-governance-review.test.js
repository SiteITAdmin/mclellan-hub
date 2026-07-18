const test = require('node:test');
const assert = require('node:assert/strict');

const { isWeeklyReviewDue } = require('../lib/model-governance-review');

test('weekly governance review is due only Sunday at 04:15', () => {
  const sunday = new Date(2026, 6, 19, 4, 15, 0);
  assert.equal(isWeeklyReviewDue(sunday, null), true);
  assert.equal(isWeeklyReviewDue(new Date(2026, 6, 19, 4, 14, 0), null), false);
  assert.equal(isWeeklyReviewDue(new Date(2026, 6, 20, 4, 15, 0), null), false);
});

test('a recent manual review suppresses the scheduled duplicate', () => {
  const sunday = new Date(2026, 6, 19, 4, 15, 0);
  assert.equal(isWeeklyReviewDue(sunday, { generated_at: '2026-07-18T04:15:00.000Z' }), false);
  assert.equal(isWeeklyReviewDue(sunday, { generated_at: '2026-07-10T04:15:00.000Z' }), true);
});
