#!/usr/bin/env node
'use strict';

// Repairs newsletters stored as a plain-text "view this online" stub.
//
// Before the multipart/alternative selection fix, a sender whose plain-text
// branch was only a pointer (beehiiv, Substack) had its entire issue discarded:
// 8 of 17 Futurepedia issues were kept as ~464 characters of link. Fixing the
// selection stops it recurring; it does not recover what is already stored.
//
// Re-fetches each stub from Gmail and, where the message also became an
// intel_document, refreshes that document's content_text so briefings built on
// it see the real issue.
//
//   node scripts/repair-newsletter-stubs.js            # report only
//   node scripts/repair-newsletter-stubs.js --apply

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: false });
} catch (_) {}

const db = require('../lib/db');
const { getGmailClient, fetchEmailByIdWithClient } = require('../lib/gmail');

const APPLY = process.argv.includes('--apply');
const USER = 'douglas';
const STUB_MAX = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const hub = db.hub();
  const stubs = hub.prepare(`
    SELECT id, gmail_message_id, subject, LENGTH(COALESCE(body_text,'')) len
    FROM email_summaries
    WHERE user = ?
      AND LENGTH(COALESCE(body_text,'')) BETWEEN 1 AND ?
      AND (body_text LIKE '%plain text version%'
           OR body_text LIKE '%view the post online%'
           OR body_text LIKE '%View this post on the web%')
      AND gmail_message_id NOT LIKE 'agentmail:%'
    ORDER BY received_at DESC
  `).all(USER, STUB_MAX);

  console.log(`[repair-stubs] ${stubs.length} newsletter(s) stored as a stub`);
  if (!stubs.length) return;
  if (!APPLY) {
    for (const s of stubs.slice(0, 10)) {
      console.log(`  ${s.len} chars — ${String(s.subject || '').slice(0, 60)}`);
    }
    console.log('[repair-stubs] dry run — re-run with --apply');
    return;
  }

  const gmail = await getGmailClient(USER);
  const updateEmail = hub.prepare('UPDATE email_summaries SET body_text = ? WHERE id = ?');
  const updateDoc = hub.prepare(
    `UPDATE intel_documents SET content_text = ?
      WHERE external_id = ? AND LENGTH(COALESCE(content_text, '')) < ?`
  );

  let repaired = 0, docsRefreshed = 0, failed = 0;
  for (const s of stubs) {
    try {
      const email = await fetchEmailByIdWithClient(gmail, s.gmail_message_id);
      const body = String(email?.bodyText || '').trim();
      // Only replace when the refetch is genuinely richer; never shrink a row.
      if (body.length > s.len * 2) {
        updateEmail.run(body, s.id);
        repaired++;
        const res = updateDoc.run(body, s.gmail_message_id, STUB_MAX);
        if (res.changes) docsRefreshed++;
      }
    } catch (err) {
      failed++;
      if (failed <= 5) console.warn(`  refetch failed ${s.gmail_message_id}: ${err.message.slice(0, 80)}`);
    }
    await sleep(150);
  }
  console.log(`[repair-stubs] done: ${repaired} email(s) repaired, ${docsRefreshed} intel document(s) refreshed, ${failed} failed`);
}

main().catch(err => { console.error('[repair-stubs]', err.message); process.exit(1); });
