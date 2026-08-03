'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isOpenRouterUrl,
  assertNotOpenRouter,
  OpenRouterBlockedError,
  installOpenRouterNetworkGuard,
  uninstallOpenRouterNetworkGuard,
} = require('../lib/openrouter-guard');
const fetch = require('../lib/fetch');

test('isOpenRouterUrl detects openrouter hostnames', () => {
  assert.equal(isOpenRouterUrl('https://openrouter.ai/api/v1/chat/completions'), true);
  assert.equal(isOpenRouterUrl('https://www.openrouter.ai/api/v1/models'), true);
  assert.equal(isOpenRouterUrl('https://api.exa.ai/search'), false);
  assert.equal(isOpenRouterUrl('hub-model://v1/chat/completions'), false);
});

test('assertNotOpenRouter throws before transmission', () => {
  assert.throws(
    () => assertNotOpenRouter('https://openrouter.ai/api/v1/chat/completions'),
    (err) => err instanceof OpenRouterBlockedError && err.code === 'OPENROUTER_BLOCKED',
  );
});

test('fetch wrapper blocks OpenRouter URLs', async () => {
  await assert.rejects(
    () => fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/model' }),
    }),
    /OpenRouter is retired/,
  );
});

test('process-level guard blocks globalThis.fetch to OpenRouter', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  try {
    installOpenRouterNetworkGuard();
    await assert.rejects(
      () => globalThis.fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST' }),
      /OpenRouter is retired/,
    );
    assert.equal(called, false);
  } finally {
    uninstallOpenRouterNetworkGuard();
    globalThis.fetch = original;
  }
});

test('hub-model:// is not an OpenRouter URL', () => {
  assert.equal(isOpenRouterUrl('hub-model://v1/chat/completions'), false);
});
