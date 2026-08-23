'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

process.env.HERMES_WEBHOOK_SECRET = 'synthetic-messages-secret';
const { runOnce } = require('../scripts/messages-capture-worker');

function createMessagesDatabase(databasePath) {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, subject TEXT,
      service TEXT, account TEXT, date INTEGER, date_edited INTEGER DEFAULT 0,
      date_retracted INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
      is_system_message INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0,
      is_corrupt INTEGER DEFAULT 0, error INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0,
      associated_message_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
      reply_to_guid TEXT DEFAULT '', handle_id INTEGER
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT, display_name TEXT, chat_identifier TEXT,
      service_name TEXT, style INTEGER
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO chat VALUES (1, 'iMessage;-;+353871234567', NULL, '+353871234567', 'iMessage', 45);
    INSERT INTO handle VALUES (1, '+353871234567', 'iMessage');
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO message (ROWID, guid, text, service, date, is_from_me, handle_id)
      VALUES (10, 'already-there', 'Existing history is not imported', 'iMessage', 809000000000000000, 0, 1);
    INSERT INTO chat_message_join VALUES (1, 10);
  `);
  return database;
}

test('worker starts at now, posts a new bubble once, and advances only its durable cursor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'messages-worker-'));
  const databasePath = path.join(directory, 'chat.db');
  const statePath = path.join(directory, 'state.json');
  let database = createMessagesDatabase(databasePath);
  database.close();

  const captures = [];
  const heartbeats = [];
  const captureUrl = 'https://synthetic-hub.invalid/api/messaging/capture';
  const post = async (url, body) => {
    if (url.endsWith('/api/messaging/capture')) captures.push(body);
    else if (url.endsWith('/api/messaging/heartbeat')) heartbeats.push(body);
    else throw new Error(`unexpected worker route: ${url}`);
    return { ok: true, created: true };
  };

  try {
    const initialized = await runOnce({ databasePath, statePath, captureUrl, addressBookRoot: directory, post });
    assert.equal(initialized.initialized, true);
    assert.equal(initialized.state.last_rowid, 10);
    assert.equal(captures.length, 0, 'existing history is not posted');

    database = new Database(databasePath);
    database.prepare(`
      INSERT INTO message (ROWID, guid, text, service, date, is_from_me, handle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(11, 'new-provider-guid', 'Please bring the synthetic papers tomorrow.', 'iMessage', 809176812763921280, 0, 1);
    database.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(1, 11);
    database.close();

    const captured = await runOnce({ databasePath, statePath, captureUrl, addressBookRoot: directory, post });
    assert.equal(captured.captured, 1);
    assert.equal(captured.state.last_rowid, 11);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].external_message_id, 'new-provider-guid');
    assert.equal(captures[0].body, 'Please bring the synthetic papers tomorrow.');
    assert.equal(captures[0].raw.direction, 'inbound');

    const repeated = await runOnce({ databasePath, statePath, captureUrl, addressBookRoot: directory, post });
    assert.equal(repeated.captured, 0);
    assert.equal(captures.length, 1, 'the durable cursor prevents a second POST');
    assert.ok(heartbeats.length >= 3);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
