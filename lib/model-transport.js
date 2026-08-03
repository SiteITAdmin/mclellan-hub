'use strict';

// Unified subscription-backed model transport. Every text reasoning call goes
// through here. OpenRouter is not a transport option.

const crypto = require('crypto');
const { resolveFeatureRunner } = require('./feature-runners');
const { runSubscriptionText, configuredRunner } = require('./subscription-agent');
const jobs = require('./subscription-agent-jobs');
const { logModelUsage } = require('./model-usage');

function messagesToPrompts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = [];
  const userParts = [];
  for (const m of list) {
    const role = String(m?.role || 'user');
    const content = typeof m?.content === 'string'
      ? m.content
      : Array.isArray(m?.content)
        ? m.content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('\n')
        : JSON.stringify(m?.content ?? '');
    if (role === 'system') systemParts.push(content);
    else userParts.push(`${role === 'assistant' ? 'Assistant' : 'User'}: ${content}`);
  }
  return {
    systemPrompt: systemParts.join('\n\n') || 'You are a careful assistant for McLellan Hub. Follow the task instructions exactly.',
    userPrompt: userParts.join('\n\n') || '',
  };
}

function boundPacket({ systemPrompt, userPrompt, maxInputChars }) {
  const max = maxInputChars || 120000;
  const sysBudget = Math.floor(max * 0.35);
  const userBudget = max - sysBudget;
  const sys = String(systemPrompt || '');
  const user = String(userPrompt || '');
  return {
    systemPrompt: sys.length > sysBudget ? `${sys.slice(0, sysBudget)}\n\n[truncated]` : sys,
    userPrompt: user.length > userBudget ? `${user.slice(0, userBudget)}\n\n[truncated]` : user,
    inputChars: Math.min(sys.length, sysBudget) + Math.min(user.length, userBudget),
    truncated: sys.length > sysBudget || user.length > userBudget,
  };
}

/**
 * Run a text model job via local CLI (Mac) or remote Mac worker (VPS).
 * Never falls back to OpenRouter or any other paid API.
 */
async function runModelText({
  feature,
  messages = null,
  systemPrompt = null,
  userPrompt = null,
  timeoutMs = null,
  user = 'system',
  modelKey = null,
  taskCode = null,
  escalate = false,
  // tests inject a runner
  _runner = null,
} = {}) {
  if (!feature) throw new Error('runModelText: feature is required');
  const config = resolveFeatureRunner(feature, { escalate });
  if (config.runner === 'local') {
    throw new Error(`Feature ${feature} requires a local specialist runner, not a text CLI`);
  }

  let sys = systemPrompt;
  let userMsg = userPrompt;
  if (messages) {
    const converted = messagesToPrompts(messages);
    sys = sys || converted.systemPrompt;
    userMsg = userMsg || converted.userPrompt;
  }
  if (!userMsg) throw new Error('runModelText: userPrompt or messages required');

  const packet = boundPacket({
    systemPrompt: sys,
    userPrompt: userMsg,
    maxInputChars: config.maxInputChars,
  });

  const started = Date.now();
  let result;
  try {
    if (_runner) {
      result = await _runner({
        feature,
        systemPrompt: packet.systemPrompt,
        userPrompt: packet.userPrompt,
        timeoutMs: timeoutMs || config.timeoutMs,
        config,
      });
    } else {
      // Prefer local CLI when available (Mac mini worker process, or Hub on darwin).
      const localConfig = configuredRunner(feature, { force: process.env.SUBSCRIPTION_AGENT_LOCAL === '1' || process.platform === 'darwin' });
      if (localConfig || process.env.SUBSCRIPTION_AGENT_LOCAL === '1' || process.platform === 'darwin') {
        const forced = {
          ...config,
          runner: config.runner,
          model: config.model,
          effort: config.effort,
        };
        result = await runSubscriptionText({
          feature,
          systemPrompt: packet.systemPrompt,
          userPrompt: packet.userPrompt,
          timeoutMs: timeoutMs || config.timeoutMs,
          force: true,
          config: forced,
        });
        if (!result) {
          throw new Error(`Local CLI runner unavailable for ${feature} (${config.runner}/${config.model})`);
        }
      } else if (jobs.enabled()) {
        result = await jobs.enqueueAndWait({
          feature,
          systemPrompt: packet.systemPrompt,
          userPrompt: packet.userPrompt,
          timeoutMs: timeoutMs || config.timeoutMs,
          meta: {
            runner: config.runner,
            model: config.model,
            effort: config.effort,
            tier: config.tier,
            inputChars: packet.inputChars,
            truncated: packet.truncated,
          },
          dedupeKey: `text:${feature}:${crypto.randomBytes(12).toString('hex')}`,
        });
      } else {
        throw new Error(
          `No subscription runner available for ${feature}: enable SUBSCRIPTION_AGENT_WORKER_ENABLED=1 on the VPS and run the Mac worker, or set SUBSCRIPTION_AGENT_LOCAL=1 with CLIs present`,
        );
      }
    }

    logModelUsage({
      user,
      feature,
      modelKey: modelKey || feature,
      modelId: `${result.runner}/${result.model}`,
      endpoint: result.runner || config.runner,
      tokensIn: Math.ceil(packet.inputChars / 4),
      tokensOut: Math.ceil(String(result.text || '').length / 4),
      costUsd: 0,
      durationMs: result.durationMs || (Date.now() - started),
      status: 'ok',
      taskCode,
    });

    return {
      text: result.text,
      runner: result.runner || config.runner,
      model: result.model || config.model,
      effort: result.effort || config.effort,
      tier: config.tier,
      durationMs: result.durationMs || (Date.now() - started),
      inputChars: packet.inputChars,
      truncated: packet.truncated,
    };
  } catch (err) {
    logModelUsage({
      user,
      feature,
      modelKey: modelKey || feature,
      modelId: `${config.runner}/${config.model}`,
      endpoint: config.runner,
      durationMs: Date.now() - started,
      status: 'error',
      errorMsg: err.message,
      taskCode,
    });
    throw err;
  }
}

module.exports = {
  runModelText,
  messagesToPrompts,
  boundPacket,
};
