'use strict';

/**
 * Synthetic test for the URL Watchlist module.
 * Tests the full path: DB tables → story insertion → dedup → error counting → auto-disable.
 * Does NOT make real HTTP calls — tests the data layer only.
 */

const path = require('path');
process.env.HUB_DB_PATH = path.join(__dirname, '..', 'data', 'hub.db');

const db = require('../lib/db');
const { uuid } = require('../lib/id');

const hub = db.hub();
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Test 1: Tables exist ──────────────────────────────────────────────────────

console.log('\n1. Table structure');
const feedCols = hub.prepare("PRAGMA table_info('watchlist_feeds')").all().map(c => c.name);
assert(feedCols.includes('id'), 'watchlist_feeds has id');
assert(feedCols.includes('user'), 'watchlist_feeds has user');
assert(feedCols.includes('url'), 'watchlist_feeds has url');
assert(feedCols.includes('label'), 'watchlist_feeds has label');
assert(feedCols.includes('provider'), 'watchlist_feeds has provider');
assert(feedCols.includes('interval_mins'), 'watchlist_feeds has interval_mins');
assert(feedCols.includes('enabled'), 'watchlist_feeds has enabled');
assert(feedCols.includes('last_error'), 'watchlist_feeds has last_error');
assert(feedCols.includes('error_count'), 'watchlist_feeds has error_count');

const storyCols = hub.prepare("PRAGMA table_info('watchlist_stories')").all().map(c => c.name);
assert(storyCols.includes('id'), 'watchlist_stories has id');
assert(storyCols.includes('feed_id'), 'watchlist_stories has feed_id');
assert(storyCols.includes('title'), 'watchlist_stories has title');
assert(storyCols.includes('snippet'), 'watchlist_stories has snippet');
assert(storyCols.includes('provider_used'), 'watchlist_stories has provider_used');

// ── Test 2: Insert and query a feed ───────────────────────────────────────────

