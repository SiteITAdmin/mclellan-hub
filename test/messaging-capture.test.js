'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Isolate to a temp hub DB so this test never touches real data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-msg-'));
const tmpDb = path.join(tmpDir, 'hub.db');
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const {
  captureMessagingMessage,
  buildEvidenceText,
  externalIdFromPayload,
} = require('../lib/messaging-capture');

before(() => {
  // Force schema init against temp DB if supported; otherwise use default path.
  try {
    db.hub();
  } catch (_) {
    // Schema may already be lazy-init on first prepare.
  }
});

test('externalIdFromPayload prefers explicit message id', () => {
  assert.equal(
    externalIdFromPayload({ external_message_id: 'wa-123', body: 'hi' }),
    'wa-123',
  );
});

test('externalIdFromPayload hashes when no id', () => {
  const a = externalIdFromPayload({ body: 'get whisky at airport', sender_id: '3531' });
  const b = externalIdFromPayload({ body: 'get whisky at airport', sender_id: '3531' });
  const c = externalIdFromPayload({ body: 'different', sender_id: '3531' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^hash:/);
});

test('captureMessagingMessage stores once and dedups', () => {
  // Ensure table exists even if HUB_DB_PATH is ignored by this codebase.
  const hub = db.hub();
  hub.exec(`
    CREATE TABLE IF NOT EXISTS messaging_messages (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'whatsapp',
      external_message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      chat_name TEXT NOT NULL DEFAULT '',
      is_group INTEGER NOT NULL DEFAULT 0,
      sender_id TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      received_at INTEGER NOT NULL DEFAULT (unixepoch()),
      raw_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'received',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user, platform, external_message_id)
    );
  `);

  const user = 'test-douglas';
  const first = captureMessagingMessage(user, {
    platform: 'whatsapp',
    external_message_id: 'msg-aunt-1',
    sender_name: 'Aunt',
    sender_id: '353871111111',
    body: 'Can you get Dad his things when you go over?',
    chat_id: '353871111111@s.whatsapp.net',
  });
  assert.equal(first.created, true);
  assert.equal(first.duplicate, false);

  const second = captureMessagingMessage(user, {
    platform: 'whatsapp',
    external_message_id: 'msg-aunt-1',
    body: 'Can you get Dad his things when you go over?',
  });
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const evidence = buildEvidenceText(first.row);
  assert.match(evidence, /Aunt/);
  assert.match(evidence, /Dad his things/);
});
