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
  if (explicit) return explicit;

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
  const routing = routingMetadata(row);
  const when = row.received_at
    ? new Date(row.received_at * 1000).toISOString()
    : '';
  return [
    `WhatsApp message from ${who}`,
    `Chat: ${chat}${row.is_group ? ' (group)' : ' (dm)'}`,
    when ? `Received: ${when}` : '',
    routing.project_name || routing.project_slug
      ? `Explicit project route: ${routing.project_name || routing.project_slug}${routing.project_slug ? ` (${routing.project_slug})` : ''}`
      : '',
    routing.subject_contact_name ? `Explicit subject route: ${routing.subject_contact_name}` : '',
    routing.contact_name ? `Explicit contact route: ${routing.contact_name}` : '',
    routing.note ? `Routing note: ${routing.note}` : '',
    routing.historical_backfill
      ? 'Historical backfill: yes — preserve as evidence; do not assume old actions are still outstanding.'
      : '',
    '',
    String(row.body || ''),
  ].filter(Boolean).join('\n');
}

function routingMetadata(row = {}) {
  let payload = row.raw_json || row.raw || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload || '{}'); } catch (_) { payload = {}; }
  }
  const route = payload?.route && typeof payload.route === 'object' ? payload.route : {};
  const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {};
  return {
    project_slug: String(payload.project_slug || route.project_slug || '').trim(),
    project_name: String(payload.project_name || route.project_name || '').trim(),
    subject_contact_name: String(payload.subject_contact_name || route.subject_contact_name || '').trim(),
    contact_name: String(payload.contact_name || route.contact_name || '').trim(),
    note: String(route.note || payload.routing_note || '').trim(),
    historical_backfill: raw.historical_backfill === true || payload.historical_backfill === true,
  };
}

/**
 * Insert or no-op on duplicate (platform + external_message_id).
 * @returns {{ id: string, created: boolean, duplicate?: boolean, row?: object }}
 */
function captureMessagingMessage(user, payload = {}) {
  if (!user) throw new Error('user required');
  const body = String(payload.body || payload.message || payload.text || '');
  if (!body.trim()) throw new Error('body required');

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
    chat_id: String(payload.chat_id || payload.chatId || ''),
    chat_name: String(payload.chat_name || payload.chatName || ''),
    is_group: payload.is_group || payload.isGroup ? 1 : 0,
    sender_id: String(payload.sender_id || payload.senderId || payload.user_id || ''),
    sender_name: String(payload.sender_name || payload.senderName || payload.pushName || ''),
    // SQLite TEXT is not the model context window. Preserve the complete
    // provider-returned message here; deterministic source chunking applies
    // later and must be able to reach asks at the tail.
    body,
    received_at: ts,
    // Preserve the complete source envelope. The nested `raw` object contains
    // transport detail, while top-level route/contact/project hints are
    // explicit operator metadata required by the synthesis linker.
    // Never truncate serialized JSON: a cut string is neither faithful nor
    // parseable, and it can erase explicit routing/backfill provenance.
    raw_json: JSON.stringify(payload),
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

  // The ingest door — see lib/source-admission.js. Admission observes, it never
  // gates: a lost receipt must not lose the message.  Required lazily because
  // source-evidence.js imports this module for its messaging adapter, so a
  // top-level import here would close the cycle.
  let admission = null;
  try {
    admission = require('./source-admission').admitSource(row.user, 'messaging_message', row.id, {
      ingester: `messaging:${row.platform || 'unknown'}`,
    });
  } catch (error) {
    console.error(`[messaging-capture] source admission failed for ${row.id}:`, error.message);
  }

  return { id: row.id, created: true, duplicate: false, row, admission };
}

function recentMessagingMessages(user, { limit = 50 } = {}) {
  return db.hub().prepare(`
    SELECT * FROM messaging_messages
     WHERE user = ?
     ORDER BY received_at DESC
     LIMIT ?
  `).all(user, limit);
}

const DEFAULT_CHAT_CONTEXT_BEFORE_SECONDS = 20 * 60;
const DEFAULT_CHAT_CONTEXT_AFTER_SECONDS = 20 * 60;
const DEFAULT_CHAT_CONTEXT_EACH_SIDE = 8;

function messageDirection(row = {}) {
  let payload = row.raw_json || row.raw || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload || '{}'); } catch (_) { payload = {}; }
  }
  const raw = payload?.raw && typeof payload.raw === 'object' ? payload.raw : {};
  const direction = String(raw.direction || payload.direction || '').trim().toLowerCase();
  if (direction === 'outbound' || direction === 'inbound') return direction;
  return '';
}

function chatNeighborsForMessage(user, row, {
  beforeSeconds = DEFAULT_CHAT_CONTEXT_BEFORE_SECONDS,
  afterSeconds = DEFAULT_CHAT_CONTEXT_AFTER_SECONDS,
  eachSide = DEFAULT_CHAT_CONTEXT_EACH_SIDE,
} = {}) {
  if (!user || !row?.id || !row.chat_id) return [];
  const ts = Number(row.received_at || 0);
  const platform = normalizePlatform(row.platform);
  const from = Math.max(0, ts - Math.max(0, Number(beforeSeconds) || 0));
  const to = ts + Math.max(0, Number(afterSeconds) || 0);
  const side = Math.max(1, Number(eachSide) || DEFAULT_CHAT_CONTEXT_EACH_SIDE);
  const window = db.hub().prepare(`
    SELECT * FROM messaging_messages
     WHERE user = ? AND platform = ? AND chat_id = ? AND id != ?
       AND received_at BETWEEN ? AND ?
     ORDER BY received_at ASC, id ASC
  `).all(user, platform, row.chat_id, row.id, from, to);
  const before = [];
  const after = [];
  for (const message of window) {
    const messageTs = Number(message.received_at || 0);
    if (messageTs < ts || (messageTs === ts && String(message.id) < String(row.id))) before.push(message);
    else after.push(message);
  }
  return [...before.slice(-side), ...after.slice(0, side)];
}

function formatChatNeighborLine(row) {
  const when = row.received_at
    ? new Date(Number(row.received_at) * 1000).toISOString()
    : '';
  const dir = messageDirection(row) || 'unknown-direction';
  const who = row.sender_name || row.sender_id || 'unknown';
  const body = String(row.body || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return `- ${when} ${dir} ${who}: ${body}`.trim();
}

function formatMessagingChatContext(user, row, opts) {
  const neighbors = chatNeighborsForMessage(user, row, opts);
  if (!neighbors.length) return '';
  return [
    'SAME-CHAT CONTEXT (neighbouring turns in this conversation; NOT the source. Do not quote these as evidence spans.)',
    ...neighbors.map(formatChatNeighborLine),
  ].join('\n');
}

module.exports = {
  captureMessagingMessage,
  recentMessagingMessages,
  buildEvidenceText,
  routingMetadata,
  externalIdFromPayload,
  messageDirection,
  chatNeighborsForMessage,
  formatChatNeighborLine,
  formatMessagingChatContext,
  DEFAULT_CHAT_CONTEXT_BEFORE_SECONDS,
  DEFAULT_CHAT_CONTEXT_AFTER_SECONDS,
  DEFAULT_CHAT_CONTEXT_EACH_SIDE,
};
