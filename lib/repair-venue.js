'use strict';

// Phase 2 of the self-repair venue: the orchestrator. Takes a fixable-narrow
// reproducer, creates a throwaway git worktree, runs the locally authenticated
// Grok CLI (via scripts/repair/grok-runner.mjs) against it with bounded instructions, drives
// the four-gate check harness, and on success pushes a repair/<id> branch,
// opens a GitHub PR, and emails Douglas. It NEVER deploys — the only deploy
// path remains a human merging the PR and running scripts/deploy.sh.
//
// Runs ONLY on the Mac mini as a standalone process (scripts/run-repair.js).
// Never imported by server.js, never run inside sendSystemReport(), no SSH
// or VPS access anywhere in this module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  saveReproducer,
  writeRepairReceipt,
  SNAPSHOT_DIR,
} = require('./repair-reproducer');
const { getSnapshotModelId } = require('./repair-triage');
const { gateReproduce, verifyFix } = require('./repair-check-harness');
const { sendRepairEmail } = require('./repair-notify');

const ROOT = path.join(__dirname, '..');
const WORKTREES_DIR = path.join(ROOT, '.repair-worktrees');

// Bounded like remediation (MAX_DISPATCHES=2); one more attempt because
// coding is harder than re-enqueueing a job.
const MAX_REPAIR_ATTEMPTS = 3;
const REPAIR_TIMEOUT_MS = 300000;
const REPAIR_MAX_TURNS = 12;
const MAX_FILES_CHANGED = 3;

const REPAIR_AGENT_FEATURE = 'repair_agent';
const REPAIR_AGENT_FALLBACK_MODEL = 'grok-4.5';

function git(args, { cwd = ROOT } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
  }
  return (res.stdout || '').trim();
}

function grokCliModel(modelId) {
  const normalized = String(modelId || '').trim().replace(/^x-ai\//, '');
  if (normalized === 'grok-4.5') return normalized;
  throw new Error(`repair_agent must be Grok 4.5 for the local Grok CLI (received ${modelId || 'empty'})`);
}

function worktreePath(reproducerId) {
  return path.join(WORKTREES_DIR, reproducerId);
}

function createWorktree(reproducerId) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const dir = worktreePath(reproducerId);
  if (fs.existsSync(dir)) removeWorktree(dir);
  git(['worktree', 'add', '--detach', dir, 'HEAD']);
  // Keep bulky/irrelevant tracked trees out. Secrets are untracked (.env*,
  // service accounts) so a fresh worktree never contains them by
  // construction; tracked config/ files (users.js, email-taxonomy.json) hold
  // no secrets and are required by lib code, so they stay.
  git(['sparse-checkout', 'set', '--no-cone', '/*', '!/data/', '!/backups/', '!/exports/', '!/token-burn-dashboard/'], { cwd: dir });
  // Belt and braces: fail loudly if a secret file somehow materialised.
  // (.env.example is the tracked, deliberately-public template.)
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('.env') && f !== '.env.example') throw new Error(`worktree contains ${f} — aborting`);
  }
  // The suite needs dependencies; a symlink to the main repo's node_modules
  // is read-only in practice (npm never runs in the worktree).
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  // Tests expect a schema'd DB under data/ — give them an empty, freshly
  // migrated one, never real data (data/ is gitignored, so it cannot enter
  // the diff, and Grok never sees a byte of Douglas's life).
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const init = spawnSync(process.execPath, [path.join(dir, 'scripts', 'init-db.js')], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`init-db in worktree failed: ${(init.stderr || '').slice(0, 300)}`);
  return dir;
}

function removeWorktree(dir) {
  try {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, encoding: 'utf8' });
  } catch (_) { /* fall through to manual cleanup */ }
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT, encoding: 'utf8' });
}

// Worktrees left behind by crashed runs — anything older than 7 days goes.
function cleanupStaleWorktrees() {
  if (!fs.existsSync(WORKTREES_DIR)) return 0;
  const cutoff = Date.now() - 7 * 86400 * 1000;
  let removed = 0;
  for (const entry of fs.readdirSync(WORKTREES_DIR)) {
    const dir = path.join(WORKTREES_DIR, entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) { removeWorktree(dir); removed++; }
    } catch (_) { /* ignore */ }
  }
  return removed;
}

