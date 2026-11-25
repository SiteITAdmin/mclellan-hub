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
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|xml)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Keep quote depth through conversion so replies outside a blockquote stay
  // attributable even when the quoted email has no visible From/Sent header.
  let depth = 0;
  const chunks = s.split(/(<\/?blockquote\b[^>]*>)/i).map(part => {
    if (/^<blockquote\b/i.test(part)) { depth++; return '\n'; }
    if (/^<\/blockquote\b/i.test(part)) { depth = Math.max(0, depth - 1); return '\n'; }
    const body = decodeEntities(part
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:p|div|li|tr|h[1-6]|table|section)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, ''));
    return depth ? body.split('\n').map(line => line.trim() ? '>'.repeat(depth) + ' ' + line : '').join('\n') : body;
  });
  return tidy(chunks.join(''));
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

// Recompute this for stored mail too: older rows can contain the full thread
// in text_fresh. Keep unquoted answers interleaved with > quoted questions.
function emailParts(source) {
  const text = String(source.text || '').replace(BANNER, '').trim();
  const header = /^(?:_{8,}[ \t]*$|From:[^\n]+\n(?:[^\n]*\n){0,6}?(?:Sent|Date):|On .{6,200} wrote:[ \t]*$|Le .{6,200} a écrit[ \t]*:[ \t]*$|[- ]{2,}(?:Original Message|Forwarded message)[- ]*|Begin forwarded message:)/im;
  const first = header.exec(text);
  const outer = (first ? text.slice(0, first.index).trim() : text).split(/^\s*>+\s*On .+ wrote:/im)[0];
  const quoted = first ? text.slice(first.index) : '';
  const unquoted = part => part.split('\n').filter(line => !/^\s*>/.test(line)).join('\n').trim();
  let fresh = unquoted(outer);
  if (quoted) {
    const body = quoted.replace(/^(?:(?:From|To|Cc|Bcc|Date|Sent|Subject|Reply-To):[^\n]*\n|_{8,}[ \t]*\n|On [^\n]+ wrote:[ \t]*\n|[^\n]*(?:forwarded message|original message)[^\n]*\n|[ \t]*\n)+/i, '');
    const immediate = body.split(header)[0].split(/^\s*>+\s*(?:On .+ wrote:|From:\s|[- ]{2,}Original Message|Begin forwarded message:)/im)[0].trim();
    if (/^\s*(?:fw|fwd):/i.test(source.title) || immediate.startsWith('>')) {
      fresh = [fresh, unquoted(immediate)].filter(Boolean).join('\n');
    }
  }
  return { fresh, quoted, authored: /^\s*(?:fw|fwd):/i.test(source.title) ? unquoted(outer) : fresh };
}

function courtesyOnly(text) {
  return /^\s*(?:(?:accepted|thanks|thank you|received|noted|regards|ok)[.,!\s]*)+$/i.test(text);
}

function actionText(source) {
  if (source.kind !== 'email') return source.text_fresh || source.text;
  const authored = emailParts(source).authored;
  if (/^(?:accepted|declined|tentative):/i.test(source.title)) return '';
  return authored.split('\n').filter(line => !courtesyOnly(line)).join('\n').trim();
}

// Quotes are compared on letters and digits only, so apostrophes, dashes and
// spacing never decide whether words are really in a source.
function squashQuote(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\u2019\u2018`\u00b4']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// A quote is real when its words are in the text. Short replies ("Paid.") count
// only as a whole line, so a few common letters cannot match anywhere.
function quoteChecker(text) {
  const hay = squashQuote(text);
  const lines = new Set(String(text || '').split('\n').map(squashQuote).filter(Boolean));
  return quote => {
    const q = squashQuote(quote);
    return q.length >= 6 ? (' ' + hay + ' ').includes(' ' + q + ' ') : q.length >= 3 && lines.has(q);
  };
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
  htmlToText, decodeEntities, tidy, splitFresh, emailParts, actionText, courtesyOnly,
  normEmail, normPhone, normName, squashQuote, quoteChecker, parseAddressList, nameFromEmail, looksAutomated,
};
