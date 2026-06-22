'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('fetch gate logs and stamps OpenRouter requests missing attribution', async () => {
  const fetch = require('../lib/fetch');
  const logPath = path.join(os.tmpdir(), `openrouter-gate-${Date.now()}.jsonl`);
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_GATE_LOG = logPath;

  let sentOptions;
  globalThis.fetch = async (_url, options) => {
    sentOptions = options;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test/model' }),
    });

    assert.equal(sentOptions.headers['HTTP-Referer'], 'https://at-unclassified.openrouter.mclellan.scot');
    assert.equal(sentOptions.headers['X-OpenRouter-Title'], 'McLellan Auto: Unclassified OpenRouter Call');

    const line = fs.readFileSync(logPath, 'utf8').trim();
    const event = JSON.parse(line);
    assert.equal(event.ok, false);
    assert.equal(event.violation, 'missing_openrouter_attribution');
    assert.equal(event.model, 'test/model');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_GATE_LOG;
    try { fs.unlinkSync(logPath); } catch (_) {}
  }
});

test('fetch gate records attributed OpenRouter requests without changing headers', async () => {
  const fetch = require('../lib/fetch');
  const logPath = path.join(os.tmpdir(), `openrouter-gate-ok-${Date.now()}.jsonl`);
  const originalFetch = globalThis.fetch;
  process.env.OPENROUTER_GATE_LOG = logPath;

  let sentOptions;
  globalThis.fetch = async (_url, options) => {
    sentOptions = options;
    return new Response('{}', { status: 200 });
  };

  try {
    await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://example.test',
        'X-OpenRouter-Title': 'Example App',
      },
      body: JSON.stringify({ model: 'test/model' }),
    });

    assert.equal(sentOptions.headers['HTTP-Referer'], 'https://example.test');
    assert.equal(sentOptions.headers['X-OpenRouter-Title'], 'Example App');

    const event = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.equal(event.ok, true);
    assert.equal(event.violation, null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENROUTER_GATE_LOG;
    try { fs.unlinkSync(logPath); } catch (_) {}
  }
});
