'use strict';

// Model usage logging. Historical rows may still show endpoint='openrouter'.
// New rows use the subscription runner name (codex/claude/grok/local).

const db = require('./db');
const { uuid } = require('./id');
const { taskCodeForFeature, normalizeTaskCode } = require('./openrouter-attribution');

function usageFromResponse(data) {
  const usage = data?.usage || {};
  return {
    tokensIn: Number(usage.prompt_tokens || 0),
    tokensOut: Number(usage.completion_tokens || 0),
    costUsd: usage.cost == null ? 0 : Number(usage.cost || 0),
    modelId: data?.model || null,
  };
}

function logModelUsage({
  user = 'system',
  feature = 'model',
  modelKey = '',
  modelId = '',
  endpoint = 'subscription',
  tokensIn = 0,
  tokensOut = 0,
  costUsd = 0,
  durationMs = null,
  status = 'ok',
  errorMsg = null,
  taskCode = null,
  promptFingerprint = null,
} = {}) {
  try {
    db.hub().prepare(`
      INSERT INTO request_logs (
        id, user, model_key, model_id, endpoint, search_provider,
        tokens_in, tokens_out, cost_usd, duration_ms, status, error_msg, task_code,
        prompt_fingerprint
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      user || 'system',
      modelKey || modelId || feature,
      modelId || modelKey || '',
      String(endpoint || 'subscription').slice(0, 40),
      feature,
      Number(tokensIn || 0),
      Number(tokensOut || 0),
      Number(costUsd || 0),
      durationMs,
      status,
      errorMsg ? String(errorMsg).slice(0, 500) : null,
      normalizeTaskCode(taskCode || taskCodeForFeature(feature)),
      promptFingerprint ? String(promptFingerprint).slice(0, 64) : null,
    );
  } catch (err) {
    console.warn('[model-usage] log skipped:', err.message);
  }
}

// Back-compat aliases — callers still import openrouter-usage in many places.
// They now write subscription/local endpoints and never contact OpenRouter.
function logOpenRouterUsage(opts) {
  return logModelUsage({ ...opts, endpoint: opts.endpoint || 'subscription' });
}

function logUsageFromResponse({ user, feature, modelKey, fallbackModelId, data, durationMs, taskCode, endpoint = 'subscription' }) {
  const usage = usageFromResponse(data);
  logModelUsage({
    user,
    feature,
    modelKey,
    modelId: usage.modelId || fallbackModelId || modelKey,
    endpoint,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    durationMs,
    taskCode: taskCode || taskCodeForFeature(feature),
  });
}

module.exports = {
  logModelUsage,
  logOpenRouterUsage,
  logUsageFromResponse,
  usageFromResponse,
};
