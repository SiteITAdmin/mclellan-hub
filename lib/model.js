'use strict';

// Model calls for the public sites' chat and JD analyser. Work is queued for
// the Mac mini subscription worker (Claude/Codex CLIs); there is no API-key or
// OpenRouter path. The CLIs return a whole answer, so streaming callers get it
// in one chunk.

const { enqueueAndWait } = require('./subscription-agent-jobs');

function messagesToPrompts(messages) {
  const systemParts = [];
  const userParts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = String(m?.role || 'user');
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    if (role === 'system') systemParts.push(content);
    else userParts.push(`${role === 'assistant' ? 'Assistant' : 'User'}: ${content}`);
  }
  return { systemPrompt: systemParts.join('\n\n'), userPrompt: userParts.join('\n\n') };
}

async function routeMessage({ feature = 'hub_chat', messages, onChunk } = {}) {
  const { systemPrompt, userPrompt } = messagesToPrompts(messages);
  const content = await enqueueAndWait({ feature, systemPrompt, userPrompt })
    .then(result => String(result?.text ?? result ?? ''));
  if (typeof onChunk === 'function' && content) onChunk(content);
  return { content };
}

function enqueueModelJob({ feature, dedupeKey, systemPrompt, userPrompt, documents, meta }, jobs = require('./subscription-agent-jobs')) {
  const runner = require('./feature-runners').resolveFeatureRunner(feature);
  if (documents && feature !== 'crm_boox_read') throw new Error('PDF reading is only enabled for Boox pages');
  return jobs.enqueue({ feature, dedupeKey, mode: 'raw_output', payload: {
    systemPrompt, userPrompt, documents, meta, runner: runner.runner, model: runner.model, effort: runner.effort,
  } });
}

module.exports = { routeMessage, messagesToPrompts, enqueueModelJob };
