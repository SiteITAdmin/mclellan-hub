#!/usr/bin/env node
'use strict';

// Entry point for the self-repair venue. Runs on the Mac mini only — as a
// launchd job at 04:30 (after the 04:00 prod snapshot refresh) or by hand:
//
//   node scripts/run-repair.js                       # full nightly pass
//   node scripts/run-repair.js --reproducer <id>     # repair one reproducer
//   node scripts/run-repair.js --dry-run             # mine + triage only
//
// Kill switch: the venue is OFF unless REPAIR_VENUE_ENABLED=1 in the
// environment, or crm_context key 'repair_venue_enabled' = '1' in the prod
// snapshot (set it in prod; the nightly snapshot carries it here). Mining
// and triage always run — they are read-only — but no Pi session starts and
// no branch/PR/email is produced while disabled, except escalation summaries.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  buildReproducers,
  loadReproducer,
  listReproducers,
  writeRepairReceipt,
  SNAPSHOT_DIR,
} = require('../lib/repair-reproducer');
const { triageReproducer } = require('../lib/repair-triage');
const { repairOne, cleanupStaleWorktrees } = require('../lib/repair-venue');
const { sendRepairEmail } = require('../lib/repair-notify');

const ROOT = path.join(__dirname, '..');

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
const has = (name) => process.argv.includes(name);

function venueEnabled() {
  if (process.env.REPAIR_VENUE_ENABLED === '1') return true;
  try {
    const db = new Database(path.join(SNAPSHOT_DIR, 'hub.db'), { readonly: true, fileMustExist: true });
    const row = db.prepare(
      "SELECT value FROM crm_context WHERE user = 'system' AND key = 'repair_venue_enabled'"
    ).get();
    db.close();
    return row?.value === '1';
  } catch (_) {
    return false;
  }
}

// The snapshot loop's own health rules apply here too: a failed or stale
// snapshot means we would be mining yesterday's (or nobody's) errors.
function snapshotHealthy() {
  const failedMarker = path.join(ROOT, 'data', 'prod-snapshots', 'LAST_RUN_FAILED');
  if (fs.existsSync(failedMarker)) {
    return { ok: false, reason: `snapshot refresh failed (${failedMarker} exists)` };
  }
  try {
    const info = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, 'snapshot.json'), 'utf8'));
    const ageHours = (Date.now() - Date.parse(info.copiedAt)) / 3600000;
    if (ageHours > 48) return { ok: false, reason: `snapshot is ${Math.round(ageHours)}h old` };
  } catch (_) {
    return { ok: false, reason: 'no readable snapshot.json in latest snapshot' };
  }
  return { ok: true };
}

async function dispatch(reproducer, verdict, { enabled, dryRun }) {
  if (verdict.verdict === 'skip') {
    console.log(`[run-repair] ${reproducer.id}: skip — ${verdict.reason}`);
    return { outcome: 'skipped' };
  }

  if (verdict.verdict === 'config_fix') {
    console.log(`[run-repair] ${reproducer.id}: config_fix — ${verdict.reason}`);
    if (!dryRun) {
      await sendRepairEmail({
        subject: `[Hub self-repair] ${reproducer.error_class} is a model-slot issue, not a code bug`,
        text: [
          `Error: ${reproducer.error.message}`,
          `Subsystem: ${reproducer.source.capo} (${reproducer.source.job_type})`,
          '',
          `Diagnosis: ${verdict.reason}`,
          verdict.config?.current_model ? `Current model on the slot: ${verdict.config.current_model}` : '',
          '',
          'Change the model in /admin/models/system — no code change needed.',
        ].filter(Boolean).join('\n'),
      });
    }
    return { outcome: 'config_email' };
  }

  if (verdict.verdict === 'escalate') {
    console.log(`[run-repair] ${reproducer.id}: escalate — ${verdict.reason}`);
    if (!dryRun) {
      await sendRepairEmail({
        subject: `[Hub self-repair] ${reproducer.error_class} needs a human fix`,
        text: [
          `Error: ${reproducer.error.message}`,
          `Subsystem: ${reproducer.source.capo} (${reproducer.source.job_type})`,
          '',
          `Why the venue won't touch it: ${verdict.reason}`,
          '',
          `Reproducer: data/repair-queue/${reproducer.id}.json`,
        ].join('\n'),
      });
    }
    return { outcome: 'escalation_email' };
  }

  // fixable-narrow
  if (dryRun) {
    console.log(`[run-repair] ${reproducer.id}: fixable-narrow (dry run — not repairing)`);
    return { outcome: 'dry_run' };
  }
  if (!enabled) {
    console.log(`[run-repair] ${reproducer.id}: fixable-narrow but venue is DISABLED (set REPAIR_VENUE_ENABLED=1 or the prod crm_context flag)`);
    return { outcome: 'disabled' };
  }
  console.log(`[run-repair] ${reproducer.id}: fixable-narrow — starting repair`);
  const result = await repairOne(reproducer);
  console.log(`[run-repair] ${reproducer.id}: ${result.status}${result.prUrl ? ` — ${result.prUrl}` : ''}${result.reason ? ` — ${result.reason}` : ''}`);
  return { outcome: result.status, result };
}

async function main() {
  const dryRun = has('--dry-run');
  const singleId = arg('--reproducer');
  const enabled = venueEnabled();

  const health = snapshotHealthy();
  if (!health.ok) {
    console.error(`[run-repair] aborting: ${health.reason}`);
    writeRepairReceipt({
      sourceId: 'venue-run', stage: 'run', status: 'fail',
      summary: `Self-repair: run aborted — ${health.reason}`,
      payload: { agent: 'hub_repair', reason: health.reason, run_at: new Date().toISOString() },
    });
    process.exit(1);
  }

  const removed = cleanupStaleWorktrees();
  if (removed) console.log(`[run-repair] cleaned ${removed} stale worktree(s)`);

  let reproducers;
  if (singleId) {
    reproducers = [loadReproducer(singleId)];
  } else {
    const { built, skipped, candidatesFound } = buildReproducers();
    console.log(`[run-repair] mined ${candidatesFound} candidate(s) → ${built.length} new reproducer(s), ${skipped.length} skipped`);
    // Include queued reproducers from earlier runs that are not exhausted.
    const ids = new Set(built.map(b => b.id));
    reproducers = [
      ...built,
      ...listReproducers().filter(r => !ids.has(r.id) && (r.repair_attempts || 0) === 0),
    ];
  }

  const summary = [];
  for (const reproducer of reproducers) {
    try {
      const verdict = await triageReproducer(reproducer, { useModel: !dryRun });
      const { outcome } = await dispatch(reproducer, verdict, { enabled, dryRun });
      summary.push({ id: reproducer.id, verdict: verdict.verdict, outcome });
    } catch (err) {
      console.error(`[run-repair] ${reproducer.id} crashed:`, err.message);
      summary.push({ id: reproducer.id, verdict: 'error', outcome: err.message });
    }
  }

  writeRepairReceipt({
    sourceId: 'venue-run', stage: 'run', status: 'pass',
    summary: `Self-repair run: ${summary.length} reproducer(s) processed (venue ${enabled ? 'enabled' : 'disabled'}${dryRun ? ', dry run' : ''})`,
    payload: { agent: 'hub_repair', enabled, dry_run: dryRun, results: summary, run_at: new Date().toISOString() },
  });

  console.log(`[run-repair] done: ${JSON.stringify(summary)}`);
}

main().catch(err => {
  console.error('[run-repair] fatal:', err);
  process.exit(1);
});
