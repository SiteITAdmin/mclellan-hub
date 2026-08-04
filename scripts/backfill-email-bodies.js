#!/usr/bin/env node
'use strict';

// Re-fetches raw Gmail bodies for email_summaries that were summarised before
// raw capture existed.
//
// Those rows carry `ingestion_status = 'processed'` with an empty `body_text`,
// so the normal retry lane in email-processor.js skips them (it only revisits
// 'captured' and 'retry'). Source evidence then reports them incomplete, and
// backfillEmbeddings refuses to embed an incomplete source — which on 4 Aug 2026
// left 2,119 of 2,191 emails permanently absent from semantic search.
//
//   node scripts/backfill-email-bodies.js                # report only
//   node scripts/backfill-email-bodies.js --apply --limit 5
//   node scripts/backfill-email-bodies.js --apply        # everything
//
// Read-only against Gmail: fetches a message by id and stores its body locally.
// Paced to stay well inside Gmail quota; safe to interrupt and re-run.

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });
} catch (_) {}

const db = require('../lib/db');
const { getGmailClient, fetchEmailByIdWithClient } = require('../lib/gmail');

const APPLY = process.argv.includes('--apply');
const USER = 'douglas';
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) || 0 : 0;
const PACE_MS = 120;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const hub = db.hub();
  let rows = hub.prepare(`
    SELECT id, gmail_message_id, subject
    FROM email_summaries
    WHERE user = ?
      AND TRIM(COALESCE(body_text, '')) = ''
      AND gmail_message_id NOT LIKE 'agentmail:%'
      AND COALESCE(gmail_message_id, '') != ''
    ORDER BY received_at DESC
  `).all(USER);

  console.log(`[backfill-bodies] ${rows.length} email(s) missing a raw body`);
  if (!rows.length) return;
  if (LIMIT) rows = rows.slice(0, LIMIT);

  if (!APPLY) {
    console.log(`[backfill-bodies] dry run — would fetch ${rows.length}. Re-run with --apply`);
    return;
  }

  const gmail = await getGmailClient(USER);
  const update = hub.prepare(
    "UPDATE email_summaries SET body_text = ? WHERE id = ? AND TRIM(COALESCE(body_text,'')) = ''"
  );

  let filled = 0, empty = 0, failed = 0;
  for (const [i, row] of rows.entries()) {
    try {
      const email = await fetchEmailByIdWithClient(gmail, row.gmail_message_id);
      const body = String(email?.bodyText || '').trim();
      if (body) { update.run(body, row.id); filled++; } else { empty++; }
    } catch (err) {
      failed++;
      // A message deleted in Gmail is expected and not worth 2,000 log lines.
      if (failed <= 5) console.warn(`  fetch failed ${row.gmail_message_id}: ${err.message.slice(0, 80)}`);
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${rows.length} — filled ${filled}, empty ${empty}, failed ${failed}`);
    }
    await sleep(PACE_MS);
  }
  console.log(`[backfill-bodies] done: filled ${filled}, empty ${empty}, failed ${failed}`);
}

main().catch(err => { console.error('[backfill-bodies]', err.message); process.exit(1); });
