'use strict';

const fetch = require('./fetch');
const db    = require('./db');
const { uuid } = require('./id');

// ── Provider helpers ──────────────────────────────────────────────────────────

/**
 * Decide which provider to use for a given URL.
 * Cascade: Firecrawl → Exa → Brave → direct HTTP.
 * If the user specified a provider other than 'auto', honour it.
 */
function getProviderForUrl(url, preferred) {
  if (preferred && preferred !== 'auto') return preferred;
  if (process.env.FIRECRAWL_API_KEY) return 'firecrawl';
  if (process.env.EXA_API_KEY)       return 'exa';
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  return 'direct';
}

// ── RSS/Atom feed fetch ───────────────────────────────────────────────────────

function parseRssFeed(xml) {
  const stories = [];
  // RSS <item> or Atom <entry>
  const itemRe = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const title = (item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const link  = (item.match(/<link[^>]*>([^<]+)<\/link>/i) || item.match(/<link[^>]+href=["']([^"']+)["']/i) || [])[1]?.trim();
    const pubDate = (item.match(/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/i) || [])[1]?.trim();
    const desc = (item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || item.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/i) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (title && link) {
      stories.push({
        url: link,
        title,
        snippet: desc || '',
        publishedAt: pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : null,
      });
    }
  }
  return stories;
}

async function rssFetch(url) {
  // 1. Try appending /feed/ to the URL (WordPress pattern)
  // 2. Try known feed paths relative to the root
  // 3. Sniff the HTML for <link rel="alternate" type="application/rss+xml">
  const candidates = [];

  // URL-relative: add /feed/ if not already a feed URL
  if (!/\/(feed|rss|atom)(\.xml)?(\/?$)/i.test(url)) {
    const base = url.replace(/\/$/, '');
    candidates.push(base + '/feed/', base + '/feed.xml', base + '/atom.xml');
    // Also try root-level feed
    try {
      const root = new URL(url).origin;
      if (!candidates.some(c => c.startsWith(root + '/feed'))) {
        candidates.push(root + '/feed/', root + '/feed.xml', root + '/atom.xml');
      }
    } catch { /* ignore */ }
  } else {
    candidates.push(url);
  }

  // Try each candidate
  for (const feedUrl of candidates) {
    try {
      const r = await fetch(feedUrl, {
        timeout: 15000,
        headers: { Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' },
      });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      const xml = await r.text();
      if (!xml.includes('<item>') && !xml.includes('<entry>')) continue;
      const stories = parseRssFeed(xml);
      if (stories.length) return { stories: stories.slice(0, 30), provider: 'rss', feedUrl };
    } catch { /* try next */ }
  }

  // Sniff the page HTML for a feed link
  try {
    const r = await fetch(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Watchlist/1.0)', Accept: 'text/html' },
    });
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

// ── Firecrawl: full-page scrape → markdown → extract links ────────────────────

async function firecrawlFetch(url) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });
  if (!r.ok) {
    if (r.status === 429) return { rateLimited: true };
    throw new Error(`Firecrawl HTTP ${r.status}`);
  }
  const data = await r.json();
  const markdown = data?.data?.markdown || '';
  if (!markdown.trim()) return null;
  return { markdown, provider: 'firecrawl', metadata: data?.data?.metadata || {} };
}

// ── Exa: semantic search for site's latest content ────────────────────────────

async function exaFetch(url) {
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  const domain = new URL(url).hostname;
  const r = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    timeout: 20000,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query: `site:${domain} latest news updates`,
      numResults: 10,
      type: 'auto',
      useAutoprompt: true,
      startPublishedDate: new Date(Date.now() - 30 * 864e5).toISOString(),
      contents: { text: { maxCharacters: 500 } },
    }),
  });
  if (!r.ok) {
    if (r.status === 429) return { rateLimited: true };
    throw new Error(`Exa HTTP ${r.status}`);
  }
  const data = await r.json();
  const stories = (data.results || []).map(x => ({
    url: x.url,
    title: x.title || x.url,
    snippet: (x.text || x.summary || '').slice(0, 500),
    publishedAt: x.publishedDate ? Math.floor(new Date(x.publishedDate).getTime() / 1000) : null,
  }));
  return { stories, provider: 'exa' };
}

// ── Brave: web search for site content ────────────────────────────────────────

