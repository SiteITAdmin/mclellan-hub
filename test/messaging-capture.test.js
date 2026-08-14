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
  messageDirection,
  chatNeighborsForMessage,
  formatMessagingChatContext,
} = require('../lib/messaging-capture');
const { sourceContext } = require('../lib/synthesis');

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

test('messaging capture preserves the complete body, provider envelope, and explicit identity', () => {
  const body = `  opening evidence\n${'x'.repeat(25000)}\nTAIL ACTION: send the complete pack.  `;
  const explicitId = `provider-${'i'.repeat(300)}`;
  const transportTrace = `trace-${'z'.repeat(60000)}`;
  const captured = captureMessagingMessage('test-douglas', {
    platform: 'whatsapp',
    external_message_id: explicitId,
    sender_name: 'Long Evidence Sender',
    body,
    raw: { transport_trace: transportTrace },
  });

  const stored = db.hub().prepare('SELECT * FROM messaging_messages WHERE id = ?').get(captured.id);
  assert.equal(stored.external_message_id, explicitId);
  assert.equal(stored.body, body);
  const envelope = JSON.parse(stored.raw_json);
  assert.equal(envelope.raw.transport_trace, transportTrace);
  assert.match(buildEvidenceText(stored), /TAIL ACTION: send the complete pack\./);
});

test('messaging evidence preserves explicit contact and project routing metadata', () => {
  const hub = db.hub();
  hub.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL
    );
  `);
  hub.prepare(`INSERT OR IGNORE INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)`)
    .run('contact-catriona', 'test-douglas', 'Catriona McLellan', '[]');
  hub.prepare(`INSERT OR IGNORE INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)`)
    .run('project-dad', 'test-douglas', 'Dad', 'dad');

  const captured = captureMessagingMessage('test-douglas', {
    platform: 'whatsapp',
    external_message_id: 'msg-catriona-1',
    sender_name: 'Catriona',
    sender_id: '353870000001@s.whatsapp.net',
    chat_name: 'Catriona',
    body: 'Dad needs a new prescription collected tomorrow.',
    contact_name: 'Catriona McLellan',
    project_slug: 'dad',
    project_name: 'Dad',
    route: {
      id: 'catriona-mclellan',
      contact_name: 'Catriona McLellan',
      project_slug: 'dad',
      project_name: 'Dad',
      note: 'Douglas explicitly routed this chat.',
    },
    raw: {
      source: 'hermes_whatsapp_bridge_passive_capture',
      direction: 'inbound',
    },
  });

  const evidence = buildEvidenceText(captured.row);
  assert.match(evidence, /Explicit project route: Dad \(dad\)/);
  assert.match(evidence, /Explicit contact route: Catriona McLellan/);
  assert.deepEqual(sourceContext('test-douglas', 'messaging_message', captured.row), {
    contactId: 'contact-catriona',
    projectId: 'project-dad',
    preferKind: 'project',
  });
});

test('same-chat neighbours are context around the current bubble, not the source', () => {
  const user = 'test-douglas';
  const chatId = '120363239923493562@g.us';
  const question = captureMessagingMessage(user, {
    platform: 'whatsapp',
    external_message_id: 'wa-walk-q',
    chat_id: chatId,
    chat_name: 'Dad Information Group',
    sender_name: 'Catriona Mclellan',
    body: 'Is he walking okay? Back to usual shuffle but just with stick?',
    received_at: 1786725558,
    raw: { direction: 'inbound' },
  });
  const answer = captureMessagingMessage(user, {
    platform: 'whatsapp',
    external_message_id: 'wa-walk-a',
    chat_id: chatId,
    chat_name: 'Dad Information Group',
    sender_name: 'Douglas McLellan',
    body: 'Not sure. Was going to test that tomorrow.',
    received_at: 1786725640,
    raw: { direction: 'outbound' },
  });
  const later = captureMessagingMessage(user, {
    platform: 'whatsapp',
    external_message_id: 'wa-other-chat',
    chat_id: 'someone-else@s.whatsapp.net',
    sender_name: 'Liz',
    body: 'When are you going back to Dublin?',
    received_at: 1786725700,
    raw: { direction: 'inbound' },
  });

  assert.equal(messageDirection(question.row), 'inbound');
  assert.equal(messageDirection(answer.row), 'outbound');
  const neighbors = chatNeighborsForMessage(user, question.row);
  assert.equal(neighbors.length, 1);
  assert.equal(neighbors[0].id, answer.id);
  assert.ok(!neighbors.some(row => row.id === later.id));

  const context = formatMessagingChatContext(user, question.row);
  assert.match(context, /SAME-CHAT CONTEXT/);
  assert.match(context, /outbound Douglas McLellan: Not sure/);
  assert.doesNotMatch(context, /When are you going back to Dublin/);
  assert.doesNotMatch(buildEvidenceText(question.row), /Not sure\. Was going to test that tomorrow/);
});

test('messaging evidence marks historical backfills as non-current evidence', () => {
  const evidence = buildEvidenceText({
    sender_name: 'Iain Clark',
    chat_name: 'Dad Information Group',
    is_group: 1,
    body: 'Call the council tomorrow.',
    received_at: 1720000000,
    raw_json: JSON.stringify({
      project_slug: 'dad',
      raw: { source: 'whatsapp_chat_export', historical_backfill: true },
    }),
  });

  assert.match(evidence, /Historical backfill: yes/);
  assert.match(evidence, /do not assume old actions are still outstanding/);
});
