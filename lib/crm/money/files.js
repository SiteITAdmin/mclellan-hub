'use strict';
// PDF statements and CSV exports, cut into parts the reader takes one at a time: a PDF
// page by page, a CSV in runs of lines under its header row. The reader then copies the
// rows out exactly as it does from a screenshot.

const { PDFDocument } = require('pdf-lib');

const MAX_PDF_PAGES = 30;
const MAX_PAGE_TEXT = 12000;
const CSV_LINES_PER_PART = 80;
const CSV_CHARS_PER_PART = 12000;
const MAX_CSV_LINES = 5000;

const said = message => Object.assign(new Error(message), { polite: true });

function isPdf(buffer) { return buffer.subarray(0, 5).equals(Buffer.from('%PDF-')); }

// The page's words placed where they sit, so a figure under "Paid out" is still under it: plain
// extracted text loses the columns, and with them which way the money went.
function layout(items) {
  const parts = items.filter(i => i && typeof i.str === 'string' && i.str.trim() && Array.isArray(i.transform))
    .map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.transform[3]) || i.height || 10 }));
  if (!parts.length) return '';
  const widths = parts.filter(p => p.w > 0 && p.s.length > 1).map(p => p.w / p.s.length).sort((a, b) => a - b);
  const cw = Math.max(1, widths.length ? widths[Math.floor(widths.length / 2)] : 5);
  const minX = Math.min(...parts.map(p => p.x));
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of parts) {
    const last = lines.at(-1);
    if (last && Math.abs(last.y - p.y) <= Math.min(last.h, p.h) * 0.5) last.items.push(p);
    else lines.push({ y: p.y, h: p.h, items: [p] });
  }
  return lines.map(l => {
    let out = '';
    for (const p of l.items.sort((a, b) => a.x - b.x)) {
      const col = Math.min(220, Math.round((p.x - minX) / cw));
      out += ' '.repeat(Math.max(out && !out.endsWith(' ') ? 1 : 0, col - out.length));
      out += p.s;
    }
    return out.trimEnd();
  }).join('\n').replace(/\n{3,}/g, '\n\n');
}

// One part per page: the page itself as a one-page PDF, and its text. An encrypted statement
// that opens without a password can still be read but not split, so its pages go as text only.
async function pdfPages(buffer) {
  const { getDocumentProxy } = await import('unpdf');
  let doc;
  try { doc = await getDocumentProxy(new Uint8Array(buffer)); }
  catch (err) {
    throw said(/password/i.test(`${err?.name} ${err?.message}`) ? 'is password-protected. Save a copy without the password, or take screenshots of it.' : 'could not be opened as a PDF.');
  }
  try {
    const n = doc.numPages;
    if (!n) throw said('has no pages.');
    if (n > MAX_PDF_PAGES) throw said(`has ${n} pages; the most one upload can take is ${MAX_PDF_PAGES}. Save the pages with transactions as a shorter PDF.`);
    let src = null;
    try { src = await PDFDocument.load(buffer, { updateMetadata: false }); } catch (_) { src = null; }
    if (src && src.getPageCount() !== n) src = null;
    const pages = [];
    for (let i = 0; i < n; i++) {
      let bytes = null, text = '';
      if (src) {
        const one = await PDFDocument.create({ updateMetadata: false });
        const [page] = await one.copyPages(src, [i]); one.addPage(page);
        bytes = Buffer.from(await one.save());
      }
      try { text = layout((await (await doc.getPage(i + 1)).getTextContent()).items); } catch (_) { text = ''; }
      pages.push({ no: i + 1, bytes, text: text.slice(0, MAX_PAGE_TEXT) });
    }
    return pages;
  } finally {
    try { await doc.destroy(); } catch (_) { /* nothing held */ }
  }
}

function decodeText(buffer) {
  if (buffer.subarray(0, 8192).includes(0)) return null;
  let s = buffer.toString('utf8');
  if (s.includes('�')) s = buffer.toString('latin1');
  return s.replace(/^﻿/, '');
}

