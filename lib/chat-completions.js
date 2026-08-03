'use strict';

// Drop-in replacement for former OpenRouter chat/completions call sites.
// Routes every request through the subscription worker plane.

const { requestModelObject, requestModelText, extractJsonCandidate } = require('./model-request');
const { runModelText } = require('./model-transport');
const { parseModelObject } = require('./model-response');

async function chatJson({
  feature,
  messages,
  user = 'system',
  modelId = 'subscription',
  defaults = {},
  label = 'AI response',
  temperature,
  maxTokens,
  attempts = 2,
  timeout,
  meta = false,
} = {}) {
  return requestModelObject({
    modelId,
    messages,
    feature,
    user,
    defaults,
    label,
    temperature,
    maxTokens,
    attempts,
    timeout,
    meta,
  });
}

async function chatText({
  feature,
  messages,
  systemPrompt,
  userPrompt,
  user = 'system',
  modelId = 'subscription',
  timeout,
  meta = false,
} = {}) {
  void modelId;
  const result = await runModelText({
    feature,
    messages,
    systemPrompt,
    userPrompt,
    timeoutMs: timeout,
    user,
  });
  return meta ? result : result.text;
}

/** Fake-stream: run the full CLI job then emit the text in small chunks. */
async function streamChat({
  feature,
  messages,
  systemPrompt,
  userPrompt,
  onChunk,
  user = 'system',
  timeout,
} = {}) {
  const result = await runModelText({
    feature,
    messages,
    systemPrompt,
    userPrompt,
    timeoutMs: timeout,
    user,
  });
  const text = String(result.text || '');
  const step = 48;
  if (typeof onChunk === 'function') {
    for (let i = 0; i < text.length; i += step) onChunk(text.slice(i, i + step));
  }
  return {
    content: text,
    tokensIn: Math.ceil((result.inputChars || 0) / 4),
    tokensOut: Math.ceil(text.length / 4),
    actualCostUsd: 0,
    sources: [],
    actualModelId: `${result.runner}/${result.model}`,
    runner: result.runner,
    model: result.model,
  };
}

function parseJsonText(text, defaults = {}, label = 'AI response') {
  return parseModelObject(extractJsonCandidate(text), defaults, label);
}

module.exports = {
  chatJson,
  chatText,
  streamChat,
  parseJsonText,
  requestModelObject,
  requestModelText,
};
