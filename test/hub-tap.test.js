'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tap-'));
const configFile = path.join(tmp, 'hub-tap.json');
const privateFile = path.join(tmp, 'private-contacts.json');
fs.writeFileSync(configFile, JSON.stringify({ url: 'https://hub.example/', secret: 'tap-secret' }));

const ME = { id: '353861111111:7@s.whatsapp.net', lid: '99887766:7@lid' };

function fakeHub({ approved = [], selfChats = [], paused = false, fail = false, outbox = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ route: url.replace('https://hub.example', ''), body, auth: opts.headers.Authorization });
    if (fail) return { ok: false, status: 503, json: async () => ({ error: 'WhatsApp capture is paused' }) };
    if (url.endsWith('/heartbeat')) return { ok: true, status: 200, json: async () => ({ approved, self_chat_ids: selfChats, paused }) };
    if (url.endsWith('/outbox/claim')) return { ok: true, status: 200, json: async () => ({ messages: outbox.splice(0) }) };
    if (url.endsWith('/outbox/complete')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ stored: true }) };
  };
  return { calls, fetchImpl };
}

function dm(from, body, over = {}) {
  return { key: { remoteJid: `${from}@s.whatsapp.net`, id: `m-${Math.random()}`, fromMe: false, ...over.key },
    message: over.message || { conversation: body }, pushName: over.pushName ?? 'Orla Byrne', messageTimestamp: 1793800000 };
}

async function tapWith(hub, opts = {}) {
  const { createHubTap } = await import('../integrations/hermes-whatsapp/hub-tap.mjs');
  return createHubTap({ configFile, privateFile, fetchImpl: hub.fetchImpl, logger: { warn() {} }, ...opts });
}

const quiet = { sock: { user: ME, groupMetadata: async () => ({ subject: 'Dad Information Group' }) }, isGroup: false };

test('tap: nothing is sent before the Hub has answered a heartbeat', async () => {
  fs.writeFileSync(privateFile, JSON.stringify({ version: 1, contacts: [] }));
  const hub = fakeHub({ approved: ['353870000001@s.whatsapp.net'] });
  const tap = await tapWith(hub);
  assert.equal(await tap.onMessage(dm('353870000001', 'hi'), quiet), 'paused');
  assert.equal(hub.calls.length, 0);
});

test('tap: approved chats send their words; others only that they exist, at most every 10 minutes', async () => {
  const hub = fakeHub({ approved: ['353870000001@s.whatsapp.net'] });
  const tap = await tapWith(hub);
  await tap.heartbeat(() => 'connected');
  assert.deepEqual(hub.calls[0].body.whatsapp, 'connected');
  assert.equal(hub.calls[0].auth, 'Bearer tap-secret');
  assert.equal(await tap.onMessage(dm('353870000001', 'See you Thursday'), quiet), 'sent');
  const sent = hub.calls[1].body;
  assert.equal(sent.body, 'See you Thursday');
  assert.equal(sent.chat_id, '353870000001@s.whatsapp.net');
  assert.equal(sent.sender_phone, '353870000001');
  assert.equal(sent.chat_name, 'Orla Byrne');
  assert.equal(await tap.onMessage(dm('353870000002', 'Private words'), quiet), 'seen');
  assert.equal(hub.calls[2].body.body, '', 'an unapproved chat never sends its words');
  assert.equal(hub.calls[2].body.chat_id, '353870000002@s.whatsapp.net');
  assert.equal(await tap.onMessage(dm('353870000002', 'More'), quiet), 'seen_recently');
  assert.equal(hub.calls.length, 3);
});