async function braveFetch(url) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const domain = new URL(url).hostname;
  const r = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=site:${encodeURIComponent(domain)}&count=10&extra_snippets=true`,
    {
      timeout: 15000,
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }
  );
  if (!r.ok) {
    if (r.status === 429) return { rateLimited: true };
    throw new Error(`Brave HTTP ${r.status}`);
  }
  const data = await r.json();
  const stories = (data.web?.results || []).map(x => ({
    url: x.url,
    title: x.title || x.url,
    snippet: x.description || (x.extra_snippets || [])[0] || '',
  }));
  return { stories, provider: 'brave' };
}

// ── Direct HTTP: scrape page for links (like regulatory-monitor) ──────────────

async function directFetch(url) {
  const r = await fetch(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Watchlist/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const domain = new URL(url).hostname;
  const stories = [];
  const seen = new Set();

  // Extract <a> links from the page
  const re = /<a[^>]+href=["']([^"'#?][^"']*?)["'][^>]*>([\s\S]{4,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw   = m[1].trim();
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 10) continue;
    try {
      const full = new URL(raw, url).href;
      if (new URL(full).hostname === domain && !seen.has(full)) {
        seen.add(full);
        stories.push({ url: full, title, snippet: '' });
      }
    } catch { /* skip malformed */ }
  }
  return { stories: stories.slice(0, 30), provider: 'direct' };
}

// ── Article content fetcher ───────────────────────────────────────────────────

function extractArticleText(html) {
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
  return paragraphs.join('\n\n').slice(0, 10000);
}

async function fetchArticleContent(url) {
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await firecrawlFetch(url);
      if (r?.markdown?.trim()) return r.markdown.slice(0, 10000);
    } catch { /* fall through */ }
  }
  try {
    const r = await fetch(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Watchlist/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!r.ok) return '';
    const html = await r.text();
    return extractArticleText(html);
  } catch { return ''; }
}

// ── Extract stories from markdown (for Firecrawl results) ─────────────────────

function extractStoriesFromMarkdown(markdown, baseUrl) {
  const stories = [];
  const seen = new Set();
  const domain = new URL(baseUrl).hostname;

  // Match markdown links: [title](url)
  const re = /\[([^\]]{4,200})\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const title = m[1].trim();
    const raw = m[2].trim();
    if (!title || title.length < 10) continue;
    try {
      const full = new URL(raw, baseUrl).href;
      if (new URL(full).hostname === domain && !seen.has(full)) {
        seen.add(full);
        stories.push({ url: full, title, snippet: '' });
      }
    } catch { /* skip */ }
  }
  return stories.slice(0, 30);
}

// ── Main fetch dispatcher ─────────────────────────────────────────────────────

async function fetchWatchlistUrl(feedRow) {
  const hub = db.hub();
  const provider = getProviderForUrl(feedRow.url, feedRow.provider);
  let result = null;
  let usedProvider = provider;

  // RSS is always tried first — free, structured, reliable
  try {
    const rssResult = await rssFetch(feedRow.url);
    if (rssResult?.stories?.length) {
      result = rssResult;
      usedProvider = 'rss';
    }
  } catch (err) {
    console.warn(`[watchlist] RSS probe failed for ${feedRow.url}: ${err.message}`);
  }

  if (!result) {
  // Provider cascade with fallback
  const cascade = [provider];
  if (provider !== 'firecrawl' && process.env.FIRECRAWL_API_KEY) cascade.unshift('firecrawl');
  if (!cascade.includes('exa') && process.env.EXA_API_KEY) cascade.push('exa');
  if (!cascade.includes('brave') && process.env.BRAVE_SEARCH_API_KEY) cascade.push('brave');
  if (!cascade.includes('direct')) cascade.push('direct');

  // De-duplicate cascade (keep order, remove repeats)
  const seen = new Set();
  const uniqueCascade = cascade.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; });

  for (const p of uniqueCascade) {
    try {
      if (p === 'firecrawl') {
        result = await firecrawlFetch(feedRow.url);
        if (result?.rateLimited) { result = null; continue; }
        if (result?.markdown) {
          result = { stories: extractStoriesFromMarkdown(result.markdown, feedRow.url), provider: 'firecrawl' };
        }
      } else if (p === 'exa') {
        result = await exaFetch(feedRow.url);
        if (result?.rateLimited) { result = null; continue; }
      } else if (p === 'brave') {
        result = await braveFetch(feedRow.url);
        if (result?.rateLimited) { result = null; continue; }
      } else {
        result = await directFetch(feedRow.url);
      }

      if (result?.stories?.length) {
        usedProvider = result.provider || p;
        break;
      }
      result = null;
    } catch (err) {
      console.warn(`[watchlist] ${p} failed for ${feedRow.url}: ${err.message}`);
      result = null;
    }
  }
  } // end if (!result) cascade

  if (!result || !result.stories?.length) {
    // All providers failed — record error
    const errorCount = (feedRow.error_count || 0) + 1;
    const updates = { last_error: 'All providers returned no stories', error_count: errorCount };
    if (errorCount >= 3) {
      updates.enabled = 0;
      console.warn(`[watchlist] auto-disabled feed "${feedRow.label}" (${feedRow.url}) after ${errorCount} consecutive failures`);
    }
    hub.prepare(`
      UPDATE watchlist_feeds
      SET last_error = ?, error_count = ?${errorCount >= 3 ? ', enabled = 0' : ''}
      WHERE id = ?
    `).run(updates.last_error, updates.error_count, feedRow.id);
    return { new: 0, total: 0, error: updates.last_error };
  }

  // Insert new stories, dedup by (feed_id, url)
  let newCount = 0;
  const newStories = []; // track newly inserted for content enrichment
  for (const story of result.stories) {
    if (!story.url || !story.title) continue;
    try {
      const storyId = uuid();
      const res = hub.prepare(`
        INSERT OR IGNORE INTO watchlist_stories
          (id, feed_id, user, url, title, snippet, published_at, provider_used)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        storyId, feedRow.id, feedRow.user, story.url,
        story.title.slice(0, 500), (story.snippet || '').slice(0, 1000),
        story.publishedAt || null, usedProvider
      );
      if (res.changes) {
        newCount++;
        newStories.push({ id: storyId, url: story.url });
      }
    } catch (err) {
      if (!err.message.includes('UNIQUE')) {
        console.warn(`[watchlist] story insert error: ${err.message}`);
      }
    }
  }

  // Enrich new stories with full article content (cap at 10 per cycle)
  const toEnrich = newStories.slice(0, 10);
  for (const { id, url: storyUrl } of toEnrich) {
    try {
      const content = await fetchArticleContent(storyUrl);
      if (content) {
        hub.prepare('UPDATE watchlist_stories SET content_markdown = ? WHERE id = ?').run(content, id);
      }
    } catch { /* ignore enrichment failures */ }
  }

  // Success — reset error state, update last_fetched_at
  hub.prepare(`
    UPDATE watchlist_feeds
    SET last_fetched_at = unixepoch(), last_error = NULL, error_count = 0
    WHERE id = ?
  `).run(feedRow.id);

  console.log(`[watchlist] ${feedRow.label || feedRow.url}: ${newCount} new stories (${usedProvider})`);
  return { new: newCount, total: result.stories.length, provider: usedProvider };
}

