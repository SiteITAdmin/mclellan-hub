'use strict';

// Personal email from douglas@mclellan.scot. Everything from Gmail is
// Personal. Sent mail is always kept (it is Douglas's own words) and its
// unknown recipients are proposed for review. Received mail is kept only from
// people Douglas knows or has waiting in review; newsletters and strangers
// are never stored.
//
// The main mailbox (douglas@mclellan.scot) uses the Hub's Google token. Extra
// mailboxes (config.extraGmailAccounts) are connected from the CRM with their
// own read-only token and kept apart by origin, cursor and run name, because
// Gmail message ids are only unique within one mailbox.

const { now, setting, setSetting } = require('./db');
const { admitSource, openProposal } = require('./sources');
const { htmlToText, parseAddressList, normEmail } = require('./text');
const identity = require('./identity');
const config = require('./config');
const runs = require('./runs');
const { isNakaiReport } = require('./cleanup');

const MAIN = { email: 'douglas@mclellan.scot', origin: 'gmail', suffix: '', label: 'Gmail', extra: false };

function extraAccount(email) {
  return { email, origin: `gmail:${email}`, suffix: `:${email}`, label: `Gmail (${email})`, extra: true };
}

function accounts() {
  return [MAIN, ...config.extraGmailAccounts().map(extraAccount)];
}

function accountFor(email) {
  return accounts().find(a => a.email === String(email || '').toLowerCase()) || null;
}

function isGmailOrigin(origin) {
  return origin === 'gmail' || String(origin || '').startsWith('gmail:');
}

function tokenKey(account) { return `google_token${account.suffix}`; }

function storedToken(account) {
  const raw = setting(tokenKey(account));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function isConnected(account) {
  return !account.extra || !!storedToken(account)?.refresh_token;
}

// Fails closed: a token is kept only for the mailbox it was asked for.
function saveToken(account, { profileEmail, tokens }) {
  if (!account?.extra) throw new Error('Only extra mailboxes are connected here');
  if (String(profileEmail || '').toLowerCase() !== account.email) {
    throw new Error(`You signed in as ${profileEmail || 'an unknown account'}, not ${account.email}. Nothing was saved.`);
  }
  const keep = tokens.refresh_token || storedToken(account)?.refresh_token;
  if (!keep) throw new Error('Google did not give the Hub a lasting token. Remove the Hub at myaccount.google.com/permissions for that account, then connect again.');
  setSetting(tokenKey(account), JSON.stringify({ refresh_token: keep, scope: tokens.scope || '', connected_at: now() }));
}

function clientFor(account) {
  if (!account.extra) return require('./google').gmail(config.hubUser);
  const token = storedToken(account);
  if (!token?.refresh_token) throw new Error(`${account.email} is not connected`);
  return require('./google').gmailWithToken(token.refresh_token);
}

function mailLink(source) {
  if (!isGmailOrigin(source.origin)) return '';
  const id = encodeURIComponent(source.external_id);
  if (source.origin === 'gmail') return `https://mail.google.com/mail/u/0/#all/${id}`;
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(source.origin.slice(6))}#all/${id}`;
}

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
    if (!others.length) return { keep: false, why: 'to_self' };
    // The old Hub's reports went only to nakai@mclellan.scot and appear as
    // Douglas's sent mail, though he never wrote them.
    if (isNakaiReport(h.subject, others.map(p => p.email))) return { keep: false, why: 'nakai_report' };
    return { keep: true, direction: 'out', h };
  }
  if (!from) return { keep: false, why: 'no_sender' };
  if (identity.isIgnored('email', from)) return { keep: false, why: 'ignored' };
  const person = identity.personForAddress('email', from);
  // Spaces never mix: a Work contact writing to Gmail is not pulled into Personal.
  if (person) return person.space === 'personal' ? { keep: true, direction: 'in', h } : { keep: false, why: 'other_space' };
  if (openProposal('email', from)) return { keep: true, direction: 'in', h };
  return { keep: false, why: 'unknown_sender' };
}

async function captureMessage(gmail, id, { isHistory = null, propose = true, account = MAIN } = {}) {
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
    origin: account.origin,
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

async function runGmailCapture({ gmail = null, account = MAIN } = {}) {
  return runs.track(`gmail_capture${account.suffix}`, async () => {
    const client = gmail || clientFor(account);
    const cursorKey = `gmail_cursor${account.suffix}`;
    const windowStart = now() - config.captureWindowDays * 86400;
    const cursor = Math.max(Number(setting(cursorKey) || 0), windowStart);
    const startedAt = now();
    const ids = await listIds(client, `after:${cursor - 3600} -in:chats -in:spam -in:trash`);
    const counts = { seen: ids.length, admitted: 0, duplicate: 0, skipped: 0 };
    for (const id of ids) {
      const r = await captureMessage(client, id, { account });
      if (r.skipped) counts.skipped += 1;
      else if (r.created) counts.admitted += 1;
      else counts.duplicate += 1;
    }
    setSetting(cursorKey, startedAt);
    return counts;
  });
}

// Every mailbox in turn. One failing (say, a revoked token) must not stop
// the others; its own run records the error for the Today screen.
async function runAllGmailCapture() {
  let first = null;
  for (const account of accounts()) {
    if (!isConnected(account)) continue;
    await runGmailCapture({ account }).catch(err => { first = first || err; });
  }
  if (first) throw first;
}

// One-off: the last three months of sent mail suggest the people Douglas
// actually writes to (twice or more), and that mail is kept as history.
async function runGmailBootstrap({ gmail = null, account = MAIN } = {}) {
  const doneKey = `gmail_bootstrap_done${account.suffix}`;
  if (setting(doneKey)) return { skipped: 'already done' };
  return runs.track(`gmail_bootstrap${account.suffix}`, async () => {
    const client = gmail || clientFor(account);
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
      const from = account.extra ? ` from ${account.email}` : '';
      if (proposePerson({ value: email, name: t.name, space: 'personal', reason: `You emailed them ${t.count} times in the last 3 months${from}` })) proposed += 1;
    }
    let stored = 0;
    for (const { id } of metas) {
      const r = await captureMessage(client, id, { isHistory: true, propose: false, account });
      if (r.created) stored += 1;
    }
    setSetting(doneKey, String(now()));
    return { sent: ids.length, proposed, stored };
  });
}

function bootstrapPending() {
  return accounts().filter(a => isConnected(a) && !setting(`gmail_bootstrap_done${a.suffix}`));
}

async function runAllGmailBootstraps() {
  let first = null;
  for (const account of bootstrapPending()) {
    await runGmailBootstrap({ account }).catch(err => { first = first || err; });
  }
  if (first) throw first;
}

module.exports = {
  runGmailCapture, runAllGmailCapture, runGmailBootstrap, runAllGmailBootstraps, bootstrapPending,
  accounts, accountFor, extraAccount, isConnected, saveToken, isGmailOrigin, mailLink,
  classify, bodyText, participantsFrom,
};
