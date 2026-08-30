'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../lib/job-queue');

function at(iso) {
  return new Date(iso);
}

test('embedding backfill starts only in the 23:00–01:44 Dublin batch window', () => {
  assert.equal(_test.isEmbedBackfillStartWindow(at('2026-08-30T21:59:00Z')), false, '22:59 Dublin');
  assert.equal(_test.isEmbedBackfillStartWindow(at('2026-08-30T22:00:00Z')), true, '23:00 Dublin');
  assert.equal(_test.isEmbedBackfillStartWindow(at('2026-08-31T00:44:00Z')), true, '01:44 Dublin');
  assert.equal(_test.isEmbedBackfillStartWindow(at('2026-08-31T00:45:00Z')), false, '01:45 Dublin');
  assert.equal(_test.isEmbedBackfillStartWindow(at('2026-08-31T01:29:00Z')), false, '02:29 Dublin');
});

test('embedding backfill requeues quickly only while its overnight window is open', () => {
  const inside = at('2026-08-30T22:30:00Z'); // 23:30 Dublin
  assert.equal(
    _test.nextEmbedBackfillRun(inside, {
      requeueNow: true,
      epochAtNextDublinFn: () => { throw new Error('not needed'); },
    }),
    Math.floor(inside.getTime() / 1000) + 60,
  );

  let scheduled = null;
  _test.nextEmbedBackfillRun(at('2026-08-31T01:30:00Z'), {
    requeueNow: true,
    epochAtNextDublinFn: (hour, minute) => {
      scheduled = { hour, minute };
      return 123;
    },
  });
  assert.deepEqual(scheduled, { hour: 23, minute: 0 });
});
