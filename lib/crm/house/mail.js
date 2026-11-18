'use strict';

const { crm, now, setting, setSetting } = require('../db');
const { bodyText, clientFor, accountFor } = require('../gmail');
const config = require('../config');
const { personForAddress } = require('../identity');
const { decodeEntities, htmlToText, parseAddressList, splitFresh } = require('../text');

const MAILBOX = 'douglas@mclellan.scot';
const DAY = 86400;
const FIRST_WINDOW = 30 * DAY;
const FOLLOWUP_WINDOW = 7 * DAY;
const THREAD_WINDOW = 45 * DAY;
const OVERLAP = 60 * 60;
const INTERVAL = 15 * 60;
const COOLDOWN = 5 * 60;
const PAGE_SIZE = 50;
const RECENT_PAGES = 3;
const REQUEST_OPTIONS = { timeout: 15000 };
const BLOCKED_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'CHAT']);
const STATE = 'house_mail_scan';
const REQUEST = 'house_mail_scan_requested';
const CURSOR = 'house_mail_cursor';
const PAGE = 'house_mail_scan_page';
const PROPERTY_TERMS = [
  'from:daft.ie', 'to:daft.ie', '"daft.ie/for-sale"', 'subject:mortgage', 'subject:conveyancing',
  '"approval in principle"', '"mortgage application"', '"mortgage approval"', '"mortgage valuation"',
  '"mortgage broker"', '"mortgage drawdown"', '"loan offer"', '"loan drawdown"', '"sale agreed"',
  '"open viewing"', '"viewing appointment"', '"viewing confirmation"', '"viewing confirmed"', '"book a viewing"',
  '(subject:viewing {property house apartment estate eircode appointment})',
  '"property viewing"', '"arrange a viewing"', '"viewing the property"', '"house viewing"',
  '"offer on the property"', '"offer on the house"', '"bid on the property"', '"booking deposit"',
  '(subject:offer {property bid asking})', '"closing of the sale"', '"solicitor for the purchase"',
  '"contract for sale"', '"contracts for sale"', '"property purchase"', '"purchase of the property"', '"building survey"',
];

function readState(key, fallback) {
  try { return JSON.parse(setting(key)) ?? fallback; } catch { return fallback; }
}

function status() {
  return {
    at: 0, lastSuccessAt: 0, listed: 0, captured: 0, failed: 0, unreadable: 0, deferred: 0, more: false, error: '',
    ...readState(STATE, {}),
    requestedAt: Number(setting(REQUEST)) || 0,
  };
}

function requestScan(t = now()) {
  if (!Number(setting(REQUEST))) setSetting(REQUEST, t);
}

function canonicalDaftUrl(value) {
  try {
    const url = new URL(decodeEntities(value).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
        !['daft.ie', 'www.daft.ie'].includes(url.hostname)) return '';
    const path = url.pathname.replace(/\/+$/, '');
    return /^\/for-sale\/(?:[a-z0-9-]+\/){0,2}\d+$/i.test(path) ? `https://www.daft.ie${path}` : '';
  } catch { return ''; }
}

function daftHref(href) {
  const direct = canonicalDaftUrl(href);
  if (direct) return direct;
  try {
    const wrapper = new URL(decodeEntities(href));
    if (!['https:', 'http:'].includes(wrapper.protocol)) return '';
    for (const name of ['url', 'u', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'link', 'to']) {
      const target = canonicalDaftUrl(wrapper.searchParams.get(name));
      if (target) return target;
    }
  } catch {}
  return '';
}

function inlineParts(part) {
  if (!part || part.filename || (part.headers || []).some(h => h.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(h.value))) return null;
  return { ...part, parts: (part.parts || []).map(inlineParts).filter(Boolean) };
}

function listingLinks(text, part) {
  const links = new Map();
  const remember = (href, label = '') => {
    const url = daftHref(href);
    if (!url) return;
    const id = url.split('/').at(-1);
    const old = links.get(id);
    if (!old || (!old.label && label)) links.set(id, { url, label });
  };
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) remember(match[0].replace(/[),.;!?]+$/, ''));
  const walk = node => {
    if (node?.mimeType?.toLowerCase() === 'text/html' && node.body?.data) {
      const html = Buffer.from(node.body.data, 'base64url').toString('utf8');
      for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = anchor[1].match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        if (!href) continue;
        remember(href[1] ?? href[2] ?? href[3], htmlToText(anchor[2]).replace(/\s+/g, ' ').slice(0, 240));
      }
    }
    for (const child of node?.parts || []) walk(child);
  };
  walk(part);
  return [...links.values()];
}

