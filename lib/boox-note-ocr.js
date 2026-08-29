'use strict';

// Handwritten note recognition — the hub half of the Boox loop.
//
// Input contract: raw store = the page files already in the vault's boox-notes
// inbox (Drive ingest or the app's note door); synthesis = Apple Vision text
// recognition here, plus Douglas's correction on /crm/questions; compiled layer
// = the .ocr.json sidecar beside each page; visible surface = the note
// transcription questions.
//
// Why Vision and not a model: the subscription CLI plane cannot carry an image
// (the CLIs take a prompt string with tools disabled), so no hosted vision model
// is reachable without unpicking those guardrails. Vision runs locally on the
// Mac mini, costs nothing and never sends the page anywhere.
//
// Vision is reliable on print, lists and numbers and unreliable on cursive
// prose, so this module NEVER treats its output as knowledge. Every page is
// surfaced for human correction; `lowConfidenceLines` is the honest signal for
// how much to doubt a page (the mean is misleading — a page of numbers scores
// ~1.0 while the prose on it scores ~0.5).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LOW_CONFIDENCE = 0.8;
// The Hub's own nightly planner PDFs reach the same folder the tablet syncs, and
// older copies are already sitting in the vault from before the ingest learned to
// skip them. They are generated output, not handwriting: recognising one wastes a
// pass on ~300 lines of our own UI text and would raise a nonsense question.
const PLANNER_NAME_PREFIX = String(process.env.BOOX_PLANNER_NAME_PREFIX || 'Hub Planner').trim();
const DEFAULT_MAX_PAGES = 12; // bound the cost of a fat notebook
const SUPPORTED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.webp']);

function vaultRoot() {
  return process.env.BOOX_DRIVE_VAULT_ROOT
    || process.env.WORKDAY_SYNC_LOCAL_DIR
    || path.join(__dirname, '..', 'data', 'synthadoc', 'mclellan-hub-knowledge');
}

function notesDir() {
  return path.join(vaultRoot(), 'raw_sources', 'boox-notes');
}

function isHubGeneratedPlanner(name) {
  if (!PLANNER_NAME_PREFIX) return false;
  const base = String(name || '');
  // Drive ingest prefixes the file id, so match the prefix anywhere in the name.
  return base.toLowerCase().includes(PLANNER_NAME_PREFIX.toLowerCase());
}

function isMac() {
  return process.platform === 'darwin';
}

/** Compile the Vision helper once and cache the binary next to the source. */
function recogniserBinary() {
  const src = path.join(__dirname, '..', 'scripts', 'native', 'ocr-page.swift');
  const bin = path.join(os.tmpdir(), 'hub-ocr-page');
  const fresh = fs.existsSync(bin)
    && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;
  if (!fresh) execFileSync('swiftc', ['-O', '-o', bin, src], { stdio: 'pipe' });
  return bin;
}

/** Identity of the bytes we read, so an unchanged page is never re-recognised. */
function fileRevision(file) {
  const stat = fs.statSync(file);
  return crypto.createHash('sha1')
    .update(`${path.basename(file)}|${stat.size}|${Math.round(stat.mtimeMs)}`)
    .digest('hex').slice(0, 16);
}

function sidecarPath(file) {
  return `${file}.ocr.json`;
}

function readSidecar(file) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Rasterise the page(s) to PNG. Images pass through untouched. */
function rasterise(file, maxPages) {
  if (path.extname(file).toLowerCase() !== '.pdf') return [file];
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ocr-'));
  execFileSync('pdftoppm', [
    '-png', '-r', '150', '-f', '1', '-l', String(maxPages),
    file, path.join(outDir, 'page'),
  ], { stdio: 'pipe' });
  return fs.readdirSync(outDir).filter(n => n.endsWith('.png')).sort()
    .map(n => path.join(outDir, n));
}

function recognise(bin, image) {
  const raw = execFileSync(bin, [image], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.lines) ? parsed.lines : [];
}

/**
 * Recognise one page file. Returns the sidecar record. Throws on a genuine
 * failure — an unreadable page is a visible ingest failure belonging to this
 * module, not a silently empty transcription.
 */
