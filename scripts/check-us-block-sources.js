#!/usr/bin/env node
'use strict';

// Probes every US authority/newsroom in the catalogue through the same layers
// available to the production monitor: direct HTTP, optional Firecrawl, Brave
// and Exa discovery, and a browser fallback for JavaScript/challenge pages.
// This is deliberately a diagnostic tool. It never writes monitor rows or
// updates baselines, so it cannot alter Nakai's EU/UK/Irish daily scope.

const fs = require('fs');
const path = require('path');
const fetch = require('../lib/fetch');
const puppeteer = require('puppeteer');
const {
  US_STATE_FINANCIAL_REGULATORS,
  US_STATE_AG_NEWSROOMS,
  NAAG_NEWSROOM,
} = require('../lib/us-regulatory-sources');

const USER_AGENT = 'Mozilla/5.0 (compatible; McLellan-US-SourceHealth/1.0)';
const TIMEOUT_MS = Number(process.env.US_SOURCE_HEALTH_TIMEOUT_MS || 15000);
const CONCURRENCY = Number(process.env.US_SOURCE_HEALTH_CONCURRENCY || 6);
const BLOCK_TERMS = 'Block Cash App Square Afterpay Clearpay Bitkey Proto TIDAL';

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function sources() {
  return [
    ...US_STATE_FINANCIAL_REGULATORS.map(source => ({ ...source, kind: 'financial-regulator' })),
    ...US_STATE_AG_NEWSROOMS.map(source => ({ ...source, kind: 'attorney-general-newsroom' })),
    { ...NAAG_NEWSROOM, kind: 'national-attorneys-general' },
  ];
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function extractLinks(html, pageUrl) {
  const links = [];
  const seen = new Set();
  const domain = hostname(pageUrl);
  const re = /<a[^>]+href=["']([^"'#?][^"']*?)["'][^>]*>([\s\S]{4,2000}?)<\/a>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 8) continue;
    try {
      const url = new URL(match[1], pageUrl).href;
      if (hostname(url) !== domain || seen.has(url)) continue;
      seen.add(url);
      links.push({ url, title: title.slice(0, 240) });
    } catch { /* malformed link */ }
  }
  return links;
}

function newsLinks(links) {
  return links.filter(link => /news|press|release|enforce|action|consumer|financial|bank|payment|settlement|investigat|announcement|bulletin|alert/i.test(`${link.title} ${link.url}`));
}

function pageText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function directProbe(source) {
  try {
    const response = await fetch(source.url, {
      timeout: TIMEOUT_MS,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain' },
    });
    const html = await response.text();
    const links = response.ok ? extractLinks(html, response.url || source.url) : [];
    const text = pageText(html).slice(0, 12000);
    return {
      status: response.status,
      ok: response.ok,
      finalUrl: response.url || source.url,
      title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      linkCount: links.length,
      newsLinkCount: newsLinks(links).length,
      contentSignal: /\b(news|press releases?|announcements?|enforcement|consumer|financial)\b/i.test(text),
      error: null,
    };
  } catch (err) {
    return { status: null, ok: false, finalUrl: source.url, title: '', linkCount: 0, newsLinkCount: 0, contentSignal: false, error: err.message };
  }
}

async function browserProbe(page, source) {
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS * 2 });
    const result = await page.evaluate(() => ({
      title: document.title,
      links: Array.from(document.querySelectorAll('a[href]')).map(a => ({ url: a.href, title: (a.textContent || '').replace(/\s+/g, ' ').trim() })),
      text: (document.body?.innerText || '').slice(0, 12000),
    }));
    const links = result.links.filter(link => link.title.length >= 8 && hostname(link.url) === hostname(source.url));
    return {
      status: 200,
      ok: true,
      title: result.title.slice(0, 240),
      linkCount: links.length,
      newsLinkCount: newsLinks(links).length,
      contentSignal: /\b(news|press releases?|announcements?|enforcement|consumer|financial)\b/i.test(result.text),
      error: null,
    };
  } catch (err) {
    return { status: null, ok: false, title: '', linkCount: 0, newsLinkCount: 0, contentSignal: false, error: err.message };
  }
}

async function firecrawlProbe(source) {
  if (!process.env.FIRECRAWL_API_KEY) return { attempted: false, status: 'not-configured', markdownLength: 0, error: null };
  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST', timeout: TIMEOUT_MS * 2,
      headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: source.url, formats: ['markdown'] }),
    });
    const data = response.ok ? await response.json() : null;
    const markdown = data?.data?.markdown || data?.markdown || '';
    return { attempted: true, status: response.status, markdownLength: markdown.length, error: response.ok && markdown ? null : `HTTP ${response.status}` };
  } catch (err) {
    return { attempted: true, status: null, markdownLength: 0, error: err.message };
  }
}

