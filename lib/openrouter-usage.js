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

function logOpenRouterUsage({
  user = 'system',
  feature = 'openrouter',
  modelKey = '',
  modelId = '',
  tokensIn = 0,
  tokensOut = 0,
  costUsd = 0,
  durationMs = null,
  status = 'ok',
  errorMsg = null,
  taskCode = null,
} = {}) {
  try {
    db.hub().prepare(`
      INSERT INTO request_logs (
        id, user, model_key, model_id, endpoint, search_provider,
        tokens_in, tokens_out, cost_usd, duration_ms, status, error_msg, task_code
      )
      VALUES (?, ?, ?, ?, 'openrouter', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(),
      user || 'system',
      modelKey || modelId || feature,
      modelId || modelKey || '',
      feature,
      Number(tokensIn || 0),
      Number(tokensOut || 0),
      Number(costUsd || 0),
      durationMs,
      status,
      errorMsg ? String(errorMsg).slice(0, 500) : null,
      normalizeTaskCode(taskCode || taskCodeForFeature(feature)),
    );
  } catch (err) {
    console.warn('[openrouter-usage] log skipped:', err.message);
  }
}

function logUsageFromResponse({ user, feature, modelKey, fallbackModelId, data, durationMs, taskCode }) {
  const usage = usageFromResponse(data);
  logOpenRouterUsage({
    user,
    feature,
    modelKey,
    modelId: usage.modelId || fallbackModelId || modelKey,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    durationMs,
    taskCode: taskCode || taskCodeForFeature(feature),
  });
}

module.exports = {
  logOpenRouterUsage,
  logUsageFromResponse,
  usageFromResponse,
};