function changedFiles(worktree) {
  const out = spawnSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter(Boolean).map(line => line.slice(3).trim()).filter(f => f && f !== 'node_modules');
}

// Post-fix scope containment: every changed file must be an allowed source
// file or a new test, nothing forbidden, and the total within budget.
function checkScope(reproducer, files) {
  const allowed = reproducer.constraints?.allowed_paths || [];
  const forbidden = reproducer.constraints?.forbidden || [];
  if (!files.length) return { ok: false, reason: 'Grok made no changes' };
  if (files.length > MAX_FILES_CHANGED) {
    return { ok: false, reason: `${files.length} files changed — over the ${MAX_FILES_CHANGED}-file budget` };
  }
  for (const file of files) {
    if (forbidden.some(f => file === f || file.startsWith(f))) {
      return { ok: false, reason: `${file} is forbidden` };
    }
    const isAllowedSource = allowed.includes(file);
    const isTest = /^test\/[^/]+\.test\.js$/.test(file);
    if (!isAllowedSource && !isTest) {
      return { ok: false, reason: `${file} is outside the allowed scope (${allowed.join(', ')} + test/)` };
    }
  }
  return { ok: true };
}

function buildSystemPrompt() {
  const { PROMPTS } = require('./prompts');
  const { getSnapshotPrompt } = require('./repair-triage');
  return getSnapshotPrompt(REPAIR_AGENT_FEATURE, PROMPTS.repair_agent);
}

function buildUserPrompt(reproducer, feedback) {
  const lines = [
    `Fix this error: ${reproducer.error.message}`,
    '',
    `Error class: ${reproducer.error_class}`,
    `Subsystem: ${reproducer.source.capo} (${reproducer.source.job_type})`,
    `Files in scope (change nothing else): ${reproducer.constraints.allowed_paths.join(', ')}`,
    `Forbidden: ${reproducer.constraints.forbidden.join(', ')}`,
    '',
    'Context: a model on this pipeline intermittently returns a wrong-shape JSON response',
    '(null, an array, or a scalar instead of the expected object). The parse guard throws and',
    'the item fails. The correct fix retries the model call, and if retries exhaust, throws a',
    'clear error so the existing job/failure machinery retries the item visibly.',
    '',
    'Deliverables:',
    '1. The minimal fix in the in-scope file(s).',
    '2. One new regression test file test/<something>.test.js that mocks the bad response shape',
    '   and asserts the corrected behaviour without any network access.',
  ];
  if (feedback) {
    lines.push('', 'Your previous attempt failed verification:', feedback, '', 'Fix the fix. Same rules apply.');
  }
  return lines.join('\n');
}

// Run one Grok CLI session in a child process. The outer five-minute kill is
// the hard deadline. Grok CLI subscription execution has no per-turn dollar
// usage feed, so turns are bounded; final usage cost is recorded after the
// session rather than treated as a real-time brake.
function runGrokSession({ worktree, reproducer, modelId, feedback }) {
  return new Promise((resolve) => {
    const jobFile = path.join(os.tmpdir(), `hub-repair-job-${reproducer.id}-${Date.now()}.json`);
    fs.writeFileSync(jobFile, JSON.stringify({
      worktree,
      modelId,
      maxTurns: REPAIR_MAX_TURNS,
      systemPrompt: buildSystemPrompt(),
      prompt: buildUserPrompt(reproducer, feedback),
    }, null, 2));

    const runner = path.join(ROOT, 'scripts', 'repair', 'grok-runner.mjs');
    const child = spawn(process.execPath, [runner, '--job', jobFile], {
      cwd: path.join(ROOT, 'scripts', 'repair'),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GROK_CLI_PATH: process.env.GROK_CLI_PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const events = [];
    let stdoutBuf = '';
    let stderrBuf = '';
    let result = null;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, REPAIR_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx); stdoutBuf = stdoutBuf.slice(idx + 1);
        try {
          const evt = JSON.parse(line);
          events.push(evt);
          if (evt.type === 'result') result = evt;
        } catch (_) { /* non-JSONL noise */ }
      }
    });
    child.stderr.on('data', (chunk) => { stderrBuf += chunk; });

    child.on('close', () => {
      clearTimeout(timer);
      try { fs.unlinkSync(jobFile); } catch (_) { /* scratch */ }
      if (timedOut) {
        resolve({ status: 'timeout', costUsd: result?.costUsd || 0, turns: result?.turns || 0, events, error: `killed after ${REPAIR_TIMEOUT_MS}ms` });
      } else if (result) {
        resolve({ ...result, events });
      } else {
        resolve({ status: 'error', costUsd: 0, turns: 0, events, error: stderrBuf.slice(-1000) || 'runner produced no result' });
      }
    });
  });
}

