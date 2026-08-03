const fetch = require('./fetch');
const db = require('./db');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { currentInfoSearch } = require('./current-info-search');

// ── Model definitions ─────────────────────────────────────────────────────────
// search modes:
//   'web-plugin' → OpenRouter web search server tool, citations via annotations
//   'native'     → model has its own search built in (Claude web search, Sonar, etc.)
//   'none'       → no search (image models)
// Emergency fallback only — used if the DB is empty or unreachable.
// All real model config lives in the model_config table, managed via /admin/models.
const DEFAULT_MODELS = {
  // Subscription CLI plane — OpenRouter free tier is retired.
  'hub-sonnet': { label: 'Hub Sonnet (subscription)', endpoint: 'subscription', id: 'claude/sonnet', tier: 'everyday', search: 'none' },
  'hub-terra': { label: 'Hub Terra (subscription)', endpoint: 'subscription', id: 'codex/terra', tier: 'everyday', search: 'none' },
  'multi-search': { label: 'Multi-search Research', endpoint: 'multi-search', id: 'orchestrated', tier: 'research', search: 'native' },
};

// Return all models visible to a user: shared defaults (user IS NULL) + that user's own.
function getModels(user) {
  try {
    const rows = db.hub().prepare(
      'SELECT * FROM model_config WHERE enabled = 1 AND (user IS NULL OR user = ?) ORDER BY tier, display_order, key'
    ).all(user || '');
    if (rows.length === 0) return DEFAULT_MODELS;
    return rows.reduce((acc, r) => {
      acc[r.key] = {
        endpoint: r.endpoint,
        id: r.model_id,
        tier: r.tier,
        search: r.search,
        label: r.label,
        baseUrl: r.base_url,
        apiKeyEnv: r.api_key_env,
        apiKey: r.api_key || undefined,
      };
      return acc;
    }, {});
  } catch {
    return DEFAULT_MODELS;
  }
}

const MODELS = DEFAULT_MODELS;

// Read the user's chosen default model from DB; fall back to subscription Sonnet.
function getDefaultModel(user) {
  try {
    const row = db.hub().prepare(
      "SELECT value FROM crm_context WHERE user = ? AND key = 'hub_default_model'"
    ).get(user || '');
    const key = row?.value || 'hub-sonnet';
    // Retired OpenRouter free tier maps to subscription Sonnet.
    if (key === 'free' || key === 'openrouter/free') return 'hub-sonnet';
    return key;
  } catch {
    return 'hub-sonnet';
  }
}