function messageEvidence(message, t) {
  const labels = message.labelIds || [];
  if (labels.some(label => BLOCKED_LABELS.has(label))) return null;
  const headers = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
  const participants = [headers.from, headers.to, headers.cc].flatMap(parseAddressList);
  if (participants.some(({ email }) => config.workAddresses().includes(email) || personForAddress('email', email)?.space === 'work')) return null;

  const payload = inlineParts(message.payload);
  const fullText = bodyText(payload);
  const text = splitFresh(fullText).fresh;
  const links = listingLinks(fullText, payload);
  const linkEvidence = links.filter(link => link.label && !text.includes(link.url)).map(link => `${link.label} — ${link.url}`).join('\n');
  return {
    subject: String(headers.subject || '(no subject)').slice(0, 400),
    sender: String(headers.from || '').slice(0, 400),
    recipients: [headers.to, headers.cc].filter(Boolean).join(', ').slice(0, 800),
    direction: labels.includes('SENT') ? 'sent' : 'received',
    at: Math.floor(Number(message.internalDate) / 1000) || t,
    body: [text.slice(0, 20000), linkEvidence.slice(0, 5000)].filter(Boolean).join('\n\n') || null,
    links: links.map(x => x.url),
    readable: Boolean(text || links.length),
  };
}

function dateQuery(since, until) {
  return `after:${since} before:${until + 1} -in:chats -in:spam -in:trash -in:drafts`;
}

async function listPage(gmail, q, maxResults, pageToken) {
  const { data } = await gmail.users.messages.list({ userId: 'me', q, maxResults, pageToken }, REQUEST_OPTIONS);
  return { messages: data.messages || [], next: data.nextPageToken || '' };
}

async function recentReplies(gmail, knownThreads, since, until) {
  const replies = [];
  if (!knownThreads.size) return { replies, limited: false };
  let next;
  for (let i = 0; i < RECENT_PAGES; i += 1) {
    const page = await listPage(gmail, dateQuery(since, until), 100, next);
    replies.push(...page.messages.filter(message => knownThreads.has(message.threadId)));
    next = page.next;
    if (!next) break;
  }
  return { replies, limited: Boolean(next) };
}

function errorCode(error) {
  return Number(error.response?.status || error.status || error.code);
}

function scanError(error) {
  if (errorCode(error) === 401 || errorCode(error) === 403 || /invalid_grant|missing.+token|no.+token/i.test(error.message)) return 'Gmail access failed. Check the Hub’s Google connection.';
  if (errorCode(error) === 429) return 'Gmail limited requests. The Hub will retry.';
  return 'The Gmail scan could not finish. The Hub will retry.';
}

function trackedTerms() {
  const properties = crm().prepare(`SELECT title, address FROM house_properties WHERE status NOT IN ('passed','closed')
    ORDER BY updated_at DESC LIMIT 16`).all();
  const terms = new Set();
  for (const { title, address } of properties) {
    const name = (address || title).split(',')[0].normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (name.length >= 8 && name.includes(' ')) terms.add(`subject:"${name}"`);
    const eircode = address.match(/\b(?:D6W|[A-Z]\d{2})\s?[A-Z0-9]{4}\b/i);
    if (eircode) terms.add(`"${eircode[0]}"`);
  }
  return [...terms];
}

function pageFor(t) {
  const cursor = Number(setting(CURSOR));
  const pending = readState(PAGE, null);
  if (pending?.until >= t - FOLLOWUP_WINDOW && pending.until <= t) return pending;
  return {
    since: Math.floor(cursor ? Math.max(cursor - OVERLAP, t - FOLLOWUP_WINDOW) : t - FIRST_WINDOW),
    until: t,
    token: '',
    skipped: [],
    terms: trackedTerms(),
  };
}