async function searchProbe(provider, source) {
  const host = hostname(source.url);
  try {
    if (provider === 'brave') {
      if (!process.env.BRAVE_SEARCH_API_KEY) return { attempted: false, status: 'not-configured', resultCount: 0, sameDomainCount: 0, error: null };
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(`site:${host} (${BLOCK_TERMS})`)}&count=5`, {
        timeout: TIMEOUT_MS,
        headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY },
      });
      const data = response.ok ? await response.json() : null;
      const results = data?.web?.results || [];
      const sameDomain = results.filter(item => hostname(item.url) === host);
      return { attempted: true, status: response.status, resultCount: results.length, sameDomainCount: sameDomain.length, sameDomainResults: sameDomain.slice(0, 3).map(item => ({ title: item.title || '', url: item.url || '' })), error: response.ok ? null : `HTTP ${response.status}` };
    }
    if (!process.env.EXA_API_KEY) return { attempted: false, status: 'not-configured', resultCount: 0, sameDomainCount: 0, error: null };
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST', timeout: TIMEOUT_MS * 2,
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY },
      body: JSON.stringify({ query: `site:${host} ${BLOCK_TERMS}`, numResults: 5, type: 'neural', useAutoprompt: true, contents: { text: { maxCharacters: 300 } } }),
    });
    const data = response.ok ? await response.json() : null;
    const results = data?.results || [];
    const sameDomain = results.filter(item => hostname(item.url) === host);
    return { attempted: true, status: response.status, resultCount: results.length, sameDomainCount: sameDomain.length, sameDomainResults: sameDomain.slice(0, 3).map(item => ({ title: item.title || '', url: item.url || '' })), error: response.ok ? null : `HTTP ${response.status}` };
  } catch (err) {
    return { attempted: true, status: null, resultCount: 0, sameDomainCount: 0, sameDomainResults: [], error: err.message };
  }
}

function verdict(result) {
  const direct = result.direct;
  const browser = result.browser;
  const firecrawl = result.firecrawl;
  const brave = result.brave;
  const exa = result.exa;
  const readable = (direct.ok && (direct.newsLinkCount > 0 || direct.contentSignal))
    || (browser.ok && (browser.newsLinkCount > 0 || browser.contentSignal))
    || firecrawl.markdownLength > 200
    || brave.sameDomainCount > 0
    || exa.sameDomainCount > 0;
  if (readable) return 'checkable';
  if (direct.status === 403 || direct.status === 429 || direct.status === 503) return 'blocked-needs-search-or-browser';
  if (direct.status >= 400 || direct.error) return 'unreachable';
  return 'reachable-no-news-signal';
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

async function checkSource(source, browser) {
  const direct = await directProbe(source);
  const needsBrowser = !direct.ok || direct.newsLinkCount === 0;
  const browserResult = needsBrowser ? await browserProbe(browser, source) : { attempted: false, status: 'not-needed', linkCount: 0, newsLinkCount: 0, contentSignal: false, error: null };
  const needsFirecrawl = !direct.ok || direct.newsLinkCount === 0;
  const firecrawl = needsFirecrawl ? await firecrawlProbe(source) : { attempted: false, status: 'not-needed', markdownLength: 0, error: null };
  const brave = await searchProbe('brave', source);
  const exa = await searchProbe('exa', source);
  const urlConfidence = direct.status === 404 ? 'not-found-review' : (direct.ok ? 'directly-reachable' : 'fallback-required');
  const result = { name: source.name, kind: source.kind, url: source.url, host: hostname(source.url), urlConfidence, direct, browser: browserResult, firecrawl, brave, exa };
  return { ...result, verdict: verdict(result) };
}

async function main() {
  loadDotEnv();
  const allSources = sources();
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  let results;
  try {
    results = await mapLimit(allSources, CONCURRENCY, async source => {
      const page = await browser.newPage();
      try { return await checkSource(source, page); }
      finally { await page.close(); }
    });
  } finally {
    await browser.close();
  }
  // Keep output machine-readable and secret-free. Keys are represented only by
  // provider status, never by their values.
  const report = {
    checkedAt: new Date().toISOString(),
    sourceCount: allSources.length,
    providerAvailability: {
      direct: true,
      browser: true,
      firecrawl: Boolean(process.env.FIRECRAWL_API_KEY),
      brave: Boolean(process.env.BRAVE_SEARCH_API_KEY),
      exa: Boolean(process.env.EXA_API_KEY),
      browserbase: false,
      browserbaseNote: 'No Browserbase connector or API key is configured in this environment.',
    },
    summary: Object.fromEntries([...new Set(results.map(result => result.verdict))].map(verdictName => [verdictName, results.filter(result => result.verdict === verdictName).length])),
    results,
  };
  const outputPath = process.argv[2] || path.join(process.cwd(), 'data', 'us-source-health.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputPath, checkedAt: report.checkedAt, sourceCount: report.sourceCount, providerAvailability: report.providerAvailability, summary: report.summary }, null, 2));
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { sources, extractLinks, newsLinks, verdict };
