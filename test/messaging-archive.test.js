'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-msg-archive-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const {
  archiveEvidenceForProject,
  archiveStatus,
  releaseDailyArchive,
} = require('../lib/messaging-archive');

const user = 'archive-test';
const projectId = 'project-dad';
const bucketId = 'bucket-dad';
const baseTs = Math.floor(new Date('2026-07-23T12:00:00Z').getTime() / 1000);

before(() => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO projects (id, user, name, slug, project_kind)
    VALUES (?, ?, 'Dad', 'dad', 'crm')
  `).run(projectId, user);
  hub.prepare(`
    INSERT INTO messaging_archive_buckets
      (id, user, project_id, name, source_name, total_messages)
    VALUES (?, ?, ?, 'Dad history', 'fixture', 21)
  `).run(bucketId, user, projectId);
  const insert = hub.prepare(`
    INSERT INTO messaging_archive_messages
      (id, bucket_id, user, external_message_id, sender_name, body, received_at, raw_json)
    VALUES (?, ?, ?, ?, 'Family', ?, ?, '{}')
  `);
  for (let i = 0; i < 21; i += 1) {
    insert.run(`archive-${i}`, bucketId, user, `external-${i}`, `Message ${i}`, baseTs - (20 - i) * 86400);
  }
  hub.prepare('UPDATE messaging_archive_buckets SET sealed_at = unixepoch() WHERE id = ?').run(bucketId);
});

after(() => {
  db.hub().close();
});

test('sealed archive rejects additions', () => {
  assert.throws(() => {
    db.hub().prepare(`
      INSERT INTO messaging_archive_messages
        (id, bucket_id, user, external_message_id, body, received_at)
      VALUES ('late', ?, ?, 'late', 'late addition', ?)
    `).run(bucketId, user, baseTs);
  }, /archive bucket is sealed/);
});

test('daily release is capped at ten and is idempotent within a Dublin day', () => {
  const first = releaseDailyArchive(user, { nowTs: baseTs });
  assert.equal(first.released, 10);
  assert.equal(first.remaining, 11);

  const duplicate = releaseDailyArchive(user, { nowTs: baseTs + 3600 });
  assert.equal(duplicate.released, 0);
  assert.equal(duplicate.remaining, 11);
  assert.equal(duplicate.reason, 'already released today');

  const nextDay = releaseDailyArchive(user, { nowTs: baseTs + 86400 });
  assert.equal(nextDay.released, 10);
  assert.equal(nextDay.remaining, 1);

  const released = db.hub().prepare(
    "SELECT * FROM messaging_messages WHERE user = ? AND external_message_id LIKE 'archive:%' ORDER BY received_at"
  ).all(user);
  assert.equal(released.length, 20);
  const raw = JSON.parse(released[0].raw_json);
  assert.equal(raw.project_slug, 'dad');
  assert.equal(raw.raw.historical_backfill, true);
  assert.equal(raw.archive_bucket_id, bucketId);
});

test('project report archive evidence obeys the original-message date window', () => {
  const evidence = archiveEvidenceForProject(user, projectId, {
    sinceDay: '2026-07-19',
    untilTs: baseTs,
    limit: 120,
  });
  assert.equal(evidence.total, 5);
  assert.equal(evidence.messages[0].body, 'Message 20');
  assert.equal(evidence.messages.at(-1).body, 'Message 16');

  const status = archiveStatus(user)[0];
  assert.equal(status.total_messages, 21);
  assert.equal(status.released, 20);
  assert.equal(status.remaining, 1);
});
