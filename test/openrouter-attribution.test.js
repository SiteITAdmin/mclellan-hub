'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  TASK_CODES,
  openRouterHeaders,
  taskCodeForFeature,
} = require('../lib/openrouter-attribution');
const { logOpenRouterUsage } = require('../lib/openrouter-usage');
const { buildTokenBurnPage } = require('../lib/token-burn');

const USER = `openrouter-attribution-test-${Date.now()}`;

test.after(() => {
  db.hub().prepare('DELETE FROM request_logs WHERE user = ?').run(USER);
});

test('builds distinct OpenRouter attribution headers for each task', () => {
  const chat = openRouterHeaders(TASK_CODES.CHAT, { apiKey: 'test-key' });
  const ingest = openRouterHeaders(TASK_CODES.NEWSLETTER_INGEST, { apiKey: 'test-key' });

  assert.equal(chat['X-OpenRouter-Title'], 'UT-Chat');
  assert.equal(chat['X-Title'], 'UT-Chat');
  assert.match(chat['HTTP-Referer'], /\/openrouter-task\/ut-chat$/);
  assert.match(ingest['HTTP-Referer'], /\/openrouter-task\/at-newsletteringest$/);
  assert.notEqual(chat['HTTP-Referer'], ingest['HTTP-Referer']);
  assert.equal(taskCodeForFeature('newsletter-extractor'), 'AT-NewsletterIngest');
});

test('stores task codes and exposes task-level Token Burn totals', () => {
  logOpenRouterUsage({
    user: USER,
    feature: 'newsletter-extractor',
    modelKey: 'newsletter_extractor',
    modelId: 'test/model',
    tokensIn: 120,
    tokensOut: 30,
    costUsd: 0.002,
    durationMs: 500,
    taskCode: TASK_CODES.NEWSLETTER_INGEST,
  });

  const stored = db.hub().prepare(`
    SELECT task_code, tokens_in, tokens_out
      FROM request_logs
     WHERE user = ?
  `).get(USER);
  assert.deepEqual(stored, {
    task_code: 'AT-NewsletterIngest',
    tokens_in: 120,
    tokens_out: 30,
  });

  const page = buildTokenBurnPage(USER);
  const task = page.liveTasks.find(row => row.task_code === 'AT-NewsletterIngest');
  assert.ok(task);
  assert.equal(task.total, 150);
  assert.equal(task.task_type, 'automatic');
});
