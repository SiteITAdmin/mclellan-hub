#!/usr/bin/env node
'use strict';

// Clears `unembeddable` tombstones so the backfill re-embeds those sources.
//
// A tombstone is never retried, so one written for a transient reason is silent
// permanent loss from semantic search. Before 3 Aug 2026 any HTTP 400 from the
// embedding engine counted as permanent, and Ollama reports runner crashes
// ("EOF") that way — twelve healthy sources were tombstoned in five hours.
//
//   node scripts/repair-unembeddable.js            # report only
//   node scripts/repair-unembeddable.js --apply    # clear them
//   node scripts/repair-unembeddable.js --apply --all
//
// Without --all, tombstones whose reason still classifies as permanent under the
// current rule are left alone; --all clears those too (use after raising a size
// limit, where a previously-genuine failure would now succeed).

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });
} catch (_) {}

const db = require('./../lib/db');
const { EMBED_UNEMBEDDABLE_MODEL } = require('../lib/retrieval');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

// Mirrors lib/retrieval.js isPermanentEmbedFailure. Kept local so the repair
// judges a stored reason string without re-running the failing request.
function reasonIsStillPermanent(reason) {
  const msg = String(reason || '');
  if (/\bEOF\b|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|fetch failed|network|timed? ?out|connection/i.test(msg)) {
    return false;
  }
  return /maximum request size/i.test(msg)
    || /too large/i.test(msg)
    || /exceeds \S+ (?:context|token|size)/i.test(msg);
}

function main() {
  const hub = db.hub();
  const rows = hub.prepare(
    'SELECT id, user, source_kind, source_id, chunk_text FROM embeddings WHERE model = ?'
  ).all(EMBED_UNEMBEDDABLE_MODEL);

  if (!rows.length) {
    console.log('[repair-unembeddable] no tombstones found');
    return;
  }

  const transient = [];
  const permanent = [];
  for (const row of rows) {
    const reason = String(row.chunk_text || '').replace(/^\[unembeddable\]\s*/, '');
    (reasonIsStillPermanent(reason) ? permanent : transient).push({ ...row, reason });
  }

  console.log(`[repair-unembeddable] ${rows.length} tombstone(s): ${transient.length} transient, ${permanent.length} still classified permanent`);
  for (const r of transient) {
    console.log(`  transient  ${r.source_kind}/${r.source_id.slice(0, 12)}  ${r.reason.slice(0, 80)}`);
  }
  for (const r of permanent) {
    console.log(`  permanent  ${r.source_kind}/${r.source_id.slice(0, 12)}  ${r.reason.slice(0, 80)}`);
  }

  const target = ALL ? [...transient, ...permanent] : transient;
  if (!APPLY) {
    console.log(`[repair-unembeddable] dry run — would clear ${target.length}. Re-run with --apply${ALL ? ' --all' : ''}`);
    return;
  }

  const del = hub.prepare('DELETE FROM embeddings WHERE id = ?');
  const clearAll = hub.transaction(list => { for (const r of list) del.run(r.id); });
  clearAll(target);
  console.log(`[repair-unembeddable] cleared ${target.length} tombstone(s); backfill will re-embed them`);
}

main();
