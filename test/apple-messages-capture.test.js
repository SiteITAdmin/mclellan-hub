'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  APPLE_EPOCH_UNIX_SECONDS,
  appleDateToUnixSeconds,
  decodeAttributedBody,
  normalizeAddress,
  resolveContactName,
  AppleMessagesReader,
  buildMessagesCapturePayload,
} = require('../lib/apple-messages-capture');

function encodedLength(length) {
  if (length <= 0x7f) return Buffer.from([length]);
  const result = Buffer.alloc(3);
  result[0] = 0x81;
  result.writeUInt16LE(length, 1);
  return result;
}

function attributedBody(text) {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped\0NSAttributedString\0NSObject\0NSString\0', 'utf8'),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    encodedLength(body.length),
    body,
    Buffer.from([0x86, 0x86]),
  ]);
}

test('decodes Messages Apple-epoch nanoseconds', () => {
  assert.equal(appleDateToUnixSeconds(1_000_000_000), APPLE_EPOCH_UNIX_SECONDS + 1_000_000_000);
  assert.equal(appleDateToUnixSeconds(809_176_812_763_921_280), 1787484012);
  assert.equal(appleDateToUnixSeconds(0), 0);
});

test('decodes short and long UTF-8 NSAttributedString bodies', () => {
  assert.equal(decodeAttributedBody(attributedBody('I’m getting it to go. xxxx')), 'I’m getting it to go. xxxx');
  const long = `Opening ${'x'.repeat(180)} tail`;
  assert.equal(decodeAttributedBody(attributedBody(long)), long);
  assert.equal(decodeAttributedBody(Buffer.from('not a typedstream')), '');
});

test('contact handles resolve by email and international/local phone suffix', () => {
  const names = new Map([
    ['person@example.com', 'Person Example'],
    ['871234567', 'Irish Person'],
  ]);
  assert.deepEqual(normalizeAddress('+353 87 123 4567'), ['353871234567', '871234567']);
  assert.equal(resolveContactName('PERSON@example.com', names), 'Person Example');
  assert.equal(resolveContactName('087 123 4567', names), 'Irish Person');
});

test('reads provider rows and builds faithful Hub capture envelopes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-messages-reader-'));
  const databasePath = path.join(directory, 'chat.db');
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
  `);
  database.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'iMessage;-;+353871234567', null, '+353871234567', 'iMessage', 45);
  database.prepare('INSERT INTO handle VALUES (?, ?, ?)').run(1, '+353871234567', 'iMessage');
  database.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(1, 1);
  database.prepare(`
    INSERT INTO message
      (ROWID, guid, attributedBody, service, date, is_from_me, handle_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(7, 'provider-guid-7', attributedBody('Please bring the papers tomorrow.'), 'iMessage', 809_176_812_763_921_280, 0, 1);
  database.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(1, 7);
  database.close();

  const reader = new AppleMessagesReader({ databasePath });
  assert.equal(reader.maxRowId(), 7);
  const rows = reader.messagesAfter(0);
  reader.close();
  assert.equal(rows.length, 1);
  const built = buildMessagesCapturePayload(rows[0], {
    user: 'douglas',
    ownerName: 'Douglas McLellan',
    contactNames: new Map([['871234567', 'Aunt Example']]),
  });
  assert.equal(built.skip_reason, null);
  assert.equal(built.payload.platform, 'messages');
  assert.equal(built.payload.external_message_id, 'provider-guid-7');
  assert.equal(built.payload.sender_name, 'Aunt Example');
  assert.equal(built.payload.chat_name, 'Aunt Example');
  assert.equal(built.payload.body, 'Please bring the papers tomorrow.');
  assert.equal(built.payload.raw.direction, 'inbound');
  assert.equal(built.payload.raw.apple_rowid, 7);
  assert.equal(built.payload.raw.historical_backfill, false);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('skips reactions, system events, and attachment-only bubbles', () => {
  assert.equal(buildMessagesCapturePayload({ rowid: 1, guid: 'reaction', associated_message_type: 2001 }).skip_reason, 'reaction');
  assert.equal(buildMessagesCapturePayload({ rowid: 2, guid: 'system', item_type: 1 }).skip_reason, 'system_event');
  assert.equal(buildMessagesCapturePayload({ rowid: 3, guid: 'attachment', cache_has_attachments: 1 }).skip_reason, 'empty_or_attachment_only');
});