// ── Exa neural search ─────────────────────────────────────────────────────────
async function exaSearch(query, days = 14) {
  const key = process.env.EXA_API_KEY;
  if (!key) {
    console.warn('[exa] no EXA_API_KEY in env — returning empty');
    return { content: query, sources: [] };
  }
  try {
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query,
        numResults: 5,
        type: 'neural',
        useAutoprompt: true,
        ...(days > 0 ? { startPublishedDate: new Date(Date.now() - days * 864e5).toISOString() } : {}),
        contents: { text: { maxCharacters: 800 } },
      }),
    });
    if (!r.ok) throw new Error(`Exa error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const sources = (data.results || []).map(x => ({
      title: x.title || x.url,
      url: x.url,
      snippet: x.text || x.summary || '',
    }));
    console.log('[exa] returned', sources.length, 'results');
    const context = sources.map(s => `${s.title}\n${s.url}\n${s.snippet}`).join('\n\n');
    const augmented = `[Exa neural search results]\n${context}\n\n---\n\nUsing the above search results where relevant, answer: ${query}`;
    return { content: augmented, sources };
  } catch (e) {
    console.error('[exa] failed:', e.message);
    return { content: query, sources: [] };
  }
}

// ── Brave / Tavily search (alternative provider) ─────────────────────────────
async function braveSearch(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY;
  if (!key) {
    console.warn('[brave] no BRAVE_SEARCH_API_KEY or TAVILY_API_KEY in env — returning empty');
    return { content: query, sources: [] };
  }
  let sources = [];
  try {
    if (process.env.BRAVE_SEARCH_API_KEY) {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY } }
      );
      const data = await r.json();
      sources = (data.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
    } else {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: 5 }),
      });
      const data = await r.json();
      sources = (data.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
    }
    console.log('[brave] returned', sources.length, 'results');
  } catch (e) {
    console.error('[brave] failed:', e.message);
    return { content: query, sources: [] };
  }
  const context = sources.map(s => `${s.title}\n${s.url}\n${s.snippet}`).join('\n\n');
  const augmented = `[Web search results]\n${context}\n\n---\n\nUsing the above search results where relevant, answer: ${query}`;
  return { content: augmented, sources };
}

// Plugin-style web search (always-on injection, no tool_call round-trip needed).
// openrouter:web_search as a "tool" changed to a server tool requiring agentic
// round-trips; the plugin approach restores the original inject-and-cite behaviour.
const WEB_SEARCH_PLUGIN = {
  id: 'web',
  engine: 'exa',
  max_results: 5,
};

// Keep the server tool definition for any agentic / multi-turn use cases
const WEB_SEARCH_TOOL = {
  type: 'openrouter:web_search',
  parameters: { engine: 'exa', max_results: 5 },
};

function formatSourcesBlock(sources, label = '**Sources**') {
  return '\n\n---\n' + label + '\n' +
    sources.map((s, i) => `[${i + 1}] [${s.title || s.url}](${s.url})`).join('\n');
}

// ── Subscription streaming (CLI plane; fake-stream for the UI) ────────────────
async function streamOpenRouter(modelId, messages, onChunk, options = {}) {
  // Research: inject Exa/Brave results before the model call — never OpenRouter web plugin.
  let workMessages = messages;
  let sources = [];
  if (options.webSearch) {
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    const question = typeof userMsg?.content === 'string' ? userMsg.content : '';
    try {
      const search = await (process.env.EXA_API_KEY ? exaSearch(question) : braveSearch(question));
      sources = search.sources || [];
      if (search.content && search.content !== question) {
        workMessages = messages.map((m, i) =>
          i === messages.length - 1 && m.role === 'user'
            ? { ...m, content: search.content }
            : m,
        );
      }
    } catch (err) {
      console.warn('[stream] web search pre-fetch failed:', err.message);
    }
  }

  const feature = options.webSearch ? 'hub_chat_research' : 'hub_chat';
  const r = await fetch('hub-model://v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(options.taskCode || TASK_CODES.CHAT, { feature }),
    body: JSON.stringify({ model: modelId, messages: workMessages, stream: false }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Subscription model error ${r.status}: ${err}`);
  }

  const data = await r.json();
  let full = data.choices?.[0]?.message?.content || '';
  const actualModelId = data.model || modelId;
  const tokensIn = data.usage?.prompt_tokens || 0;
  const tokensOut = data.usage?.completion_tokens || 0;
  const actualCostUsd = data.usage?.cost ?? 0;

  // Fake-stream for the chat UI.
  const step = 48;
  for (let i = 0; i < full.length; i += step) onChunk(full.slice(i, i + step));

  if (sources.length > 0) {
    const block = formatSourcesBlock(sources, '**Sources** (Exa/Brave)');
    onChunk(block);
    full += block;
  }

  return { content: full, tokensIn, tokensOut, actualCostUsd, sources, actualModelId };
}

// ── Generic OpenAI-compatible streaming (Perplexity, Groq, OpenAI, Mistral…) ─
async function streamCustomOpenAI(def, messages, onChunk) {
  const apiKey = def.apiKey || (def.apiKeyEnv ? process.env[def.apiKeyEnv] : null);
  if (!apiKey) throw new Error(`Missing API key for model — add it in Model settings`);
  const baseUrl = (def.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Missing base_url for custom-openai model');

  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: def.id, messages, stream: true }),
  });

  if (!r.ok) throw new Error(`${def.endpoint} error ${r.status}: ${await r.text()}`);

  let full = '';
  let tokensIn = 0, tokensOut = 0, actualCostUsd = null;
  let citations = [];

  for await (const chunk of r.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) { full += delta; onChunk(delta); }
        // Perplexity returns citations at the top level
        if (parsed.citations) citations = parsed.citations;
        if (parsed.usage) {
          tokensIn = parsed.usage.prompt_tokens || 0;
          tokensOut = parsed.usage.completion_tokens || 0;
          if (parsed.usage.cost != null) actualCostUsd = parsed.usage.cost;
        }
      } catch (_) {}
    }
  }

  if (citations.length > 0) {
    const block = formatSourcesBlock(citations.map(u => ({ url: u, title: u })));
    onChunk(block);
    full += block;
  }

  return { content: full, tokensIn, tokensOut, actualCostUsd, sources: citations.map(u => ({ url: u, title: u })) };
}

