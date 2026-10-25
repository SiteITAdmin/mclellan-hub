'use strict';

// Text helpers shared by capture, identity and atomisation.

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£' };

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}

function htmlToText(html) {
  let s = String(html || '');
  if (!/<[a-z!/][^>]*>/i.test(s)) return tidy(decodeEntities(s));
  s = s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|xml)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section)>/gi, '\n')
    .replace(/<(p|div|li|tr|h[1-6]|blockquote|table|section)(\s[^>]*)?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(s));
}

function tidy(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Beacon's mail gateway prepends this banner to every outside email.
const BANNER = /^EXTERNAL UNTRUSTED EMAIL:.*$/gim;

// Where the quoted earlier thread starts in a reply. Everything after it was
// already captured (or will be) as its own email, so atoms come from the fresh
// part only.
const QUOTE_MARKERS = [
  /^_{8,}\s*$/m,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^From:\s.+\n(?:.*\n){0,2}?Sent:\s/im,
  /^On .{6,120} wrote:\s*$/im,
  /^Le .{6,120} a écrit\s*:\s*$/im,
];

function splitFresh(text) {
  const clean = String(text || '').replace(BANNER, '').trim();
  let cut = clean.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(clean);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  return { fresh: clean.slice(0, cut).trim(), quoted: clean.slice(cut).trim() };
}

function normEmail(v) {
  const m = String(v || '').match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : '';
}

// Irish and UK numbers written locally become E.164 so the same phone always
// matches itself; anything else keeps its digits with a leading +.
function normPhone(v) {
  let s = String(v || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return s;
  if (s.startsWith('08') && s.length === 10) return `+353${s.slice(1)}`;
  if (s.startsWith('07') && s.length === 11) return `+44${s.slice(1)}`;
  return `+${s}`;
}

// "Ciarán Doyle" and "ciaran doyle" are the same written name: accents and
// case are dropped, nothing else. This is not fuzzy matching; Alec never
// becomes Alan.
function normName(v) {
  return String(v || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Alec Byrne <alec@x.ie>; bob@y.com" → [{ name, email }]
function parseAddressList(s) {
  const out = [];
  for (const part of String(s || '').split(/[;,](?![^<]*>)/)) {
    const email = normEmail(part);
    if (!email) continue;
    const name = part.replace(/<[^>]*>/, '').replace(/["']/g, '').replace(email, '').trim();
    out.push({ email, name: name && !name.includes('@') ? name : '' });
  }
  return out;
}

// Display name from "First.Last@domain" when the header carries no name.
function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  if (!/[._]/.test(local)) return '';
  return local.split(/[._]/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|mailer-daemon|postmaster|bounce|news(letter)?|info|support|phishalert|calendar|digest)([+._-].*)?@/i;

function looksAutomated(email) {
  return AUTOMATED.test(String(email || ''));
}

module.exports = {
  htmlToText, decodeEntities, tidy, splitFresh,
  normEmail, normPhone, normName, parseAddressList, nameFromEmail, looksAutomated,
};
