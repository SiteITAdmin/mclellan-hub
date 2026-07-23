'use strict';

const crypto = require('crypto');

const HEADER_RE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s+([^:]+):\s?(.*)$/;
const INVISIBLE_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

function cleanInvisible(value) {
  return String(value || '').replace(INVISIBLE_RE, '');
}

function normalize(value) {
  return cleanInvisible(value).trim().toLowerCase();
}

function timeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  return Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  ) - date.getTime();
}

function epochSeconds(parts, timeZone = 'Europe/Dublin') {
  const utcGuess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  let offset = timeZoneOffsetMs(new Date(utcGuess), timeZone);
  let timestamp = utcGuess - offset;
  const correctedOffset = timeZoneOffsetMs(new Date(timestamp), timeZone);
  if (correctedOffset !== offset) timestamp = utcGuess - correctedOffset;
  return Math.floor(timestamp / 1000);
}

function parseWhatsAppExport(text, { timeZone = 'Europe/Dublin' } = {}) {
  const lines = String(text || '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const messages = [];
  let current = null;

  function finish() {
    if (!current) return;
    current.body = cleanInvisible(current.body).trim();
    messages.push(current);
    current = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = cleanInvisible(lines[index]);
    const match = headerLine.match(HEADER_RE);
    if (!match) {
      if (current) {
        current.body += `\n${cleanInvisible(lines[index])}`;
        current.line_end = index + 1;
      }
      continue;
    }

    finish();
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const dateParts = {
      day: Number(match[1]),
      month: Number(match[2]),
      year,
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] || 0),
    };
    current = {
      sender: cleanInvisible(match[7]).trim(),
      body: cleanInvisible(match[8]),
      received_at: epochSeconds(dateParts, timeZone),
      local_timestamp: `${String(dateParts.day).padStart(2, '0')}/${String(dateParts.month).padStart(2, '0')}/${dateParts.year}, ${String(dateParts.hour).padStart(2, '0')}:${String(dateParts.minute).padStart(2, '0')}:${String(dateParts.second).padStart(2, '0')}`,
      line_start: index + 1,
      line_end: index + 1,
    };
  }
  finish();
  return messages;
}

function isOmittedAttachment(body) {
  const text = cleanInvisible(body).trim().replace(/^<|>$/g, '');
  return /^(?:image|video|audio|gif|sticker|document|contact card|media) omitted$/i.test(text);
}

function isSystemMessage(message, chatName) {
  const sender = normalize(message?.sender);
  const body = normalize(message?.body);
  if (!body) return true;
  if (sender && sender === normalize(chatName)) return true;
  return /^(?:messages and calls are end-to-end encrypted|you (?:created|added|removed)|.+ (?:added|removed) .+|.+ (?:left|joined using)|.+ changed (?:this group's|the group|the subject|the group description)|security code changed)/i.test(body);
}

function participantContact(route, sender) {
  const wanted = normalize(sender);
  return (route?.participant_contacts || []).find(participant =>
    (participant.sender_names || []).some(name => normalize(name) === wanted)
  )?.contact_name || '';
}

function senderExportId(sender) {
  const slug = normalize(sender).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return slug ? `export-name:${slug}` : '';
}

function buildImportRecords(messages, {
  route,
  chatName,
  user = 'douglas',
  sourceName = '_chat.txt',
  ownerNames = ['Douglas', 'Douglas McLellan'],
} = {}) {
  if (!route?.id) throw new Error('route with id required');
  if (!chatName) throw new Error('chatName required');

  const records = [];
  const skipped = { system: 0, omitted_attachment: 0, empty: 0 };
  const occurrences = new Map();
  const ownerSet = new Set(ownerNames.map(normalize));

  for (const message of messages || []) {
    if (!String(message.body || '').trim()) {
      skipped.empty += 1;
      continue;
    }
    if (isSystemMessage(message, chatName)) {
      skipped.system += 1;
      continue;
    }
    if (isOmittedAttachment(message.body)) {
      skipped.omitted_attachment += 1;
      continue;
    }

    const contactName = participantContact(route, message.sender);
    const basis = [chatName, message.local_timestamp, message.sender, message.body].join('\u0000');
    const occurrence = (occurrences.get(basis) || 0) + 1;
    occurrences.set(basis, occurrence);
    const digest = crypto.createHash('sha256').update(`${basis}\u0000${occurrence}`).digest('hex');
    const routed = {
      id: route.id,
      project_slug: route.project_slug || '',
      project_name: route.project_name || '',
      contact_name: contactName,
      note: route.note || '',
    };

    records.push({
      user,
      platform: 'whatsapp',
      external_message_id: `whatsapp-export:${digest.slice(0, 48)}`,
      chat_id: `export:${route.id}`,
      chat_name: chatName,
      is_group: true,
      sender_id: senderExportId(message.sender),
      sender_name: message.sender,
      body: message.body,
      received_at: message.received_at,
      project_slug: route.project_slug || undefined,
      project_name: route.project_name || undefined,
      contact_name: contactName || undefined,
      route: routed,
      raw: {
        source: 'whatsapp_chat_export',
        source_name: sourceName,
        historical_backfill: true,
        direction: ownerSet.has(normalize(message.sender)) ? 'outbound' : 'inbound',
        message_type: 'text',
        export_timestamp_local: message.local_timestamp,
        export_timezone: 'Europe/Dublin',
        line_start: message.line_start,
        line_end: message.line_end,
      },
    });
  }

  return { records, skipped };
}

module.exports = {
  parseWhatsAppExport,
  buildImportRecords,
  isOmittedAttachment,
  isSystemMessage,
  participantContact,
  epochSeconds,
};