// ── OpenRouter non-streaming (Sonar) ─────────────────────────────────────────
async function fetchOpenRouterFull(modelId, messages, taskCode = TASK_CODES.CHAT) {
  const r = await fetch('hub-model://v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(taskCode),
    body: JSON.stringify({ model: modelId, messages, stream: false }),
  });
  if (!r.ok) throw new Error(`OpenRouter error ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Multi-round research orchestration ───────────────────────────────────────
// 1. Plan: cheap model generates specific search queries
// 2. Search: run all queries in parallel (Brave if configured, else OpenRouter web plugin)
// 3. Synthesise: Gemini 2.5 Pro writes the final report across all gathered sources
async function multiSearchRoute(messages, onChunk, taskCode = TASK_CODES.CHAT_RESEARCH) {
  const userMsg = [...messages].reverse().find(m => m.role === 'user');
  const question = (typeof userMsg?.content === 'string' ? userMsg.content : '')
    .replace(/<\/?[a-z_]+>/gi, '').trim().slice(0, 1200);

  // Phase 1: query planning
  onChunk('_Planning research queries…_\n\n');
  let queries = [question.slice(0, 200)];
  try {
    const planData = await fetchOpenRouterFull(getSystemModelId('multisearch_planner', 'system', 'deepseek/deepseek-v3.2'), [
      { role: 'system', content: getSystemPrompt('multisearch_planner', 'system', PROMPTS.multisearch_planner) },
      { role: 'user', content: question },
    ], taskCode);
    logUsageFromResponse({
      user: 'system',
      feature: 'chat-research-planner',
      modelKey: 'multisearch_planner',
      fallbackModelId: getSystemModelId('multisearch_planner', 'system', 'deepseek/deepseek-v3.2'),
      data: planData,
      taskCode,
    });
    const text = planData.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]).filter(q => typeof q === 'string').slice(0, 6);
      if (parsed.length) queries = parsed;
    }
  } catch (_) {}

  // Phase 2: search — Exa (neural) preferred, Brave as fallback, OR web plugin if neither
  const hasExa   = !!process.env.EXA_API_KEY;
  const hasBrave = !!(process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY);
  const hasLocalSearch = hasExa || hasBrave;
  let contextBlock = '';
  let gatheredSources = [];
  let multiSearchLabel = 'Multi-search';

  if (hasLocalSearch) {
    multiSearchLabel  = hasExa ? 'Multi-search (Exa)' : 'Multi-search (Brave/Tavily)';
    onChunk(`_Searching ${queries.length} targeted queries in parallel…_\n\n`);
    const results = await Promise.all(queries.map(q =>
      currentInfoSearch(q, { provider: 'auto', days: 30, limit: 8 }).catch(() => ({ sources: [] }))
    ));
    const seen = new Set();
    const sources = [];
    for (const r of results) {
      for (const s of (r.sources || [])) {
        if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push(s); }
      }
    }
    if (sources.length) {
      gatheredSources = sources.slice(0, 24);
      contextBlock = sources.slice(0, 24).map((s, i) =>
        `[${i + 1}] ${s.title}\n${s.url}\nChecked: ${s.checkedAt || new Date().toISOString()}\n${s.snippet || ''}`
      ).join('\n\n');
      onChunk(`_Synthesising across ${sources.length} unique sources…_\n\n`);
    }
  } else {
    onChunk(`_Searching with web plugin (${queries.length} planned queries)…_\n\n`);
  }

  // Phase 3: synthesis
  let synthMessages;
  if (contextBlock) {
    synthMessages = [
      { role: 'system', content: getSystemPrompt('multisearch_synthesiser', 'system', PROMPTS.multisearch_synthesiser) },
      ...messages.slice(0, -1),
      {
        role: 'user',
        content:
          `${question}\n\n---\n` +
          `[Multi-search context — ${queries.length} targeted queries retrieved the following sources. ` +
          `Use inline citations like [1] that match these source numbers.]\n\n${contextBlock}`,
      },
    ];
  } else {
    synthMessages = [
      { role: 'system', content: `${getSystemPrompt('multisearch_synthesiser', 'system', PROMPTS.multisearch_synthesiser)}\n\nResearch these specific angles:\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}` },
      ...messages,
    ];
  }

  const result = await streamOpenRouter(getSystemModelId('multisearch_synthesiser', 'system', 'google/gemini-2.5-pro-preview'), synthMessages, onChunk,
    { webSearch: !contextBlock, searchDepth: 'high', taskCode }
  );

  if (gatheredSources.length > 0) {
    const block = formatSourcesBlock(gatheredSources, `**Sources** (${multiSearchLabel})`);
    onChunk(block);
    result.content += block;
    result.sources = gatheredSources;
  }

  return result;
}

// ── Image generation (OpenRouter path retired) ───────────────────────────────
async function generateOpenRouterImage() {
  throw new Error('Image generation via OpenRouter is retired. Configure Google AI image generation or another approved local path.');
}

// ── Google AI image generation ────────────────────────────────────────────────
async function generateGoogleImage(prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );
  if (!r.ok) throw new Error(`Google AI error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!part) throw new Error('No image in response');
  return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
}

