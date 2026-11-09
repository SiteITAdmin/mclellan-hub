// McLellan Hub tap for the Hermes WhatsApp bridge (CRM-PLAN §8).
//
// Installed into ~/.hermes/hermes-agent/scripts/whatsapp-bridge/ by
// scripts/install-hermes-tap.sh, which adds two lines to bridge.js. It sees
// every message before Hermes filters it, and never changes what Hermes does.
//
// - People on the private-contacts list are never sent to the Hub, not even
//   the fact that their chat exists. If that list can't be read, nothing is
//   sent at all.
// - Only chats Douglas has approved on the Hub are sent with their words.
//   Any other chat is reported by name only, so it can wait in review.
// - Nothing is queued or retried: if the Hub refuses or is unreachable, the
//   message is dropped and counted. The Hub's stop switch means stop.
// - A heartbeat every minute tells the Hub Hermes is alive and whether
//   WhatsApp is connected, and brings back the approved chats and the switch.

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SPOOL = path.join(os.homedir(), '.hermes', 'hub-capture');
const HEARTBEAT_MS = 60 * 1000;
const SEEN_REPORT_MS = 10 * 60 * 1000;
const GROUP_NAME_MS = 6 * 60 * 60 * 1000;

export function digits(value) {
  let d = String(value || '').replace(/@.*/, '').replace(/:.*/, '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('08') && d.length === 10) d = `353${d.slice(1)}`;
  else if (d.startsWith('07') && d.length === 11) d = `44${d.slice(1)}`;
  return d;
}

// Every phone-like string anywhere in a contact entry counts, so the list's
// exact shape doesn't matter.
export function privateNumbers(json) {
  const out = new Set();
  const walk = v => {
    if (typeof v === 'string' || typeof v === 'number') {
      const d = digits(v);
      if (d.length >= 7) out.add(d);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(json?.contacts || []);
  return out;
}

export function messageText(message = {}) {
  const m = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message || message;
  if (m.conversation) return { body: m.conversation, media: '' };
  if (m.extendedTextMessage?.text) return { body: m.extendedTextMessage.text, media: '' };
  for (const [key, label] of [['imageMessage', 'Photo'], ['videoMessage', 'Video'], ['documentMessage', 'Document'], ['audioMessage', 'Voice note'], ['stickerMessage', 'Sticker'], ['locationMessage', 'Location'], ['contactMessage', 'Contact']]) {
    if (m[key]) {
      const caption = m[key].caption || '';
      const name = key === 'documentMessage' && m[key].fileName ? ` ${m[key].fileName}` : '';
      return { body: caption ? `[${label}${name}] ${caption}` : '', media: label };
    }
  }
  return { body: '', media: '' };
}

export function createHubTap({
  configFile = process.env.HUB_TAP_CONFIG || path.join(SPOOL, 'hub-tap.json'),
  privateFile = path.join(SPOOL, 'private-contacts.json'),
  fetchImpl = globalThis.fetch,
  logger = console,
  clock = () => Date.now(),
} = {}) {
  const state = { approved: new Set(), selfChatIds: [], paused: true, sent: 0, failed: 0, lastError: '', lastErrorAt: null, blockedPrivate: false };
  const seenReported = new Map();
  const groupNames = new Map();
  let cfg = null;
  let priv = { mtime: -1, numbers: new Set() };

  function config() {
    if (cfg) return cfg;
    try {
      const c = JSON.parse(readFileSync(configFile, 'utf8'));
      if (c.url && c.secret) cfg = { url: String(c.url).replace(/\/+$/, ''), secret: String(c.secret) };
    } catch (err) {
      logger.warn?.(`[hub-tap] no Hub config at ${configFile}: ${err.message}`);
    }
    return cfg;
  }

  // Fails closed: an unreadable list stops everything until it reads again.
  function privateList() {
    let mtime;
    try { mtime = statSync(privateFile).mtimeMs; } catch { state.blockedPrivate = false; return priv.numbers; }
    if (mtime !== priv.mtime) {
      try {
        priv = { mtime, numbers: privateNumbers(JSON.parse(readFileSync(privateFile, 'utf8'))) };
        state.blockedPrivate = false;
      } catch (err) {
        state.blockedPrivate = true;
        logger.warn?.(`[hub-tap] private-contacts list unreadable, sending nothing: ${err.message}`);
        return null;
      }
    }
    return state.blockedPrivate ? null : priv.numbers;
  }

  async function post(route, body) {
    const c = config();
    if (!c || !fetchImpl) return null;
    const res = await fetchImpl(`${c.url}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.secret}`, 'Content-Type': 'application/json', 'User-Agent': 'mclellan-hub-tap/1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ? `HTTP ${res.status}: ${data.error}` : `HTTP ${res.status}`);
    return data;
  }

  function failed(err) {
    state.failed += 1;
    state.lastError = String(err.message || err).slice(0, 300);
    state.lastErrorAt = Math.floor(clock() / 1000);
    logger.warn?.(`[hub-tap] ${state.lastError}`);
  }

  async function heartbeat(getConnection) {
    let whatsapp = 'unknown';
    try { whatsapp = getConnection?.() || 'unknown'; } catch {}
    privateList();
    try {
      const r = await post('/api/crm/whatsapp/heartbeat', {
        whatsapp, sent: state.sent, failed: state.failed, last_error: state.lastError, last_error_at: state.lastErrorAt,
        blocked_private: state.blockedPrivate,
      });
      if (r) {
        state.approved = new Set(r.approved || []);
        state.selfChatIds = Array.isArray(r.self_chat_ids) ? r.self_chat_ids : [];
        state.paused = !!r.paused;
      }
    } catch (err) {
      // Without a fresh answer, assume paused: never send words on stale approval.
      state.paused = true;
      failed(err);
    }
  }

  // Reminders the Hub has queued for Douglas's own chat. Nothing is sent to
  // anyone else, and each item is claimed once so a lost reply cannot duplicate.
  async function deliverOutbox(getSock) {
    if (state.paused || !state.selfChatIds.length) return 0;
    const sock = getSock?.();
    if (!sock) return 0;
    let messages;
    try {
      const r = await post('/api/crm/whatsapp/outbox/claim', { self_chat_ids: state.selfChatIds });
      messages = Array.isArray(r?.messages) ? r.messages : [];
    } catch (err) {
      failed(err);
      return 0;
    }
    let sent = 0;
    for (const m of messages) {
      try {
        await sock.sendMessage(m.chat_id, { text: m.body });
        await post('/api/crm/whatsapp/outbox/complete', { id: m.id, ok: true });
        sent += 1;
      } catch (err) {
        await post('/api/crm/whatsapp/outbox/complete', { id: m.id, ok: false, error: String(err.message || err).slice(0, 300) }).catch(() => {});
      }
    }
    return sent;
  }

  function start(getConnection, getSock) {
    const beat = () => heartbeat(getConnection).then(() => deliverOutbox(getSock)).catch(() => {});
    setTimeout(beat, 5000).unref?.();
    setInterval(beat, HEARTBEAT_MS).unref?.();
    return beat;
  }

  async function groupName(sock, chatId) {
    const hit = groupNames.get(chatId);
    if (hit && clock() - hit.at < GROUP_NAME_MS) return hit.name;
    try {
      const meta = await sock.groupMetadata(chatId);
      groupNames.set(chatId, { name: meta?.subject || '', at: clock() });
      return meta?.subject || '';
    } catch { return hit?.name || ''; }
  }

  // Work out who and where from one Baileys message. Phones are digits only.
  async function describe(msg, { sock, senderId, isGroup, lidToPhone = {} }) {
    const key = msg.key || {};
    const phoneOf = jid => {
      const s = String(jid || '');
      if (s.endsWith('@s.whatsapp.net')) return digits(s);
      if (s.endsWith('@lid')) return lidToPhone[digits(s)] ? digits(lidToPhone[digits(s)]) : '';
      return '';
    };
    const myNumber = digits(sock?.user?.id);
    const myLid = digits(sock?.user?.lid);
    const fromMe = !!key.fromMe;
    if (isGroup) {
      return {
        chat_id: key.remoteJid, is_group: true, is_self: false, from_me: fromMe, peer_phone: '',
        chat_name: await groupName(sock, key.remoteJid),
        sender_phone: fromMe ? '' : phoneOf(senderId) || phoneOf(key.participantAlt) || phoneOf(key.participant),
        sender_name: fromMe ? '' : (msg.pushName || ''),
      };
    }
    const peer = phoneOf(key.remoteJid) || phoneOf(key.remoteJidAlt);
    const chatNum = digits(key.remoteJid);
    const isSelf = (!!myNumber && (chatNum === myNumber || peer === myNumber)) || (!!myLid && chatNum === myLid);
    return {
      // The same person can arrive as a LID or a phone JID; the phone form keeps one chat.
      chat_id: peer ? `${peer}@s.whatsapp.net` : key.remoteJid,
      is_group: false, is_self: isSelf, from_me: fromMe, peer_phone: isSelf ? '' : peer,
      chat_name: isSelf ? 'You' : (fromMe ? '' : (msg.pushName || '')),
      sender_phone: fromMe ? '' : peer, sender_name: fromMe ? '' : (msg.pushName || ''),
    };
  }

  async function onMessage(msg, ctx = {}) {
    try {
      const remote = String(msg?.key?.remoteJid || '');
      if (!msg?.message || !remote || remote === 'status@broadcast' || remote.endsWith('@newsletter') || remote.endsWith('@broadcast')) return 'skip';
      const { body, media } = messageText(msg.message);
      if (!body && !media) return 'skip';
      const numbers = privateList();
      if (!numbers) return 'blocked_private';
      if (state.paused) return 'paused';
      const d = await describe(msg, ctx);
      if ((d.peer_phone && numbers.has(d.peer_phone)) || (d.sender_phone && numbers.has(d.sender_phone))) return 'private';
      const sentAt = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || Math.floor(clock() / 1000);
      if (state.approved.has(d.chat_id)) {
        if (!body) return 'no_text';
        await post('/api/crm/whatsapp/message', { ...d, message_id: msg.key.id, body: body.slice(0, 20000), sent_at: sentAt });
        state.sent += 1;
        return 'sent';
      }
      const last = seenReported.get(d.chat_id) || 0;
      if (clock() - last < SEEN_REPORT_MS) return 'seen_recently';
      seenReported.set(d.chat_id, clock());
      await post('/api/crm/whatsapp/message', { ...d, message_id: msg.key.id, body: '', sent_at: sentAt });
      return 'seen';
    } catch (err) {
      failed(err);
      return 'failed';
    }
  }

  return { onMessage, start, heartbeat, deliverOutbox, state };
}
