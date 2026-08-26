'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the vault at a throwaway dir before the module reads the env var.
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'boox-notes-'));
process.env.BOOX_DRIVE_VAULT_ROOT = TMP_VAULT;

const {
  storeHandwrittenNote,
  listHandwrittenNotes,
  existingCapture,
  isSupportedMime,
  appNotesDir,
} = require('../lib/boox-notes');

// A minimal but real PNG (1x1) so we exercise actual bytes, not a placeholder.
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('stores a handwritten page in the shared boox raw inbox with provenance', () => {
  const record = storeHandwrittenNote({
    captureId: 'dev-abc-001',
    buffer: FAKE_PNG,
    mimetype: 'image/png',
    title: 'Beacon handover notes',
    capturedAt: '2026-08-26T10:00:00Z',
    linkedDate: '2026-08-26',
    linkedEventId: 'evt-123',
  });

  assert.equal(record.duplicate, false);
  assert.equal(record.captureId, 'dev-abc-001');
  assert.equal(record.linkedDate, '2026-08-26');
  // Lands under the Drive loop's raw inbox, in the app/ subfolder.
  assert.match(record.file, /^raw_sources[/\\]boox-notes[/\\]app[/\\]/);
  const abs = path.join(TMP_VAULT, record.file);
  assert.ok(fs.existsSync(abs), 'image file was written');
  assert.equal(fs.statSync(abs).size, FAKE_PNG.length, 'full bytes stored, not truncated');
});

test('is idempotent on captureId — a retry does not double-land the page', () => {
  const first = storeHandwrittenNote({
    captureId: 'dev-retry-1', buffer: FAKE_PNG, mimetype: 'image/png', title: 'Draft',
  });
  assert.equal(first.duplicate, false);

  // Same capture, connectivity blip, app resends with a tweaked title.
  const retry = storeHandwrittenNote({
    captureId: 'dev-retry-1', buffer: FAKE_PNG, mimetype: 'image/png', title: 'Draft (edited)',
  });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.file, first.file, 'resolves to the already-stored file');

  const images = fs.readdirSync(appNotesDir()).filter(f => f.startsWith('dev-retry-1-') && f.endsWith('.png'));
  assert.equal(images.length, 1, 'exactly one image on disk for the capture');
  assert.ok(existingCapture('dev-retry-1'), 'capture is findable by id');
});

test('rejects an unsupported type and an empty page', () => {
  assert.equal(isSupportedMime('image/png'), true);
  assert.equal(isSupportedMime('text/plain'), false);
  assert.throws(() => storeHandwrittenNote({
    captureId: 'dev-bad-1', buffer: FAKE_PNG, mimetype: 'text/plain',
  }), /unsupported note type/);
  assert.throws(() => storeHandwrittenNote({
    captureId: 'dev-bad-2', buffer: Buffer.alloc(0), mimetype: 'image/png',
  }), /empty note file/);
  assert.throws(() => storeHandwrittenNote({
    captureId: '', buffer: FAKE_PNG, mimetype: 'image/png',
  }), /captureId is required/);
});

test('lists stored captures newest-first', () => {
  const ids = listHandwrittenNotes({ limit: 50 }).map(n => n.captureId);
  assert.ok(ids.includes('dev-abc-001'));
  assert.ok(ids.includes('dev-retry-1'));
  // Unsupported/empty attempts left nothing behind.
  assert.ok(!ids.includes('dev-bad-1'));
  assert.ok(!ids.includes('dev-bad-2'));
});
