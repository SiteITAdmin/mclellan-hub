'use strict';

const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { writeNote } = require('./obsidian-vault');

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
  while ((m = re.exec(xml)) !== null) out.push(extractCdata(m[1]).trim());
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

// ── Feed ingestion ─────────────────────────────────────────────────────────────

async function ingestFeed(feedRow, user) {
  const hub = db.hub();
  let xml;
  try {
    const res = await fetch(feedRow.url, {
      headers: { 'User-Agent': 'McLellan-Hub/1.0 (RSS reader)' },
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    console.error(`[rss] fetch failed for ${feedRow.name}: ${err.message}`);
    return { ingested: 0, skipped: 0 };
  }

  const items = parseRss(xml);
  let ingested = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.guid || !item.title) { skipped++; continue; }

    const exists = hub.prepare('SELECT 1 FROM rss_articles WHERE feed_id = ? AND guid = ?').get(feedRow.id, item.guid);
    if (exists) { skipped++; continue; }

    const publishedAt = item.pubDate ? Math.floor(new Date(item.pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
    if (isNaN(publishedAt)) { skipped++; continue; }

    const content = htmlToMarkdown(item.content);
    const wc = wordCount(content);
    const dateStr = new Date(publishedAt * 1000).toISOString().slice(0, 10);
    const slug = titleToSlug(item.title);
    const vaultPath = `Creators/${feedRow.creator_slug}/${dateStr}-${slug}.md`;

    const vaultContent = `# ${item.title}\n\n**Source:** [${feedRow.name}](${item.url})  \n**Published:** ${dateStr}  \n**Creator:** ${feedRow.creator_slug}\n\n---\n\n${content}\n`;

    let savedVaultPath = null;
    try {
      writeNote({ notePath: vaultPath, content: vaultContent, mode: 'overwrite' });
      savedVaultPath = vaultPath;
    } catch (err) {
      console.warn(`[rss] vault write failed for "${item.title}": ${err.message}`);
    }

    const id = uuid();
    try {
      hub.prepare(`
        INSERT INTO rss_articles (id, feed_id, user, creator_slug, guid, title, url, published_at, content_markdown, word_count, vault_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, feedRow.id, user, feedRow.creator_slug, item.guid, item.title, item.url, publishedAt, content, wc, savedVaultPath);
      ingested++;
      console.log(`[rss] ingested: ${feedRow.creator_slug} / "${item.title}"`);
    } catch (err) {
      if (!err.message.includes('UNIQUE')) console.error(`[rss] db insert failed: ${err.message}`);
      else skipped++;
    }
  }

  hub.prepare('UPDATE rss_feeds SET last_fetched_at = unixepoch() WHERE id = ?').run(feedRow.id);
  return { ingested, skipped };
}

async function ingestAllFeeds(user = 'douglas') {
  const hub = db.hub();
  const feeds = hub.prepare('SELECT * FROM rss_feeds WHERE user = ? AND enabled = 1').all(user);
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