test('tap: private contacts are never sent, and an unreadable list stops everything', async () => {
  fs.writeFileSync(privateFile, JSON.stringify({ version: 1, contacts: [{ slug: 'x', whatsapp: '+353 87 000 0009' }] }));
  const hub = fakeHub({ approved: ['353870000009@s.whatsapp.net'] });
  const tap = await tapWith(hub);
  await tap.heartbeat(() => 'connected');
  assert.equal(await tap.onMessage(dm('353870000009', 'hello'), quiet), 'private');
  assert.equal(await tap.onMessage(dm('353870000008', 'hello'), quiet), 'seen');
  assert.equal(hub.calls.filter(c => c.body.chat_id === '353870000009@s.whatsapp.net').length, 0, 'not even that the chat exists');
  fs.writeFileSync(privateFile, '{ not json');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(privateFile, later, later);
  assert.equal(await tap.onMessage(dm('353870000001', 'hello'), quiet), 'blocked_private');
  await tap.heartbeat(() => 'connected');
  assert.equal(hub.calls.at(-1).body.blocked_private, true, 'the Hub is told, so Today can say so');
  fs.writeFileSync(privateFile, JSON.stringify({ version: 1, contacts: [] }));
});

test('tap: a refused or failed send is counted and dropped, never retried', async () => {
  const hub = fakeHub({ approved: ['353870000001@s.whatsapp.net'] });
  const tap = await tapWith(hub);
  await tap.heartbeat(() => 'connected');
  const failing = fakeHub({ fail: true });
  hub.fetchImpl = failing.fetchImpl;
  const tap2 = await tapWith(failing);
  tap2.state.paused = false;
  tap2.state.approved = new Set(['353870000001@s.whatsapp.net']);
  assert.equal(await tap2.onMessage(dm('353870000001', 'x'), quiet), 'failed');
  assert.equal(tap2.state.failed, 1);
  assert.match(tap2.state.lastError, /HTTP 503: WhatsApp capture is paused/);
  assert.equal(failing.calls.length, 1);
  await tap2.heartbeat(() => 'connected');
  assert.equal(tap2.state.paused, true, 'a failed heartbeat means stop until the Hub answers');
});

test('tap: works out self-chat, LID senders and group names', async () => {
  const hub = fakeHub({ approved: ['353861111111@s.whatsapp.net', '353870000005@s.whatsapp.net', '120363001@g.us'] });
  const tap = await tapWith(hub);
  await tap.heartbeat(() => 'connected');
  await tap.onMessage(dm('353861111111', 'Met Aoife', { key: { fromMe: true }, pushName: 'Douglas' }), quiet);
  let b = hub.calls.at(-1).body;
  assert.equal(b.is_self, true);
  assert.equal(b.from_me, true);
  assert.equal(b.peer_phone, '');
  await tap.onMessage({ key: { remoteJid: '5551234@lid', id: 'l1', fromMe: false }, message: { extendedTextMessage: { text: 'From a LID' } }, pushName: 'Sam' },
    { ...quiet, lidToPhone: { 5551234: '353870000005' } });
  b = hub.calls.at(-1).body;
  assert.equal(b.chat_id, '353870000005@s.whatsapp.net', 'the phone form keeps one chat per person');
  assert.equal(b.sender_phone, '353870000005');
  await tap.onMessage({ key: { remoteJid: '120363001@g.us', id: 'g1', participant: '447700900111@s.whatsapp.net' }, message: { imageMessage: { caption: 'Dad at the GP' } }, pushName: 'Iain' },
    { ...quiet, isGroup: true, senderId: '447700900111@s.whatsapp.net' });
  b = hub.calls.at(-1).body;
  assert.equal(b.chat_name, 'Dad Information Group');
  assert.equal(b.sender_phone, '447700900111');
  assert.equal(b.body, '[Photo] Dad at the GP');
  assert.equal(await tap.onMessage({ key: { remoteJid: 'status@broadcast', id: 's' }, message: { conversation: 'status' } }, quiet), 'skip');
  assert.equal(await tap.onMessage(dm('353870000005', '', { message: { reactionMessage: { text: '👍' } } }), quiet), 'skip');
  assert.equal(await tap.onMessage(dm('353870000005', '', { message: { audioMessage: {} } }), quiet), 'no_text', 'a voice note in an approved chat has no words to store');
});

