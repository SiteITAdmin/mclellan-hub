'use strict';

// The agent-level self-check for model JSON calls (the "check + receipt" rung
// of the agentic operating model, docs/agentic-build-operating-model.md).
//
// Every background feature that expects a JSON object from a model goes
// through requestModelObject(): one place that calls OpenRouter, validates
// the response shape via parseModelObject, retries with a corrective
// instruction and backoff, and — critically — records the truth of each
// attempt in request_logs.status:
//
//   'ok'            clean first-attempt success
//   'retried'       succeeded, but only after >=1 bad-shape response
//   'shape_failure' this attempt returned an unusable shape
//
// Before this existed, a retry that rescued a bad response was invisible:
// the call logged status='ok' and nobody could see that a model slot was
// degrading until calls started crashing outright. The model_governance capo
// reads these statuses (modelShapeHealth below), so a slot whose retry rate
// climbs is escalated as a config problem BEFORE jobs start failing.

const fetch = require('./fetch');
const db = require('./db');
const { parseModelObject } = require('./model-response');
const { openRouterHeaders, taskCodeForFeature } = require('./openrouter-attribution');
const { logOpenRouterUsage, usageFromResponse } = require('./openrouter-usage');

const DEFAULT_RETRY_INSTRUCTION =
  'Retry instruction: return one valid JSON object only. Do not return null, an array, prose, markdown, or an empty response. Use null for uncertain fields.';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call an OpenRouter chat model that must return a JSON object. Returns the
// parsed object (defaults merged). Throws the last parse error when every
// attempt returns a bad shape — the error message keeps parseModelObject's
// wording ("<label> must be a JSON object" / "<label> was not valid JSON") so
// downstream monitoring, processing_failures, and the repair venue's error
// classes keep matching.
async function requestModelObject({
  modelId,
  messages,
  feature,
  modelKey = feature,
  taskCode,
  user = 'system',
  defaults = {},
  label = 'AI response',
  temperature = 0.1,
  // Number, or function(attempt) for callers that shrink the budget on retry
  // to let a truncation-prone model finish its JSON cleanly.
  // Default is deliberate: omitting max_tokens makes OpenRouter reserve a huge
  // completion budget (often 64k). With a thin prepaid balance that reservation
  // alone returns 402 even when the actual reply would be a few hundred tokens.
  // JSON classifiers/CRM stages almost never need more than ~1k output tokens.
  maxTokens = 1024,
  responseFormat = { type: 'json_object' },
  attempts = 2,
  backoffMs = 1000,
  timeout = undefined,
  extraBody = {},
  retryInstruction = DEFAULT_RETRY_INSTRUCTION,
  // meta: true returns { object, modelId, usage, attempts } instead of the
  // bare object, for callers that record run receipts.
  meta = false,
} = {}) {
  if (!modelId) throw new Error('requestModelObject: modelId is required');
  if (!Array.isArray(messages) || !messages.length) throw new Error('requestModelObject: messages are required');
  const resolvedTaskCode = taskCode || taskCodeForFeature(feature);

  let lastError = null;
  const total = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && backoffMs) await sleep(backoffMs * (attempt - 1));

    // On retry, restate the shape contract on the last user message — the
    // bad response is usually a formatting lapse, not a capability gap.
    const attemptMessages = attempt === 1 ? messages : messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\n${retryInstruction}` }
        : m,
    );
    const attemptMaxTokens = typeof maxTokens === 'function' ? maxTokens(attempt) : maxTokens;

    const started = Date.now();
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders(resolvedTaskCode),
      body: JSON.stringify({
        model: modelId,
        messages: attemptMessages,
        response_format: responseFormat,
        temperature,
        ...(attemptMaxTokens ? { max_tokens: attemptMaxTokens } : {}),
        ...extraBody,
      }),
      ...(timeout ? { timeout } : {}),
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
    const data = await resp.json();
    const usage = usageFromResponse(data);
    total.tokensIn += usage.tokensIn; total.tokensOut += usage.tokensOut; total.costUsd += usage.costUsd;
    const durationMs = Date.now() - started;

    try {
      const parsed = parseModelObject(data.choices?.[0]?.message?.content, defaults, label);
      logOpenRouterUsage({
        user, feature, modelKey,
        modelId: usage.modelId || modelId,
        tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
        durationMs,
        status: attempt === 1 ? 'ok' : 'retried',
        errorMsg: attempt === 1 ? null : `recovered after ${attempt - 1} bad-shape response(s): ${lastError?.message}`,
        taskCode: resolvedTaskCode,
      });
      return meta
        ? { object: parsed, modelId: usage.modelId || modelId, usage: total, attempts: attempt }
        : parsed;
    } catch (err) {
      lastError = err;
      logOpenRouterUsage({
        user, feature, modelKey,
        modelId: usage.modelId || modelId,
        tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
        durationMs,
        status: 'shape_failure',
        errorMsg: err.message,
        taskCode: resolvedTaskCode,
      });
      if (attempt < attempts) {
        console.warn(`[model-request] ${feature} retrying after invalid model response:`, err.message);
      }
    }
  }
  throw lastError;
}

// Shape health per model slot over a window, from the statuses recorded
// above. Consumed by the model_governance capo: a slot that only succeeds on
// retry (or fails outright) at a high rate is a model/config problem to fix
// in /admin/models/system before it becomes crashed jobs.
function modelShapeHealth({ sinceEpoch = Math.floor(Date.now() / 1000) - 86400, minCalls = 10 } = {}) {
  let rows = [];
  try {
    rows = db.hub().prepare(`
      SELECT model_key, model_id,
             COUNT(*) AS attempts,
             SUM(CASE WHEN status = 'shape_failure' THEN 1 ELSE 0 END) AS shape_failures,
             SUM(CASE WHEN status = 'retried' THEN 1 ELSE 0 END) AS recoveries
      FROM request_logs
      WHERE ts >= ? AND status IN ('ok', 'retried', 'shape_failure')
      GROUP BY model_key, model_id
    `).all(sinceEpoch);
  } catch (_) {
    return { unhealthy: [], watched: 0 };
  }
  const unhealthy = [];
  let watched = 0;
  for (const row of rows) {
    if (Number(row.attempts) < minCalls) continue;
    watched++;
    const failureRate = Number(row.shape_failures) / Number(row.attempts);
    if (failureRate >= 0.1) {
      unhealthy.push({
        model_key: row.model_key,
        model_id: row.model_id,
        attempts: Number(row.attempts),
        shape_failures: Number(row.shape_failures),
        recoveries: Number(row.recoveries),
        failure_rate: Number(failureRate.toFixed(3)),
      });
    }
  }
  unhealthy.sort((a, b) => b.failure_rate - a.failure_rate);
  return { unhealthy, watched };
}

module.exports = { requestModelObject, modelShapeHealth, DEFAULT_RETRY_INSTRUCTION };
