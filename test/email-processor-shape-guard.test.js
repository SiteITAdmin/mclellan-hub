'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub dependencies before we require the module under test.
const fetchPath = require.resolve('../lib/fetch');
const settingsPath = require.resolve('../lib/settings');
const promptsPath = require.resolve('../lib/prompts');
const taskLearningPath = require.resolve('../lib/task-learning');
const retrievalPath = require.resolve('../lib/retrieval');
const openrouterAttributionPath = require.resolve('../lib/openrouter-attribution');
const openrouterUsagePath = require.resolve('../lib/openrouter-usage');

let fetchCallCount = 0;
let fetchResponse = {
  ok: true,
  json: async () => ({
    choices: [{ message: { content: 'null' } }],
  }),
};

require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: async () => {
    fetchCallCount++;
    return fetchResponse;
  },
};

require.cache[settingsPath] = {
  id: settingsPath,
  filename: settingsPath,
  loaded: true,
  exports: {
    getSystemModelId: () => 'mock/model',
    getSystemPrompt: () => 'mock prompt',
  },
};

require.cache[promptsPath] = {
  id: promptsPath,
  filename: promptsPath,
  loaded: true,
  exports: { PROMPTS: {} },
};

require.cache[taskLearningPath] = {
  id: taskLearningPath,
  filename: taskLearningPath,
  loaded: true,
  exports: { formatLearnedTaskRules: () => '' },
};

require.cache[retrievalPath] = {
  id: retrievalPath,
  filename: retrievalPath,
  loaded: true,
  exports: { semanticSearch: async () => [] },
};

require.cache[openrouterAttributionPath] = {
  id: openrouterAttributionPath,
  filename: openrouterAttributionPath,
  loaded: true,
  exports: { openRouterHeaders: () => ({}), TASK_CODES: { EMAIL_CLASSIFICATION: 'test' } },
};

require.cache[openrouterUsagePath] = {
  id: openrouterUsagePath,
  filename: openrouterUsagePath,
  loaded: true,
  exports: { logUsageFromResponse: () => {} },
};

// Now that stubs are in place, we can load the module.
const { classifyEmail } = require('../lib/email-processor');

test.beforeEach(() => {
  fetchCallCount = 0;
});

test('email classifier retries on response shape error and then throws', async t => {
  const warnLogs = [];
  t.mock.method(console, 'warn', msg => warnLogs.push(msg));
  // Speed up the test by making the backoff delay immediate
  t.mock.method(global, 'setTimeout', (callback) => callback());

  const dummyEmail = { fromName: 'Test', fromEmail: 'test@example.com', 'subject': 'test', bodyText: 'test' };

  await assert.rejects(
    classifyEmail(dummyEmail, [], [], []),
    {
      message: '[email] email-classifier failed after 3 attempts: Email classifier response must be a JSON object'
    }
  );

  assert.equal(fetchCallCount, 3, 'Model should have been tried 3 times');
  assert.equal(warnLogs.length, 2, 'A warning should be logged for each retry');
  assert.match(warnLogs[0], /retrying in 1s \(attempt 2\)/);
  assert.match(warnLogs[1], /retrying in 2s \(attempt 3\)/);
});

test('email classifier retries on network error and then throws', async t => {
  fetchResponse = { ok: false, status: 500 };
  const warnLogs = [];
  t.mock.method(console, 'warn', msg => warnLogs.push(msg));
  t.mock.method(global, 'setTimeout', (callback) => callback());

  const dummyEmail = { fromName: 'Test', fromEmail: 'test@example.com', 'subject': 'test', bodyText: 'test' };

  await assert.rejects(
    classifyEmail(dummyEmail, [], [], []),
    {
      message: '[email] email-classifier failed after 3 attempts: OpenRouter 500'
    }
  );

  assert.equal(fetchCallCount, 3, 'Model should have been tried 3 times');
  assert.equal(warnLogs.length, 2, 'A warning should be logged for each retry');
  assert.match(warnLogs[0], /retrying in 1s \(attempt 2\)/);
  assert.match(warnLogs[1], /retrying in 2s \(attempt 3\)/);
});
