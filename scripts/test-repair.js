#!/usr/bin/env node
'use strict';

// Run a targeted reproduction for one repair reproducer (Gate 1 of the check
// harness, also usable standalone). Mac-mini only — reads the prod snapshot,
// never the live DB.
//
//   node scripts/test-repair.js --reproducer <id> [--target-root <dir>]
//
// For nondeterministic error classes (model response shape) this runs the
// synthetic mock test and reports whether the error class reproduces. For
// deterministic classes it re-runs the failing flow against the snapshot.
// --target-root points the synthetic test at a worktree instead of the main
// repo, so the harness can prove RED before a fix and GREEN after it.

const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadReproducer,
  writeRepairReceipt,
} = require('../lib/repair-reproducer');

const ROOT = path.join(__dirname, '..');

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

function main() {
  const id = arg('--reproducer');
  if (!id) {
    console.error('Usage: node scripts/test-repair.js --reproducer <id> [--target-root <dir>]');
    process.exit(2);
  }
  const targetRoot = path.resolve(arg('--target-root') || ROOT);
  const reproducer = loadReproducer(id);

  let reproduced = false;
  let detail = '';

  if (reproducer.reproduction.synthetic_test) {
    const testPath = path.join(ROOT, reproducer.reproduction.synthetic_test);
    const run = spawnSync(process.execPath, ['--test', testPath], {
      cwd: targetRoot,
      env: { ...process.env, REPAIR_TARGET_ROOT: targetRoot },
      encoding: 'utf8',
      timeout: 60000,
    });
    // The synthetic test asserts the recorded error occurs for the bad input
    // class: exit 0 = error reproduced. This is Gate 1 (does the error
    // exist?); the post-fix proof is Grok's own regression test (Gate 2), not
    // this file — throwing on a bad shape may remain the correct contract at
    // this layer while the caller learns to retry or fail visibly.
    reproduced = run.status === 0;
    detail = (run.stdout || '') + (run.stderr || '');
  } else {
    // No synthetic test was generated for this class. Deterministic classes
    // that reach here (schema errors etc.) are escalate-verdict anyway; being
    // honest about "cannot reproduce" beats running a fake check.
    console.log(`[test-repair] ${id}: no reproduction path for ${reproducer.error_class} — manual reproduction required`);
    writeRepairReceipt({
      sourceId: id,
      stage: 'reproduce',
      status: 'warn',
      summary: `Self-repair: could not reproduce ${reproducer.error_class} — no synthetic test available`,
      payload: {
        agent: 'hub_repair',
        error_class: reproducer.error_class,
        error_signature: reproducer.error_signature,
        reproduced: false,
        reason: 'no_reproduction_path',
        run_at: new Date().toISOString(),
      },
    });
    process.exit(3);
  }

  console.log(`[test-repair] ${id}: ${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'} (target: ${targetRoot})`);
  if (process.env.REPAIR_VERBOSE) console.log(detail);

  writeRepairReceipt({
    sourceId: id,
    stage: 'reproduce',
    status: reproduced ? 'pass' : 'warn',
    summary: `Self-repair: ${reproducer.error_class} ${reproduced ? 'reproduced' : 'did not reproduce'} against ${path.relative(ROOT, targetRoot) || 'main repo'}`,
    payload: {
      agent: 'hub_repair',
      error_class: reproducer.error_class,
      error_signature: reproducer.error_signature,
      reproduced,
      target_root: targetRoot,
      run_at: new Date().toISOString(),
    },
  });

  process.exit(reproduced ? 0 : 1);
}

main();
