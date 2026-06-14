'use strict';

require('dotenv').config();
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { backfillFromLabels } = require('../lib/newsletter-pipeline');

const user = process.argv.find(arg => arg.startsWith('--user='))?.split('=')[1] || 'douglas';
const days = Number(process.argv.find(arg => arg.startsWith('--days='))?.split('=')[1] || 7);
const shouldBackfill = !process.argv.includes('--no-backfill');

function seedExternalSources(hub) {
  const legacy = hub.prepare(`
    SELECT from_email, MAX(from_name) AS from_name, COUNT(*) AS item_count
    FROM nl_topics
    WHERE user = ? AND from_email IS NOT NULL
      AND lower(from_email) NOT IN (
        'mclellanhub@agentmail.to',
        'douglas.mclellan@beaconhospital.ie',
        'messaging-digest-noreply@linkedin.com'
      )
    GROUP BY lower(from_email)
  `).all(user);
  const insert = hub.prepare(`
    INSERT OR IGNORE INTO intel_sources
      (id, user, name, source_kind, match_type, match_value)
    VALUES (?, ?, ?, 'email', 'sender_email', ?)
  `);
  for (const source of legacy) {
    insert.run(uuid(), user, source.from_name || source.from_email, source.from_email.toLowerCase());
  }
  return legacy.length;
}

function restoreRssCorpus(hub) {
  const rows = hub.prepare(`
    SELECT a.*, f.name AS feed_name, f.url AS feed_url
    FROM rss_articles a JOIN rss_feeds f ON f.id = a.feed_id
    WHERE a.user = ? AND f.enabled = 1
  `).all(user);
  for (const article of rows) {
    const sourceId = uuid();
    hub.prepare(`
      INSERT OR IGNORE INTO intel_sources
        (id, user, name, source_kind, match_type, match_value)
      VALUES (?, ?, ?, 'rss', 'feed_url', ?)
    `).run(sourceId, user, article.feed_name, article.feed_url);
    const source = hub.prepare(`
      SELECT id FROM intel_sources
      WHERE user = ? AND source_kind = 'rss' AND match_type = 'feed_url' AND match_value = ?
    `).get(user, article.feed_url);
    const documentId = uuid();
    hub.prepare(`
      INSERT OR IGNORE INTO intel_documents
        (id, user, source_id, external_id, source_kind, title, sender_name,
         source_url, published_at, content_text)
      VALUES (?, ?, ?, ?, 'rss', ?, ?, ?, ?, ?)
    `).run(
      documentId, user, source?.id || null, article.guid || article.url,
      article.title, article.feed_name, article.url, article.published_at,
      article.content_markdown || ''
    );
    const document = hub.prepare(`
      SELECT id FROM intel_documents
      WHERE user = ? AND source_kind = 'rss' AND external_id = ?
    `).get(user, article.guid || article.url);
    hub.prepare(`
      INSERT INTO intel_items
        (id, user, document_id, title, summary, content_text, item_type,
         category, entities_json, themes_json, source_url, published_at,
         extraction_method, extracted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'article', 'Other', '[]', '[]', ?, ?, 'direct_rss', unixepoch())
    `).run(
      uuid(), user, document.id, article.title,
      String(article.content_markdown || '').slice(0, 500).replace(/\s+/g, ' '),
      article.content_markdown || '', article.url, article.published_at
    );
  }
  return rows.length;
}

async function main() {
  const hub = db.hub();
  hub.prepare(`
    UPDATE nl_formats
    SET focus_query = 'Claude and Anthropic'
    WHERE user = ? AND focus_query IS NULL AND lower(name) LIKE '%claude%'
  `).run(user);
  const sourceCount = seedExternalSources(hub);
  const reset = hub.transaction(() => {
    hub.prepare('DELETE FROM intel_items WHERE user = ?').run(user);
    hub.prepare('DELETE FROM intel_documents WHERE user = ?').run(user);
    hub.prepare('DELETE FROM nl_topics WHERE user = ?').run(user);
    hub.prepare('DELETE FROM nl_generation_jobs WHERE user = ?').run(user);
    hub.prepare('DELETE FROM nl_briefings WHERE user = ?').run(user);
  });
  reset();
  const rssCount = restoreRssCorpus(hub);
  console.log(`[intelligence-reset] retained ${sourceCount} approved email sources and restored ${rssCount} RSS articles`);

  if (shouldBackfill) {
    const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
    const results = await backfillFromLabels(
      user,
      ['Resources/Newsletters', 'Resources/Research'],
      sinceTs
    );
    console.log(JSON.stringify(results, null, 2));
  }
}

main().catch(err => {
  console.error('[intelligence-reset] failed:', err);
  process.exitCode = 1;
});