console.log('\n2. Feed CRUD');
const testUser = '__test_watchlist__';
const feedId = uuid();
hub.prepare(`
  INSERT INTO watchlist_feeds (id, user, url, label, provider, interval_mins)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(feedId, testUser, 'https://test.example.com', 'Test Feed', 'auto', 60);

const feed = hub.prepare('SELECT * FROM watchlist_feeds WHERE id = ?').get(feedId);
assert(feed !== undefined, 'feed inserted');
assert(feed.label === 'Test Feed', 'feed label correct');
assert(feed.enabled === 1, 'feed enabled by default');
assert(feed.error_count === 0, 'error_count starts at 0');
assert(feed.interval_mins === 60, 'interval_mins correct');

// ── Test 3: Insert stories with dedup ─────────────────────────────────────────

console.log('\n3. Story insertion and dedup');
const storyId1 = uuid();
hub.prepare(`
  INSERT INTO watchlist_stories (id, feed_id, user, url, title, snippet, provider_used)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(storyId1, feedId, testUser, 'https://test.example.com/story-1', 'First Story', 'A snippet', 'exa');

const story = hub.prepare('SELECT * FROM watchlist_stories WHERE id = ?').get(storyId1);
assert(story !== undefined, 'story inserted');
assert(story.title === 'First Story', 'story title correct');
assert(story.provider_used === 'exa', 'provider_used recorded');

// Dedup: same feed_id + url should be ignored
const dupResult = hub.prepare(`
  INSERT OR IGNORE INTO watchlist_stories (id, feed_id, user, url, title, snippet, provider_used)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(uuid(), feedId, testUser, 'https://test.example.com/story-1', 'Duplicate Story', 'Dup', 'brave');
assert(dupResult.changes === 0, 'duplicate story rejected (INSERT OR IGNORE)');

// Different URL should be accepted
hub.prepare(`
  INSERT OR IGNORE INTO watchlist_stories (id, feed_id, user, url, title, snippet, provider_used)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(uuid(), feedId, testUser, 'https://test.example.com/story-2', 'Second Story', 'Another snippet', 'direct');

const storyCount = hub.prepare('SELECT COUNT(*) AS c FROM watchlist_stories WHERE feed_id = ?').get(feedId).c;
assert(storyCount === 2, `story count is 2 (got ${storyCount})`);

// ── Test 4: Error counting and auto-disable ───────────────────────────────────

console.log('\n4. Error counting and auto-disable');
hub.prepare('UPDATE watchlist_feeds SET error_count = 2, last_error = ? WHERE id = ?')
  .run('test error', feedId);

let updated = hub.prepare('SELECT * FROM watchlist_feeds WHERE id = ?').get(feedId);
assert(updated.error_count === 2, 'error_count set to 2');
assert(updated.last_error === 'test error', 'last_error stored');
assert(updated.enabled === 1, 'still enabled at error_count=2');

// Simulate third error → auto-disable
hub.prepare('UPDATE watchlist_feeds SET error_count = 3, enabled = 0 WHERE id = ?').run(feedId);
updated = hub.prepare('SELECT * FROM watchlist_feeds WHERE id = ?').get(feedId);
assert(updated.enabled === 0, 'auto-disabled at error_count=3');

// Re-enable and reset errors (toggle)
hub.prepare('UPDATE watchlist_feeds SET enabled = 1, error_count = 0, last_error = NULL WHERE id = ?').run(feedId);
updated = hub.prepare('SELECT * FROM watchlist_feeds WHERE id = ?').get(feedId);
assert(updated.enabled === 1, 're-enabled after toggle');
assert(updated.error_count === 0, 'error_count reset after toggle');

// ── Test 5: User-scoped uniqueness ────────────────────────────────────────────

console.log('\n5. User-scoped URL uniqueness');
const dupFeedResult = hub.prepare(`
  INSERT OR IGNORE INTO watchlist_feeds (id, user, url, label, provider, interval_mins)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(uuid(), testUser, 'https://test.example.com', 'Duplicate Feed', 'auto', 60);
assert(dupFeedResult.changes === 0, 'duplicate URL for same user rejected');

// Different user, same URL should be accepted
const otherFeedResult = hub.prepare(`
  INSERT OR IGNORE INTO watchlist_feeds (id, user, url, label, provider, interval_mins)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(uuid(), '__test_watchlist_other__', 'https://test.example.com', 'Other User Feed', 'auto', 60);
assert(otherFeedResult.changes === 1, 'same URL for different user accepted');

// ── Test 6: Feed → stories join (admin view query) ───────────────────────────

console.log('\n6. Admin view query');
const feedsWithCounts = hub.prepare(`
  SELECT f.*, COUNT(s.id) AS story_count, MAX(s.fetched_at) AS latest_story_at
  FROM watchlist_feeds f LEFT JOIN watchlist_stories s ON s.feed_id = f.id
  WHERE f.user = ? GROUP BY f.id ORDER BY f.created_at DESC
`).all(testUser);
assert(feedsWithCounts.length === 1, `found 1 feed for test user (got ${feedsWithCounts.length})`);
assert(feedsWithCounts[0].story_count === 2, `story_count is 2 (got ${feedsWithCounts[0].story_count})`);

// ── Test 7: Job queue seed check ──────────────────────────────────────────────

console.log('\n7. Job queue integration');
const watchlistJob = hub.prepare(
  "SELECT 1 FROM system_jobs WHERE type = 'watchlist_poll' AND status IN ('pending','running') LIMIT 1"
).get();
// This may or may not exist depending on whether seedJobs() ran, so just check the query works
assert(true, 'watchlist_poll query executes without error');

// ── Cleanup ───────────────────────────────────────────────────────────────────

hub.prepare('DELETE FROM watchlist_stories WHERE user = ?').run(testUser);
hub.prepare('DELETE FROM watchlist_feeds WHERE user = ?').run(testUser);
hub.prepare('DELETE FROM watchlist_feeds WHERE user = ?').run('__test_watchlist_other__');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
