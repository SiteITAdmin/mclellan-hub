'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { deduplicateRssData } = require('../lib/db');

test('RSS migration merges duplicate feeds and articles, then enforces URL uniqueness', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE rss_feeds (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      name TEXT NOT NULL,
      creator_slug TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_fetched_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE rss_articles (
      id TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL,
      user TEXT NOT NULL,
      creator_slug TEXT NOT NULL,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      content_markdown TEXT NOT NULL DEFAULT '',
      word_count INTEGER DEFAULT 0,
      vault_path TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(feed_id, guid)
    );
    INSERT INTO rss_feeds (id,user,name,creator_slug,url,created_at) VALUES
      ('feed-a','douglas','Nate','nate','https://example.com/feed',1),
      ('feed-b','douglas','Nate duplicate','nate','https://example.com/feed',2);
    INSERT INTO rss_articles (id,feed_id,user,creator_slug,guid,title,url,published_at) VALUES
      ('article-a','feed-a','douglas','nate','g1','One','https://example.com/one',1),
      ('article-b','feed-b','douglas','nate','g1','One','https://example.com/one',1),
      ('article-c','feed-b','douglas','nate','g2','Two','https://example.com/two',2);
  `);

  deduplicateRssData(database);

  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM rss_feeds').get().n, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM rss_articles').get().n, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM rss_articles WHERE feed_id = 'feed-a'").get().n, 2);
  assert.throws(
    () => database.prepare(`
      INSERT INTO rss_feeds (id,user,name,creator_slug,url)
      VALUES ('feed-c','douglas','Again','nate','https://example.com/feed')
    `).run(),
    /UNIQUE/
  );
  database.close();
});
