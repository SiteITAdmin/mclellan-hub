const fetch = require('node-fetch');
const db = require('./db');

// ── Model definitions ─────────────────────────────────────────────────────────
// search modes:
//   'web-plugin' → OpenRouter web search server tool, citations via annotations
//   'native'     → model has its own search built in (Claude web search, Sonar, etc.)
//   'none'       → no search (image models)
const DEFAULT_MODELS = {
  // Free tier — OpenRouter free models router, picks randomly from available free models
  'free':             { endpoint: 'openrouter', id: 'openrouter/free', tier: 'everyday', search: 'web-plugin' },
  // Everyday tier — use OpenRouter web plugin
  'deepseek-v3':      { endpoint: 'openrouter', id: 'deepseek/deepseek-v3.2', tier: 'everyday', search: 'web-plugin' },
  'mimo-flash':       { endpoint: 'openrouter', id: 'tencent/hunyuan-a13b-instruct:free', tier: 'everyday', search: 'web-plugin' },
  'mistral-small':    { endpoint: 'openrouter', id: 'mistralai/mistral-small-2603', tier: 'everyday', search: 'web-plugin' },
  'grok-fast':        { endpoint: 'openrouter', id: 'x-ai/grok-3-mini', tier: 'everyday', search: 'web-plugin' },
  // Project tier
  'claude-opus':      { endpoint: 'openrouter', id: 'anthropic/claude-opus-4.7', tier: 'project', search: 'native' },
  // News & Light Research — Perplexity models + multi-round orchestration
  'sonar':               { label: 'Sonar', endpoint: 'openrouter', id: 'perplexity/sonar', tier: 'news-research', search: 'native' },
  'sonar-deep-research': { label: 'Sonar Deep Research', endpoint: 'openrouter', id: 'perplexity/sonar-deep-research', tier: 'news-research', search: 'native' },
  'sonar-reasoning':     { label: 'Sonar Reasoning Pro', endpoint: 'openrouter', id: 'perplexity/sonar-reasoning-pro', tier: 'news-research', search: 'native' },
  'multi-search':        { label: 'Multi-Search (Orchestrated)', endpoint: 'multi-search', id: 'multi-search', tier: 'news-research', search: 'native' },
  // Deep Research
  'gemini-25-pro':       { label: 'Gemini 2.5 Pro', endpoint: 'openrouter', id: 'google/gemini-2.5-pro-preview', tier: 'deep-research', search: 'web-plugin' },
  'claude-sonnet':       { label: 'Claude Sonnet', endpoint: 'openrouter', id: 'anthropic/claude-sonnet-4.6', tier: 'deep-research', search: 'native' },
  // Project / high-capability
  'o3':                  { endpoint: 'openrouter', id: 'openai/o3', tier: 'project', search: 'web-plugin' },
  // Image
  'nano-banana':      { endpoint: 'google-ai', id: 'gemini-2.0-flash-preview-image-generation', tier: 'image', search: 'none' },
  'flux-pro':         { endpoint: 'openrouter', id: 'black-forest-labs/flux-1.1-pro', tier: 'image', search: 'none' },
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
const DEFAULT_MODEL = 'free';

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
  let tokensIn = 0, tokensOut = 0;
  let actualModelId = modelId;        // OpenRouter may route to a different model (e.g. free tier)
  let citations = [];                 // legacy Sonar-style URL list
  const annotationMap = new Map();    // keyed by url → { url, title }

  for await (const chunk of r.body) {
    const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
    for (const line of lines) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.model) actualModelId = parsed.model;
        const choice = parsed.choices?.[0];
        const delta = choice?.delta?.content || '';
        if (delta) { full += delta; onChunk(delta); }

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
        }
      } catch (_) {}
    }
  }

  // Build sources block — prefer structured annotations, fall back to raw citations
  let sources = [];
  if (annotationMap.size > 0) {
    sources = [...annotationMap.values()];
  } else if (citations.length > 0) {
    sources = citations.map(url => ({ url, title: url }));
  }

  if (sources.length > 0) {
    const label = options.webSearch ? '**Sources** (OpenRouter web)' : '**Sources**';
    const block = formatSourcesBlock(sources, label);
    onChunk(block);
    full += block;
  }

  return { content: full, tokensIn, tokensOut, sources, actualModelId };
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
  let tokensIn = 0, tokensOut = 0;
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
        }
      } catch (_) {}
    }
  }

  if (citations.length > 0) {
    const block = formatSourcesBlock(citations.map(u => ({ url: u, title: u })));
    onChunk(block);
    full += block;
  }

  return { content: full, tokensIn, tokensOut, sources: citations.map(u => ({ url: u, title: u })) };
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
    const planData = await fetchOpenRouterFull('deepseek/deepseek-v3.2', [
      { role: 'system', content: 'You are a research planner. Generate 5-6 specific, varied web search queries to comprehensively research the user\'s question from different angles. Return ONLY a JSON array of strings, no other text.' },
      { role: 'user', content: question },
    ]);
    const text = planData.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]).filter(q => typeof q === 'string').slice(0, 6);
      if (parsed.length) queries = parsed;
    }
  } catch (_) {}

  // Phase 2: search
  const hasBrave = !!(process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY);
  let contextBlock = '';

  if (hasBrave) {
    onChunk(`_Searching ${queries.length} targeted queries in parallel…_\n\n`);
    const results = await Promise.all(queries.map(q => braveSearch(q).catch(() => ({ sources: [] }))));
    const seen = new Set();
    const sources = [];
    for (const r of results) {
      for (const s of (r.sources || [])) {
        if (s.url && !seen.has(s.url)) { seen.add(s.url); sources.push(s); }
      }
    }
    if (sources.length) {
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
      ...messages.slice(0, -1),
      { role: 'user', content: `${question}\n\n---\n[Multi-search context — ${queries.length} targeted queries retrieved the following sources:]\n\n${contextBlock}` },
    ];
  } else {
    synthMessages = [
      { role: 'system', content: `Research this thoroughly using web search, covering these specific angles:\n${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}` },
      ...messages,
    ];
  }

  const result = await streamOpenRouter('google/gemini-2.5-pro-preview', synthMessages, onChunk,
    { webSearch: !contextBlock, searchDepth: 'high' }
  );
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
async function routeMessage({ model, messages, user, onChunk, noSearch = false, searchProvider = 'openrouter', searchDepth = 'medium' }) {
  const models = getModels(user);
  const modelKey = model || DEFAULT_MODEL;
  const def = models[modelKey] || models[DEFAULT_MODEL];

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

  // If Brave is the chosen provider for a web-capable model, prefetch and inject
  if (webCapable && searchProvider === 'brave') {
    const lastUser = [...finalMessages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      const { content, sources } = await braveSearch(lastUser.content);
      // Clone to avoid mutating caller's messages
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

    // If Brave provided sources, append them as a block (the model can't annotate them)
    if (braveSources.length > 0) {
      const block = formatSourcesBlock(braveSources, '**Sources** (Brave)');
      onChunk(block);
      result.content += block;
    }
  } else if (def.endpoint === 'custom-openai' || def.endpoint === 'perplexity' || def.endpoint === 'openai' || def.endpoint === 'groq' || def.endpoint === 'mistral') {
    result = await streamCustomOpenAI(def, finalMessages, onChunk);
    if (def.search === 'native' && searchProvider !== 'off') searchUsed = true;
  } else if (def.endpoint === 'google-ai') {
    const prompt = finalMessages[finalMessages.length - 1].content;
    const imageData = await generateGoogleImage(prompt);
    onChunk('\x00' + `![Generated image](${imageData})`);
    result = { content: `![Generated image](${imageData})`, tokensIn: 0, tokensOut: 0 };
  }

  // Rough cost estimate (OpenRouter pricing varies — this is approximate)
  const costUsd = (result.tokensIn / 1_000_000 * 0.5) + (result.tokensOut / 1_000_000 * 1.5);

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
async function tagConversation(question, answer) {
  const snippet = `Q: ${question.slice(0, 400)}\nA: ${answer.slice(0, 600)}`;
  try {
    const data = await fetchOpenRouterFull('meta-llama/llama-3.1-8b-instruct:free', [
      { role: 'system', content: 'You extract topic tags from a Q&A. Return ONLY a JSON array of 3-7 lowercase strings, e.g. ["powershell","exchange online","graph api"]. No other text.' },
      { role: 'user', content: snippet },
    ]);
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string').slice(0, 7) : [];
  } catch (_) {
    return [];
  }
}

module.exports = { routeMessage, MODELS, DEFAULT_MODELS, tagConversation };
