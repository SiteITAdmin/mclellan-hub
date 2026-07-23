'use strict';

const db = require('./db');
const { uuid } = require('./id');

const DUBLIN_TIME_ZONE = 'Europe/Dublin';
const DEFAULT_DAILY_LIMIT = 10;

function dublinDay(timestampMs = Date.now()) {
  return new Date(timestampMs).toLocaleDateString('sv-SE', { timeZone: DUBLIN_TIME_ZONE });
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function releaseRawJson(message, bucket) {
  const raw = parseJson(message.raw_json, {});
  raw.project_slug = bucket.project_slug;
  raw.project_name = bucket.project_name;
  raw.archive_bucket_id = bucket.id;
  raw.archive_release = true;
  raw.route = {
    ...(raw.route && typeof raw.route === 'object' ? raw.route : {}),
    project_slug: bucket.project_slug,
    project_name: bucket.project_name,
  };
  raw.raw = {
    ...(raw.raw && typeof raw.raw === 'object' ? raw.raw : {}),
    source: 'sealed_messaging_archive',
    historical_backfill: true,
    archive_bucket_id: bucket.id,
  };
  return JSON.stringify(raw);
}

function releaseDailyArchive(user, {
  limit = DEFAULT_DAILY_LIMIT,
  nowTs = Math.floor(Date.now() / 1000),
} = {}) {
  const hub = db.hub();
  const day = dublinDay(nowTs * 1000);
  const boundedLimit = Math.max(1, Math.min(DEFAULT_DAILY_LIMIT, Number(limit) || DEFAULT_DAILY_LIMIT));

  return hub.transaction(() => {
    const bucket = hub.prepare(`
      SELECT b.*, p.slug AS project_slug, p.name AS project_name
      FROM messaging_archive_buckets b
      JOIN projects p ON p.id = b.project_id AND p.user = b.user
      WHERE b.user = ?
        AND b.sealed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM messaging_archive_messages m
          WHERE m.bucket_id = b.id AND m.released_at IS NULL
        )
      ORDER BY b.created_at, b.id
      LIMIT 1
    `).get(user);
    if (!bucket) return { released: 0, remaining: 0, complete: true, reason: 'archive empty' };
    if (bucket.last_release_day === day) {
      const remaining = hub.prepare(
        'SELECT count(*) n FROM messaging_archive_messages WHERE bucket_id = ? AND released_at IS NULL'
      ).get(bucket.id).n;
      return { bucketId: bucket.id, released: 0, remaining, complete: remaining === 0, reason: 'already released today' };
    }

    const messages = hub.prepare(`
      SELECT *
      FROM messaging_archive_messages
      WHERE bucket_id = ? AND released_at IS NULL
      ORDER BY received_at, id
      LIMIT ?
    `).all(bucket.id, boundedLimit);
    const insert = hub.prepare(`
      INSERT INTO messaging_messages
        (id, user, platform, external_message_id, chat_id, chat_name, is_group,
         sender_id, sender_name, body, received_at, raw_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)
    `);
    const markReleased = hub.prepare(`
      UPDATE messaging_archive_messages
      SET released_at = ?, released_message_id = ?
      WHERE id = ? AND released_at IS NULL
    `);

    let released = 0;
    for (const message of messages) {
      const releasedMessageId = uuid();
      insert.run(
        releasedMessageId,
        user,
        message.platform,
        `archive:${bucket.id}:${message.external_message_id}`,
        message.chat_id,
        message.chat_name,
        message.is_group,
        message.sender_id,
        message.sender_name,
        message.body,
        message.received_at,
        releaseRawJson(message, bucket),
        nowTs
      );
      released += markReleased.run(nowTs, releasedMessageId, message.id).changes;
    }

    hub.prepare('UPDATE messaging_archive_buckets SET last_release_day = ? WHERE id = ?')
      .run(day, bucket.id);
    const remaining = hub.prepare(
      'SELECT count(*) n FROM messaging_archive_messages WHERE bucket_id = ? AND released_at IS NULL'
    ).get(bucket.id).n;
    return {
      bucketId: bucket.id,
      bucketName: bucket.name,
      released,
      remaining,
      complete: remaining === 0,
    };
  })();
}

function archiveEvidenceForProject(user, projectId, {
  sinceDay,
  untilTs = Math.floor(Date.now() / 1000),
  limit = 120,
} = {}) {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT m.received_at, m.sender_name, m.chat_name, m.body, b.name AS bucket_name
    FROM messaging_archive_messages m
    JOIN messaging_archive_buckets b ON b.id = m.bucket_id
    WHERE b.user = ? AND b.project_id = ? AND b.sealed_at IS NOT NULL
      AND m.received_at <= ?
    ORDER BY m.received_at DESC, m.id DESC
  `).all(user, projectId, untilTs);
  const withinWindow = rows.filter(row => !sinceDay || dublinDay(row.received_at * 1000) >= sinceDay);
  return {
    total: withinWindow.length,
    truncated: withinWindow.length > limit,
    messages: withinWindow.slice(0, Math.max(1, Number(limit) || 120)),
  };
}

function archiveStatus(user) {
  return db.hub().prepare(`
    SELECT b.id, b.name, b.total_messages, b.sealed_at, b.last_release_day,
           sum(CASE WHEN m.released_at IS NOT NULL THEN 1 ELSE 0 END) AS released,
           sum(CASE WHEN m.released_at IS NULL THEN 1 ELSE 0 END) AS remaining
    FROM messaging_archive_buckets b
    LEFT JOIN messaging_archive_messages m ON m.bucket_id = b.id
    WHERE b.user = ?
    GROUP BY b.id
    ORDER BY b.created_at
  `).all(user);
}

module.exports = {
  DEFAULT_DAILY_LIMIT,
  dublinDay,
  releaseDailyArchive,
  archiveEvidenceForProject,
  archiveStatus,
  _test: { releaseRawJson },
};