// ── Process all due feeds ─────────────────────────────────────────────────────

async function processAllDueFeeds(user) {
  const hub = db.hub();
  const nowEpoch = Math.floor(Date.now() / 1000);

  const dueFeeds = hub.prepare(`
    SELECT * FROM watchlist_feeds
    WHERE user = ? AND enabled = 1
      AND (last_fetched_at IS NULL OR last_fetched_at + interval_mins * 60 <= ?)
    ORDER BY last_fetched_at ASC
  `).all(user, nowEpoch);

  if (!dueFeeds.length) return { processed: 0, total: 0 };

  let totalNew = 0;
  let processed = 0;
  for (const feed of dueFeeds) {
    try {
      const result = await fetchWatchlistUrl(feed);
      totalNew += result.new || 0;
      processed++;
    } catch (err) {
      console.error(`[watchlist] unexpected error processing ${feed.url}: ${err.message}`);
      // Record error on the feed
      const errorCount = (feed.error_count || 0) + 1;
      hub.prepare(`
        UPDATE watchlist_feeds
        SET last_error = ?, error_count = ?${errorCount >= 3 ? ', enabled = 0' : ''}
        WHERE id = ?
      `).run(err.message.slice(0, 500), errorCount, feed.id);
    }
  }

  console.log(`[watchlist] processed ${processed} due feeds for ${user}: ${totalNew} new stories`);
  return { processed, totalNew };
}

module.exports = { fetchWatchlistUrl, processAllDueFeeds, getProviderForUrl, fetchArticleContent };
