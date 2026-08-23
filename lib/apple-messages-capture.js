'use strict';

/**
 * Read-only adapter for macOS Messages and Contacts databases.
 *
 * This module only turns provider rows into faithful messaging capture
 * envelopes. It does not decide contacts, projects, facts, or actions; those
 * remain the CRM knowledge engine's job after /api/messaging/capture.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APPLE_EPOCH_UNIX_SECONDS = 978307200;
const DEFAULT_MESSAGES_DB = path.join(process.env.HOME || '/Users/dm_mini', 'Library', 'Messages', 'chat.db');
const DEFAULT_ADDRESS_BOOK_ROOT = path.join(
  process.env.HOME || '/Users/dm_mini',
  'Library', 'Application Support', 'AddressBook',
);

function appleDateToUnixSeconds(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const seconds = raw > 1e12 ? raw / 1e9 : raw;
  return Math.floor(APPLE_EPOCH_UNIX_SECONDS + seconds);
}

function decodeTypedstreamLength(buffer, offset) {
  if (!Buffer.isBuffer(buffer) || offset >= buffer.length) return null;
  const marker = buffer[offset];
  if (marker <= 0x7f) return { value: marker, bytes: 1 };
  if (marker === 0x81 && offset + 3 <= buffer.length) {
    return { value: buffer.readUInt16LE(offset + 1), bytes: 3 };
  }
  if (marker === 0x82 && offset + 5 <= buffer.length) {
    return { value: buffer.readUInt32LE(offset + 1), bytes: 5 };
  }
  if (marker === 0x83 && offset + 9 <= buffer.length) {
    const value = buffer.readBigUInt64LE(offset + 1);
    if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return { value: Number(value), bytes: 9 };
  }
  return null;
}

// Modern Messages leaves message.text empty and stores the body in an
// NSAttributedString typedstream. The main UTF-8 NSString is length-prefixed
// after the '+' type marker. Decode only that provider string; never scrape
// arbitrary printable runs from the binary envelope.
function decodeAttributedBody(value) {
  if (!value) return '';
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  // typedstream class names are counted bytes, not consistently NUL-terminated
  // (modern short bodies commonly continue with 0x01 immediately).
  const classMarker = Buffer.from('NSString', 'utf8');
  let classOffset = 0;
  while (classOffset < buffer.length) {
    const found = buffer.indexOf(classMarker, classOffset);
    if (found < 0) break;
    const searchStart = found + classMarker.length;
    const searchEnd = Math.min(buffer.length - 2, searchStart + 32);
    for (let cursor = searchStart; cursor <= searchEnd; cursor += 1) {
      if (buffer[cursor] !== 0x01 || buffer[cursor + 1] !== 0x2b) continue;
      const length = decodeTypedstreamLength(buffer, cursor + 2);
      if (!length || length.value < 0) continue;
      const bodyStart = cursor + 2 + length.bytes;
      const bodyEnd = bodyStart + length.value;
      if (bodyEnd > buffer.length) continue;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(bodyStart, bodyEnd));
      } catch (_) {
        // A later NSString marker may contain the actual body.
      }
    }
    classOffset = found + classMarker.length;
  }
  return '';
}

function messageBody(row = {}) {
  const plain = String(row.text || '');
  if (plain.trim()) return plain;
  return decodeAttributedBody(row.attributed_body);
}

function normalizeAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return [];
  if (raw.includes('@')) return [raw];
  const digits = raw.replace(/\D/g, '');
  if (!digits) return [raw];
  return digits.length >= 9 ? [digits, digits.slice(-9)] : [digits];
}

function contactDisplayName(row = {}) {
  const explicit = String(row.name || '').trim();
  if (explicit) return explicit;
  const personal = [row.first_name, row.middle_name, row.last_name]
    .map(value => String(value || '').trim()).filter(Boolean).join(' ');
  return personal || String(row.organization || row.nickname || '').trim();
}

function addressBookDatabases(root = DEFAULT_ADDRESS_BOOK_ROOT) {
  const candidates = [root, path.join(root, 'Sources')];
  const found = [];
  for (const candidate of candidates) {
    let entries = [];
    try { entries = fs.readdirSync(candidate, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.isFile() && /^AddressBook-v\d+\.abcddb$/.test(entry.name)) {
        found.push(path.join(candidate, entry.name));
      } else if (candidate.endsWith(`${path.sep}Sources`) && entry.isDirectory()) {
        let nested = [];
        try { nested = fs.readdirSync(path.join(candidate, entry.name)); } catch (_) { continue; }
        for (const name of nested) {
          if (/^AddressBook-v\d+\.abcddb$/.test(name)) found.push(path.join(candidate, entry.name, name));
        }
      }
    }
  }
  return [...new Set(found)];
}

function addContactAddress(map, address, name) {
  const label = String(name || '').trim();
  if (!label) return;
  for (const key of normalizeAddress(address)) {
    if (!key) continue;
    if (!map.has(key)) map.set(key, label);
    else if (map.get(key) !== label) map.set(key, null);
  }
}

function readContactNames({ root = DEFAULT_ADDRESS_BOOK_ROOT, databasePaths = null } = {}) {
  const names = new Map();
  const paths = databasePaths || addressBookDatabases(root);
  for (const databasePath of paths) {
    let database;
    try {
      database = new Database(databasePath, { readonly: true, fileMustExist: true });
      const contacts = database.prepare(`
        SELECT r.ZNAME AS name, r.ZFIRSTNAME AS first_name, r.ZMIDDLENAME AS middle_name,
               r.ZLASTNAME AS last_name, r.ZORGANIZATION AS organization, r.ZNICKNAME AS nickname,
               p.ZFULLNUMBER AS address
        FROM ZABCDPHONENUMBER p
        JOIN ZABCDRECORD r ON r.Z_PK = CASE WHEN p.ZOWNER > 0 THEN p.ZOWNER ELSE p.Z22_OWNER END
        WHERE COALESCE(p.ZFULLNUMBER, '') != ''
        UNION ALL
        SELECT r.ZNAME, r.ZFIRSTNAME, r.ZMIDDLENAME, r.ZLASTNAME, r.ZORGANIZATION, r.ZNICKNAME,
               e.ZADDRESS
        FROM ZABCDEMAILADDRESS e
        JOIN ZABCDRECORD r ON r.Z_PK = CASE WHEN e.ZOWNER > 0 THEN e.ZOWNER ELSE e.Z22_OWNER END
        WHERE COALESCE(e.ZADDRESS, '') != ''
      `).all();
      for (const contact of contacts) addContactAddress(names, contact.address, contactDisplayName(contact));
    } catch (_) {
      // One disabled Contacts account must not block Messages capture from all
      // other accounts. The raw sender handle remains valid provenance.
    } finally {
      try { database?.close(); } catch (_) {}
    }
  }
  return names;
}

function resolveContactName(handle, names) {
  for (const key of normalizeAddress(handle)) {
    const name = names?.get(key);
    if (name) return name;
  }
  return '';
}

class AppleMessagesReader {
  constructor({ databasePath = DEFAULT_MESSAGES_DB } = {}) {
    this.databasePath = databasePath;
    this.database = new Database(databasePath, { readonly: true, fileMustExist: true });
  }

  close() {
    this.database.close();
  }

  maxRowId() {
    return Number(this.database.prepare('SELECT COALESCE(MAX(ROWID), 0) AS rowid FROM message').get().rowid || 0);
  }

  messagesAfter(rowId, { limit = 250 } = {}) {
    return this.database.prepare(`
      SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody AS attributed_body,
             m.subject, m.service, m.account, m.date, m.date_edited, m.date_retracted,
             m.is_from_me, m.is_system_message, m.is_empty, m.is_corrupt, m.error,
             m.item_type, m.associated_message_type, m.cache_has_attachments,
             m.reply_to_guid, c.guid AS chat_guid, c.display_name AS chat_display_name,
             c.chat_identifier, c.service_name AS chat_service, c.style AS chat_style,
             h.id AS sender_handle, h.service AS sender_service,
             (SELECT GROUP_CONCAT(hp.id, '|')
                FROM chat_handle_join chj
                JOIN handle hp ON hp.ROWID = chj.handle_id
               WHERE chj.chat_id = c.ROWID) AS participant_handles
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?
    `).all(Number(rowId) || 0, Math.max(1, Math.min(2000, Number(limit) || 250)));
  }
}

function buildMessagesCapturePayload(row, {
  user = 'douglas', ownerName = 'Douglas McLellan', contactNames = new Map(),
} = {}) {
  const rowid = Number(row?.rowid || 0);
  const skip = reason => ({ payload: null, skip_reason: reason, rowid });
  if (!rowid || !String(row.guid || '').trim()) return skip('missing_provider_identity');
  if (Number(row.is_corrupt || 0)) return skip('corrupt');
  if (Number(row.is_system_message || 0) || Number(row.item_type || 0) !== 0) return skip('system_event');
  if (Number(row.associated_message_type || 0) !== 0) return skip('reaction');
  const body = messageBody(row);
  if (!String(body || '').trim()) {
    return skip(row.attributed_body ? 'unreadable_attributed_body' : 'empty_or_attachment_only');
  }

  const outgoing = Boolean(Number(row.is_from_me || 0));
  const peerHandle = String(row.sender_handle || row.chat_identifier || '').trim();
  const peerName = resolveContactName(peerHandle, contactNames);
  const participants = String(row.participant_handles || '').split('|').map(value => value.trim()).filter(Boolean);
  const isGroup = Number(row.chat_style || 0) === 43 || participants.length > 1;
  const chatName = String(row.chat_display_name || '').trim()
    || (!isGroup ? peerName : '')
    || String(row.chat_identifier || row.chat_guid || '').trim();
  const receivedAt = appleDateToUnixSeconds(row.date) || Math.floor(Date.now() / 1000);

  return {
    payload: {
      user: String(user || 'douglas'),
      platform: 'messages',
      external_message_id: String(row.guid),
      chat_id: String(row.chat_guid || row.chat_identifier || ''),
      chat_name: chatName,
      is_group: isGroup,
      sender_id: outgoing ? 'me' : peerHandle,
      sender_name: outgoing ? ownerName : (peerName || peerHandle),
      body,
      received_at: receivedAt,
      raw: {
        source: 'apple_messages_chat_db',
        direction: outgoing ? 'outbound' : 'inbound',
        apple_rowid: rowid,
        service: String(row.service || row.chat_service || ''),
        chat_identifier: String(row.chat_identifier || ''),
        participant_handles: participants,
        subject: String(row.subject || ''),
        reply_to_guid: String(row.reply_to_guid || ''),
        has_attachments: Boolean(Number(row.cache_has_attachments || 0)),
        date_edited: appleDateToUnixSeconds(row.date_edited),
        date_retracted: appleDateToUnixSeconds(row.date_retracted),
        historical_backfill: false,
      },
    },
    skip_reason: null,
    rowid,
  };
}

module.exports = {
  APPLE_EPOCH_UNIX_SECONDS,
  DEFAULT_MESSAGES_DB,
  DEFAULT_ADDRESS_BOOK_ROOT,
  appleDateToUnixSeconds,
  decodeTypedstreamLength,
  decodeAttributedBody,
  messageBody,
  normalizeAddress,
  contactDisplayName,
  addressBookDatabases,
  readContactNames,
  resolveContactName,
  AppleMessagesReader,
  buildMessagesCapturePayload,
};
