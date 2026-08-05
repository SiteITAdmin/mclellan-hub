'use strict';

// Phase 2 of the self-repair venue: the orchestrator. Takes a fixable-narrow
// reproducer, creates a throwaway git worktree, runs the locally authenticated
// Grok CLI (via scripts/repair/grok-runner.mjs) against it with bounded instructions, drives
// the four-gate check harness, and on success pushes a repair/<id> branch and
// opens a GitHub PR.
//
// By default it stops there and emails Douglas — a human merging the PR and
// running scripts/deploy.sh is the only deploy path. When the auto-deploy
// flag is on (see autoDeployEnabled() below), and only for a reproducer that
// already passed triage as "no judgment needed" (fixable-narrow) plus every
// verification gate (reproduced, scoped to <=3 files in its own declared
// subsystem, regression test + full suite green in an isolated worktree),
// it additionally merges its own PR, runs scripts/deploy.sh, and watches the
// VPS come back healthy — auto-reverting and redeploying the prior revision
// if it doesn't. The judgment filter is triage + the gates, same as the
// PR-only path; the only thing auto-deploy removes is waiting for Douglas to
// click merge on a fix that was never going to need his judgment anyway. The
// guardrail Douglas chose is the existing per-bug attempt/time budget
// (MAX_REPAIR_ATTEMPTS, REPAIR_TIMEOUT_MS) — no separate daily deploy cap.
//
// Runs ONLY on the Mac mini as a standalone process (scripts/run-repair.js).
// Never imported by server.js, never run inside sendSystemReport(). SSH/VPS
// access only happens inside the auto-deploy functions below, and only when
// the flag is on — with the flag off (the default) this module behaves
// exactly as before: PR opened, human merges, human runs scripts/deploy.sh.

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

// Auto-deploy is a separate flag from the venue's own on/off switch, so
// Douglas can turn "fix and open a PR" back on without also re-enabling
// unattended deploys, or vice versa.
const AUTODEPLOY_ENV = 'REPAIR_VENUE_AUTODEPLOY';
const AUTODEPLOY_FLAG_KEY = 'repair_venue_autodeploy_enabled';
const DEPLOY_HOST = process.env.REPAIR_DEPLOY_HOST || 'root@178.104.235.142';
const DEPLOY_SCRIPT = path.join(ROOT, 'scripts', 'deploy.sh');
const DEPLOY_TIMEOUT_MS = 15 * 60000;
const SSH_TIMEOUT_MS = 30000;
// After a deploy, wait this long before the first check (services take a
// moment to restart), then poll a bounded number of times before giving up
// and rolling back — this is the "or number of attempts" half of the
// guardrail Douglas asked for, applied to the health check rather than the
// fix attempt.
const HEALTH_CHECK_DELAY_MS = 20000;
const HEALTH_CHECK_RETRIES = 6;
const HEALTH_CHECK_INTERVAL_MS = 20000;

const REPAIR_AGENT_FEATURE = 'repair_agent';
const REPAIR_AGENT_FALLBACK_MODEL = 'grok-4.5';

function git(args, { cwd = ROOT } = {}) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
  }
  return (res.stdout || '').trim();
}

// Same on/off pattern as the venue's own kill switch (run-repair.js
// venueEnabled()): env var for a manual override, else a flag in the prod
// snapshot's crm_context so Douglas can flip it from the live system without
// touching code. Any read failure fails closed (auto-deploy off).
function autoDeployEnabled() {
  if (process.env[AUTODEPLOY_ENV] === '1') return true;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(SNAPSHOT_DIR, 'hub.db'), { readonly: true, fileMustExist: true });
    const row = db.prepare(
      "SELECT value FROM crm_context WHERE user = 'system' AND key = ?"
    ).get(AUTODEPLOY_FLAG_KEY);
    db.close();
    return row?.value === '1';
  } catch (_) {
    return false;
  }
}