// Records, not fields: a quoted field may hold a line break, so lines are cut only outside quotes.
function csvRecords(text) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (cur.trim()) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Null when the file is not delimited text at all. The header is the first line that names a
// date column; a bank's preamble above it (account name, period) is left out.
function csvParts(buffer) {
  const text = decodeText(buffer);
  if (text == null) return null;
  const records = csvRecords(text);
  if (records.length < 2 || !records.slice(0, 15).some(r => /[,;\t]/.test(r))) return null;
  const h = Math.max(0, records.slice(0, 15).findIndex(r => /date|datum|fecha/i.test(r) && /[,;\t]/.test(r)));
  const header = records[h].slice(0, 1000), body = records.slice(h + 1);
  if (!body.length) throw said('has a header row but no lines under it.');
  if (body.length > MAX_CSV_LINES) throw said(`has ${body.length} lines; the most one upload can take is ${MAX_CSV_LINES}. Export a shorter period.`);
  const parts = [];
  let cur = [], chars = 0, first = 1;
  body.forEach((r, i) => {
    const line = r.slice(0, 1000);
    if (cur.length && (cur.length >= CSV_LINES_PER_PART || chars + line.length > CSV_CHARS_PER_PART)) {
      parts.push({ from: first, to: i, lines: cur });
      cur = []; chars = 0; first = i + 1;
    }
    cur.push(line); chars += line.length + 1;
  });
  parts.push({ from: first, to: body.length, lines: cur });
  return { total: body.length, parts: parts.map(p => ({ from: p.from, to: p.to, text: [header, ...p.lines].join('\n') })) };
}

// Every amount a file's text holds, as positive cents. A CSV is split into its fields (a comma there
// is a column break, not a thousands mark); a PDF page's text into words. Each token is read every way
// banks write money (1234.56, 1,234.56, 1.234,56, 4.5, -42.10, €42.10, 42.10DR, (42.10)).
function amountsIn(text, { csv = false } = {}) {
  const out = new Set();
  const tokens = csv ? csvFields(String(text || '')) : String(text || '').split(/\s+/);
  for (const raw of tokens) {
    const t = raw.trim().replace(/^"|"$/g, '').replace(/^\(|\)$/g, '').replace(/^[+-]|[+-]$/g, '').replace(/^(€|eur)\s?|\s?(€|eur|cr|dr)$/gi, '').replace(/^[+-]/, '');
    const readings = [];
    if (/^\d+$/.test(t)) readings.push(t);
    if (/^\d+\.\d{1,2}$/.test(t)) readings.push(t);
    if (/^\d+,\d{1,2}$/.test(t)) readings.push(t.replace(',', '.'));
    if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) readings.push(t.replace(/,/g, ''));
    if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) readings.push(t.replace(/\./g, '').replace(',', '.'));
    for (const r of readings) { const n = Number(r); if (Number.isFinite(n) && n < 1e8) out.add(Math.round(n * 100)); }
  }
  return out;
}

function csvFields(text) {
  const lines = text.split('\n');
  const head = lines[0] || '';
  const delimiter = [',', ';', '\t'].map(d => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const fields = [];
  for (const l of lines) {
    let cur = '', quoted = false;
    for (const c of l) {
      if (c === '"') quoted = !quoted;
      else if (c === delimiter && !quoted) { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
  }
  return fields;
}

function amountIn(text, cents, opts) { return amountsIn(text, opts).has(Math.abs(Math.round(cents))); }

const hasAmounts = text => /\d[.,]\d{2}(?!\d)/.test(String(text || ''));

module.exports = { MAX_PDF_PAGES, MAX_CSV_LINES, CSV_LINES_PER_PART, isPdf, layout, pdfPages, decodeText, csvRecords, csvParts, amountsIn, amountIn, hasAmounts };