function transcribeFile(file, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (!isMac()) throw new Error('boox-note-ocr requires macOS (Vision framework)');
  const bin = recogniserBinary();
  const images = rasterise(file, maxPages);
  if (!images.length) throw new Error(`no pages rasterised from ${path.basename(file)}`);

  const pages = images.map((image, index) => {
    const lines = recognise(bin, image);
    return {
      page: index + 1,
      text: lines.map(l => l.text).join('\n'),
      lineCount: lines.length,
      lowConfidenceLines: lines.filter(l => l.confidence < LOW_CONFIDENCE).length,
      // Keep the doubtful lines so review can point at what to check, without
      // storing the whole confidence array for a clean page.
      doubtful: lines.filter(l => l.confidence < LOW_CONFIDENCE).map(l => l.text).slice(0, 40),
    };
  });

  const allLines = pages.reduce((n, p) => n + p.lineCount, 0);
  const lowLines = pages.reduce((n, p) => n + p.lowConfidenceLines, 0);
  const record = {
    file: path.relative(vaultRoot(), file),
    name: path.basename(file),
    revision: fileRevision(file),
    recognisedAt: new Date().toISOString(),
    engine: 'apple-vision',
    pageCount: pages.length,
    truncated: path.extname(file).toLowerCase() === '.pdf' && pages.length >= maxPages,
    lineCount: allLines,
    lowConfidenceLines: lowLines,
    // The share of lines Vision itself doubted — the honest readability signal.
    doubtRatio: allLines ? Number((lowLines / allLines).toFixed(3)) : 1,
    text: pages.map(p => p.text).filter(Boolean).join('\n\n'),
    pages,
  };
  fs.writeFileSync(sidecarPath(file), JSON.stringify(record, null, 2));
  return record;
}

/** Page files in the notes inbox that still need recognising for their revision. */
function pendingFiles({ limit = 0 } = {}) {
  const dir = notesDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!SUPPORTED.has(path.extname(entry.name).toLowerCase())) continue;
      if (isHubGeneratedPlanner(entry.name)) continue;
      const existing = readSidecar(full);
      if (existing && existing.revision === fileRevision(full)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return limit > 0 ? out.slice(0, limit) : out;
}

/** Recognise everything outstanding. Never throws for one bad page. */
function transcribePending({ limit = 0, maxPages = DEFAULT_MAX_PAGES } = {}) {
  const files = pendingFiles({ limit });
  const done = [];
  const failed = [];
  for (const file of files) {
    try {
      done.push(transcribeFile(file, { maxPages }));
    } catch (err) {
      failed.push({ file: path.relative(vaultRoot(), file), error: err.message });
    }
  }
  return { recognised: done.length, failed, files: done };
}

/**
 * Save Douglas's corrected reading of a page. The correction belongs to the page
 * itself, not to a one-sentence knowledge statement: a page of notes compressed
 * into a sentence would lose most of what he wrote. Stored beside the raw file so
 * the fix travels with the document and survives a re-sync, and so a corrected
 * page is never asked about again while its bytes are unchanged.
 */
function saveCorrection(relFile, correctedText) {
  const full = path.resolve(vaultRoot(), relFile);
  const root = notesDir();
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('file is outside the notes inbox');
  const record = readSidecar(full);
  if (!record) throw new Error('no transcription for that page');
  record.correctedText = String(correctedText || '').trim();
  record.correctedAt = new Date().toISOString();
  fs.writeFileSync(sidecarPath(full), JSON.stringify(record, null, 2));
  return record;
}

/** Every transcription the vault holds, newest first. */
function listTranscriptions({ limit = 0 } = {}) {
  const dir = notesDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ocr.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch (_) { /* skip */ }
    }
  };
  walk(dir);
  out.sort((a, b) => String(b.recognisedAt || '').localeCompare(String(a.recognisedAt || '')));
  return limit > 0 ? out.slice(0, limit) : out;
}

module.exports = {
  LOW_CONFIDENCE,
  isHubGeneratedPlanner,
  notesDir,
  vaultRoot,
  sidecarPath,
  readSidecar,
  transcribeFile,
  saveCorrection,
  transcribePending,
  pendingFiles,
  listTranscriptions,
};
