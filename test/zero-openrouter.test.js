'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function scanExecutableOpenRouterUrls() {
  const result = spawnSync(
    'rg',
    [
      '-n',
      'https://openrouter\\.ai',
      '-g', '*.js',
      '-g', '*.mjs',
      '-g', '*.cjs',
      '--glob', '!node_modules/**',
      '--glob', '!.claude/**',
      '--glob', '!.repair-worktrees/**',
      '--glob', '!automation-discovery-run/**',
      '--glob', '!data/**',
      '--glob', '!scripts/repair/**',
      '--glob', '!token-burn-dashboard/node_modules/**',
      '--glob', '!test/**',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  // Guard may still name the host for blocking — that is not request construction.
  return lines.filter(line => !line.includes('lib/openrouter-guard.js') && !line.includes('// '));
}

test('static scan: no OpenRouter URL request construction in executable code', () => {
  const hits = scanExecutableOpenRouterUrls();
  assert.deepEqual(hits, [], hits.join('\n'));
});

test('token-burn sync script is retired and does not call OpenRouter', () => {
  const p = path.join(ROOT, 'token-burn-dashboard/scripts/sync-openrouter-activity.mjs');
  const src = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(src, /https:\/\/openrouter\.ai/);
  assert.match(src, /retired/i);
});

test('CLI failure path cannot call OpenRouter (guard + transport)', async () => {
  const { requestModelObject } = require('../lib/model-request');
  const { assertNotOpenRouter } = require('../lib/openrouter-guard');
  await assert.rejects(
    requestModelObject({
      modelId: 'x-ai/grok-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      feature: 'email_classifier',
      backoffMs: 0,
      attempts: 1,
      _runner: async () => { throw new Error('CLI out of credits'); },
    }),
    /CLI out of credits/,
  );
  // Even a mistaken direct attempt is blocked.
  assert.throws(() => assertNotOpenRouter('https://openrouter.ai/api/v1/chat/completions'));
});

test('embedding failure does not contact OpenRouter', async () => {
  const fetch = require('../lib/fetch');
  const resp = await fetch('hub-model://v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model: 'x', input: 'hi' }),
  });
  assert.equal(resp.ok, false);
  assert.equal(resp.status, 503);
  await assert.rejects(
    () => fetch('https://openrouter.ai/api/v1/embeddings', { method: 'POST' }),
    /OpenRouter is retired/,
  );
});

test('openRouterHeaders never emits OpenRouter credentials', () => {
  const { openRouterHeaders } = require('../lib/openrouter-attribution');
  const h = openRouterHeaders('AT-EmailClassification', { apiKey: 'sk-or-v1-secret' });
  assert.equal(h.Authorization, undefined);
  assert.ok(h['X-Hub-Task-Code']);
});
