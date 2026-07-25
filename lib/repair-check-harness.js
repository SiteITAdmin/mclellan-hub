'use strict';

// The four-gate verification for repair-venue fixes. The check is the
// contract: a fix is accepted only if the gates prove the behaviour is
// CORRECT, not merely that the code no longer throws.
//
//   Gate 1 — reproduction: before the fix, the recorded error class must be
//            demonstrable (synthetic mock test for nondeterministic model-
//            response errors; snapshot re-run for deterministic ones).
//   Gate 2 — regression test: the test Grok wrote must pass, and one must
//            exist. This is the primary proof for nondeterministic errors:
//            it mocks the bad model response and asserts the code retries or
//            fails visibly — never silently defaults.
//   Gate 3 — full suite: npm test in the worktree, no regressions.
//   Gate 4 — snapshot flow: deterministic errors only; re-run the failing
//            flow against real snapshot data. Skipped for nondeterministic
//            classes — the synthetic test is the proof there.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run(cmd, args, { cwd, env = {}, timeout = 300000 } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: cwd || ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    output: ((res.stdout || '') + (res.stderr || '')).slice(-8000),
  };
}

// Gate 1: the error must exist before we try to fix it.
function gateReproduce(reproducer, worktree) {
  if (reproducer.reproduction?.synthetic_test) {
    const res = run(process.execPath, [
      path.join(ROOT, 'scripts', 'test-repair.js'),
      '--reproducer', reproducer.id,
      '--target-root', worktree,
    ]);
    return { gate: 'reproduce', ok: res.ok, detail: res.ok ? 'error class reproduced' : 'could not reproduce recorded error' };
  }
  if (reproducer.reproduction?.deterministic) {
    return { gate: 'reproduce', ok: false, detail: 'deterministic reproduction not implemented for this class — escalate' };
  }
  return { gate: 'reproduce', ok: false, detail: 'no reproduction path' };
}

// Gate 2: Grok must have written at least one regression test, and it must
// pass. `testFiles` are worktree-relative paths of changed/added test files.
function gateRegressionTest(worktree, testFiles) {
  if (!testFiles.length) {
    return { gate: 'regression_test', ok: false, detail: 'no regression test written — a fix without a test is not accepted' };
  }
  const res = run(process.execPath, ['--test', ...testFiles], { cwd: worktree });
  return {
    gate: 'regression_test',
    ok: res.ok,
    detail: res.ok ? `${testFiles.length} regression test file(s) pass` : `regression test failed:\n${res.output}`,
  };
}

// Gate 3: the whole suite, exactly as CI/dev runs it.
function gateFullSuite(worktree) {
  const res = run('npm', ['test'], { cwd: worktree, timeout: 600000 });
  return {
    gate: 'full_suite',
    ok: res.ok,
    detail: res.ok ? 'npm test green' : `npm test failed:\n${res.output}`,
  };
}

// Gate 4: deterministic data-dependent errors re-run the real failing flow
// against the snapshot. Nondeterministic classes skip — re-calling a model
// that intermittently misbehaves proves nothing either way.
function gateSnapshotFlow(reproducer, worktree) {
  if (!reproducer.reproduction?.deterministic) {
    return { gate: 'snapshot_flow', ok: true, skipped: true, detail: 'skipped (nondeterministic error class — synthetic test is the proof)' };
  }
  const res = run('bash', [
    path.join(ROOT, 'scripts', 'run-with-prod-snapshot.sh'),
    path.join(ROOT, reproducer.snapshot.path),
    process.execPath, path.join(ROOT, 'scripts', 'test-repair.js'),
    '--reproducer', reproducer.id,
    '--target-root', worktree,
  ]);
  // Post-fix the reproduction must FAIL to reproduce: the flow now works.
  return {
    gate: 'snapshot_flow',
    ok: !res.ok,
    detail: !res.ok ? 'failing flow now passes against snapshot data' : 'error still reproduces against snapshot',
  };
}

// Run gates 2–4 after a fix. Gate 1 runs before the Grok session (see
// lib/repair-venue.js). Returns { ok, gates } with per-gate outcomes.
function verifyFix({ reproducer, worktree, testFiles }) {
  const gates = [];
  const g2 = gateRegressionTest(worktree, testFiles);
  gates.push(g2);
  if (g2.ok) {
    const g3 = gateFullSuite(worktree);
    gates.push(g3);
    if (g3.ok) gates.push(gateSnapshotFlow(reproducer, worktree));
  }
  return { ok: gates.every(g => g.ok), gates };
}

module.exports = {
  gateReproduce,
  gateRegressionTest,
  gateFullSuite,
  gateSnapshotFlow,
  verifyFix,
};
