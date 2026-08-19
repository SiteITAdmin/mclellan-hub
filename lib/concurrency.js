'use strict';

// Bounded-concurrency map: runs `fn` over `items` with at most `limit` promises
// in flight at once, and returns results in input order. Used to parallelise the
// per-list Google Tasks pull and the per-task Calendar-block removal on snooze
// without an unbounded Promise.all that could trip Google's per-user API quotas.
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  if (!list.length) return results;
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, list.length));
  const workers = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = next;
        next += 1;
        if (i >= list.length) break;
        results[i] = await fn(list[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
