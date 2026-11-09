'use strict';

// The forward-to inbox (mclellanhub@agentmail.to): anything Douglas hands the
// Hub on purpose, by forwarding it or copying the address in. Read-only: the
// Hub never changes or sends anything there.
//
// There is one address, so the space comes from which of Douglas's own
// addresses is on the message: a work address makes it Work, otherwise
// Personal. A message that doesn't involve Douglas at all is not stored.

const { now } = require('./db');
const config = require('./config');
const identity = require('./identity');
const runs = require('./runs');
const { admitSource, sourceByExternal } = require('./sources');
const { admitFile } = require('./documents');
const { htmlToText, parseAddressList, normEmail } = require('./text');

const API = 'https://api.agentmail.to/v0';
const DAY = 86400;
const MAX_ATTACHMENT = 20 * 1024 * 1024;

function live(http = fetch) {
  const key = process.env.AGENTMAIL_API_KEY, inbox = process.env.AGENTMAIL_INBOX_ID;
  if (!key || !inbox) throw new Error('The forwarding inbox has no key set (AGENTMAIL_API_KEY, AGENTMAIL_INBOX_ID)');
  const call = async path => {
    const res = await http(`${API}/inboxes/${encodeURIComponent(inbox)}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`AgentMail ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return {
    list: pageToken => call(`/messages?limit=50${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`),
    get: id => call(`/messages/${encodeURIComponent(id)}`),
    attachment: async (id, attachmentId) => {
      const meta = await call(`/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`);
      if (Number(meta.size) > MAX_ATTACHMENT) throw new Error('Attachment exceeds 20 MB');
      const url = new URL(meta.download_url);
      if (url.protocol !== 'https:') throw new Error('Attachment has no HTTPS download URL');
      const res = await http(url.href, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
      const chunks = []; let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_ATTACHMENT) throw new Error('Attachment exceeds 20 MB');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  };
}

const list = v => (Array.isArray(v) ? v : v ? [v] : []).flatMap(x => parseAddressList(x));

function participantsOf(m) {
  const from = list(m.from)[0];
  return [...(from ? [{ role: 'from', ...from }] : []), ...list(m.to).map(p => ({ role: 'to', ...p })), ...list(m.cc).map(p => ({ role: 'cc', ...p }))]
    .filter(p => !p.email.endsWith('@agentmail.to'));
}

function spaceFor(participants) {
  const emails = participants.map(p => normEmail(p.email));
  if (emails.some(e => config.workAddresses().includes(e))) return 'work';
  if (emails.some(e => config.personalAddresses().includes(e))) return 'personal';
  return null;
}

async function captureMessage(api, id, t) {
  const m = await api.get(id);
  const participants = participantsOf(m);
  const space = spaceFor(participants);
  if (!space) return { skipped: 'not_douglas' };
  const sender = participants.find(p => p.role === 'from');
  const mine = !!sender && identity.isSelf(sender.email);
  const text = String(m.text || '').trim() || htmlToText(m.html || '');
  const occurredAt = Math.floor(Date.parse(m.timestamp) / 1000) || t;
  const readable = text.replace(/\s+/g, '').length >= 3;
  const { created } = admitSource({
    space, kind: 'email', origin: 'agentmail', externalId: m.message_id, title: m.subject || '(no subject)', occurredAt,
    direction: mine ? 'out' : 'in', text, rawRef: m.thread_id || '', participants, readable,
    unreadableReason: readable ? '' : 'No text in the email (attachments only)',
    // Mail Douglas forwards himself is read at once. Mail someone else copied
    // the address into is held until Douglas has said who they are.
    proposeFrom: mine ? 'none' : 'from', holdUnknownSender: !mine, proposeReason: 'They copied in your Hub address',
  });
  let files = 0;
  for (const a of m.attachments || []) {
    if (a.inline || a.content_disposition === 'inline') continue;
    const externalId = `${m.message_id}:${a.attachment_id}`;
    if (sourceByExternal('agentmail', externalId) || sourceByExternal('agentmail', `${externalId}:1`)) continue;
    // An attachment is only opened when Douglas sent it or already knows the sender.
    if (!mine && !identity.personForAddress('email', normEmail(sender?.email))) continue;
    if (Number(a.size) > MAX_ATTACHMENT) {
      admitSource({ space, kind: 'report', origin: 'agentmail', externalId, title: a.filename || 'attachment', occurredAt,
        participants, readable: false, unreadableReason: 'Attachment exceeds 20 MB' });
      continue;
    }
    const buffer = await api.attachment(m.message_id, a.attachment_id);
    await admitFile({ space, buffer, name: a.filename || 'attachment', origin: 'agentmail', externalId, occurredAt, participants, direction: mine ? 'out' : 'in' });
    files += 1;
  }
  return { created, files };
}

async function run({ api, t = now() } = {}) {
  return runs.track('agentmail_capture', async () => {
    api ||= live();
    const since = t - config.captureWindowDays * DAY;
    const detail = { seen: 0, captured: 0, files: 0, skipped: 0 };
    let pageToken, done = false, pages = 0;
    do {
      const page = await api.list(pageToken);
      for (const m of page.messages || []) {
        const at = Math.floor(Date.parse(m.timestamp) / 1000);
        // Newest first: once past the window there is nothing further to do.
        if (Number.isFinite(at) && at < since) { done = true; break; }
        if (!(m.labels || []).includes('received') || !Number.isFinite(at) || at > t + 300) continue;
        detail.seen += 1;
        // Revisit attachments after a partial failure or sender approval.
        const r = await captureMessage(api, m.message_id, t);
        if (r.skipped) detail.skipped += 1;
        else { detail.captured += r.created ? 1 : 0; detail.files += r.files; }
      }
      pageToken = page.next_page_token;
      pages += 1;
    } while (pageToken && !done && pages < 10);
    return detail;
  });
}

module.exports = { run, participantsOf, spaceFor, live };
