const fetch = require('./fetch');
const db = require('./db');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

// ── Model definitions ─────────────────────────────────────────────────────────
// search modes:
//   'web-plugin' → OpenRouter web search server tool, citations via annotations
//   'native'     → model has its own search built in (Claude web search, Sonar, etc.)
//   'none'       → no search (image models)
// Emergency fallback only — used if the DB is empty or unreachable.
// All real model config lives in the model_config table, managed via /admin/models.
const DEFAULT_MODELS = {
  'free': { label: 'Free (OpenRouter)', endpoint: 'openrouter', id: 'openrouter/free', tier: 'everyday', search: 'web-plugin' },
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

// Read the user's chosen default model from DB; fall back to 'free'.
function getDefaultModel(user) {
  try {
    const row = db.hub().prepare(
      "SELECT value FROM crm_context WHERE user = ? AND key = 'hub_default_model'"
    ).get(user || '');
    return row?.value || 'free';
  } catch {
    return 'free';
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

const WEB_SEARCH_TOOL = {
  type: 'openrouter:web_search',
  parameters: {
    engine: 'firecrawl',
    max_results: 5,
    user_location: {
      type: 'approximate',
      city: 'Dublin',
      region: 'Leinster',
      country: 'Ireland',
      timezone: 'Europe/Dublin',
    },
  },
};

function formatSourcesBlock(sources, label = '**Sources**') {
  return '\n\n---\n' + label + '\n' +
    sources.map((s, i) => `[${i + 1}] [${s.title || s.url}](${s.url})`).join('\n');
}

// ── OpenRouter streaming ──────────────────────────────────────────────────────
async function streamOpenRouter(modelId, messages, onChunk, options = {}) {
  const body = { model: modelId, messages, stream: true };
  if (options.webSearch) {
    const tool = { ...WEB_SEARCH_TOOL, parameters: { ...WEB_SEARCH_TOOL.parameters } };
    if (options.searchDepth) tool.parameters.search_context_size = options.searchDepth;
    body.tools = [tool];
    body.tool_choice = 'auto';
    console.log(`[stream] ${modelId} sending with webSearch tool`);
  }

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenRouter error ${r.status}: ${err}`);
  }

  let full = '';
  let tokensIn = 0, tokensOut = 0, actualCostUsd = null;
  let actualModelId = modelId;        // OpenRouter may route to a different model (e.g. free tier)
  let citations = [];                 // legacy Sonar-style URL list
  const annotationMap = new Map();    // keyed by url → { url, title }
  // DeepSeek and some other models leak their internal tool-call syntax (DSML) as streaming
  // text content. Once detected, suppress all further delta content — never show it to the user.
  const STREAM_TOOL_LEAK_RE = /<[|]tool_calls_section_begin[|]>|\u{FF5C}{2}DSML\u{FF5C}{2}/u;
  let toolLeakDetected = false;

  let firstChunkLogged = false;
  for await (const chunk of r.body) {
    const raw = Buffer.from(chunk).toString('utf-8');
    if (options.webSearch && !firstChunkLogged) {
      firstChunkLogged = true;
      console.log(`[stream] ${modelId} first_chunk: ${raw.slice(0, 500).replace(/\n/g, '↵')}`);
    }
    const lines = raw.split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.model) actualModelId = parsed.model;
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content || '';
        if (delta) {
          full += delta;
          if (!toolLeakDetected) {
            if (STREAM_TOOL_LEAK_RE.test(full)) {
              toolLeakDetected = true;
              console.log(`[stream] ${modelId} TOOL LEAK detected in stream — suppressing output`);
            } else {
              onChunk(delta);
            }
          }
        }

        // OpenRouter web plugin annotations (on delta or message)
        const anns = choice?.delta?.annotations || choice?.message?.annotations || [];
        for (const a of anns) {
          if (a.type === 'url_citation' && a.url_citation?.url) {
            const u = a.url_citation.url;
            if (!annotationMap.has(u)) {
              annotationMap.set(u, { url: u, title: a.url_citation.title || u });
            }
          }
        }

        if (parsed.citations) citations = parsed.citations;
        if (parsed.usage) {
          tokensIn = parsed.usage.prompt_tokens || 0;
          tokensOut = parsed.usage.completion_tokens || 0;
          if (parsed.usage.cost != null) actualCostUsd = parsed.usage.cost;
        }

        // Log key streaming events for web plugin calls to diagnose per-model behaviour
        if (options.webSearch) {
          const fr = choice?.finish_reason;
          if (fr) console.log(`[stream] ${modelId} finish_reason=${fr} content_so_far=${full.length} annotations=${annotationMap.size}`);
          if (choice?.delta?.tool_calls?.length) console.log(`[stream] ${modelId} tool_calls_delta tool=${JSON.stringify(choice.delta.tool_calls[0]?.function?.name)}`);
        }
      } catch (_) {}
    }
  }

  // Build sources block — prefer structured annotations, fall back to raw citations
  // Build sources block — prefer structured annotations, fall back to raw citations
  // (done before toolLeakDetected check so we can include sources in the leak warning)
  let sources = [];
  if (annotationMap.size > 0) {
    sources = [...annotationMap.values()];
  } else if (citations.length > 0) {
    sources = citations.map(url => ({ url, title: url }));
  }

  // Tool leak: model output DSML/internal syntax as its answer text.
  // Log first 300 chars of the leaked content for diagnosis.
  if (toolLeakDetected) {
    console.log(`[stream] ${modelId} TOOL LEAK content (first 300): ${full.slice(0, 300).replace(/\n/g, '↵')}`);
    if (sources.length > 0) {
      // Model DID search (we have citations) but garbled the answer with DSML.
      // Show what we have: sources are real, answer text is not. Offer retry.
      const warning = `⚠️ *This model ran the web search (${sources.length} sources found) but generated malformed output — try sending your message again. If it keeps happening, switch to Exa or a model with native search.*\n\n`;
      onChunk(warning);
      full = warning;
      const block = formatSourcesBlock(sources, '**Sources** (OpenRouter web — answer failed)');
      onChunk(block);
      full += block;
    } else {
      // No sources either — model doesn't support the plugin at all.
      const warning = '⚠️ *This model does not support the web search plugin — it leaked internal tool-call syntax instead of searching. Switch to a model with native search (Sonar, Gemini) or use Exa instead.*\n\n';
      onChunk(warning);
      full = warning;
    }
    return { content: full, tokensIn, tokensOut, actualCostUsd, sources, actualModelId };
  }

  // If the model emitted sources but no substantive answer, the web search plugin ran but
  // the model didn't generate a response body (known issue with some models + tool_choice=auto).
  // Italic-only lines (e.g. "_Searching for…_") are status notices, not real content —
  // strip them before deciding whether the answer is empty.
  const substantiveContent = full.replace(/^_[^\n]*_\s*$/gm, '').trim();
  if (sources.length > 0 && !substantiveContent) {
    // Model invoked the search tool but emitted no text body
    const warning = '⚠️ *The model ran a web search but returned no answer — it may not support the web search plugin. Try switching to Semantic search (Exa) or a more capable model (Gemini 2.5 Pro, Sonar, DeepSeek V3).*\n\n';
    onChunk(warning);
    full = warning;
  } else if (!substantiveContent && options.webSearch) {
    // Model received the web plugin tool but returned nothing at all — tool was silently ignored
    const warning = '⚠️ *No response received — this model does not support the web search plugin. Switch to Semantic search (Exa) in search settings, or choose a model with native or web-plugin search support.*\n\n';
    onChunk(warning);
    full = warning;
  }

  if (sources.length > 0) {
    const label = options.webSearch ? '**Sources** (OpenRouter web)' : '**Sources**';
    const block = formatSourcesBlock(sources, label);
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
async function fetchOpenRouterFull(modelId, messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify({ model: modelId, messages, stream: false }),
  });
  if (!r.ok) throw new Error(`OpenRouter error ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Multi-round research orchestration ───────────────────────────────────────
// 1. Plan: cheap model generates specific search queries
// 2. Search: run all queries in parallel (Brave if configured, else OpenRouter web plugin)
// 3. Synthesise: Gemini 2.5 Pro writes the final report across all gathered sources
async function multiSearchRoute(messages, onChunk) {
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
    ]);
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
    const searcher    = hasExa ? exaSearch : braveSearch;
    multiSearchLabel  = hasExa ? 'Multi-search (Exa)' : 'Multi-search (Brave)';
    onChunk(`_Searching ${queries.length} targeted queries in parallel…_\n\n`);
    const results = await Promise.all(queries.map(q => searcher(q).catch(() => ({ sources: [] }))));
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
        `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet || ''}`
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
    { webSearch: !contextBlock, searchDepth: 'high' }
  );

  if (gatheredSources.length > 0) {
    const block = formatSourcesBlock(gatheredSources, `**Sources** (${multiSearchLabel})`);
    onChunk(block);
    result.content += block;
    result.sources = gatheredSources;
  }

  return result;
}

// ── OpenRouter image generation ──────────────────────────────────────────────
async function generateOpenRouterImage(modelId, prompt) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter image error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('No response from image model');

  // Content can be a string (data URL) or an array of content parts
  const content = msg.content;
  if (typeof content === 'string' && content.startsWith('data:')) {
    return { imageUrl: content, tokensIn: data.usage?.prompt_tokens || 0, tokensOut: data.usage?.completion_tokens || 0 };
  }
  if (Array.isArray(content)) {
    const imgPart = content.find(p => p.type === 'image_url');
    if (imgPart?.image_url?.url) {
      return { imageUrl: imgPart.image_url.url, tokensIn: data.usage?.prompt_tokens || 0, tokensOut: data.usage?.completion_tokens || 0 };
    }
  }
  throw new Error('No image found in response');
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
async function routeMessage({ model, messages, user, onChunk, noSearch = false, searchProvider = 'openrouter', searchDepth = 'medium', exaDays = 14 }) {
  const models = getModels(user);
  const defaultModelKey = getDefaultModel(user);
  const modelKey = model || defaultModelKey;
  const def = models[modelKey] || models[defaultModelKey] || models['free'];

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
    result = await multiSearchRoute(finalMessages, onChunk);
    searchUsed = true;
  } else if (def.endpoint === 'openrouter' && (def.tier === 'research' || def.tier === 'news-research') && def.search === 'native') {
    // Sonar — non-streaming to capture citations
    console.log('[sonar] starting non-streaming request...');
    onChunk('_Researching… this can take up to 60 seconds._\n\n');
    const data = await fetchOpenRouterFull(def.id, finalMessages);
    const msg = data.choices?.[0]?.message || {};
    const content = msg.content || '';

    // Merge citations from all known locations
    const sourceMap = new Map();
    // 1) Perplexity top-level citations (URLs)
    for (const u of (data.citations || [])) {
      if (typeof u === 'string' && !sourceMap.has(u)) sourceMap.set(u, { url: u, title: u });
    }
    // 2) OpenRouter-normalised message.annotations
    for (const a of (msg.annotations || [])) {
      if (a.type === 'url_citation' && a.url_citation?.url) {
        const u = a.url_citation.url;
        if (!sourceMap.has(u)) sourceMap.set(u, { url: u, title: a.url_citation.title || u });
      }
    }
    // 3) Some providers emit search_results
    for (const s of (data.search_results || msg.search_results || [])) {
      if (s.url && !sourceMap.has(s.url)) sourceMap.set(s.url, { url: s.url, title: s.title || s.url });
    }
    const sources = [...sourceMap.values()];

    console.log('[sonar] got response, sources:', sources.length);

    let full = content;
    if (sources.length > 0) {
      full += formatSourcesBlock(sources);
    }
    onChunk('\x00' + full);
    result = {
      content: full,
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      actualCostUsd: data.usage?.cost ?? null,
    };
    searchUsed = true;
  } else if (def.endpoint === 'openrouter' && def.tier === 'image') {
    const prompt = finalMessages[finalMessages.length - 1].content;
    console.log(`[router] image gen via OpenRouter: ${def.id}`);
    onChunk('_Generating image…_\n\n');
    const { imageUrl, tokensIn, tokensOut } = await generateOpenRouterImage(def.id, prompt);
    const imgMd = `![Generated image](${imageUrl})`;
    onChunk('\x00' + imgMd);
    result = { content: imgMd, tokensIn, tokensOut };
  } else if (def.endpoint === 'openrouter') {
    const useWebPlugin = webCapable && searchProvider === 'openrouter';
    console.log(`[router] ${def.id} · search=${def.search} · provider=${searchProvider} · webPlugin=${useWebPlugin} · braveSources=${braveSources.length}`);
    result = await streamOpenRouter(def.id, finalMessages, onChunk, { webSearch: useWebPlugin, searchDepth });
    console.log(`[router] → streamed ${result.content.length} chars, ${result.sources?.length || 0} OpenRouter sources`);
    if (useWebPlugin && result.sources && result.sources.length > 0) searchUsed = true;
    if (def.search === 'native' && searchProvider !== 'off') searchUsed = true;

    // If Brave/Exa provided sources, append them as a block (the model can't annotate them)
    if (braveSources.length > 0) {
      const providerLabel = searchProvider === 'exa' ? 'Exa' : 'Brave';
      const block = formatSourcesBlock(braveSources, `**Sources** (${providerLabel})`);
      onChunk(block);
      result.content += block;
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
    ]);
    logUsageFromResponse({
      user,
      feature: 'recall-tagging',
      modelKey: 'recall-tagging',
      fallbackModelId: modelId,
      data,
      durationMs: Date.now() - started,
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

module.exports = { routeMessage, MODELS, DEFAULT_MODELS, getDefaultModel, tagConversation, generateGoogleImage, exaSearch, braveSearch, WEB_SEARCH_TOOL };
