'use strict';

// Reports and documents: a file becomes text with a readability verdict, then
// goes through the one door like any other source. Only the text is kept.

const { createHash } = require('crypto');
const path = require('path');
const { admitSource, sourceByExternal } = require('./sources');
const { crm } = require('./db');
const { htmlToText } = require('./text');

// The reader takes about 24,000 characters at a time, so a long report is read in parts.
const PART = 20000;
const MIN_TEXT = 40;

async function toText(buffer, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  let text;
  if (ext === '.pdf') {
    const { extractText } = await import('unpdf');
    text = (await extractText(new Uint8Array(buffer), { mergePages: false })).text.join('\n\n');
  } else if (ext === '.docx') {
    text = (await require('mammoth').extractRawText({ buffer })).value;
  } else if (['.xlsx', '.xls'].includes(ext)) {
    const XLSX = require('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    text = book.SheetNames.map(n => `${n}\n${XLSX.utils.sheet_to_csv(book.Sheets[n])}`).join('\n\n');
  } else if (['.html', '.htm'].includes(ext)) {
    text = htmlToText(buffer.toString('utf8'));
  } else if (['.txt', '.md', '.csv', '.vtt', '.srt', '.transcript'].includes(ext)) {
    if (buffer.includes(0)) return { text: '', readable: false, reason: 'This is not a text file' };
    text = buffer.toString('utf8');
  } else {
    return { text: '', readable: false, reason: `The Hub can't read ${ext || 'this kind of'} files yet` };
  }
  text = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s+/g, '').length < MIN_TEXT) {
    return { text, readable: false, reason: ext === '.pdf' ? 'No text in this PDF (it is probably a scan)' : 'Almost no text in this file' };
  }
  return { text, readable: true, reason: '' };
}

function split(text) {
  const out = [];
  let rest = text;
  while (rest.length > PART) {
    const cut = Math.max(rest.lastIndexOf('\n\n', PART), rest.lastIndexOf('\n', PART), rest.lastIndexOf('. ', PART) + 1);
    const at = cut > PART / 2 ? cut : PART;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function admitFile({ space, buffer, name, origin = 'upload', externalId = null, occurredAt = null, participants = [], direction = null, kind = 'report', isHistory = null }) {
  const key = externalId || `${space}:${createHash('sha256').update(buffer).digest('hex')}`;
  let verdict;
  try { verdict = await toText(buffer, name); }
  catch (err) { verdict = { text: '', readable: false, reason: `Couldn't open the file: ${String(err.message).slice(0, 200)}` }; }
  const title = String(name || 'Untitled document').slice(0, 300);
  const base = { space, kind, origin, occurredAt, participants, direction, isHistory };
  if (!verdict.readable) {
    const s = admitSource({ ...base, externalId: key, title, text: verdict.text, readable: false, unreadableReason: verdict.reason });
    return { sources: [s.source], created: s.created, readable: false, reason: verdict.reason, unread: 0 };
  }
  // A copy refused earlier (say, before its file type was readable) must not answer
  // "already here" for a readable one: it is retired, keeping it as evidence.
  for (const k of [key, `${key}:1`]) {
    const old = sourceByExternal(origin, k);
    if (old && !old.readable) crm().prepare("UPDATE sources SET atomise_status = 'ignored', external_id = ? WHERE id = ? AND readable = 0").run(`${k}:unreadable:${old.id}`, old.id);
  }
  const parts = split(verdict.text);
  const sources = [];
  let created = false;
  parts.forEach((text, i) => {
    const s = admitSource({ ...base, externalId: parts.length > 1 ? `${key}:${i + 1}` : key,
      title: parts.length > 1 ? `${title} (part ${i + 1} of ${parts.length})` : title, text, fresh: text });
    sources.push(s.source);
    created = created || s.created;
  });
  return { sources, created, readable: true, reason: '', unread: 0 };
}

module.exports = { toText, split, admitFile, PART };
