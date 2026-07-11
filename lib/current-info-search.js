'use strict';

const fetch = require('./fetch');

const CURRENT_INFO_RE = /\b(today|latest|current|recent|this week|this month|released|pricing|version|deadline|law|regulation|guidance|news|schedule|score|CEO|minister|president|API|model)\b/i;

function shouldUseCurrentInfoSearch(text) {
  return CURRENT_INFO_RE.test(String(text || ''));
}

function normaliseSource(source, provider, query) {
  return {
    title: source.title || source.url || query,
    url: source.url || '',
    snippet: source.snippet || '',
    publishedAt: source.publishedAt || null,
    provider,
    checkedAt: new Date().toISOString(),
  };
}

async function currentInfoSearch(query, { provider = 'auto', days = 14, limit = 10 } = {}) {
  const providers = provider === 'auto'
    ? [
        process.env.EXA_API_KEY ? 'exa' : null,
        (process.env.BRAVE_SEARCH_API_KEY || process.env.TAVILY_API_KEY) ? 'brave' : null,
      ].filter(Boolean)
    : [provider];

  if (!providers.length) {
    return {
      query,
      provider: 'none',
      checkedAt: new Date().toISOString(),
      sources: [],
      content: '',
      warning: 'No current-information search provider is configured. Set EXA_API_KEY, BRAVE_SEARCH_API_KEY, or TAVILY_API_KEY.',
    };
  }

  const seen = new Set();
  const sources = [];
  const contentBlocks = [];

  for (const p of providers) {
    const result = p === 'exa'
      ? await exaSearch(query, days)
      : await braveSearch(query);
    for (const source of result.sources || []) {
      if (!source.url || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(normaliseSource(source, p, query));
      if (sources.length >= limit) break;
    }
    if (result.content) contentBlocks.push(result.content);
    if (sources.length >= limit) break;
  }

  return {
    query,
    provider: providers.join('+'),
    checkedAt: new Date().toISOString(),
    sources,
    content: contentBlocks.join('\n\n---\n\n'),
  };
}

async function exaSearch(query, days = 14) {
  const key = process.env.EXA_API_KEY;
  if (!key) return { content: '', sources: [] };
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
        contents: { text: { maxCharacters: 1000 } },
      }),
    });
    if (!r.ok) throw new Error(`Exa ${r.status}`);
    const data = await r.json();
    const sources = (data.results || []).map(x => ({
      title: x.title || x.url,
      url: x.url,
      snippet: x.text || x.summary || '',
      publishedAt: x.publishedDate || null,
    }));
    return { content: sources.map(s => `${s.title}\n${s.url}\n${s.snippet}`).join('\n\n'), sources };
  } catch (err) {
    console.warn('[current-info] exa failed:', err.message);
    return { content: '', sources: [] };
  }
}

async function braveSearch(query) {
  try {
    if (process.env.BRAVE_SEARCH_API_KEY) {
      const r = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY } }
      );
      if (!r.ok) throw new Error(`Brave ${r.status}`);
      const data = await r.json();
      return {
        content: '',
        sources: (data.web?.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.description })),
      };
    }
    if (process.env.TAVILY_API_KEY) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: 5 }),
      });
      if (!r.ok) throw new Error(`Tavily ${r.status}`);
      const data = await r.json();
      return {
        content: '',
        sources: (data.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content })),
      };
    }
  } catch (err) {
    console.warn('[current-info] brave/tavily failed:', err.message);
  }
  return { content: '', sources: [] };
}

function formatCurrentInfoContext(result) {
  const sources = result.sources || [];
  const header = [
    `[Current-info search]`,
    `Query: ${result.query}`,
    `Provider: ${result.provider}`,
    `Checked: ${result.checkedAt}`,
    result.warning ? `Warning: ${result.warning}` : '',
  ].filter(Boolean).join('\n');
  const body = sources.map((s, i) =>
    `[${i + 1}] ${s.title}\n${s.url}\nChecked: ${s.checkedAt}\n${s.snippet || ''}`
  ).join('\n\n');
  return `${header}\n\n${body}`.trim();
}

module.exports = {
  shouldUseCurrentInfoSearch,
  currentInfoSearch,
  formatCurrentInfoContext,
  exaSearch,
  braveSearch,
};