test('tap: reminders are claimed once and sent only to the approved self chat', async () => {
  const hub = fakeHub({ approved: ['353861111111@s.whatsapp.net'], selfChats: ['353861111111@s.whatsapp.net'],
    outbox: [{ id: 'o1', chat_id: '353861111111@s.whatsapp.net', body: '[Hub] Meeting in 30 minutes: Purview' }] });
  const tap = await tapWith(hub);
  const sent = [];
  const sock = { ...quiet.sock, sendMessage: async (chatId, payload) => { sent.push({ chatId, payload }); } };
  await tap.heartbeat(() => 'connected');
  assert.equal(await tap.deliverOutbox(() => sock), 1);
  assert.deepEqual(sent, [{ chatId: '353861111111@s.whatsapp.net', payload: { text: '[Hub] Meeting in 30 minutes: Purview' } }]);
  assert.ok(hub.calls.some(c => c.route === '/api/crm/whatsapp/outbox/claim'));
  const done = hub.calls.find(c => c.route === '/api/crm/whatsapp/outbox/complete');
  assert.deepEqual(done.body, { id: 'o1', ok: true });
  const before = hub.calls.length;
  const echo = { key: { remoteJid: '353861111111@s.whatsapp.net', id: 'echo1', fromMe: true }, message: { conversation: '[Hub] Meeting in 30 minutes: Purview' } };
  assert.equal(await tap.onMessage(echo, { ...quiet, sock }), 'own_reply', 'the reminder WhatsApp echoes back is not sent to the Hub as a note');
  assert.equal(hub.calls.length, before);
  assert.equal(await tap.deliverOutbox(() => sock), 0, 'a claimed reminder is not sent twice');
  tap.state.paused = true;
  assert.equal(await tap.deliverOutbox(() => sock), 0, 'a paused Hub sends nothing');
});

test('tap installer patches the bridge once, stops if it has changed, and sets capture-only mode', () => {
  const dir = path.join(tmp, 'bridge');
  fs.mkdirSync(dir);
  const bridge = [
    '#!/usr/bin/env node',
    "import express from 'express';",
    'let sock = null;',
    "let connectionState = 'disconnected';",
    'sock.ev.on("messages.upsert", async ({ messages }) => { for (const msg of messages) {',
    "      const senderNumber = resolvedSenderId.replace(/@.*/, '');",
    '} });',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'bridge.js'), bridge);
  const envFile = path.join(tmp, 'hermes.env');
  fs.writeFileSync(envFile, 'WHATSAPP_MODE=self-chat\nOTHER=1\n');
  const env = { ...process.env, HERMES_BRIDGE_DIR: dir, HERMES_ENV_FILE: envFile, HUB_TAP_SPOOL: path.join(tmp, 'spool'), HUB_TAP_SECRET: 'abc' };
  const script = path.join(__dirname, '..', 'scripts', 'install-hermes-tap.sh');
  execFileSync(script, { env, stdio: 'pipe' });
  const patched = fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8');
  assert.match(patched, /^#!\/usr\/bin\/env node\nimport \{ createHubTap \} from '\.\/hub-tap\.mjs';/);
  assert.match(patched, /hubTap\.start\(\(\) => connectionState, \(\) => sock\)/);
  assert.match(patched, /hubTap\.onMessage\(msg, \{ sock, senderId: resolvedSenderId, isGroup, lidToPhone \}\)/);
  assert.ok(fs.existsSync(path.join(dir, 'hub-tap.mjs')));
  execFileSync(script, { env, stdio: 'pipe' });
  assert.equal(fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8'), patched, 'running it again changes nothing');
  const envText = fs.readFileSync(envFile, 'utf8');
  assert.match(envText, /^WHATSAPP_MODE=bot$/m);
  assert.match(envText, /^WHATSAPP_DM_POLICY=allowlist$/m);
  assert.match(envText, /^WHATSAPP_ALLOWED_USERS=$/m);
  assert.match(envText, /^WHATSAPP_GROUP_POLICY=disabled$/m);
  assert.match(envText, /^OTHER=1$/m);
  const cfg = path.join(tmp, 'spool', 'hub-tap.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { url: 'https://douglas.mclellan.scot', secret: 'abc' });
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);

  fs.writeFileSync(path.join(dir, 'bridge.js'), "import x from 'y';\nconst somethingElse = 1;\n");
  assert.throws(() => execFileSync(script, { env, stdio: 'pipe' }), /anchor not found/);
});
