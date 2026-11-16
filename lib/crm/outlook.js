'use strict';

// Work email. Douglas's own flow saves each Outlook 365 email into a Drive
// folder as a file that starts with a plain header block:
//
//   FROM: a@x.ie
//   TO: b@x.ie;c@x.ie
//   CC: ...              (optional, being added to the flow)
//   SUBJECT: ...
//   RECEIVED: 2026-10-24T00:46:02+00:00
//   MESSAGE-ID: ...      (optional)
//   CONVERSATION-ID: ... (optional)
//   FOLDER: Inbox|Sent   (optional)
//
//   MESSAGE:
//   <html>…
//
// Everything from Outlook is Work. Only mail Douglas sent or received is
// admitted: the flow also catches some mail addressed only to colleagues.

const { crm, now } = require('./db');
const { admitSource } = require('./sources');
const { htmlToText, parseAddressList, normEmail } = require('./text');
const config = require('./config');
const runs = require('./runs');

const HEADER_KEYS = ['FROM', 'TO', 'CC', 'SUBJECT', 'RECEIVED', 'MESSAGE-ID', 'CONVERSATION-ID', 'FOLDER'];

function parseOutlookFile(raw, { sent = false, title = '' } = {}) {
  const s = String(raw || '').replace(/^﻿/, '');
  const idx = s.search(/^MESSAGE:\s*$/m);
  const inline = idx < 0 ? s.search(/\bMESSAGE:/) : -1;
  if (idx < 0 && inline < 0) {
    if (!sent) return null;
    const htmlAt = s.search(/<(?:!doctype\s+html|html)(?:\s|>)/i);
    if (htmlAt < 0) return null;
    const recipients = s.slice(0, htmlAt).trim();
    const to = parseAddressList(recipients);
    if (!to.length || recipients.split(/[;,]/).some(v => v.trim() && !normEmail(v))) return null;
    return { from: { email: config.workAddresses()[0], name: 'Douglas McLellan' },
      to, cc: [], subject: title, receivedAt: null, messageId: '', conversationId: '',
      folder: 'sent', legacy: true, text: htmlToText(s.slice(htmlAt)) };
  }
  const headPart = idx >= 0 ? s.slice(0, idx) : s.slice(0, inline);
  const body = idx >= 0 ? s.slice(idx).replace(/^MESSAGE:\s*/, '') : s.slice(inline + 'MESSAGE:'.length);

  const fields = {};
  // The first test file had no line breaks between fields, so split on the
  // known keys rather than on lines.
  const re = new RegExp(`(?:^|\\s)(${HEADER_KEYS.map(k => k.replace('-', '\\-')).join('|')}):\\s*`, 'g');
  const marks = [];
  let m;
  while ((m = re.exec(headPart))) marks.push({ key: m[1], start: m.index + m[0].length, at: m.index });
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : headPart.length;
    fields[mk.key] = headPart.slice(mk.start, end).trim();
  });
  if (!fields.FROM && !fields.SUBJECT) return null;

  const received = Date.parse(fields.RECEIVED || '');
  return {
    from: parseAddressList(fields.FROM)[0] || null,
    to: parseAddressList(fields.TO),
    cc: parseAddressList(fields.CC),
    subject: fields.SUBJECT || '',
    receivedAt: Number.isFinite(received) ? Math.floor(received / 1000) : null,
    messageId: fields['MESSAGE-ID'] || '',
    conversationId: fields['CONVERSATION-ID'] || '',
    folder: (fields.FOLDER || '').toLowerCase(),
    text: htmlToText(body),
  };
}

