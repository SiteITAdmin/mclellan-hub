'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fetch = require('../lib/fetch');

test('native fetch wrapper preserves timeout behavior', async () => {
  const originalFetch = globalThis.fetch;
  let receivedSignal;
  globalThis.fetch = async (_url, options) => {
    receivedSignal = options.signal;
    return { ok: true };
  };
  try {
    await fetch('https://example.invalid', { timeout: 10 });
    assert(receivedSignal instanceof AbortSignal);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(receivedSignal.aborted, true);
    assert.equal(receivedSignal.reason?.name, 'TimeoutError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
