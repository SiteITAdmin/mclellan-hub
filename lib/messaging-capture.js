'use strict';

/**
 * Messaging capture — raw store for WhatsApp (and future chat platforms)
 * forwarded by Hermes. This is evidence only. CRM knowledge engine decides
 * whether a message becomes atoms and/or projected tasks.
 */

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');

function now() {
  return Math.floor(Date.now() / 1000);
}

function normalizePlatform(value) {
  const p = String(value || 'whatsapp').trim().toLowerCase();
  return p || 'whatsapp';
}

function externalIdFromPayload(payload) {
  const explicit = String(
    payload.external_message_id ||
    payload.message_id ||
    payload.messageId ||
    payload.id ||
    ''
  ).trim();
  if (explicit) return explicit.slice(0, 240);

  // Stable fallback when Hermes only has body + sender (agent:start hook).
  const basis = [
    payload.platform || 'whatsapp',
    payload.chat_id || payload.chatId || '',
    payload.sender_id || payload.senderId || payload.user_id || '',
    payload.body || payload.message || payload.text || '',
    payload.received_at || payload.ts || '',
  ].join('|');
  return `hash:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

function buildEvidenceText(row) {
  const who = row.sender_name || row.sender_id || 'unknown sender';
  const chat = row.chat_name || row.chat_id || (row.is_group ? 'group' : 'dm');
  const when = row.received_at
    ? new Date(row.received_at * 1000).toISOString()
    : '';
  return [
    `WhatsApp message from ${who}`,
    `Chat: ${chat}${row.is_group ? ' (group)' : ' (dm)'}`,
    when ? `Received: ${when}` : '',
    '',
    String(row.body || '').trim(),
  ].filter(Boolean).join('\n');
}

/**
 * Insert or no-op on duplicate (platform + external_message_id).
 * @returns {{ id: string, created: boolean, duplicate?: boolean, row?: object }}
 */
function captureMessagingMessage(user, payload = {}) {
  if (!user) throw new Error('user required');
  const body = String(payload.body || payload.message || payload.text || '').trim();
  if (!body) throw new Error('body required');

  const platform = normalizePlatform(payload.platform);
  const externalMessageId = externalIdFromPayload(payload);
  const hub = db.hub();

  const existing = hub.prepare(`
    SELECT * FROM messaging_messages
     WHERE user = ? AND platform = ? AND external_message_id = ?
     LIMIT 1
  `).get(user, platform, externalMessageId);
  if (existing) {
    return { id: existing.id, created: false, duplicate: true, row: existing };
  }

  const receivedAt = Number(payload.received_at || payload.ts || 0);
  const ts = Number.isFinite(receivedAt) && receivedAt > 1_000_000_000
    ? Math.floor(receivedAt > 1e12 ? receivedAt / 1000 : receivedAt)
    : now();

  const row = {
    id: uuid(),
    user,
    platform,
    external_message_id: externalMessageId,
    chat_id: String(payload.chat_id || payload.chatId || '').slice(0, 240),
    chat_name: String(payload.chat_name || payload.chatName || '').slice(0, 240),
    is_group: payload.is_group || payload.isGroup ? 1 : 0,
    sender_id: String(payload.sender_id || payload.senderId || payload.user_id || '').slice(0, 240),
    sender_name: String(payload.sender_name || payload.senderName || payload.pushName || '').slice(0, 240),
    body: body.slice(0, 20000),
    received_at: ts,
    raw_json: JSON.stringify(payload.raw || payload).slice(0, 50000),
    status: 'received',
    created_at: now(),
  };

  hub.prepare(`
    INSERT INTO messaging_messages
      (id, user, platform, external_message_id, chat_id, chat_name, is_group,
       sender_id, sender_name, body, received_at, raw_json, status, created_at)
    VALUES
      (@id, @user, @platform, @external_message_id, @chat_id, @chat_name, @is_group,
       @sender_id, @sender_name, @body, @received_at, @raw_json, @status, @created_at)
  `).run(row);

  return { id: row.id, created: true, duplicate: false, row };
}

function recentMessagingMessages(user, { limit = 50 } = {}) {
  return db.hub().prepare(`
    SELECT * FROM messaging_messages
     WHERE user = ?
     ORDER BY received_at DESC
     LIMIT ?
  `).all(user, limit);
}

module.exports = {
  captureMessagingMessage,
  recentMessagingMessages,
  buildEvidenceText,
  externalIdFromPayload,
};
