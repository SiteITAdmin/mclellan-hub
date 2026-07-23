#!/usr/bin/env node
/**
 * Fix broken M365 RSS URLs and add practical admin feeds for Douglas's
 * news briefing pipeline.
 *
 * Usage:
 *   node scripts/fix-m365-rss-feeds.js              # upsert feeds only
 *   node scripts/fix-m365-rss-feeds.js --fetch      # upsert then ingest
 *   node scripts/fix-m365-rss-feeds.js --user=douglas
 *
 * HUB_DB_PATH can point at a snapshot or prod path.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../lib/db');
const { uuid } = require('../lib/id');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
);

const USER = args.user || 'douglas';
const DO_FETCH = Boolean(args.fetch);

// Known-good M365 / Entra / Teams admin feeds (verified HTTP 200 + items).
// creator_slug is the stable key for upsert.
const M365_FEEDS = [
  // Fixes for feeds that were registered with site roots (0 articles)
  {
    name: 'SharePoint Maven',
    creator_slug: 'sharepoint',
    url: 'https://sharepointmaven.com/feed/',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'Microsoft 365 for IT Pros',
    creator_slug: 'office-365',
    url: 'https://office365itpros.com/feed/',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'Roadmap Watch',
    creator_slug: 'roadmap',
    url: 'https://www.roadmapwatch.com/rss',
    feed_group: 'work',
    provider: 'rss',
  },
  // Entra — often pointed at a single post URL instead of the feed
  {
    name: 'Entra News',
    creator_slug: 'entra',
    url: 'https://entra.news/feed',
    feed_group: 'work',
    provider: 'rss',
  },
  // New practical M365 sources
  // Cloudflare often blocks VPS IPs (403). Left in catalog as provider auto;
  // script enables it, but operators may need Firecrawl or to disable if empty.
  {
    name: 'M365 Admin (Hands on Tek)',
    creator_slug: 'm365-admin',
    url: 'https://m365admin.handsontek.net/feed/',
    feed_group: 'work',
    provider: 'auto',
  },
  {
    name: 'Practical 365',
    creator_slug: 'practical-365',
    url: 'https://practical365.com/feed/',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'LazyAdmin',
    creator_slug: 'lazyadmin',
    url: 'https://lazyadmin.nl/feed/',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'Mike McBride on M365',
    creator_slug: 'mcbride-m365',
    url: 'https://mcbridem365.substack.com/feed',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'Microsoft Teams Blog',
    creator_slug: 'teams-blog',
    url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=MicrosoftTeamsBlog',
    feed_group: 'work',
    provider: 'rss',
  },
  {
    name: 'Joanne C Klein',
    creator_slug: 'joanne-c-klein',
    url: 'https://joannecklein.com/feed/',
    feed_group: 'work',
    provider: 'rss',
  },
];

function reassignArticles(hub, fromFeedId, toFeedId, creatorSlug) {
  // Drop articles that would collide on the keeper feed, then move the rest.
  hub.prepare(`
    DELETE FROM rss_articles
    WHERE feed_id = ?
      AND EXISTS (
        SELECT 1 FROM rss_articles kept
        WHERE kept.feed_id = ?
          AND (kept.guid = rss_articles.guid OR kept.url = rss_articles.url)
      )
  `).run(fromFeedId, toFeedId);
  hub.prepare(`
    UPDATE rss_articles
       SET feed_id = ?, creator_slug = ?
     WHERE feed_id = ?
  `).run(toFeedId, creatorSlug, fromFeedId);
}

function deleteFeedRow(hub, feedId) {
  hub.prepare('DELETE FROM rss_articles WHERE feed_id = ?').run(feedId);
  hub.prepare('DELETE FROM rss_feeds WHERE id = ?').run(feedId);
}

function upsertFeed(hub, feed) {
  const existingBySlug = hub.prepare(
    'SELECT id, url, name, creator_slug FROM rss_feeds WHERE user = ? AND creator_slug = ?'
  ).get(USER, feed.creator_slug);

  const existingByUrl = hub.prepare(
    'SELECT id, creator_slug, url, name FROM rss_feeds WHERE user = ? AND url = ?'
  ).get(USER, feed.url);

  // Prefer the row that already has the correct URL (may be a different slug on prod).
  // Keep that row; retire a broken homepage-URL duplicate under our preferred slug.
  if (existingByUrl) {
    const oldUrlOnSlug = existingBySlug && existingBySlug.id !== existingByUrl.id
      ? existingBySlug.url
      : null;
    if (existingBySlug && existingBySlug.id !== existingByUrl.id) {
      reassignArticles(hub, existingBySlug.id, existingByUrl.id, existingByUrl.creator_slug);
      deleteFeedRow(hub, existingBySlug.id);
    }
    hub.prepare(`
      UPDATE rss_feeds
         SET name = COALESCE(NULLIF(name, ''), ?),
             feed_group = CASE WHEN feed_group = 'personal' THEN feed_group ELSE ? END,
             provider = ?,
             enabled = 1,
             last_error = NULL,
             error_count = 0
       WHERE id = ?
    `).run(feed.name, feed.feed_group, feed.provider, existingByUrl.id);
    ensureIntelSource(hub, feed, oldUrlOnSlug);
    return {
      action: existingBySlug && existingBySlug.id !== existingByUrl.id ? 'merged' : 'unchanged',
      id: existingByUrl.id,
      from: existingByUrl.creator_slug,
    };
  }

  // Slug exists, target URL free — fix URL in place (homepage → real feed).
  if (existingBySlug) {
    const oldUrl = existingBySlug.url;
    hub.prepare(`
      UPDATE rss_feeds
         SET name = ?,
             url = ?,
             feed_group = ?,
             provider = ?,
             enabled = 1,
             last_error = NULL,
             error_count = 0
       WHERE id = ?
    `).run(feed.name, feed.url, feed.feed_group, feed.provider, existingBySlug.id);
    ensureIntelSource(hub, feed, oldUrl);
    return { action: oldUrl === feed.url ? 'unchanged' : 'updated', id: existingBySlug.id, from: oldUrl };
  }

  const id = uuid();
  hub.prepare(`
    INSERT INTO rss_feeds
      (id, user, name, creator_slug, url, enabled, provider, interval_mins, feed_group, error_count)
    VALUES (?, ?, ?, ?, ?, 1, ?, 1440, ?, 0)
  `).run(id, USER, feed.name, feed.creator_slug, feed.url, feed.provider, feed.feed_group);

  ensureIntelSource(hub, feed);
  return { action: 'inserted', id };
}

function ensureIntelSource(hub, feed, oldUrl) {
  const byNew = hub.prepare(`
    SELECT id FROM intel_sources
    WHERE user = ? AND source_kind = 'rss' AND match_type = 'feed_url' AND match_value = ?
  `).get(USER, feed.url);

  if (byNew) {
    hub.prepare(`
      UPDATE intel_sources
         SET name = ?, enabled = 1, briefing_priority = 1, extraction_mode = 'substantial'
       WHERE id = ?
    `).run(feed.name, byNew.id);
    // Drop stale intel_sources row for the old homepage URL if present.
    if (oldUrl && oldUrl !== feed.url) {
      hub.prepare(`
        DELETE FROM intel_sources
        WHERE user = ? AND source_kind = 'rss' AND match_type = 'feed_url'
          AND match_value = ? AND id != ?
      `).run(USER, oldUrl, byNew.id);
    }
    return byNew.id;
  }

  if (oldUrl && oldUrl !== feed.url) {
    const byOld = hub.prepare(`
      SELECT id FROM intel_sources
      WHERE user = ? AND source_kind = 'rss' AND match_type = 'feed_url' AND match_value = ?
    `).get(USER, oldUrl);
    if (byOld) {
      hub.prepare(`
        UPDATE intel_sources
           SET match_value = ?, name = ?, enabled = 1, briefing_priority = 1, extraction_mode = 'substantial'
         WHERE id = ?
      `).run(feed.url, feed.name, byOld.id);
      return byOld.id;
    }
  }

  const id = uuid();
  hub.prepare(`
    INSERT INTO intel_sources
      (id, user, name, source_kind, match_type, match_value, enabled, extraction_mode, briefing_priority)
    VALUES (?, ?, ?, 'rss', 'feed_url', ?, 1, 'substantial', 1)
  `).run(id, USER, feed.name, feed.url);
  return id;
}

async function main() {
  const hub = db.hub();
  const results = [];

  const tx = hub.transaction(() => {
    for (const feed of M365_FEEDS) {
      results.push({ ...feed, ...upsertFeed(hub, feed) });
    }
  });
  tx();

  for (const r of results) {
    const label = r.action === 'updated'
      ? `UPDATED  ${r.creator_slug}: ${r.from} → ${r.url}`
      : r.action === 'merged'
        ? `MERGED   ${r.creator_slug}: ${r.from} → ${r.url}`
      : r.action === 'inserted'
        ? `INSERTED ${r.creator_slug}: ${r.url}`
        : r.action === 'adopted'
          ? `ADOPTED  ${r.creator_slug} (was ${r.from}): ${r.url}`
          : `OK       ${r.creator_slug}: ${r.url}`;
    console.log(`[m365-rss] ${label}`);
  }

  const summary = hub.prepare(`
    SELECT name, creator_slug, url, feed_group, enabled, provider
    FROM rss_feeds
    WHERE user = ?
    ORDER BY feed_group, name
  `).all(USER);
  console.log('\n[m365-rss] current feeds:');
  for (const f of summary) {
    console.log(`  [${f.feed_group}] ${f.enabled ? 'on' : 'off'} ${f.name} → ${f.url}`);
  }

  if (!DO_FETCH) {
    console.log('\n[m365-rss] done (feeds only). Re-run with --fetch to ingest articles.');
    return;
  }

  console.log('\n[m365-rss] fetching all enabled feeds…');
  const { ingestFeed } = require('../lib/rss-ingest');
  const feeds = hub.prepare(
    'SELECT * FROM rss_feeds WHERE user = ? AND enabled = 1 ORDER BY name'
  ).all(USER);

  let totalIn = 0;
  let totalSkip = 0;
  for (const feed of feeds) {
    try {
      const result = await ingestFeed(feed, USER);
      totalIn += result.ingested || 0;
      totalSkip += result.skipped || 0;
      console.log(`[m365-rss] fetch ${feed.creator_slug}: +${result.ingested || 0} new, ${result.skipped || 0} skipped${result.error ? ` ERR ${result.error}` : ''}`);
    } catch (err) {
      console.error(`[m365-rss] fetch ${feed.creator_slug} failed: ${err.message}`);
    }
  }
  console.log(`[m365-rss] fetch complete: ${totalIn} new, ${totalSkip} skipped`);
}

main().catch(err => {
  console.error('[m365-rss] fatal:', err);
  process.exit(1);
});
