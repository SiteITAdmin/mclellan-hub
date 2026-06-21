'use strict';

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { startExtractionRun, finishExtractionRun } = require('./intelligence-audit');

// ── XML helpers ────────────────────────────────────────────────────────────────

function extractCdata(str) {
  const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : str;
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? extractCdata(m[1]).trim() : '';
}

function extractTagAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function parseRss(xml) {
  const itemBlocks = extractTagAll(xml, 'item');
  return itemBlocks.map(block => {
    const guid = extractTag(block, 'guid') || extractTag(block, 'link');
    const link = extractTag(block, 'link') || guid;
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published');
    const contentEncoded = extractTag(block, 'content:encoded') || extractTag(block, 'content');
    const description = extractTag(block, 'description');
    return {
      title: extractTag(block, 'title'),
      url: link,
      guid,
      pubDate,
      content: contentEncoded || description,
    };
  });
}

// ── HTML → readable markdown ───────────────────────────────────────────────────

function htmlToMarkdown(html) {
  return String(html || '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${'#'.repeat(+n)} ${stripTags(t)}\n`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${stripTags(t)}**`)
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${stripTags(t)}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `*${stripTags(t)}*`)
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `*${stripTags(t)}*`)
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `[${stripTags(text)}](${href})`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${stripTags(t).trim()}\n`)
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, t) => `${stripTags(t).trim()}\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => t.split('\n').map(l => `> ${l}`).join('\n') + '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(str) {
  return String(str || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function titleToSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

// ── Provider cascade helpers (for non-RSS feeds) ──────────────────────────────
// These mirror lib/watchlist.js but write into intel pipeline instead of watchlist_stories.

function parseRssFeed(xml) {
  const stories = [];
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const title = (item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const link  = (item.match(/<link[^>]*>([^<]+)<\/link>/i) || item.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1]?.trim();
    const pubDate = (item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i) || [])[1]?.trim();
    const desc = (item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || item.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (title && link) {
      stories.push({ url: link, title, snippet: desc || '', publishedAt: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null });
    }
  }
  return stories;
}

async function rssFetchSmart(url) {
  const candidates = [url];
  if (!/\/(feed|rss|atom)(\.xml)?(\/?$)/i.test(url) && !/^https?:\/\/feeds\./i.test(url)) {
    const base = url.replace(/\/$/, '');
    candidates.push(base + '/feed/', base + '/feed.xml', base + '/atom.xml');
    try {
      const root = new URL(url).origin;
      if (!candidates.some(c => c.startsWith(root + '/feed'))) {
        candidates.push(root + '/feed/', root + '/feed.xml', root + '/atom.xml');
      }
    } catch { /* ignore */ }
  }
  for (const feedUrl of candidates) {
    try {
      const r = await fetch(feedUrl, { timeout: 15000, headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' } });
      if (!r.ok) continue;
      const xml = await r.text();
      if (!xml.includes('<item>') && !xml.includes('<entry>')) continue;
      const stories = parseRssFeed(xml);
      if (stories.length) return { stories: stories.slice(0, 30), provider: 'rss', feedUrl };
    } catch { /* try next */ }
  }
  try {
    const r = await fetch(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Hub/1.0)', Accept: 'text/html' } });
    if (!r.ok) return null;
    const html = await r.text();
    const feedLinkRe = /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)["']/gi;
    let lm;
    while ((lm = feedLinkRe.exec(html)) !== null) {
      try {
        const feedUrl = new URL(lm[1], url).href;
        const r2 = await fetch(feedUrl, { timeout: 15000, headers: { Accept: 'application/rss+xml,application/xml' } });
        if (!r2.ok) continue;
        const xml = await r2.text();
        const stories = parseRssFeed(xml);
        if (stories.length) return { stories: stories.slice(0, 30), provider: 'rss', feedUrl };
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  return null;
}

async function firecrawlFetch(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST', timeout: 30000,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });
  if (!r.ok) { if (r.status === 429) return { rateLimited: true }; return null; }
  const data = await r.json();
  const markdown = data?.data?.markdown || '';
  if (!markdown.trim()) return null;
  return { markdown, provider: 'firecrawl' };
}

function extractStoriesFromMarkdown(markdown, baseUrl) {
  const stories = [];
  const seen = new Set();
  let domain;
  try { domain = new URL(baseUrl).hostname; } catch { return stories; }
  const re = /\[([^\]]{4,200})\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const title = m[1].trim();
    if (title.length < 10) continue;
    try {
      const full = new URL(m[2].trim(), baseUrl).href;
      if (new URL(full).hostname === domain && !seen.has(full)) {
        seen.add(full);
        stories.push({ url: full, title, snippet: '' });
      }
    } catch { /* skip */ }
  }
  return stories.slice(0, 30);
}

async function exaFetch(url) {
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  const domain = new URL(url).hostname;
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST', timeout: 20000,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ query: `site:${domain} latest news`, numResults: 10, type: 'auto', useAutoprompt: true, startPublishedDate: new Date(Date.now() - 30 * 864e5).toISOString(), contents: { text: { maxCharacters: 500 } } }),
  });
  if (!r.ok) { if (r.status === 429) return { rateLimited: true }; return null; }
  const data = await r.json();
  const stories = (data.results || []).map(x => ({ url: x.url, title: x.title || x.url, snippet: (x.text || '').slice(0, 500), publishedAt: x.publishedDate ? Math.floor(new Date(x.publishedDate).getTime() / 1000) : null }));
  return { stories, provider: 'exa' };
}

async function braveFetch(url) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const domain = new URL(url).hostname;
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=site:${encodeURIComponent(domain)}&count=10&extra_snippets=true`, {
    timeout: 15000, headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  if (!r.ok) { if (r.status === 429) return { rateLimited: true }; return null; }
  const data = await r.json();
  const stories = (data.web?.results || []).map(x => ({ url: x.url, title: x.title || x.url, snippet: x.description || '' }));
  return { stories, provider: 'brave' };
}

async function directFetch(url) {
  const r = await fetch(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Hub/1.0)', Accept: 'text/html,application/xhtml+xml' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const domain = new URL(url).hostname;
  const stories = [];
  const seen = new Set();
  const re = /<a[^>]+href=["']([^"'#?][^"']*?)["'][^>]*>([\s\S]{4,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 10) continue;
    try {
      const full = new URL(m[1].trim(), url).href;
      if (new URL(full).hostname === domain && !seen.has(full)) {
        seen.add(full);
        stories.push({ url: full, title, snippet: '' });
      }
    } catch { /* skip */ }
  }
  return { stories: stories.slice(0, 30), provider: 'direct' };
}

async function fetchArticleContent(url) {
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await firecrawlFetch(url);
      if (r?.markdown?.trim()) return r.markdown.slice(0, 50000);
    } catch { /* fall through */ }
  }
  try {
    const r = await fetch(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Hub/1.0)', Accept: 'text/html,application/xhtml+xml' } });
    if (!r.ok) return '';
    const html = await r.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '');
    const paragraphs = [];
    const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (text.length > 40) paragraphs.push(text);
    }
    return paragraphs.join('\n\n').slice(0, 50000);
  } catch { return ''; }
}

// ── Write a story to rss_articles + intel pipeline ────────────────────────────

async function writeStoryToIntel(hub, feedRow, user, story, content) {
  const guid = story.guid || story.url;
  const publishedAt = story.publishedAt || Math.floor(Date.now() / 1000);
  const wc = wordCount(content);

  const articleId = uuid();
  try {
    hub.prepare(`
      INSERT INTO rss_articles
        (id, feed_id, user, creator_slug, guid, title, url, published_at, content_markdown, word_count, vault_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(articleId, feedRow.id, user, feedRow.creator_slug, guid,
      story.title.slice(0, 500), story.url, publishedAt, content, wc);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return 'skipped';
    throw err;
  }

  const sourceId = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO intel_sources
      (id, user, name, source_kind, match_type, match_value)
    VALUES (?, ?, ?, 'rss', 'feed_url', ?)
  `).run(sourceId, user, feedRow.name, feedRow.url);

  const source = hub.prepare(
    'SELECT id FROM intel_sources WHERE user = ? AND source_kind = \'rss\' AND match_type = \'feed_url\' AND match_value = ?'
  ).get(user, feedRow.url);

  const documentId = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO intel_documents
      (id, user, source_id, external_id, source_kind, title, sender_name, source_url, published_at, content_text)
    VALUES (?, ?, ?, ?, 'rss', ?, ?, ?, ?, ?)
  `).run(documentId, user, source?.id || null, guid, story.title, feedRow.name, story.url, publishedAt, content);

  const document = hub.prepare(
    'SELECT id FROM intel_documents WHERE user = ? AND source_kind = \'rss\' AND external_id = ?'
  ).get(user, guid);

  if (document) {
    const runStartedAt = Date.now();
    const runId = startExtractionRun({ user, documentId: document.id, method: 'direct_rss' });
    try {
      hub.prepare(`
        INSERT INTO intel_items
          (id, user, document_id, title, summary, content_text, item_type,
           category, entities_json, themes_json, source_url, published_at,
           extraction_method, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'article', 'Other', '[]', '[]', ?, ?, 'direct_rss', unixepoch())
      `).run(uuid(), user, document.id, story.title, content.slice(0, 500).replace(/\s+/g, ' '), content, story.url, publishedAt);
      finishExtractionRun(runId, { status: 'complete', itemCount: 1, durationMs: Date.now() - runStartedAt });
    } catch (err) {
      finishExtractionRun(runId, { status: 'failed', itemCount: 0, durationMs: Date.now() - runStartedAt, error: err.message });
      throw err;
    }
  }

  return 'ingested';
}

// ── Feed ingestion ─────────────────────────────────────────────────────────────

function buildFetchHeaders(url) {
  const headers = { 'User-Agent': 'McLellan-Hub/1.0 (RSS reader)' };
  if (url.includes('substack.com') && process.env.SUBSTACK_SID) {
    headers['Cookie'] = `substack.sid=${process.env.SUBSTACK_SID}`;
  }
  return headers;
}

async function ingestFeed(feedRow, user) {
  const hub = db.hub();

  // ── RSS path: fast, structured, preferred for feeds with RSS URLs ─────────
  let rssXml;
  try {
    const res = await fetch(feedRow.url, { headers: buildFetchHeaders(feedRow.url), timeout: 15000 });
    if (res.ok) rssXml = await res.text();
  } catch { /* fall through to cascade */ }

  if (rssXml) {
    const items = parseRss(rssXml);
    if (items.length > 0) {
      let ingested = 0, skipped = 0;
      for (const item of items) {
        if (!item.guid || !item.title) { skipped++; continue; }
        const exists = hub.prepare('SELECT 1 FROM rss_articles WHERE user = ? AND (url = ? OR (feed_id = ? AND guid = ?))').get(user, item.url, feedRow.id, item.guid);
        if (exists) { skipped++; continue; }
        const publishedAt = item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
        if (isNaN(publishedAt)) { skipped++; continue; }
        const content = htmlToMarkdown(item.content);
        try {
          const status = await writeStoryToIntel(hub, feedRow, user,
            { guid: item.guid, url: item.url, title: item.title, publishedAt },
            content
          );
          if (status === 'skipped') skipped++; else { ingested++; console.log(`[rss] ingested: ${feedRow.creator_slug} / "${item.title}"`); }
        } catch (err) {
          if (!err.message.includes('UNIQUE')) console.error(`[rss] db insert failed: ${err.message}`);
          else skipped++;
        }
      }
      hub.prepare('UPDATE rss_feeds SET last_fetched_at = unixepoch(), last_error = NULL, error_count = 0 WHERE id = ?').run(feedRow.id);
      return { ingested, skipped };
    }
    // XML parsed but no items — might not be RSS. Fall through to cascade.
  }

  // ── Provider cascade: for non-RSS URLs or feeds where RSS probe failed ────
  // Only attempt cascade if provider isn't locked to 'rss'
  if (feedRow.provider === 'rss') {
    hub.prepare('UPDATE rss_feeds SET last_fetched_at = unixepoch() WHERE id = ?').run(feedRow.id);
    return { ingested: 0, skipped: 0 };
  }

  let cascadeResult = null;
  let usedProvider = null;

  const cascade = [];
  const preferred = feedRow.provider || 'auto';
  if (preferred !== 'auto') cascade.push(preferred);
  if (!cascade.includes('firecrawl') && process.env.FIRECRAWL_API_KEY) cascade.push('firecrawl');
  if (!cascade.includes('exa') && process.env.EXA_API_KEY) cascade.push('exa');
  if (!cascade.includes('brave') && process.env.BRAVE_SEARCH_API_KEY) cascade.push('brave');
  if (!cascade.includes('direct')) cascade.push('direct');

  // RSS-smart probe comes first in cascade
  try {
    const rssResult = await rssFetchSmart(feedRow.url);
    if (rssResult?.stories?.length) {
      cascadeResult = rssResult;
      usedProvider = 'rss';
    }
  } catch { /* continue */ }

  if (!cascadeResult) {
    for (const p of cascade) {
      try {
        let result = null;
        if (p === 'firecrawl') {
          result = await firecrawlFetch(feedRow.url);
          if (result?.rateLimited) { result = null; continue; }
          if (result?.markdown) result = { stories: extractStoriesFromMarkdown(result.markdown, feedRow.url), provider: 'firecrawl' };
        } else if (p === 'exa') {
          result = await exaFetch(feedRow.url);
          if (result?.rateLimited) { result = null; continue; }
        } else if (p === 'brave') {
          result = await braveFetch(feedRow.url);
          if (result?.rateLimited) { result = null; continue; }
        } else {
          result = await directFetch(feedRow.url);
        }
        if (result?.stories?.length) { cascadeResult = result; usedProvider = result.provider || p; break; }
      } catch (err) {
        console.warn(`[feed-cascade] ${p} failed for ${feedRow.url}: ${err.message}`);
      }
    }
  }

  if (!cascadeResult?.stories?.length) {
    const errorCount = (feedRow.error_count || 0) + 1;
    const willDisable = errorCount >= 3;
    hub.prepare(`UPDATE rss_feeds SET last_error = ?, error_count = ?${willDisable ? ', enabled = 0' : ''} WHERE id = ?`)
      .run('All providers returned no stories', errorCount, feedRow.id);
    if (willDisable) console.warn(`[feed-cascade] auto-disabled feed "${feedRow.name}" (${feedRow.url}) after ${errorCount} failures`);
    return { ingested: 0, skipped: 0, error: 'All providers returned no stories' };
  }

  // Ingest cascade results — enrich with full article content (cap at 10 per cycle)
  let ingested = 0, skipped = 0;
  const toProcess = cascadeResult.stories.slice(0, 20);
  for (let i = 0; i < toProcess.length; i++) {
    const story = toProcess[i];
    if (!story.url || !story.title) { skipped++; continue; }
    const exists = hub.prepare('SELECT 1 FROM rss_articles WHERE user = ? AND guid = ?').get(user, story.url);
    if (exists) { skipped++; continue; }
    const content = i < 10 ? await fetchArticleContent(story.url) : (story.snippet || '');
    try {
      const status = await writeStoryToIntel(hub, feedRow, user, { ...story, guid: story.url }, content);
      if (status === 'skipped') skipped++; else { ingested++; console.log(`[feed-cascade] ingested: ${feedRow.name} / "${story.title}" (${usedProvider})`); }
    } catch (err) {
      if (!err.message.includes('UNIQUE')) console.error(`[feed-cascade] db insert failed: ${err.message}`);
      else skipped++;
    }
  }

  hub.prepare('UPDATE rss_feeds SET last_fetched_at = unixepoch(), last_error = NULL, error_count = 0 WHERE id = ?').run(feedRow.id);
  return { ingested, skipped, provider: usedProvider };
}

async function ingestAllFeeds(user = 'douglas', { dueOnly = false } = {}) {
  const hub = db.hub();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const feeds = dueOnly
    ? hub.prepare('SELECT * FROM rss_feeds WHERE user = ? AND enabled = 1 AND (last_fetched_at IS NULL OR last_fetched_at + interval_mins * 60 <= ?)').all(user, nowEpoch)
    : hub.prepare('SELECT * FROM rss_feeds WHERE user = ? AND enabled = 1').all(user);
  let total = { ingested: 0, skipped: 0 };
  for (const feed of feeds) {
    const result = await ingestFeed(feed, user);
    total.ingested += result.ingested;
    total.skipped += result.skipped;
  }
  console.log(`[rss] all feeds done: ${total.ingested} ingested, ${total.skipped} skipped`);
  return total;
}

module.exports = { ingestFeed, ingestAllFeeds, parseRss, htmlToMarkdown };