async function capture(gmail, message, t) {
  let full;
  try {
    const response = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' }, REQUEST_OPTIONS);
    full = response.data;
  } catch (error) {
    if (errorCode(error) === 404) return 'skipped';
    return 'failed';
  }
  const evidence = messageEvidence(full, t);
  if (!evidence) return 'skipped';
  crm().prepare(`INSERT OR IGNORE INTO house_mail
    (gmail_id, thread_id, subject, sender, recipients, occurred_at, body, links, status, direction, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    message.id, full.threadId || message.threadId || '', evidence.subject, evidence.sender, evidence.recipients,
    evidence.at, evidence.body, JSON.stringify(evidence.links), evidence.readable ? 'waiting' : 'unreadable', evidence.direction, t
  );
  return evidence.readable ? 'captured' : 'unreadable';
}

async function runScan({ gmail, t }) {
  const previous = status();
  const receipt = { at: t, lastSuccessAt: previous.lastSuccessAt, listed: 0, captured: 0, failed: 0, unreadable: 0, deferred: 0, more: false, error: '' };
  setSetting(REQUEST, 0);
  setSetting(STATE, JSON.stringify(receipt));
  let page;
  try {
    page = pageFor(t);
    const client = gmail || clientFor(accountFor(MAILBOX));
    const terms = [...PROPERTY_TERMS, ...(page.terms || [])];
    const target = await listPage(client, `${dateQuery(page.since, page.until)} {${terms.join(' ')}}`, PAGE_SIZE, page.token || undefined);
    const threads = crm().prepare(`SELECT DISTINCT m.thread_id FROM house_mail m JOIN house_events e ON e.gmail_id = m.gmail_id
      WHERE m.thread_id != '' AND m.occurred_at >= ? AND e.state IN ('suggested','confirmed')`).all(t - THREAD_WINDOW);
    const knownThreads = new Set(threads.map(row => row.thread_id));
    const recent = await recentReplies(client, knownThreads, Math.max(page.since, page.until - 2 * DAY), page.until);
    const candidates = new Map([...target.messages, ...recent.replies].map(message => [message.id, message]));
    const held = crm().prepare('SELECT 1 FROM house_mail WHERE gmail_id = ?');
    const skipped = new Set(page.skipped);
    const fresh = [...candidates.values()].filter(message => message.id && !skipped.has(message.id) && !held.get(message.id));
    receipt.listed = candidates.size;
    receipt.deferred = Math.max(fresh.length - PAGE_SIZE, 0);
    receipt.more = Boolean(target.next);
    const picked = fresh.slice(0, PAGE_SIZE);
    for (let i = 0; i < picked.length; i += 8) {
      const batch = picked.slice(i, i + 8);
      const results = await Promise.all(batch.map(message => capture(client, message, t)));
      results.forEach((result, index) => {
        if (result === 'skipped') skipped.add(batch[index].id);
        if (result === 'failed') receipt.failed += 1;
        if (result === 'unreadable') receipt.unreadable += 1;
        if (result === 'captured' || result === 'unreadable') receipt.captured += 1;
      });
    }

    if (receipt.failed) receipt.error = 'Some messages could not be fetched. The Hub will retry.';
    else if (recent.limited) receipt.error = 'The recent reply search hit its limit. Some replies may be missing.';
    if (receipt.failed || receipt.deferred) setSetting(PAGE, JSON.stringify({ ...page, skipped: [...skipped] }));
    else if (target.next) setSetting(PAGE, JSON.stringify({ ...page, token: target.next, skipped: [...skipped] }));
    else {
      setSetting(PAGE, '');
      setSetting(CURSOR, page.until);
      receipt.lastSuccessAt = t;
    }
    return receipt;
  } catch (error) {
    if (page?.token && errorCode(error) === 400) setSetting(PAGE, '');
    receipt.error = scanError(error);
    throw new Error(receipt.error);
  } finally {
    setSetting(STATE, JSON.stringify(receipt));
  }
}

let inFlight;

function scan({ gmail = null, t = now() } = {}) {
  if (!inFlight) inFlight = runScan({ gmail, t }).finally(() => { inFlight = null; });
  return inFlight;
}

async function tickScan({ gmail = null, t = now() } = {}) {
  const last = status();
  const soon = last.requestedAt || last.deferred || last.more;
  if (last.at && t - last.at < (soon ? COOLDOWN : INTERVAL)) return null;
  return scan({ gmail, t });
}

module.exports = { scan, status, tickScan, requestScan, canonicalDaftUrl };
