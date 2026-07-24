'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWhatsAppExport,
  buildImportRecords,
} = require('../lib/whatsapp-export');

const route = {
  id: 'dad-information-group',
  match: { chat_type: 'group', chat_names: ['Dad Information Group'] },
  project_slug: 'dad',
  project_name: 'Dad',
  subject_contact_name: 'Alister McLellan',
  note: 'Explicit group route.',
  participant_contacts: [
    { contact_name: 'Catriona McLellan', sender_names: ['Catriona McLellan', 'Catriona'] },
    { contact_name: 'Iain Clark', sender_names: ['Iain Clark', 'Iain'] },
    { contact_name: 'Liz Walker', sender_names: ['Liz Walker', 'Aunt Liz Walker', 'Aunt Liz'] },
    { contact_name: 'Nakai McLellan', sender_names: ['Nakai McLellan', 'Nakai Mutenga', 'Kai'] },
    { contact_name: 'Liz Smith', sender_names: ['Liz Smith', 'Wee Lizzie'] },
  ],
};

test('parses multiline WhatsApp exports with Dublin daylight-saving timestamps', () => {
  const parsed = parseWhatsAppExport([
    '[15/02/2024, 20:28:25] Dad Information Group: Messages and calls are end-to-end encrypted.',
    '[15/02/2024, 20:28:50] Douglas: First message',
    '[20/07/2026, 17:38:54] Iain Clark: First line',
    'Second line',
  ].join('\n'));

  assert.equal(parsed.length, 3);
  assert.equal(new Date(parsed[1].received_at * 1000).toISOString(), '2024-02-15T20:28:50.000Z');
  assert.equal(new Date(parsed[2].received_at * 1000).toISOString(), '2026-07-20T16:38:54.000Z');
  assert.equal(parsed[2].body, 'First line\nSecond line');
});

test('builds stable routed records while excluding system and omitted-media rows', () => {
  const parsed = parseWhatsAppExport([
    '[15/02/2024, 20:28:25] Dad Information Group: You created group “Dad Information Group”',
    '[15/02/2024, 20:28:50] Douglas: Dad update',
    '[13/04/2024, 19:33:47] Aunt Liz Walker: You added Aunt Liz Walker',
    '[20/07/2026, 17:38:54] Iain Clark: Important update',
    '[20/07/2026, 18:30:16] Aunt Liz Walker: image omitted',
    '[20/07/2026, 21:36:57] Aunt Liz Walker: Point taken.',
  ].join('\n'));
  const first = buildImportRecords(parsed, { route, chatName: 'Dad Information Group' });
  const second = buildImportRecords(parsed, { route, chatName: 'Dad Information Group' });

  assert.equal(first.records.length, 3);
  assert.deepEqual(first.skipped, { system: 2, omitted_attachment: 1, empty: 0 });
  assert.equal(first.records[1].contact_name, 'Iain Clark');
  assert.equal(first.records[2].contact_name, 'Liz Walker');
  assert.equal(first.records[0].project_slug, 'dad');
  assert.equal(first.records[0].route.subject_contact_name, 'Alister McLellan');
  assert.equal(first.records[0].raw.historical_backfill, true);
  assert.deepEqual(
    first.records.map(record => record.external_message_id),
    second.records.map(record => record.external_message_id)
  );
});