function commitAndPush(reproducer, worktree, files) {
  const branch = `repair/${reproducer.id}`;
  git(['checkout', '-b', branch], { cwd: worktree });
  git(['add', ...files], { cwd: worktree });
  git(['commit', '-m',
    `Self-repair: ${reproducer.error_class} — ${reproducer.error.message.slice(0, 60)}\n\n`
    + `Reproducer: ${reproducer.id}\n`
    + `Verified: synthetic regression test + full suite in isolated worktree.\n`
    + `Generated by the Mac-mini repair venue; human review required before deploy.`,
  ], { cwd: worktree });
  git(['push', '-u', 'origin', branch], { cwd: worktree });
  return branch;
}

function openPullRequest(reproducer, branch, verification, session) {
  const bodyFile = path.join(os.tmpdir(), `hub-repair-pr-${reproducer.id}.md`);
  const gateLines = verification.gates.map(g =>
    `- ${g.ok ? '✅' : '❌'} ${g.gate}${g.skipped ? ' (skipped)' : ''}: ${g.detail}`).join('\n');
  fs.writeFileSync(bodyFile, [
    `Automated fix from the Mac-mini self-repair venue. **Review before merging; deploy only via \`scripts/deploy.sh\`.**`,
    '',
    `## Reproducer`,
    '```json',
    JSON.stringify({
      id: reproducer.id,
      error_class: reproducer.error_class,
      error: reproducer.error.message,
      source: reproducer.source,
      constraints: reproducer.constraints,
    }, null, 2),
    '```',
    '',
    `## Verification`,
    `- ✅ reproduce: error class reproduced before the fix`,
    gateLines,
    '',
    `## Session`,
    `- Model: ${session.modelId}`,
    `- Execution: Grok CLI subscription ($${session.costUsd || 0}, ${session.turns}/${REPAIR_MAX_TURNS} turns, attempt ${session.attempt}/${MAX_REPAIR_ATTEMPTS})`,
    '',
    '🤖 Generated by the Hub self-repair venue (Grok CLI coding agent, human-gated)',
  ].join('\n'));
  const res = spawnSync('gh', ['pr', 'create', '--head', branch,
    '--title', `[self-repair] ${reproducer.error_class}: ${reproducer.error.message.slice(0, 70)}`,
    '--body-file', bodyFile,
  ], { cwd: ROOT, encoding: 'utf8' });
  try { fs.unlinkSync(bodyFile); } catch (_) { /* scratch */ }
  if (res.status !== 0) return { url: null, error: (res.stderr || '').slice(0, 500) };
  return { url: (res.stdout || '').trim().split('\n').pop(), error: null };
}

async function notifySuccess({ reproducer, branch, prUrl, verification, session, files }) {
  const gateLines = verification.gates.map(g =>
    `  ${g.ok ? '✓' : '✗'} ${g.gate}${g.skipped ? ' (skipped)' : ''}: ${g.detail.split('\n')[0]}`).join('\n');
  return sendRepairEmail({
    subject: `[Hub self-repair] ${reproducer.error_class} — PR ready`,
    text: [
      `The repair venue fixed: ${reproducer.error.message}`,
      '',
      `Branch: ${branch}`,
      `PR: ${prUrl || 'PR creation failed — branch is pushed, open the PR manually'}`,
      `Files changed: ${files.join(', ')}`,
      '',
      'Verification:',
      '  ✓ reproduce: error class reproduced before the fix',
      gateLines,
      '',
      `Execution: Grok CLI subscription ($${session.costUsd || 0}; attempt ${session.attempt}/${MAX_REPAIR_ATTEMPTS}, ${session.turns}/${REPAIR_MAX_TURNS} turns, model ${session.modelId})`,
      '',
      'Review the PR diff and merge when ready. Then: scripts/deploy.sh',
    ].join('\n'),
  });
}

