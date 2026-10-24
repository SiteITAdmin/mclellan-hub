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

module.exports = { routeMessage, messagesToPrompts };
