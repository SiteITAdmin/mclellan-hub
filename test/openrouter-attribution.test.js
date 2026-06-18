'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  TASK_CODES,
  openRouterHeaders,
  refererForTaskCode,
  taskCodeForFeature,
  titleForTaskCode,
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
  const mycelium = openRouterHeaders(TASK_CODES.MYCELIUM, { apiKey: 'test-key' });
  const planner = openRouterHeaders(TASK_CODES.LINKEDIN_PLANNER, { apiKey: 'test-key' });
  const promptAdapter = openRouterHeaders(TASK_CODES.PROMPT_ADAPTER, { apiKey: 'test-key' });
  const promptOptimizer = openRouterHeaders(TASK_CODES.PROMPT_OPTIMIZER, { apiKey: 'test-key' });
  const wikiVision = openRouterHeaders(TASK_CODES.WIKI_IMAGE_VISION, { apiKey: 'test-key' });
  const wikiLinking = openRouterHeaders(TASK_CODES.WIKI_LINKING, { apiKey: 'test-key' });
  const hermesCapture = openRouterHeaders(TASK_CODES.HERMES_CRM_CAPTURE, { apiKey: 'test-key' });

  assert.equal(chat['X-OpenRouter-Title'], 'McLellan User: Hub Chat');
  assert.equal(chat['X-Title'], 'McLellan User: Hub Chat');
  assert.equal(ingest['X-OpenRouter-Title'], 'McLellan Auto: Intelligence Email Topic Extraction');
  assert.equal(mycelium['X-OpenRouter-Title'], 'McLellan Auto: Document Task Extraction');
  assert.equal(planner['X-OpenRouter-Title'], 'McLellan User: LinkedIn Research Planning');
  assert.equal(promptAdapter['X-OpenRouter-Title'], 'McLellan User: Prompt Adapter');
  assert.equal(promptOptimizer['X-OpenRouter-Title'], 'McLellan User: Prompt Optimizer');
  assert.equal(wikiVision['X-OpenRouter-Title'], 'McLellan Auto: Wiki Image Vision');
  assert.equal(wikiLinking['X-OpenRouter-Title'], 'McLellan Auto: Wiki Link Discovery');
  assert.equal(hermesCapture['X-OpenRouter-Title'], 'McLellan User: Hermes CRM Capture');
  assert.match(chat['HTTP-Referer'], /^https:\/\/ut-chat\.openrouter\.mclellan\.scot$/);
  assert.match(ingest['HTTP-Referer'], /^https:\/\/at-newsletteringest\.openrouter\.mclellan\.scot$/);
  assert.equal(refererForTaskCode(TASK_CODES.LINKEDIN_SCORER), 'https://ut-linkedinscorer.openrouter.mclellan.scot');
  assert.notEqual(chat['HTTP-Referer'], ingest['HTTP-Referer']);
  assert.equal(taskCodeForFeature('newsletter-extractor'), 'AT-NewsletterIngest');
  assert.equal(taskCodeForFeature('wiki-doc-save'), 'AT-WikiDocPage');
  assert.equal(taskCodeForFeature('wiki-linking'), 'AT-WikiLinking');
  assert.equal(taskCodeForFeature('testbench-prompt-improver'), 'UT-PromptQuickImprover');
  assert.equal(taskCodeForFeature('prompt-optimizer'), 'UT-PromptOptimizer');
  assert.equal(taskCodeForFeature('hermes-crm-capture'), 'UT-HermesCrmCapture');
  assert.equal(titleForTaskCode(taskCodeForFeature('mycelium-doc-tasks')), 'McLellan Auto: Document Task Extraction');
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