async function notifyFailure({ reproducer, reason, attempts, costUsd }) {
  return sendRepairEmail({
    subject: `[Hub self-repair] could not fix ${reproducer.error_class} — needs you`,
    text: [
      `The repair venue could not fix: ${reproducer.error.message}`,
      '',
      `Error class: ${reproducer.error_class}`,
      `Subsystem: ${reproducer.source.capo} (${reproducer.source.job_type})`,
      `Attempts: ${attempts}/${MAX_REPAIR_ATTEMPTS}, Grok CLI subscription execution ($${costUsd})`,
      `Last failure: ${reason}`,
      '',
      `Reproducer: data/repair-queue/${reproducer.id}.json`,
      'The reproducer and synthetic test are ready if you want to fix it by hand.',
    ].join('\n'),
  });
}

// Attempt to repair one triaged fixable-narrow reproducer end to end.
async function repairOne(reproducer, { modelId = null } = {}) {
  if ((reproducer.repair_attempts || 0) >= MAX_REPAIR_ATTEMPTS) {
    return { status: 'exhausted', reason: 'attempt budget already spent' };
  }

  const chosenModel = grokCliModel(modelId || getSnapshotModelId(REPAIR_AGENT_FEATURE, REPAIR_AGENT_FALLBACK_MODEL));
  const worktree = createWorktree(reproducer.id);
  let totalCost = 0;
  let lastReason = '';

  try {
    // Gate 1 — the error must exist before we fix it.
    const gate1 = gateReproduce(reproducer, worktree);
    if (!gate1.ok) {
      writeRepairReceipt({
        sourceId: reproducer.id, stage: 'fix', status: 'warn',
        summary: `Self-repair: skipped ${reproducer.error_class} — ${gate1.detail}`,
        payload: {
          agent: 'hub_repair', error_class: reproducer.error_class,
          error_signature: reproducer.error_signature, result: 'not_reproduced',
          gate1, run_at: new Date().toISOString(),
        },
      });
      return { status: 'not_reproduced', reason: gate1.detail };
    }

    let feedback = null;
    for (let attempt = (reproducer.repair_attempts || 0) + 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
      reproducer.repair_attempts = attempt;
      saveReproducer(reproducer);

      const session = await runGrokSession({ worktree, reproducer, modelId: chosenModel, feedback });
      totalCost += session.costUsd || 0;
      session.modelId = chosenModel;
      session.attempt = attempt;

      if (session.status !== 'done') {
        lastReason = `Grok session ${session.status}: ${session.error || ''}`;
        feedback = null;
        // A failed session can leave the worktree half-edited: reset it.
        spawnSync('git', ['checkout', '--', '.'], { cwd: worktree });
        spawnSync('git', ['clean', '-fd'], { cwd: worktree });
        continue;
      }

      const files = changedFiles(worktree);
      const scope = checkScope(reproducer, files);
      if (!scope.ok) {
        lastReason = `scope violation: ${scope.reason}`;
        feedback = `Scope violation: ${scope.reason}. Revert to the rules: only ${reproducer.constraints.allowed_paths.join(', ')} plus one new test file in test/.`;
        spawnSync('git', ['checkout', '--', '.'], { cwd: worktree });
        spawnSync('git', ['clean', '-fd'], { cwd: worktree });
        continue;
      }

      const testFiles = files.filter(f => f.startsWith('test/'));
      const verification = verifyFix({ reproducer, worktree, testFiles });
      if (!verification.ok) {
        const failed = verification.gates.find(g => !g.ok);
        lastReason = `${failed.gate} failed: ${failed.detail.split('\n')[0]}`;
        feedback = `Verification gate "${failed.gate}" failed:\n${failed.detail}\nYour changes are still in place — fix them.`;
        // Persist the full gate output per attempt — without it a failed run
        // is undiagnosable after the worktree is cleaned up.
        writeRepairReceipt({
          sourceId: reproducer.id, stage: 'attempt', status: 'warn',
          summary: `Self-repair attempt ${attempt}: ${failed.gate} failed`,
          payload: {
            agent: 'hub_repair', error_signature: reproducer.error_signature,
            attempt, files_changed: files, failed_gate: failed.gate,
            gate_output: failed.detail.slice(0, 6000),
            execution: 'grok_cli_subscription',
            cost_usd_so_far: Number(totalCost.toFixed(4)),
            run_at: new Date().toISOString(),
          },
        });
        continue;
      }

      // All gates green — branch, push, PR, email, receipt.
      const branch = commitAndPush(reproducer, worktree, files);
      const pr = openPullRequest(reproducer, branch, verification, session);
      const email = await notifySuccess({ reproducer, branch, prUrl: pr.url, verification, session, files });

      writeRepairReceipt({
        sourceId: reproducer.id, stage: 'fix', status: 'pass',
        summary: `Self-repair: fixed ${reproducer.error_class} — PR ${pr.url || branch} awaiting review`,
        payload: {
          agent: 'hub_repair',
          error_class: reproducer.error_class,
          error_signature: reproducer.error_signature,
          capo: reproducer.source.capo,
          job_type: reproducer.source.job_type,
          reproducer_id: reproducer.id,
          branch,
          pr_url: pr.url,
          pr_error: pr.error,
          files_changed: files,
          includes_regression_test: testFiles.length > 0,
          attempts: attempt,
          execution: 'grok_cli_subscription',
          cost_usd: Number(totalCost.toFixed(4)),
          model_id: chosenModel,
          snapshot_path: reproducer.snapshot.path,
          verification: {
            reproduce: 'pass',
            ...Object.fromEntries(verification.gates.map(g => [g.gate, g.skipped ? 'skipped' : (g.ok ? 'pass' : 'fail')])),
          },
          email_sent: email.sent,
          reversible: true,
          deployed: false,
          run_at: new Date().toISOString(),
        },
      });
      return { status: 'fixed', branch, prUrl: pr.url, costUsd: totalCost, attempts: attempt };
    }

    // Attempts exhausted.
    const email = await notifyFailure({ reproducer, reason: lastReason, attempts: reproducer.repair_attempts, costUsd: Number(totalCost.toFixed(4)) });
    writeRepairReceipt({
      sourceId: reproducer.id, stage: 'fix', status: 'fail',
      summary: `Self-repair: cannot fix ${reproducer.error_class} after ${reproducer.repair_attempts} attempt(s) — escalated to Douglas`,
      payload: {
        agent: 'hub_repair',
        error_class: reproducer.error_class,
        error_signature: reproducer.error_signature,
        result: 'attempts_exhausted',
        last_failure: lastReason,
        attempts: reproducer.repair_attempts,
        execution: 'grok_cli_subscription',
        cost_usd: Number(totalCost.toFixed(4)),
        model_id: chosenModel,
        email_sent: email.sent,
        run_at: new Date().toISOString(),
      },
    });
    return { status: 'failed', reason: lastReason, costUsd: totalCost };
  } finally {
    removeWorktree(worktree);
  }
}

module.exports = {
  MAX_REPAIR_ATTEMPTS,
  REPAIR_TIMEOUT_MS,
  REPAIR_MAX_TURNS,
  MAX_FILES_CHANGED,
  REPAIR_AGENT_FEATURE,
  WORKTREES_DIR,
  grokCliModel,
  createWorktree,
  removeWorktree,
  cleanupStaleWorktrees,
  changedFiles,
  checkScope,
  buildSystemPrompt,
  buildUserPrompt,
  runGrokSession,
  repairOne,
  commitAndPush,
  openPullRequest,
  notifySuccess,
  notifyFailure,
};
