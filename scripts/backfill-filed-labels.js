#!/usr/bin/env node
'use strict';

// One-time repair: ingest historical mail that Douglas has filed under canonical
// Gmail labels but that the routine label poll will never catch. The routine poll
// windows on a message's RECEIVED date (`after:<cursor>`), so mail filed today but
// received days/weeks ago sits behind the cursor forever. This sweep fetches by
// label id, ignoring the received-date window, and dedups against what the Hub
// already holds.
//
//   Classification labels  -> classifyEmail() for a summary, stored in
//                             email_summaries under the filed label (authoritative).
//   Intelligence labels    -> backfillFromLabels() into the briefing, capped to a
//                             recent window so stale items are not ingested.
//
// MUST run on the VPS: the Gmail refresh token lives there and using it elsewhere
// risks the live service's auth. Dry-run by default; pass --commit to write.
//
//   node scripts/backfill-filed-labels.js            # report only
//   node scripts/backfill-filed-labels.js --commit   # actually ingest

const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { getEnabledEmailLabels } = require('../lib/email-taxonomy');
const { classifyEmail } = require('../lib/email-processor');
const { backfillFromLabels } = require('../lib/newsletter-pipeline');
const { fetchEmailsByLabel } = require('../lib/gmail');

const USER = process.env.BACKFILL_USER || 'douglas';
const COMMIT = process.argv.includes('--commit');
const INTELLIGENCE_LABELS = new Set(['resources/newsletters', 'resources/research']);
const INTEL_WINDOW_DAYS = Number(process.env.BACKFILL_INTEL_DAYS || 60);

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function main() {
  const hub = db.hub();
  const emailLabels = getEnabledEmailLabels(USER);
  const intelLabels = emailLabels.filter(l => INTELLIGENCE_LABELS.has(l.toLowerCase()));
  const classifyLabels = emailLabels.filter(l => !INTELLIGENCE_LABELS.has(l.toLowerCase()));

  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ?').all(USER);
  const ctxEmails = hub.prepare("SELECT key, value FROM crm_context WHERE user = ? AND key LIKE '%_email'").all(USER);
  const emailByKey = {};
  for (const r of ctxEmails) emailByKey[r.key] = r.value;
  const enrichedContacts = contacts.map(c => ({
    ...c,
    email: c.email || emailByKey[`${c.name.toLowerCase().replace(/\s+/g, '_')}_email`] || null,
  }));
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(USER);

  const processedIds = new Set(
    hub.prepare('SELECT gmail_message_id FROM email_summaries WHERE user = ?').all(USER).map(r => r.gmail_message_id)
  );

  console.log(`[backfill] user=${USER} mode=${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`[backfill] classification labels: ${classifyLabels.length}; intelligence labels: ${intelLabels.join(', ') || '(none)'} (last ${INTEL_WINDOW_DAYS}d)`);

  // ── Classification labels: full history, summary + filed label ──────────────
  let totalIngested = 0;
  for (const label of classifyLabels) {
    let emails;
    try {
      emails = await fetchEmailsByLabel(USER, label, 0);
    } catch (err) {
      console.warn(`[backfill] "${label}" fetch failed: ${err.message}`);
      continue;
    }
    const missing = emails.filter(e => !processedIds.has(e.id));
    if (!missing.length) {
      console.log(`[backfill] ${label}: ${emails.length} filed, 0 missing`);
      continue;
    }
    console.log(`[backfill] ${label}: ${emails.length} filed, ${missing.length} missing${emails.length >= 100 ? ' (label at 100-fetch cap — older mail may remain)' : ''}`);
    if (!COMMIT) { totalIngested += missing.length; continue; }

    for (const email of missing) {
      try {
        const result = await classifyEmail(email, enrichedContacts, projects, emailLabels, USER, 'email');
        const validSlug = projects.some(p => p.slug === result.project_slug) ? result.project_slug : null;
        hub.prepare(`
          INSERT OR IGNORE INTO email_summaries
            (id, user, gmail_message_id, subject, from_name, from_email,
             received_at, summary, project_slug, gmail_label, gmail_label_source, gmail_label_checked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', unixepoch())
        `).run(
          uuid(), USER, email.id, email.subject, email.fromName, normalizeEmail(email.fromEmail),
          email.receivedAt, result.summary, validSlug, label
        );
        processedIds.add(email.id);
        totalIngested++;
      } catch (err) {
        console.warn(`[backfill] classify failed for "${email.subject}": ${err.message}`);
      }
    }
    console.log(`[backfill] ${label}: ingested ${missing.length}`);
  }

  // ── Intelligence labels: recent window into the briefing ────────────────────
  let intelTopics = 0;
  if (intelLabels.length) {
    const sinceTs = Math.floor(Date.now() / 1000) - INTEL_WINDOW_DAYS * 86400;
    if (!COMMIT) {
      console.log(`[backfill] intelligence (${intelLabels.join(', ')}): would backfill last ${INTEL_WINDOW_DAYS}d (dedup by message id)`);
    } else {
      const results = await backfillFromLabels(USER, intelLabels, sinceTs);
      for (const [label, r] of Object.entries(results)) {
        if (r.error) console.warn(`[backfill] intel ${label}: ${r.error}`);
        else { console.log(`[backfill] intel ${label}: ${r.emails} emails → ${r.topics} topics`); intelTopics += r.topics || 0; }
      }
    }
  }

  console.log(`[backfill] DONE — ${COMMIT ? 'ingested' : 'would ingest'} ${totalIngested} classification email(s); intelligence topics: ${intelTopics}`);
  if (!COMMIT) console.log('[backfill] re-run with --commit to write.');
}

main().then(() => process.exit(0)).catch(err => { console.error('[backfill] fatal:', err); process.exit(1); });
