#!/usr/bin/env node
'use strict';

// Recognise handwritten Boox pages that have arrived in the vault.
//
// Runs on the Mac mini: Vision is a macOS framework and pdftoppm lives here, and
// the subscription CLI plane cannot carry an image. Only text travels onward —
// the page itself never leaves the machine.
//
// Nothing here becomes knowledge. Each page's reading is written beside it and
// surfaced on /crm/questions for Douglas to check against the original, because
// Vision is unreliable on cursive and a wrong transcription asserted as fact is
// worse than no transcription at all.
//
//   node scripts/ocr-boox-notes.js [--limit=10] [--max-pages=12]

require('dotenv').config();
const { transcribePending, pendingFiles } = require('../lib/boox-note-ocr');

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

if (process.platform !== 'darwin') {
  console.log('[boox-ocr] skipped: needs macOS (Vision framework)');
  process.exit(0);
}

const limit = arg('limit', 10);
const maxPages = arg('max-pages', 12);
const outstanding = pendingFiles().length;
const result = transcribePending({ limit, maxPages });

for (const failure of result.failed) {
  console.error(`[boox-ocr] FAILED ${failure.file}: ${failure.error}`);
}
console.log(
  `[boox-ocr] done: recognised=${result.recognised} failed=${result.failed.length} `
  + `outstanding=${Math.max(0, outstanding - result.recognised)}`,
);
// A page that cannot be read is a visible failure, not a silent skip.
process.exit(result.failed.length ? 1 : 0);