function ssh(command, { timeout = SSH_TIMEOUT_MS } = {}) {
  const res = spawnSync(
    'ssh',
    ['-o', 'StrictHostKeyChecking=accept-new', '-o', `ConnectTimeout=10`, DEPLOY_HOST, command],
    { encoding: 'utf8', timeout },
  );
  return { ok: res.status === 0, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

// The revision live on the VPS right now, captured BEFORE we deploy the fix,
// so a failed health check has something concrete to roll back to. Returns
// null (not throws) on any failure — callers must treat a null previous
// revision as "cannot safely auto-revert" and escalate instead of guessing.
function currentDeployedRevision() {
  const res = ssh('cat /app/.deployed-revision');
  return res.ok && res.stdout ? res.stdout : null;
}

// Merges the repair's own PR via gh (squash, matching the single-commit
// history the rest of the repo uses), then brings the local ROOT checkout
// (the real Mac-mini working copy scripts/deploy.sh runs from, NOT the
// throwaway worktree) up to date with it — deploy.sh expects a clean, current
// `main` and pushes whatever is already there.
function mergeAndSyncMain(branch) {
  const merge = spawnSync('gh', ['pr', 'merge', branch, '--squash', '--delete-branch'], { cwd: ROOT, encoding: 'utf8' });
  if (merge.status !== 0) {
    return { ok: false, error: `gh pr merge failed: ${(merge.stderr || merge.stdout || '').slice(0, 500)}` };
  }
  try {
    git(['checkout', 'main']);
    git(['pull', '--ff-only', 'origin', 'main']);
  } catch (err) {
    return { ok: false, error: `main checkout/pull after merge failed: ${err.message}` };
  }
  if (git(['status', '--porcelain'])) {
    return { ok: false, error: 'ROOT checkout is not clean after merge — refusing to deploy over local changes' };
  }
  return { ok: true, sha: git(['rev-parse', 'HEAD']) };
}

function runDeployScript() {
  const res = spawnSync(DEPLOY_SCRIPT, [], { cwd: ROOT, encoding: 'utf8', timeout: DEPLOY_TIMEOUT_MS });
  return { ok: res.status === 0, output: `${res.stdout || ''}\n${res.stderr || ''}`.trim().slice(-4000) };
}

// The only signal available without new remote infrastructure: the service
// came back up and stayed up. This is weaker than re-running the exact check
// that flagged the original error (that check reads the live prod DB, which
// this Mac-mini process never touches), so it catches "the deploy broke the
// service" but not "the deploy left the original bug half-fixed" — the venue
// already proved the fix against a snapshot and the full suite before it ever
// got here; this step is a smoke test, not a re-verification of the bug.
async function waitForHealthyDeploy() {
  await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_DELAY_MS));
  for (let attempt = 1; attempt <= HEALTH_CHECK_RETRIES; attempt++) {
    const res = ssh('systemctl is-active hub');
    if (res.ok && res.stdout === 'active') return { ok: true, attempts: attempt };
    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
  }
  return { ok: false, attempts: HEALTH_CHECK_RETRIES, reason: 'hub.service did not report active after deploy' };
}