// ── Main route function ───────────────────────────────────────────────────────
// searchProvider: 'openrouter' (default) | 'brave' | 'off'
async function routeMessage({
  model,
  messages,
  user,
  onChunk,
  noSearch = false,
  searchProvider = 'openrouter',
  searchDepth = 'medium',
  exaDays = 14,
  taskCode = null,
}) {
  const models = getModels(user);
  const defaultModelKey = getDefaultModel(user);
  const modelKey = model || defaultModelKey;
  const def = models[modelKey] || models[defaultModelKey] || models['free'];
  const resolvedTaskCode = taskCode ||
    (def.tier === 'image' ? TASK_CODES.IMAGE :
      def.endpoint === 'multi-search' || def.tier === 'research' || def.tier === 'news-research'
        ? TASK_CODES.CHAT_RESEARCH
        : TASK_CODES.CHAT);

  // Normalise: noSearch wins; off is same as noSearch
  if (noSearch || searchProvider === 'off') searchProvider = 'off';

  let finalMessages = [...messages];
  let searchUsed = false;
  let braveSources = [];
  let result;

  // web-plugin: inject the OR tool. native: model has built-in search (Sonar etc) but we
  // still inject the tool if the user explicitly requests references, so Claude/etc also
  // gets live data. none: image models — never search.
  const webCapable = def.search !== 'none';

  // If Brave or Exa is the chosen provider for a web-capable model, prefetch and inject
  if (webCapable && (searchProvider === 'brave' || searchProvider === 'exa')) {
    const lastUser = [...finalMessages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      const searcher = searchProvider === 'exa' ? exaSearch : braveSearch;
      const { content, sources } = await searcher(lastUser.content, searchProvider === 'exa' ? exaDays : undefined);
      finalMessages = finalMessages.map(m => m === lastUser ? { ...m, content } : m);
      braveSources = sources || [];
      if (braveSources.length > 0) searchUsed = true;
    }
  }

  if (def.endpoint === 'multi-search') {
    console.log('[multi-search] starting orchestrated research...');
    result = await multiSearchRoute(finalMessages, onChunk, resolvedTaskCode);
    searchUsed = true;
  } else if (def.endpoint === 'openrouter' || def.endpoint === 'subscription') {
    // Historical model_config rows may still say endpoint=openrouter; runtime
    // always uses the subscription CLI plane (never the OpenRouter network).
    if (def.tier === 'image') {
      throw new Error('Image generation via OpenRouter is retired. Use an external image tool or a future local vision path.');
    }
    const useResearch = webCapable && (searchProvider === 'openrouter' || searchProvider === 'exa' || searchProvider === 'brave' || searchProvider === 'on');
    console.log(`[router] subscription ${def.id} · provider=${searchProvider} · research=${useResearch}`);
    result = await streamOpenRouter(def.id, finalMessages, onChunk, {
      webSearch: useResearch && searchProvider !== 'off',
      searchDepth,
      taskCode: resolvedTaskCode,
    });
    if (result.sources && result.sources.length > 0) searchUsed = true;
    if (braveSources.length > 0) {
      const providerLabel = searchProvider === 'exa' ? 'Exa' : 'Brave';
      const block = formatSourcesBlock(braveSources, `**Sources** (${providerLabel})`);
      onChunk(block);
      result.content += block;
      searchUsed = true;
    }
  } else if (def.endpoint === 'custom-openai' || def.endpoint === 'perplexity' || def.endpoint === 'openai' || def.endpoint === 'groq' || def.endpoint === 'mistral') {
    result = await streamCustomOpenAI(def, finalMessages, onChunk);
    if (def.search === 'native' && searchProvider !== 'off') searchUsed = true;
  } else if (def.endpoint === 'google-ai') {
    const prompt = finalMessages[finalMessages.length - 1].content;
    const imageData = await generateGoogleImage(prompt); // returns data:mime;base64,...
    // Save to disk so dchat and Google Chat get a real URL instead of a huge data blob
    const { randomUUID } = require('crypto');
    const imgFs   = require('fs');
    const imgPath = require('path');
    const b64Match = imageData.match(/^data:([^;]+);base64,(.+)$/);
    let imgSrc = imageData; // fallback: keep data URL
    if (b64Match) {
      const ext = b64Match[1].includes('jpeg') ? 'jpg' : 'png';
      const filename = `img-${randomUUID()}.${ext}`;
      const genDir = imgPath.join(__dirname, '..', 'public', 'generated');
      imgFs.mkdirSync(genDir, { recursive: true });
      imgFs.writeFileSync(imgPath.join(genDir, filename), Buffer.from(b64Match[2], 'base64'));
      imgSrc = `/generated/${filename}`;
    }
    const imgMd = `![Generated image](${imgSrc})`;
    onChunk('\x00' + imgMd);
    result = { content: imgMd, tokensIn: 0, tokensOut: 0 };
  }

  // Use the real billed cost from OpenRouter when available; fall back to a rough estimate.
  // OpenRouter includes usage.cost in the final streaming chunk — this is what you're actually charged,
  // including search fees, routing surcharges, and native token costs (critical for Sonar Deep Research etc.).
  const estimatedCostUsd = (result.tokensIn / 1_000_000 * 0.5) + (result.tokensOut / 1_000_000 * 1.5);
  const costUsd = result.actualCostUsd ?? estimatedCostUsd;

  return {
    content: result.content,
    model: modelKey,
    modelId: result.actualModelId || def.id,
    endpoint: def.endpoint,
    searchUsed,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd,
    taskCode: resolvedTaskCode,
  };
}