function admitOutlookEmail(parsed, { fileId, fileCreatedAt }) {
  const self = config.workAddresses();
  const all = [parsed.from, ...parsed.to, ...parsed.cc].filter(Boolean);
  const fromSelf = parsed.from && self.includes(normEmail(parsed.from.email));
  const toSelf = all.some(p => self.includes(normEmail(p.email)));
  if (!toSelf) return { skipped: 'not_addressed' };
  if (all.every(p => self.includes(normEmail(p.email)))) return { skipped: 'to_self' };

  if (parsed.legacy) {
    const matches = crm().prepare("SELECT * FROM sources WHERE origin = 'outlook' AND direction = 'out' AND title = ? AND text = ?").all(parsed.subject, parsed.text);
    const to = parsed.to.map(p => normEmail(p.email)).sort().join(';');
    for (const source of matches) {
      const stored = crm().prepare("SELECT value FROM source_addresses WHERE source_id = ? AND role = 'to' ORDER BY value").all(source.id).map(r => r.value).join(';');
      if (stored === to) return { created: false, source };
    }
  }
  const direction = fromSelf || parsed.folder === 'sent' ? 'out' : 'in';
  const participants = [
    ...(parsed.from ? [{ role: 'from', ...parsed.from }] : []),
    ...parsed.to.map(p => ({ role: 'to', ...p })),
    ...parsed.cc.map(p => ({ role: 'cc', ...p })),
  ];
  const readable = parsed.text.replace(/\s+/g, '').length >= 3 || !!parsed.subject;
  const { source, created } = admitSource({
    space: 'work',
    kind: 'email',
    origin: 'outlook',
    externalId: parsed.messageId || fileId,
    title: parsed.subject || '(no subject)',
    occurredAt: parsed.receivedAt || fileCreatedAt || now(),
    direction,
    text: parsed.text,
    rawRef: fileId,
    participants,
    readable,
    unreadableReason: readable ? '' : 'The saved email had no text',
    proposeFrom: direction === 'out' ? 'to' : 'from',
    holdUnknownSender: direction === 'in',
  });
  return { created, source };
}

async function runOutlookCapture({ drive = null } = {}) {
  return runs.track('outlook_capture', async () => {
    const client = drive || require('./google').drive(config.hubUser);
    const db = require('./db');
    const counts = { files: 0, admitted: 0, duplicate: 0, not_addressed: 0, to_self: 0, unparsed: 0 };
    const folders = [
      { id: config.outlookFolderId(), key: 'outlook_cursor', sent: false },
      { id: config.outlookSentFolderId(), key: 'outlook_sent_cursor', sent: true },
    ];
    for (const folder of folders) {
      const since = db.setting(folder.key) || new Date((now() - config.captureWindowDays * 86400) * 1000).toISOString();
      const types = folder.sent
        ? "(mimeType = 'text/html' or mimeType = 'application/octet-stream' or mimeType = 'text/plain')"
        : "mimeType = 'text/html'";
      let pageToken;
      let newest = since;
      const files = [];
      do {
        const res = await client.files.list({
          q: `'${folder.id}' in parents and ${types} and trashed = false and createdTime >= '${since}'`,
          fields: 'nextPageToken, files(id, name, createdTime, mimeType)',
          orderBy: 'createdTime', pageSize: 200, pageToken,
        });
        files.push(...(res.data.files || []));
        pageToken = res.data.nextPageToken;
      } while (pageToken);
      // A corrected HTML export is authoritative over an earlier headerless copy.
      files.sort((a, b) => Number(b.mimeType === 'text/html') - Number(a.mimeType === 'text/html'));
      for (const f of files) {
        counts.files += 1;
        if (crm().prepare("SELECT 1 FROM sources WHERE origin = 'outlook' AND raw_ref = ?").get(f.id)) {
          counts.duplicate += 1;
        } else {
          const res = await client.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'text' });
          const parsed = parseOutlookFile(String(res.data || ''), { sent: folder.sent, title: f.name });
          if (!parsed) throw new Error(`Cannot read Outlook ${folder.sent ? 'Sent' : 'Inbox'} file ${f.id}; capture will retry`);
          const r = admitOutlookEmail(parsed, { fileId: f.id, fileCreatedAt: Math.floor(Date.parse(f.createdTime) / 1000) });
          if (r.skipped) counts[r.skipped] += 1;
          else if (r.created) counts.admitted += 1;
          else counts.duplicate += 1;
        }
        if (f.createdTime > newest) newest = f.createdTime;
      }
      db.setSetting(folder.key, newest);
      const last = db.setting('outlook_last_file_at') || '';
      if (newest > last) db.setSetting('outlook_last_file_at', newest);
    }
    return counts;
  });
}

module.exports = { parseOutlookFile, admitOutlookEmail, runOutlookCapture };