// Revert the squashed merge commit (keeps history append-only, matching the
// "prefer reversible ops" rule) and redeploy, so the VPS ends up back on the
// revision it was running before this attempt. If we never captured a
// previous revision, or the revert/redeploy itself fails, this returns
// ok:false — the caller must escalate to Douglas rather than leave the VPS
// in an unknown state silently.
function revertAndRedeploy(mergeSha, previousRevision) {
  if (!previousRevision) {
    return { ok: false, error: 'no previous revision was captured before deploying — cannot auto-revert safely' };
  }
  try {
    git(['revert', '--no-edit', mergeSha]);
    git(['push', 'origin', 'main']);
  } catch (err) {
    return { ok: false, error: `git revert/push failed: ${err.message}` };
  }
  const deploy = runDeployScript();
  if (!deploy.ok) {
    return { ok: false, error: `revert commit pushed but redeploy failed: ${deploy.output}` };
  }
  return { ok: true };
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

// The auto-deploy path for a reproducer that already has an open, verified
// PR. Every step (read previous revision, merge, deploy, health-check,
// revert) can fail on its own, and each failure gets a distinct email and
// receipt outcome rather than one generic "something went wrong" — a
// half-completed deploy that reads as routine is exactly the silent-failure
// class this project's rules warn against.
async function autoDeployAndVerify({ reproducer, branch, pr, verification, session, attempt }) {
  const previousRevision = currentDeployedRevision();
  if (!previousRevision) {
    await sendRepairEmail({
      subject: `[Hub self-repair] ${reproducer.error_class} — PR ready but NOT auto-deployed`,
      text: [
        `The repair venue fixed: ${reproducer.error.message}`,
        '',
        `Branch: ${branch}`,
        `PR: ${pr.url || 'PR creation failed — branch is pushed, open the PR manually'}`,
        '',
        `Auto-deploy is on, but the venue could not read the currently deployed revision from `
          + `${DEPLOY_HOST} (/app/.deployed-revision), so it has nothing safe to roll back to if the `
          + 'deploy goes wrong. Stopped before merging.',
        '',
        'Review and merge the PR yourself, then: scripts/deploy.sh',
      ].join('\n'),
    });
    return {
      status: 'pr_only_no_revision',
      receiptStatus: 'warn',
      summary: `Self-repair: fixed ${reproducer.error_class} — PR ${pr.url || branch} awaiting review (auto-deploy skipped: could not read deployed revision)`,
      payload: { deployed: false, auto_deploy_attempted: true, auto_deploy_error: 'could not read /app/.deployed-revision' },
    };
  }

  const merge = mergeAndSyncMain(branch);
  if (!merge.ok) {
    await sendRepairEmail({
      subject: `[Hub self-repair] ${reproducer.error_class} — PR ready but auto-merge failed`,
      text: [
        `The repair venue fixed: ${reproducer.error.message}`,
        '',
        `Branch: ${branch}`,
        `PR: ${pr.url || 'PR creation failed — branch is pushed, open the PR manually'}`,
        '',
        `Auto-deploy is on, but merging failed: ${merge.error}`,
        '',
        'Review and merge the PR yourself, then: scripts/deploy.sh',
      ].join('\n'),
    });
    return {
      status: 'pr_only_merge_failed',
      receiptStatus: 'warn',
      summary: `Self-repair: fixed ${reproducer.error_class} — PR ${pr.url || branch} awaiting review (auto-merge failed)`,
      payload: { deployed: false, auto_deploy_attempted: true, auto_deploy_error: merge.error },
    };
  }

  const deploy = runDeployScript();
  if (!deploy.ok) {
    await sendRepairEmail({
      subject: `[Hub self-repair] ${reproducer.error_class} — merged but deploy FAILED`,
      text: [
        `The repair venue fixed and merged: ${reproducer.error.message}`,
        '',
        `Merged to main: ${merge.sha}`,
        `Previous deployed revision (still live on the VPS): ${previousRevision}`,
        '',
        'scripts/deploy.sh failed:',
        deploy.output,
        '',
        'main now contains the fix but the VPS is still running the previous revision.',
        'Run scripts/deploy.sh by hand once the problem above is resolved.',
      ].join('\n'),
    });
    return {
      status: 'merged_deploy_failed',
      receiptStatus: 'fail',
      summary: `Self-repair: fixed ${reproducer.error_class}, merged to main, but deploy FAILED — VPS still on previous revision`,
      payload: {
        deployed: false, auto_deploy_attempted: true, merged: true, merge_sha: merge.sha,
        previous_revision: previousRevision, auto_deploy_error: deploy.output,
      },
    };
  }

  const health = await waitForHealthyDeploy();
  if (health.ok) {
    const email = await sendRepairEmail({
      subject: `[Hub self-repair] ${reproducer.error_class} — auto-deployed and healthy`,
      text: [
        `The repair venue fixed, merged, and deployed: ${reproducer.error.message}`,
        '',
        `Branch: ${branch} (merged and deleted)`,
        `PR: ${pr.url || branch}`,
        `Deployed revision: ${merge.sha}`,
        `Previous revision (still in git history if you need it): ${previousRevision}`,
        `Health check: hub.service active after ${health.attempts} check(s)`,
        '',
        'Verification before deploy:',
        '  ✓ reproduce: error class reproduced before the fix',
        ...verification.gates.map(g => `  ${g.ok ? '✓' : '✗'} ${g.gate}${g.skipped ? ' (skipped)' : ''}: ${g.detail.split('\n')[0]}`),
        '',
        `Execution: Grok CLI subscription ($${session.costUsd || 0}; attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}, model ${session.modelId})`,
        '',
        `If this caused a problem: git revert --no-edit ${merge.sha} && git push origin main && scripts/deploy.sh`,
      ].join('\n'),
    });
    return {
      status: 'deployed',
      receiptStatus: 'pass',
      summary: `Self-repair: fixed, merged, and deployed ${reproducer.error_class} — VPS healthy`,
      payload: {
        deployed: true, auto_deploy_attempted: true, merged: true, merge_sha: merge.sha,
        previous_revision: previousRevision, health_check: health, email_sent: email.sent,
      },
    };
  }

  // Unhealthy — revert.
  const revert = revertAndRedeploy(merge.sha, previousRevision);
  if (revert.ok) {
    await sendRepairEmail({
      subject: `[Hub self-repair] ${reproducer.error_class} — auto-deploy failed health check, auto-reverted`,
      text: [
        `The repair venue deployed a fix for: ${reproducer.error.message}`,
        '',
        `Deployed revision ${merge.sha} did not pass the post-deploy health check: ${health.reason}`,
        `Automatically reverted and redeployed the previous state (${previousRevision}). The VPS should be back to normal.`,
        '',
        `The fix itself is still on GitHub (a revert commit on main, nothing deleted) if you want to `
          + `pick it up by hand: ${pr.url || branch}`,
      ].join('\n'),
    });
    return {
      status: 'reverted',
      receiptStatus: 'fail',
      summary: `Self-repair: deployed ${reproducer.error_class} fix failed health check — auto-reverted successfully`,
      payload: {
        deployed: false, auto_deploy_attempted: true, merged: true, merge_sha: merge.sha,
        previous_revision: previousRevision, health_check: health, reverted: true,
      },
    };
  }

  // Worst case: deployed something unhealthy AND could not revert. This needs
  // Douglas immediately — say so plainly rather than let it read like a
  // routine failure email.
  await sendRepairEmail({
    subject: '[Hub self-repair] URGENT — auto-deploy unhealthy and auto-revert FAILED',
    text: [
      `The repair venue deployed a fix for: ${reproducer.error.message}`,
      '',
      `Deployed revision ${merge.sha} did not pass the post-deploy health check: ${health.reason}`,
      `Auto-revert also failed: ${revert.error}`,
      '',
      `The VPS may currently be running a broken deploy. Please check it now: ssh ${DEPLOY_HOST} 'systemctl status hub'`,
      `To roll back by hand: git revert --no-edit ${merge.sha} && git push origin main && scripts/deploy.sh`,
      `(previous known-good revision: ${previousRevision})`,
    ].join('\n'),
  });
  return {
    status: 'revert_failed',
    receiptStatus: 'fail',
    summary: `Self-repair: URGENT — deployed ${reproducer.error_class} fix is unhealthy and auto-revert FAILED, needs immediate attention`,
    payload: {
      deployed: true, auto_deploy_attempted: true, merged: true, merge_sha: merge.sha,
      previous_revision: previousRevision, health_check: health, reverted: false, revert_error: revert.error,
    },
  };
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

      // All gates green — branch, push, PR.
      const branch = commitAndPush(reproducer, worktree, files);
      const pr = openPullRequest(reproducer, branch, verification, session);
      const baseReceiptPayload = {
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
        reversible: true,
      };

      if (!autoDeployEnabled()) {
        const email = await notifySuccess({ reproducer, branch, prUrl: pr.url, verification, session, files });
        writeRepairReceipt({
          sourceId: reproducer.id, stage: 'fix', status: 'pass',
          summary: `Self-repair: fixed ${reproducer.error_class} — PR ${pr.url || branch} awaiting review`,
          payload: { ...baseReceiptPayload, email_sent: email.sent, deployed: false, run_at: new Date().toISOString() },
        });
        return { status: 'fixed', branch, prUrl: pr.url, costUsd: totalCost, attempts: attempt };
      }

      // Auto-deploy path. Every step from here can fail independently, and
      // each failure mode gets its own outcome + email — a silent partial
      // deploy is exactly the failure class CLAUDE.md warns about, so nothing
      // here is allowed to just fall through.
      const outcome = await autoDeployAndVerify({ reproducer, branch, pr, verification, session, attempt });
      writeRepairReceipt({
        sourceId: reproducer.id, stage: 'fix', status: outcome.receiptStatus,
        summary: outcome.summary,
        payload: { ...baseReceiptPayload, ...outcome.payload, run_at: new Date().toISOString() },
      });
      if (outcome.status === 'deployed') {
        return { status: 'deployed', branch, prUrl: pr.url, costUsd: totalCost, attempts: attempt };
      }
      return { status: outcome.status, branch, prUrl: pr.url, reason: outcome.summary, costUsd: totalCost, attempts: attempt };
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
  autoDeployEnabled,
  mergeAndSyncMain,
  runDeployScript,
  waitForHealthyDeploy,
  revertAndRedeploy,
  currentDeployedRevision,
  autoDeployAndVerify,
  AUTODEPLOY_ENV,
  AUTODEPLOY_FLAG_KEY,
  HEALTH_CHECK_RETRIES,
};