// ── Long-term memory tagging ──────────────────────────────────────────────────
// Fire-and-forget: called after each successful Q&A to extract topic tags.
// Uses a free/cheap model; failures are silently swallowed.
async function tagConversation(question, answer, user = 'system') {
  const snippet = `Q: ${question.slice(0, 400)}\nA: ${answer.slice(0, 600)}`;
  try {
    const started = Date.now();
    const modelId = getSystemModelId('recall_tagger', 'system', 'meta-llama/llama-3.1-8b-instruct:free');
    const data = await fetchOpenRouterFull(modelId, [
      { role: 'system', content: getSystemPrompt('recall_tagger', 'system', PROMPTS.recall_tagger) },
      { role: 'user', content: snippet },
    ], TASK_CODES.RECALL_TAGGING);
    logUsageFromResponse({
      user,
      feature: 'recall-tagging',
      modelKey: 'recall-tagging',
      fallbackModelId: modelId,
      data,
      durationMs: Date.now() - started,
      taskCode: TASK_CODES.RECALL_TAGGING,
    });
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string').slice(0, 7) : [];
  } catch (_) {
    return [];
  }
}

module.exports = { routeMessage, MODELS, DEFAULT_MODELS, getDefaultModel, tagConversation, generateGoogleImage, exaSearch, braveSearch, WEB_SEARCH_PLUGIN, WEB_SEARCH_TOOL };
