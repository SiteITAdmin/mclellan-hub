'use strict';

// Personal email from douglas@mclellan.scot. Everything from Gmail is
// Personal. Sent mail is always kept (it is Douglas's own words) and its
// unknown recipients are proposed for review. Received mail is kept only from
// people Douglas knows or has waiting in review; newsletters and strangers
// are never stored.

const { now, setting, setSetting } = require('./db');
const { admitSource, openProposal } = require('./sources');
const { htmlToText, parseAddressList, normEmail } = require('./text');
const identity = require('./identity');
const config = require('./config');
const runs = require('./runs');

function headerMap(payload) {
  return Object.fromEntries((payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
}

function decode(data) {
  return Buffer.from(String(data || ''), 'base64url').toString('utf8');
}

function bodyText(payload) {
  const html = [];
  const plain = [];
  const walk = part => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    if ((type === 'text/html' || type === 'text/plain') && part.body?.data) {
      (type === 'text/html' ? html : plain).push(decode(part.body.data));
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  if (plain.length) return plain.join('\n').trim();
  return htmlToText(html.join('\n'));
}

async function listIds(gmail, q, cap = 500) {
  const ids = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    ids.push(...(res.data.messages || []).map(m => m.id));
    pageToken = res.data.nextPageToken;
  } while (pageToken && ids.length < cap);
  return ids.slice(0, cap);
}

function participantsFrom(h) {
  const from = parseAddressList(h.from)[0];
  return [
    ...(from ? [{ role: 'from', ...from }] : []),
    ...parseAddressList(h.to).map(p => ({ role: 'to', ...p })),
    ...parseAddressList(h.cc).map(p => ({ role: 'cc', ...p })),
  ];
}

// Decide from headers alone whether a message is worth fetching in full.
function classify(meta) {
  const h = headerMap(meta.payload);
  const labels = meta.labelIds || [];
  const sent = labels.includes('SENT');
  const from = normEmail(h.from);
  if (sent) {
    // Mail from Douglas to only himself is the Hub's own reports, not a conversation.
    const others = participantsFrom(h).filter(p => p.role !== 'from' && !identity.isSelf(p.email));
    return others.length ? { keep: true, direction: 'out', h } : { keep: false, why: 'to_self' };
  }
  if (!from) return { keep: false, why: 'no_sender' };
  if (identity.isIgnored('email', from)) return { keep: false, why: 'ignored' };
  const person = identity.personForAddress('email', from);
  // Spaces never mix: a Work contact writing to Gmail is not pulled into Personal.
  if (person) return person.space === 'personal' ? { keep: true, direction: 'in', h } : { keep: false, why: 'other_space' };
  if (openProposal('email', from)) return { keep: true, direction: 'in', h };
  return { keep: false, why: 'unknown_sender' };
}

async function captureMessage(gmail, id, { isHistory = null, propose = true } = {}) {
  const meta = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
  const c = classify(meta.data);
  if (!c.keep) return { skipped: c.why };
  const full = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const text = bodyText(full.data.payload);
  const readable = text.replace(/\s+/g, '').length >= 3;
  const internal = Math.floor(Number(full.data.internalDate || 0) / 1000) || now();
  const { created } = admitSource({
    space: 'personal',
    kind: 'email',
    origin: 'gmail',
    externalId: id,
    title: c.h.subject || '(no subject)',
    occurredAt: internal,
    direction: c.direction,
    text,
    rawRef: full.data.threadId || id,
    participants: participantsFrom(c.h),
    readable,
    unreadableReason: readable ? '' : 'No text in the email (images or attachments only)',
    proposeFrom: propose && c.direction === 'out' ? 'to' : 'none',
    holdUnknownSender: c.direction === 'in',
    isHistory,
  });
  return { created };
}

async function runGmailCapture({ gmail = null } = {}) {
  return runs.track('gmail_capture', async () => {
    const client = gmail || require('./google').gmail(config.hubUser);
    const windowStart = now() - config.captureWindowDays * 86400;
    const cursor = Math.max(Number(setting('gmail_cursor') || 0), windowStart);
    const startedAt = now();
    const ids = await listIds(client, `after:${cursor - 3600} -in:chats -in:spam -in:trash`);
    const counts = { seen: ids.length, admitted: 0, duplicate: 0, skipped: 0 };
    for (const id of ids) {
      const r = await captureMessage(client, id);
      if (r.skipped) counts.skipped += 1;
      else if (r.created) counts.admitted += 1;
      else counts.duplicate += 1;
    }
    setSetting('gmail_cursor', startedAt);
    return counts;
  });
}

// One-off: the last three months of sent mail suggest the people Douglas
// actually writes to (twice or more), and that mail is kept as history.
async function runGmailBootstrap({ gmail = null } = {}) {
  if (setting('gmail_bootstrap_done')) return { skipped: 'already done' };
  return runs.track('gmail_bootstrap', async () => {
    const client = gmail || require('./google').gmail(config.hubUser);
    const ids = await listIds(client, `in:sent newer_than:${config.bootstrapDays}d`, 2000);
    const tally = new Map();
    const metas = [];
    for (const id of ids) {
      const meta = await client.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] });
      metas.push({ id, meta: meta.data });
      for (const p of participantsFrom(headerMap(meta.data.payload))) {
        if (p.role === 'from' || identity.isSelf(p.email)) continue;
        const t = tally.get(p.email) || { count: 0, name: p.name };
        t.count += 1;
        if (!t.name && p.name) t.name = p.name;
        tally.set(p.email, t);
      }
    }
    const { proposePerson } = require('./sources');
    let proposed = 0;
    for (const [email, t] of tally) {
      if (t.count < config.bootstrapMinEmails) continue;
      if (identity.identifierRow('email', email)) continue;
      if (proposePerson({ value: email, name: t.name, space: 'personal', reason: `You emailed them ${t.count} times in the last 3 months` })) proposed += 1;
    }
    let stored = 0;
    for (const { id } of metas) {
      const r = await captureMessage(client, id, { isHistory: true, propose: false });
      if (r.created) stored += 1;
    }
    setSetting('gmail_bootstrap_done', String(now()));
    return { sent: ids.length, proposed, stored };
  });
}

module.exports = { runGmailCapture, runGmailBootstrap, classify, bodyText, participantsFrom };
