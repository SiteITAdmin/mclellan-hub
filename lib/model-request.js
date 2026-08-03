'use strict';

// Agent-level self-check for model JSON calls (check + receipt rung).
// Every background feature that expects a JSON object from a model goes
// through requestModelObject(): subscription CLI transport, shape validation,
// bounded retries, receipts in request_logs. Never OpenRouter.

const { parseModelObject } = require('./model-response');
const { taskCodeForFeature } = require('./openrouter-attribution');
const { logModelUsage } = require('./model-usage');
const { runModelText } = require('./model-transport');
const db = require('./db');

const DEFAULT_RETRY_INSTRUCTION =
  'Retry instruction: return one valid JSON object only. Do not return null, an array, prose, markdown, or an empty response. Use null for uncertain fields.';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractJsonCandidate(text) {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  // Strip common markdown fences from CLI models.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

/**
 * Call a subscription-backed model that must return a JSON object.
 * modelId is accepted for call-site compatibility but routing uses `feature`
 * via the feature-runners registry — OpenRouter model ids are never contacted.
 */
async function requestModelObject({
  modelId,
  messages,
  feature,
  modelKey = feature,
  taskCode,
  user = 'system',
  defaults = {},
  label = 'AI response',
  temperature = 0.1, // ignored — CLIs manage sampling
  maxTokens = 1024, // ignored for transport; bounds enforced via maxOutputChars
  responseFormat = { type: 'json_object' },
  attempts = 2,
  backoffMs = 1000,
  timeout = undefined,
  extraBody = {},
  retryInstruction = DEFAULT_RETRY_INSTRUCTION,
  meta = false,
  _runner = null,
} = {}) {
  // modelId retained for attribution only; transport never uses OpenRouter.
  void modelId; void temperature; void maxTokens; void responseFormat; void extraBody;
  if (!Array.isArray(messages) || !messages.length) throw new Error('requestModelObject: messages are required');
  if (!feature) throw new Error('requestModelObject: feature is required');
  const resolvedTaskCode = taskCode || taskCodeForFeature(feature);

  let lastError = null;
  const total = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && backoffMs) await sleep(backoffMs * (attempt - 1));

    const attemptMessages = attempt === 1 ? messages : messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? { ...m, content: `${m.content}\n\n${retryInstruction}` }
        : m,
    );

    // Nudge JSON object contract into the system side on every attempt.
    const withJsonContract = [
      {
        role: 'system',
        content: 'Return one valid JSON object only. No markdown fences, no prose outside the object.',
      },
      ...attemptMessages,
    ];

    const started = Date.now();
    let text;
    let transportMeta = {};
    try {
      const result = await runModelText({
        feature,
        messages: withJsonContract,
        timeoutMs: timeout,
        user,
        modelKey,
        taskCode: resolvedTaskCode,
        _runner,
      });
      text = result.text;
      transportMeta = result;
      total.tokensIn += Math.ceil((result.inputChars || 0) / 4);
      total.tokensOut += Math.ceil(String(text || '').length / 4);
    } catch (err) {
      // Transport failure: fail closed, no OpenRouter fallback.
      throw err;
    }

    const durationMs = Date.now() - started;
    try {
      const parsed = parseModelObject(extractJsonCandidate(text), defaults, label);
      // Transport already logged ok; add shape-recovery marker when needed.
      if (attempt > 1) {
        logModelUsage({
          user, feature, modelKey,
          modelId: `${transportMeta.runner}/${transportMeta.model}`,
          endpoint: transportMeta.runner || 'subscription',
          tokensIn: 0, tokensOut: 0, costUsd: 0,
          durationMs,
          status: 'retried',
          errorMsg: `recovered after ${attempt - 1} bad-shape response(s): ${lastError?.message}`,
          taskCode: resolvedTaskCode,
        });
      }
      return meta
        ? {
            object: parsed,
            modelId: `${transportMeta.runner}/${transportMeta.model}`,
            usage: total,
            attempts: attempt,
            runner: transportMeta.runner,
            model: transportMeta.model,
          }
        : parsed;
    } catch (err) {
      lastError = err;
      logModelUsage({
        user, feature, modelKey,
        modelId: `${transportMeta.runner || '?'}/${transportMeta.model || '?'}`,
        endpoint: transportMeta.runner || 'subscription',
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

/** Free-text model call (briefings, wiki, chat synthesis). */
async function requestModelText(opts) {
  const result = await runModelText(opts);
  return opts.meta ? result : result.text;
}

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

module.exports = {
  requestModelObject,
  requestModelText,
  modelShapeHealth,
  DEFAULT_RETRY_INSTRUCTION,
  extractJsonCandidate,
};
