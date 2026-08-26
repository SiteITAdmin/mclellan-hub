'use strict';

/**
 * The Boox app's handwriting ingest door — the inbound half of the native
 * planner app.
 *
 * The device does no recognition. It captures raw ink (PNG/JPEG/PDF) and pushes
 * the page here; every OCR/handwriting-recognition decision stays at the hub.
 * This module lands that raw page in the SAME vault raw inbox the Boox → Drive
 * notebook loop already uses (`raw_sources/boox-notes`), under an `app/`
 * subfolder, so the existing hub-side recognition/review workflow processes an
 * app-captured page exactly as it does a Drive-synced notebook. See
 * docs/boox-drive-ingest.md.
 *
 * Deliberately NOT here: OCR, a `documents` row, or auto-queueing for synthesis.
 * A `documents` row expects markdown, which an un-recognised image does not have
 * yet; and the import-only guardrail (weak handwriting must not auto-enter the
 * knowledge base) is the whole reason the Drive loop stops at the raw inbox.
 * App captures obey the same rule: they wait in the inbox for the same
 * deliberate review step, not a second pipeline.
 *
 * Idempotent on the device-supplied capture id, because an offline app that
 * loses connectivity mid-push must be able to retry without landing the same
 * page twice.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VAULT = path.join(ROOT, 'data', 'synthadoc', 'mclellan-hub-knowledge');

// Same extension set the drive loop accepts, minus the office/text formats a
// handwriting page never is. A page is an image or a flattened PDF.
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'application/pdf': 'pdf',
};

function vaultRoot() {
  return String(process.env.BOOX_DRIVE_VAULT_ROOT || DEFAULT_VAULT);
}

// The app notebook lives beside the Drive notebooks, not mixed into them, so a
// device-pushed page and a Drive-synced notebook are never confused for one
// another even though they share the same review workflow.
function appNotesDir() {
  return path.join(vaultRoot(), 'raw_sources', 'boox-notes', 'app');
}

// Mirrors scripts/ingest-boox-drive-notes.js safeName so app-captured files and
// Drive-captured files read the same in the raw inbox.
function safeName(name) {
  return String(name || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

// The capture id is the app's idempotency key and half of every filename, so it
// must be filesystem-safe before it is trusted in a path.
function safeCaptureId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

function isSupportedMime(mimetype) {
  return Boolean(EXT_BY_MIME[String(mimetype || '').toLowerCase()]);
}

function sidecarFor(captureId) {
  const dir = appNotesDir();
  const safe = safeCaptureId(captureId);
  if (!safe || !fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find(file => file.startsWith(`${safe}-`) && file.endsWith('.json'));
  return match ? path.join(dir, match) : null;
}

// Returns the stored record for a capture id, or null. The retry check keys on
// the capture id alone (not the title), so re-sending the same page with a
// tweaked title still resolves to the one already stored.
function existingCapture(captureId) {
  const file = sidecarFor(captureId);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

/**
 * Store one handwritten page in the raw inbox.
 *
 * `provenance` (linkedDate / linkedEventId / pageRef) records where the page
 * belongs — a day, a meeting note page, or a numbered blank — so the later
 * recognition/review step can put the note back in context without the app
 * re-sending it. Returns the stored record with `duplicate` set.
 */
function storeHandwrittenNote({
  captureId, buffer, mimetype, title,
  capturedAt = null, linkedDate = null, linkedEventId = null, pageRef = null,
  ingester = 'boox-app',
}) {
  const safe = safeCaptureId(captureId);
  if (!safe) throw new Error('captureId is required');
  if (!buffer || !buffer.length) throw new Error('empty note file');
  const mime = String(mimetype || '').toLowerCase();
  if (!isSupportedMime(mime)) throw new Error(`unsupported note type: ${mimetype || 'unknown'}`);

  const existing = existingCapture(safe);
  if (existing) return { ...existing, duplicate: true };

  const dir = appNotesDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = EXT_BY_MIME[mime];
  const base = `${safe}-${safeName(title || 'note')}`;
  const fileRel = path.join('raw_sources', 'boox-notes', 'app', `${base}.${ext}`);
  fs.writeFileSync(path.join(vaultRoot(), fileRel), buffer);

  const record = {
    captureId: safe,
    ingester,
    title: title || null,
    mimetype: mime,
    bytes: buffer.length,
    capturedAt: capturedAt || null,
    linkedDate: linkedDate || null,
    linkedEventId: linkedEventId || null,
    pageRef: pageRef || null,
    file: fileRel,
    storedAt: Math.floor(Date.now() / 1000),
  };
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(record, null, 2) + '\n');
  return { ...record, duplicate: false };
}

// What has the app landed in the inbox? Backs a health/INGEST count and lets the
// sync endpoint tell the app which captures the hub already holds.
function listHandwrittenNotes({ limit = 100 } = {}) {
  const dir = appNotesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.storedAt || 0) - (a.storedAt || 0))
    .slice(0, Math.max(1, Number(limit) || 100));
}

module.exports = {
  EXT_BY_MIME,
  vaultRoot,
  appNotesDir,
  isSupportedMime,
  existingCapture,
  storeHandwrittenNote,
  listHandwrittenNotes,
};
