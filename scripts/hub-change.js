#!/usr/bin/env node
'use strict';

/**
 * hub-change — McLellan Hub change-management CLI.
 *
 * Usage:
 *   node scripts/hub-change.js new
 *   node scripts/hub-change.js investigate <id>
 *   node scripts/hub-change.js plan <id>
 *   node scripts/hub-change.js branch <id>
 *   node scripts/hub-change.js context <id>
 *   node scripts/hub-change.js commit <id>
 *   node scripts/hub-change.js push <id>
 *   node scripts/hub-change.js pr <id>
 *   node scripts/hub-change.js merged <id>
 *   node scripts/hub-change.js deploy <id>
 *   node scripts/hub-change.js close <id>
 *   node scripts/hub-change.js status
 *   node scripts/hub-change.js show <id>
 *   node scripts/hub-change.js log <id>
 *   node scripts/hub-change.js note <id> <text>
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');

// ─── Constants ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..');
const CHANGE_DIR = path.join(ROOT, '.hub-changes');
const SNAPSHOT_ROOT =
  process.env.HUB_SNAPSHOT_ROOT ||
  process.env.SNAPSHOT_ROOT ||
  `${process.env.HOME}/Library/Application Support/mclellan-hub/prod-snapshots`;
const VPS = process.env.VPS || 'root@178.104.235.142';
const REMOTE_APP = process.env.REMOTE_APP || '/app';
const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=/tmp/mclellan-hcchg-${process.pid}`,
  '-o', 'ControlPersist=60',
];

const STEPS = [
  'new', 'investigating', 'planned', 'branching', 'implementing',
  'committed', 'pushed', 'pr', 'merged', 'deployed', 'verifying', 'closed',
];

const BRANCH_PREFIX = {
  fix: 'fix',
  feature: 'feature',
  refactor: 'refactor',
  incident: 'repair',
  emergency: 'hotfix',
  chore: 'chore',
};

const TYPE_INFO = {
  fix:       { label: 'Bug fix',           needsInvestigate: false, needsPlan: true,  fast: false },
  feature:   { label: 'New feature',       needsInvestigate: false, needsPlan: true,  fast: false },
  refactor:  { label: 'Refactor',          needsInvestigate: false, needsPlan: true,  fast: false },
  incident:  { label: 'Live incident',     needsInvestigate: true,  needsPlan: true,  fast: false },
  emergency: { label: 'Emergency hotfix',  needsInvestigate: true,  needsPlan: true,  fast: true  },
  chore:     { label: 'Tiny/cosmetic',     needsInvestigate: false, needsPlan: false, fast: true  },
};

const AREAS = [
  'Email (Gmail)', 'AgentMail', 'Flight Tracker', 'CRM', 'Calendar',
  'Google Tasks', 'Documents / Projects', 'Knowledge Layer', 'Ingest Door',
  'External Effect Gate', 'Core Infrastructure', 'Mycelium',
  'Regulatory Monitor', 'Job Queue', 'Reminders', 'Suggestions',
  'System Report', 'Morning Briefing', 'M365 Briefing', 'US Block Special',
  'Afternoon Briefing', 'Wiki (Synthadoc)', 'URL Watchlist',
  'AI Text Humanizer', 'Model Style Profiles', 'Self-Repair (Mac)',
  'LinkedIn Content Research', 'Infrastructure / Deploy', 'Other',
];

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function makeId(date) {
  const d = date || new Date();
  const datePart = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const timePart = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return { datePart, timePart };
}

function generateId(type, area, title, date) {
  const { datePart, timePart } = makeId(date);
  const areaSlug = slugify(area || 'general').slice(0, 8);
  const titleSlug = slugify(title);
  return `${datePart}-${timePart}-${areaSlug}-${titleSlug}`;
}

function branchNameFor(type, slug) {
  const prefix = BRANCH_PREFIX[type] || 'change';
  return `${prefix}/${slug}`;
}

function requiredStepsFor(type) {
  const info = TYPE_INFO[type];
  if (!info) return STEPS.slice();
  if (info.fast) return ['new', 'branching', 'implementing', 'committed', 'merged', 'deployed', 'closed'];
  const steps = ['new'];
  if (info.needsInvestigate) steps.push('investigating');
  if (info.needsPlan) steps.push('planned');
  steps.push('branching', 'implementing', 'committed', 'pushed', 'pr', 'merged', 'deployed', 'closed');
  return steps;
}

function defaultCommitSubject(ticket) {
  const area = ticket.area ? `(${ticket.area})` : '';
  return `${ticket.type}${area}: ${ticket.title}`;
}

function formatStep(step) {
  const icons = {
    new: '●', investigating: '◌', planned: '◌', branching: '▸',
    implementing: '▸', committed: '✓', pushed: '✓', pr: '▸',
    merged: '✓', deployed: '✓', verifying: '◌', closed: '■',
  };
  return `${icons[step] || '?'} ${step}`;
}

function stepsUntilClosed(ticket) {
  const all = STEPS;
  const current = all.indexOf(ticket.step);
  return all.slice(current + 1);
}

function nextStep(ticket) {
  const all = STEPS;
  const idx = all.indexOf(ticket.step);
  if (idx < 0 || idx >= all.length - 1) return null;
  return all[idx + 1];
}

function isTerminal(ticket) {
  return ticket.step === 'closed';
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

function gitRun(args, opts) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2 ** 22,
    ...opts,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status,
  };
}

function gitDirty() {
  const r = gitRun(['status', '--porcelain']);
  return r.stdout.length > 0;
}

function currentBranch() {
  return gitRun(['rev-parse', '--abbrev-ref', 'HEAD']).stdout;
}

function gitHead() {
  return gitRun(['rev-parse', 'HEAD']).stdout;
}

function hasRemote() {
  const r = gitRun(['remote', 'get-url', 'origin']);
  return r.ok && r.stdout.length > 0;
}

function branchExists(name) {
  const r = gitRun(['rev-parse', '--verify', name]);
  return r.ok;
}

function branchMergedIntoMain(branchName) {
  const r = gitRun(['merge-base', '--is-ancestor', branchName, 'origin/main']);
  return r.ok;
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

async function getSnapshotInfo() {
  try {
    const latestLink = path.join(SNAPSHOT_ROOT, 'latest');
    const resolved = await fsp.realpath(latestLink).catch(() => null);
    if (!resolved) return { found: false, reason: 'no latest symlink' };

    const snapshotJsonPath = path.join(resolved, 'snapshot.json');
    let snapshotJson = {};
    try {
      const raw = await fsp.readFile(snapshotJsonPath, 'utf8');
      snapshotJson = JSON.parse(raw);
    } catch { /* not fatal */ }

    const deployedHeadPath = path.join(resolved, 'deployed-head.txt');
    const deployedRevPath = path.join(resolved, 'deployed-revision.txt');
    let deployedHead = '';
    let deployedRev = '';
    try { deployedHead = (await fsp.readFile(deployedHeadPath, 'utf8')).trim(); } catch { /* ok */ }
    try { deployedRev = (await fsp.readFile(deployedRevPath, 'utf8')).trim(); } catch { /* ok */ }

    const copiedAt = snapshotJson.copiedAt ? new Date(snapshotJson.copiedAt) : null;
    const ageMs = copiedAt ? Date.now() - copiedAt.getTime() : null;
    const ageHours = ageMs !== null ? Math.round(ageMs / 3600000 * 10) / 10 : null;

    return {
      found: true,
      path: resolved,
      copiedAt: copiedAt ? copiedAt.toISOString() : null,
      ageHours,
      deployedHead,
      deployedRev,
      sizeBytes: snapshotJson.sizeBytes || null,
    };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// ─── Live evidence (SSH) ─────────────────────────────────────────────────────

function fetchLiveEvidence() {
  const remoteScript = `
set -u
echo "LIVE_EVIDENCE_START"
echo "SERVICE=$(systemctl is-active hub 2>/dev/null || echo unknown)"
echo "HEAD=$(git -C ${REMOTE_APP} rev-parse HEAD 2>/dev/null || echo missing)"
echo "HEAD_DATE=$(git -C ${REMOTE_APP} log -1 --format=%cI 2>/dev/null || echo missing)"
echo "HEAD_MSG=$(git -C ${REMOTE_APP} log -1 --format=%s 2>/dev/null || echo missing)"
echo "REV=$(cat ${REMOTE_APP}/.deployed-revision 2>/dev/null || echo missing)"
echo "TREE_CLEAN=$(git -C ${REMOTE_APP} diff --quiet 2>/dev/null && echo yes || echo no)"
echo "NODE_VER=$(node --version 2>/dev/null || echo missing)"
echo "UPTIME=$(uptime -p 2>/dev/null || echo unknown)"
echo "DISK=$(df -h / | tail -1 | awk '{print $4}')"
echo ""
echo "=== JOURNAL (last 2h) ==="
journalctl -u hub.service --since '2 hours ago' --no-pager -o short-precise 2>/dev/null | tail -200 || true
echo "=== JOBS (recent errors) ==="
node -e "
const Database = require('/app/node_modules/better-sqlite3');
try {
  const db = new Database('/app/data/hub.db', { readonly: true, fileMustExist: true });
  const rows = db.prepare(\"SELECT id, type, status, run_at, error FROM system_jobs WHERE status = 'error' ORDER BY run_at DESC LIMIT 10\").all();
  console.log(rows.map(r => r.run_at + ' [' + r.type + '] ' + (r.error || '').slice(0, 150)).join('\\n'));
} catch(e) { console.log('(db error: ' + e.message + ')'); }
" 2>/dev/null || true
echo ""
echo "LIVE_EVIDENCE_END"
`;

  const result = spawnSync('ssh', [...SSH_OPTS, VPS, 'bash -s'], {
    input: remoteScript,
    encoding: 'utf8',
    maxBuffer: 2 ** 22,
    timeout: 30000,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || `exit ${result.status}`,
    };
  }

  const raw = result.stdout || '';
  const startIdx = raw.indexOf('LIVE_EVIDENCE_START');
  const endIdx = raw.indexOf('LIVE_EVIDENCE_END');
  if (startIdx < 0 || endIdx < 0) {
    return { ok: false, error: 'Could not parse live evidence output', raw };
  }

  const body = raw.slice(startIdx + 'LIVE_EVIDENCE_START'.length, endIdx).trim();
  const parsed = {};
  for (const line of body.split('\n')) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0 && eqIdx < 40 && !line.startsWith('===')) {
      const key = line.slice(0, eqIdx);
      parsed[key] = line.slice(eqIdx + 1);
    }
  }

  const journalStart = body.indexOf('=== JOURNAL');
  const jobsStart = body.indexOf('=== JOBS');
  parsed._journal = journalStart >= 0 && jobsStart >= 0
    ? body.slice(journalStart, jobsStart).trim()
    : '';
  parsed._jobs = jobsStart >= 0
    ? body.slice(jobsStart).replace(/=== JOBS[^=]*===\n?/, '').trim()
    : '';

  return { ok: true, data: parsed };
}

// ─── State helpers ────────────────────────────────────────────────────────────

async function ensureChangeDir() {
  await fsp.mkdir(CHANGE_DIR, { recursive: true });
}

function changePath(id) {
  return path.join(CHANGE_DIR, `${id}.json`);
}

function changeMdPath(id) {
  return path.join(CHANGE_DIR, `${id}.md`);
}

async function loadChange(id) {
  try {
    const raw = await fsp.readFile(changePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveChange(ticket) {
  await ensureChangeDir();
  const tmp = changePath(ticket.id) + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(ticket, null, 2) + '\n');
  await fsp.rename(tmp, changePath(ticket.id));
}

function logEvent(ticket, event) {
  if (!ticket.log) ticket.log = [];
  ticket.log.push({ ts: new Date().toISOString(), event });
}

function advanceStep(ticket, step) {
  ticket.step = step;
  logEvent(ticket, `step: ${step}`);
}

function findChangeBySlug(slug) {
  const prefix = slug.replace(/\.json$/, '');
  // exact match first
  if (fs.existsSync(changePath(prefix))) return prefix;
  // partial match
  const files = fs.readdirSync(CHANGE_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const id = f.replace('.json', '');
    if (id.includes(prefix)) return id;
  }
  return null;
}

// ─── Prompt helpers ───────────────────────────────────────────────────────────

async function askChoice(rl, prompt, choices) {
  console.log('');
  choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  console.log('');
  const ans = await rl.question(prompt);
  const n = parseInt(ans, 10);
  if (n >= 1 && n <= choices.length) return choices[n - 1];
  return ans.trim();
}

async function askConfirm(rl, prompt, defaultYes) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = (await rl.question(`${prompt} ${suffix} `)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans === 'y' || ans === 'yes';
}

async function askText(rl, prompt, defaultVal) {
  const ans = await rl.question(`${prompt}${defaultVal ? ` (${defaultVal})` : ''}: `);
  return ans.trim() || defaultVal || '';
}

async function askMultiline(rl, prompt) {
  console.log(`${prompt} (end with a blank line)`);
  const lines = [];
  while (true) {
    const line = await rl.question('  > ');
    if (line.trim() === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

async function editorPrompt(label, initialContent) {
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
  const tmpFile = path.join(CHANGE_DIR, `.edit-${process.pid}.md`);

  await ensureChangeDir();
  await fsp.writeFile(tmpFile, initialContent || `\n# ${label}\n\n`);

  const result = spawnSync(editor, [tmpFile], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  let content = '';
  try {
    content = (await fsp.readFile(tmpFile, 'utf8'))
      .split('\n')
      .filter(l => !l.startsWith('# '))
      .join('\n')
      .trim();
  } catch { /* editor may not have written */ }

  try { await fsp.unlink(tmpFile); } catch { /* cleanup best effort */ }
  return content;
}

// ─── Context bundle builder ───────────────────────────────────────────────────

function buildContextBundle(ticket, evidence, snapshot) {
  const lines = [];
  lines.push(`# Change context: ${ticket.id}`);
  lines.push('');
  lines.push(`Type: ${ticket.type} (${TYPE_INFO[ticket.type]?.label || ticket.type})`);
  lines.push(`Area: ${ticket.area}`);
  lines.push(`Title: ${ticket.title}`);
  lines.push(`Branch: ${ticket.branch || '(not yet created)'}`);
  lines.push('');
  lines.push('## Description');
  lines.push(ticket.description || '(none)');
  lines.push('');

  if (ticket.reportedAt) {
    lines.push(`Reported at: ${ticket.reportedAt}`);
  }

  if (evidence) {
    lines.push('## Live production evidence');
    lines.push('');
    if (evidence.ok) {
      const d = evidence.data;
      lines.push(`Service: ${d.SERVICE || 'unknown'}`);
      lines.push(`Deployed HEAD: ${d.HEAD || 'unknown'}`);
      lines.push(`Deployed at: ${d.HEAD_DATE || 'unknown'}`);
      lines.push(`Last commit msg: ${d.HEAD_MSG || 'unknown'}`);
      lines.push(`Deployed revision: ${d.REV || 'unknown'}`);
      lines.push(`Working tree clean: ${d.TREE_CLEAN || 'unknown'}`);
      lines.push(`Node: ${d.NODE_VER || 'unknown'}`);
      lines.push(`Disk free: ${d.DISK || 'unknown'}`);
      lines.push('');
      if (d._journal) {
        lines.push('### Recent logs');
        lines.push('```');
        lines.push(d._journal);
        lines.push('```');
      }
      if (d._jobs) {
        lines.push('### Recent error jobs');
        lines.push('```');
        lines.push(d._jobs);
        lines.push('```');
      }
    } else {
      lines.push(`**Evidence gathering failed:** ${evidence.error}`);
    }
    lines.push('');
  }

  if (snapshot && snapshot.found) {
    lines.push('## Diagnostic snapshot');
    lines.push(`Captured: ${snapshot.copiedAt || 'unknown'} (${snapshot.ageHours !== null ? snapshot.ageHours + 'h ago' : 'age unknown'})`);
    lines.push(`Deployed HEAD in snapshot: ${snapshot.deployedHead || 'unknown'}`);
    lines.push('');
  }

  if (ticket.plan) {
    lines.push('## Plan');
    lines.push(ticket.plan.proposal || '(no proposal)');
    if (ticket.plan.tests && ticket.plan.tests.length) {
      lines.push('');
      lines.push('### Tests');
      ticket.plan.tests.forEach(t => lines.push(`- ${t}`));
    }
    if (ticket.plan.risks && ticket.plan.risks.length) {
      lines.push('');
      lines.push('### Regression risks');
      ticket.plan.risks.forEach(r => lines.push(`- ${r}`));
    }
    lines.push('');
  }

  lines.push('## Hub rules — agent must follow');
  lines.push('');
  lines.push('Read before modifying any Hub code:');
  lines.push('- AGENTS.md');
  lines.push('- CLAUDE.md');
  lines.push('- ARCHITECTURE.md');
  lines.push('- MODULES.md');
  lines.push('- docs/hub-input-contract.md');
  lines.push('');
  lines.push('Knowledge-first: prefer LLM synthesis / source evidence / compiled knowledge atoms over table-first CRM logic, manual links, or raw row queries.');
  lines.push('');
  lines.push('Zero OpenRouter: production makes zero calls to OpenRouter. Do not re-add keys or fallbacks.');
  lines.push('');
  lines.push('Search the repository for existing implementations before building anything new. Do not duplicate.');
  lines.push('');
  lines.push('Effect gate: task creation only via google-tasks.js createTask with declared origin.');
  lines.push('');
  lines.push('## Instructions');
  lines.push('');
  if (ticket.type === 'incident' || ticket.type === 'emergency') {
    lines.push('Treat production as the source of truth. The snapshot may be stale.');
    lines.push('Investigate the root cause using live evidence above, then propose the smallest fix using existing Hub architecture.');
  } else {
    lines.push('Investigate the area. Propose the smallest change using existing Hub architecture. Identify risks and tests.');
  }
  lines.push('');
  lines.push('Do not implement yet. Report findings and your proposed plan first.');

  return lines.join('\n');
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdNew(args) {
  await ensureChangeDir();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const type = args.type || await askChoice(rl, 'Type: ', Object.keys(TYPE_INFO));
    const typeInfo = TYPE_INFO[type];
    if (!typeInfo) {
      console.error(`Unknown type: ${type}. Valid: ${Object.keys(TYPE_INFO).join(', ')}`);
      process.exit(1);
    }

    const area = args.area || await askChoice(rl, 'Area: ', AREAS);
    const title = args.title || await askText(rl, 'Title');
    if (!title) { console.error('Title is required.'); process.exit(1); }

    const description = args.desc || await askText(rl, 'Description (one line)', '');

    const reportedAt = (type === 'incident' || type === 'emergency')
      ? (args.reported || await askText(rl, 'When was this first noticed? (ISO date or "now")', new Date().toISOString()))
      : null;

    const id = generateId(type, area, title);
    const slug = slugify(title);
    const branch = branchNameFor(type, slug);

    console.log('');
    console.log(`  ID:     ${id}`);
    console.log(`  Type:   ${type} — ${typeInfo.label}`);
    console.log(`  Area:   ${area}`);
    console.log(`  Title:  ${title}`);
    console.log(`  Branch: ${branch}`);
    console.log('');

    const ok = await askConfirm(rl, 'Create this change?', true);
    if (!ok) { console.log('Aborted.'); return; }

    const ticket = {
      id,
      slug,
      type,
      area,
      title,
      description,
      branch,
      step: 'new',
      reportedAt,
      createdAt: new Date().toISOString(),
      createdBy: 'douglas',
      plan: null,
      evidence: null,
      pr: null,
      mergedAt: null,
      pushedAt: null,
      committedAt: null,
      deployedAt: null,
      closedAt: null,
      notes: [],
      log: [],
    };

    if (typeInfo.fast) {
      ticket.plan = { proposal: 'Fast-track: no formal plan required.', tests: [], risks: [] };
      advanceStep(ticket, 'planned');
    }

    logEvent(ticket, `created (type=${type}, area=${area})`);
    await saveChange(ticket);

    console.log('');
    console.log(`Change ${ticket.id} created.`);
    console.log('');
    console.log('Next steps:');
    const remaining = stepsUntilClosed(ticket);
    remaining.forEach(s => console.log(`  ${formatStep(s)}`));
    console.log('');
    if (typeInfo.needsInvestigate) {
      console.log(`  hub-change.js investigate ${ticket.id}`);
    }
    if (typeInfo.needsPlan || !typeInfo.fast) {
      console.log(`  hub-change.js plan ${ticket.id}`);
    }
    console.log('');
  } finally {
    rl.close();
  }
}

async function cmdPreflight() {
  console.log('');
  console.log('McLellan Hub — change preflight');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const branch = currentBranch();
  const dirty = gitDirty();
  const head = gitHead();
  const headShort = head.slice(0, 7);
  const headMsg = gitRun(['log', '-1', '--format=%s']).stdout;
  const remote = hasRemote();

  console.log(`  Branch:   ${branch}`);
  console.log(`  HEAD:     ${headShort}  ${headMsg}`);
  console.log(`  Dirty:    ${dirty ? 'YES — uncommitted changes' : 'no'}`);
  console.log(`  Remote:   ${remote ? 'yes' : 'no'}`);
  console.log('');

  if (branch === 'main' && dirty) {
    console.log('  ⚠  You are on main with uncommitted changes.');
    console.log('     Create a branch before starting work:');
    console.log('     hub-change.js new → then branch.');
    console.log('');
  }

  const snapshot = await getSnapshotInfo();
  if (snapshot.found) {
    const ageStr = snapshot.ageHours !== null ? `${snapshot.ageHours}h ago` : 'unknown age';
    console.log(`  Snapshot: ${snapshot.copiedAt}  (${ageStr})`);
    console.log(`  Snap HEAD: ${(snapshot.deployedHead || 'unknown').slice(0, 7)}`);
  } else {
    console.log(`  Snapshot: none (${snapshot.reason})`);
  }
  console.log('');

  if (remote) {
    const gh = gitRun(['ls-remote', 'origin', 'HEAD']);
    const ghHead = gh.ok ? gh.stdout.split(/\s+/)[0]?.slice(0, 7) : '?';
    console.log(`  GitHub:   ${ghHead}`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

async function cmdInvestigate(id, args) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  if (ticket.type !== 'incident' && ticket.type !== 'emergency') {
    console.log(`Investigation is not required for type "${ticket.type}". Use plan instead.`);
    return;
  }

  console.log(`Investigating: ${ticket.title}`);
  console.log('');

  const snapshot = await getSnapshotInfo();
  console.log('Fetching live production evidence...');
  const evidence = fetchLiveEvidence();

  // Build combined evidence record
  const ev = {
    snapshot,
    live: evidence,
    snapshotAgeHours: snapshot.ageHours || null,
    snapshotStalenessWarning: null,
    complete: evidence.ok,
    gatheredAt: new Date().toISOString(),
    reportedAt: ticket.reportedAt,
  };

  if (snapshot.found && ticket.reportedAt) {
    const reported = new Date(ticket.reportedAt);
    const snapDate = snapshot.copiedAt ? new Date(snapshot.copiedAt) : null;
    if (snapDate && snapDate < reported) {
      ev.snapshotStalenessWarning =
        `Snapshot is OLDER than the reported incident (snapshot: ${snapshot.copiedAt}, reported: ${ticket.reportedAt}). Do not rely on snapshot for diagnosing this failure.`;
    }
  }

  if (!evidence.ok) {
    ev.complete = false;
    ev.gap = `Live evidence could not be gathered: ${evidence.error}`;
    console.log('');
    console.log('⚠  Live evidence gathering failed:');
    console.log(`   ${evidence.error}`);
    console.log('');
  } else {
    const d = evidence.data;
    console.log('');
    console.log('  Live production:');
    console.log(`    Service:      ${d.SERVICE || '?'}`);
    console.log(`    HEAD:         ${(d.HEAD || '?').slice(0, 7)}  ${d.HEAD_MSG || ''}`);
    console.log(`    Deployed at:  ${d.HEAD_DATE || '?'}`);
    console.log(`    Rev:          ${(d.REV || '?').slice(0, 7)}`);
    console.log(`    Node:         ${d.NODE_VER || '?'}`);
    console.log(`    Disk free:    ${d.DISK || '?'}`);
    console.log('');

    if (snapshot.found) {
      const age = snapshot.ageHours !== null ? `${snapshot.ageHours}h` : '?';
      console.log(`  Snapshot: ${age} old, HEAD ${(snapshot.deployedHead || '?').slice(0, 7)}`);
      if (d.HEAD && snapshot.deployedHead && d.HEAD !== snapshot.deployedHead) {
        console.log('  ⚠  Snapshot HEAD differs from live HEAD — snapshot is stale.');
      }
      console.log('');
    }
  }

  // Write findings
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const findings = await askMultiline(rl, 'Your findings (what you observed):');
    ticket.evidence = { ...ev, findings };
    advanceStep(ticket, 'investigating');
    logEvent(ticket, `investigation complete (live_ok=${evidence.ok})`);
    await saveChange(ticket);
    console.log('');
    console.log('Investigation recorded.');
    console.log(`  hub-change.js plan ${ticket.id}`);
    console.log('');
  } finally {
    rl.close();
  }
}

async function cmdPlan(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  const typeInfo = TYPE_INFO[ticket.type];

  // Gate: incident needs investigation
  if (typeInfo.needsInvestigate && !ticket.evidence) {
    console.error(`Cannot plan a ${ticket.type} without investigation first.`);
    console.error(`Run: hub-change.js investigate ${ticket.id}`);
    process.exit(1);
  }

  if (typeInfo.needsInvestigate && ticket.evidence && !ticket.evidence.complete) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ack = await askConfirm(rl,
      '⚠  Live evidence is incomplete. Proceed to plan despite missing evidence?', false);
    rl.close();
    if (!ack) { console.log('Aborted. Gather evidence first.'); return; }
    logEvent(ticket, 'acknowledged incomplete evidence');
  }

  console.log(`Planning: ${ticket.title}`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const proposal = await askMultiline(rl, 'Plan (what you will change and why):');
    if (!proposal) { console.error('Plan is required.'); process.exit(1); }

    const testsRaw = await askMultiline(rl, 'Tests to add or run (one per line, blank to skip)');
    const tests = testsRaw ? testsRaw.split('\n').filter(Boolean) : [];

    const risksRaw = await askMultiline(rl, 'Regression risks (one per line, blank to skip)');
    const risks = risksRaw ? risksRaw.split('\n').filter(Boolean) : [];

    ticket.plan = {
      proposal,
      tests,
      risks,
      doneAt: new Date().toISOString(),
    };

    advanceStep(ticket, 'planned');
    logEvent(ticket, `plan recorded (${tests.length} tests, ${risks.length} risks)`);
    await saveChange(ticket);

    console.log('');
    console.log('Plan recorded.');
    console.log(`  hub-change.js branch ${ticket.id}`);
    console.log('');
  } finally {
    rl.close();
  }
}

async function cmdBranch(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  // Gate: clean working tree
  if (gitDirty()) {
    console.error('Working tree is dirty. Commit or stash current changes before branching.');
    console.error('  git add -A && git commit -m "WIP: ..."');
    console.error('  or: git stash');
    process.exit(1);
  }

  // Gate: plan required for non-fast types
  const typeInfo = TYPE_INFO[ticket.type];
  if (typeInfo.needsPlan && !ticket.plan) {
    console.error(`Cannot branch without a plan. Run: hub-change.js plan ${ticket.id}`);
    process.exit(1);
  }

  // Gate: don't branch on main if already on a feature branch
  const branch = currentBranch();
  if (branch !== 'main') {
    console.log(`Currently on branch: ${branch}`);
    console.log('Switching to main first...');
    const r = gitRun(['checkout', 'main']);
    if (!r.ok) {
      console.error(`Failed to switch to main: ${r.stderr}`);
      process.exit(1);
    }
  }

  // Create branch
  if (branchExists(ticket.branch)) {
    console.log(`Branch ${ticket.branch} already exists. Checking out.`);
    const r = gitRun(['checkout', ticket.branch]);
    if (!r.ok) {
      console.error(`Failed to checkout: ${r.stderr}`);
      process.exit(1);
    }
  } else {
    const r = gitRun(['checkout', '-b', ticket.branch]);
    if (!r.ok) {
      console.error(`Failed to create branch: ${r.stderr}`);
      process.exit(1);
    }
    console.log(`Created branch: ${ticket.branch}`);
  }

  advanceStep(ticket, 'branching');
  ticket.repoHeadAtBranch = gitHead();
  logEvent(ticket, `branch created: ${ticket.branch}`);
  await saveChange(ticket);

  console.log('');
  console.log('Ready for implementation.');
  console.log('  hub-change.js context <id>   — get the agent handoff bundle');
  console.log('');
}

async function cmdContext(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  const evidence = ticket.evidence || null;
  const snapshot = await getSnapshotInfo();
  const bundle = buildContextBundle(ticket, evidence, snapshot);

  // Write the md file
  await ensureChangeDir();
  await fsp.writeFile(changeMdPath(id), bundle + '\n');

  // Also print to stdout
  console.log(bundle);
  console.log('');
  console.log(`Context written to: ${changeMdPath(id)}`);
  console.log('');
}

async function cmdCommit(id, args) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  const branch = currentBranch();
  if (branch === 'main') {
    console.error('Cannot commit on main. Switch to the change branch first.');
    console.error(`  git checkout ${ticket.branch}`);
    process.exit(1);
  }

  if (!gitDirty()) {
    console.log('Nothing to commit.');
    return;
  }

  const subject = defaultCommitSubject(ticket);
  const body = `Refs: ${ticket.id}`;

  if (args.message) {
    // Use provided message
    const r = gitRun(['add', '-A']);
    if (!r.ok) { console.error(`git add failed: ${r.stderr}`); process.exit(1); }

    const cr = gitRun(['commit', '-m', `${args.message}\n\n${body}`]);
    if (!cr.ok) { console.error(`git commit failed: ${cr.stderr}`); process.exit(1); }
  } else {
    // Open editor
    const msgFile = path.join(CHANGE_DIR, `.commit-msg-${process.pid}.txt`);
    await fsp.writeFile(msgFile, `${subject}\n\n${body}\n`);
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const r = gitRun(['add', '-A']);
    if (!r.ok) { console.error(`git add failed: ${r.stderr}`); process.exit(1); }

    const cr = spawnSync('git', ['commit', '-F', msgFile], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    try { await fsp.unlink(msgFile); } catch { /* cleanup */ }
    if (cr.status !== 0) {
      console.error('Commit failed or was aborted.');
      process.exit(1);
    }
  }

  advanceStep(ticket, 'committed');
  ticket.committedAt = new Date().toISOString();
  logEvent(ticket, `committed on ${branch}`);
  await saveChange(ticket);

  console.log('');
  console.log('Committed. Next:');
  console.log(`  hub-change.js push ${ticket.id}`);
  console.log('');
}

async function cmdPush(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  const branch = currentBranch();
  if (branch !== ticket.branch) {
    console.error(`Not on branch ${ticket.branch} (currently on ${branch}).`);
    process.exit(1);
  }

  const r = gitRun(['push', '-u', 'origin', ticket.branch]);
  if (!r.ok) {
    console.error(`Push failed: ${r.stderr}`);
    process.exit(1);
  }

  advanceStep(ticket, 'pushed');
  ticket.pushedAt = new Date().toISOString();
  logEvent(ticket, `pushed to origin/${ticket.branch}`);
  await saveChange(ticket);

  console.log('Pushed. Next:');
  console.log(`  hub-change.js pr ${ticket.id}`);
  console.log('');
}

async function cmdPr(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  if (!hasRemote()) {
    console.error('No git remote configured.');
    process.exit(1);
  }

  // Build PR body from context bundle
  const evidence = ticket.evidence || null;
  const snapshot = await getSnapshotInfo();
  const bundle = buildContextBundle(ticket, evidence, snapshot);
  const bodyFile = changeMdPath(id);
  await fsp.writeFile(bodyFile, bundle + '\n');

  const title = `${ticket.type}(${ticket.area}): ${ticket.title}`;
  const footer = `\n\n---\nChange: ${ticket.id} | Type: ${ticket.type} | Area: ${ticket.area}`;

  const r = spawnSync('gh', [
    'pr', 'create',
    '--title', title,
    '--body-file', bodyFile,
    '--body', footer,
    '--base', 'main',
    '--head', ticket.branch,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2 ** 22 });

  if (r.status !== 0) {
    console.error(`PR creation failed: ${r.stderr || r.stdout}`);
    console.error('');
    console.error('You may need to push first or create the PR manually:');
    console.error(`  git push -u origin ${ticket.branch}`);
    console.error(`  gh pr create --title "${title}" --body-file ${bodyFile} --base main --head ${ticket.branch}`);
    process.exit(1);
  }

  // Parse PR URL from output
  const prUrl = (r.stdout || '').trim();
  const prMatch = prUrl.match(/https:\/\/github\.com\/.*\/pull\/(\d+)/);
  ticket.pr = {
    url: prUrl,
    number: prMatch ? parseInt(prMatch[1], 10) : null,
    createdAt: new Date().toISOString(),
  };

  advanceStep(ticket, 'pr');
  logEvent(ticket, `PR created: ${prUrl}`);
  await saveChange(ticket);

  console.log('');
  console.log(`PR created: ${prUrl}`);
  console.log('');
  console.log('After merge:');
  console.log(`  hub-change.js merged ${ticket.id}`);
  console.log('');
}

async function cmdMerged(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  // Verify branch is merged into origin/main
  const check = branchMergedIntoMain(ticket.branch);
  if (!check) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log(`Branch ${ticket.branch} does not appear merged into origin/main yet.`);
    const ok = await askConfirm(rl, 'Mark as merged anyway?', false);
    rl.close();
    if (!ok) return;
  }

  advanceStep(ticket, 'merged');
  ticket.mergedAt = new Date().toISOString();
  logEvent(ticket, 'marked as merged');
  await saveChange(ticket);

  console.log('');
  console.log('Marked as merged. Next:');
  console.log(`  hub-change.js deploy ${ticket.id}`);
  console.log('');
}

async function cmdDeploy(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  // Gate: must be on main
  const branch = currentBranch();
  if (branch !== 'main') {
    console.error(`Not on main (currently on ${branch}). Switch to main before deploying.`);
    process.exit(1);
  }

  // Gate: must be clean
  if (gitDirty()) {
    console.error('Working tree is dirty. Commit or stash before deploying.');
    process.exit(1);
  }

  // Gate: must be merged (unless emergency)
  if (ticket.type !== 'emergency' && ticket.step !== 'merged') {
    console.error(`Cannot deploy: change is at step "${ticket.step}", expected "merged".`);
    console.error(`Run: hub-change.js merged ${ticket.id}`);
    process.exit(1);
  }

  // Confirm
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ok = await askConfirm(rl,
    `Deploy ${ticket.type}: "${ticket.title}" to production via deploy.sh?`, false);
  rl.close();
  if (!ok) { console.log('Deploy aborted.'); return; }

  console.log('Deploying...');
  const r = spawnSync('bash', ['scripts/deploy.sh'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (r.status !== 0) {
    console.error('Deploy failed.');
    process.exit(1);
  }

  advanceStep(ticket, 'deployed');
  ticket.deployedAt = new Date().toISOString();
  logEvent(ticket, 'deployed to production');
  await saveChange(ticket);

  console.log('');
  console.log('Deployed. Next:');
  console.log(`  Verify production, then: hub-change.js close ${ticket.id}`);
  console.log('');
}

async function cmdClose(id, args) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  if (isTerminal(ticket)) {
    console.log('Already closed.');
    return;
  }

  // Warn if not deployed
  if (ticket.step !== 'deployed' && ticket.type !== 'chore') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = await askConfirm(rl,
      `⚠  Change is at step "${ticket.step}", not deployed. Close anyway?`, false);
    rl.close();
    if (!ok) { console.log('Aborted.'); return; }
  }

  if (args && args.note) {
    ticket.notes.push({ ts: new Date().toISOString(), text: args.note });
  }

  advanceStep(ticket, 'closed');
  ticket.closedAt = new Date().toISOString();
  logEvent(ticket, 'closed');
  await saveChange(ticket);

  console.log(`Change ${ticket.id} closed.`);
}

async function cmdStatus() {
  await ensureChangeDir();
  const files = fs.readdirSync(CHANGE_DIR).filter(f => f.endsWith('.json')).sort().reverse();

  if (files.length === 0) {
    console.log('No changes recorded.');
    return;
  }

  console.log('');
  console.log('McLellan Hub — open changes');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  for (const f of files) {
    const ticket = JSON.parse(await fsp.readFile(path.join(CHANGE_DIR, f), 'utf8'));
    const stepIcon = formatStep(ticket.step);
    const prInfo = ticket.pr ? `  PR #${ticket.pr.number || '?'}` : '';
    console.log(`  ${ticket.id}  ${stepIcon}  ${ticket.type.padEnd(10)} ${ticket.title}${prInfo}`);
  }
  console.log('');
}

async function cmdShow(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  console.log(JSON.stringify(ticket, null, 2));
  console.log('');
}

async function cmdLog(id) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  console.log('');
  console.log(`Change log: ${ticket.id}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const entry of (ticket.log || [])) {
    console.log(`  ${entry.ts}  ${entry.event}`);
  }
  console.log('');
}

async function cmdNote(id, text) {
  const ticket = await loadChange(id);
  if (!ticket) { console.error(`Change not found: ${id}`); process.exit(1); }

  if (!text) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    text = await askText(rl, 'Note');
    rl.close();
  }

  if (!text) { console.error('Note text required.'); process.exit(1); }

  ticket.notes.push({ ts: new Date().toISOString(), text });
  logEvent(ticket, `note: ${text}`);
  await saveChange(ticket);

  console.log('Note added.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  switch (cmd) {
    case 'new': {
      const parsed = {};
      for (let i = 0; i < rest.length; i += 2) {
        if (rest[i] && rest[i].startsWith('--') && rest[i + 1]) {
          parsed[rest[i].slice(2)] = rest[i + 1];
        }
      }
      await cmdNew(parsed);
      break;
    }
    case 'preflight':
      await cmdPreflight();
      break;
    case 'investigate': {
      const id = rest[0] || await promptForId('investigate');
      const parsed = {};
      for (let i = 1; i < rest.length; i += 2) {
        if (rest[i] && rest[i].startsWith('--') && rest[i + 1]) {
          parsed[rest[i].slice(2)] = rest[i + 1];
        }
      }
      await cmdInvestigate(id, parsed);
      break;
    }
    case 'plan': {
      const id = rest[0] || await promptForId('plan');
      await cmdPlan(id);
      break;
    }
    case 'branch': {
      const id = rest[0] || await promptForId('branch');
      await cmdBranch(id);
      break;
    }
    case 'context': {
      const id = rest[0] || await promptForId('context');
      await cmdContext(id);
      break;
    }
    case 'commit': {
      const id = rest[0] || await promptForId('commit');
      const parsed = {};
      for (let i = 1; i < rest.length; i += 2) {
        if (rest[i] && rest[i].startsWith('--') && rest[i + 1]) {
          parsed[rest[i].slice(2)] = rest[i + 1];
        }
      }
      await cmdCommit(id, parsed);
      break;
    }
    case 'push': {
      const id = rest[0] || await promptForId('push');
      await cmdPush(id);
      break;
    }
    case 'pr': {
      const id = rest[0] || await promptForId('pr');
      await cmdPr(id);
      break;
    }
    case 'merged': {
      const id = rest[0] || await promptForId('merged');
      await cmdMerged(id);
      break;
    }
    case 'deploy': {
      const id = rest[0] || await promptForId('deploy');
      await cmdDeploy(id);
      break;
    }
    case 'close': {
      const id = rest[0] || await promptForId('close');
      const parsed = {};
      for (let i = 1; i < rest.length; i += 2) {
        if (rest[i] === '--note' && rest[i + 1]) {
          parsed.note = rest[i + 1];
        }
      }
      await cmdClose(id, parsed);
      break;
    }
    case 'status':
      await cmdStatus();
      break;
    case 'show': {
      const id = rest[0];
      if (!id) { console.error('Usage: hub-change.js show <id>'); process.exit(1); }
      await cmdShow(id);
      break;
    }
    case 'log': {
      const id = rest[0];
      if (!id) { console.error('Usage: hub-change.js log <id>'); process.exit(1); }
      await cmdLog(id);
      break;
    }
    case 'note': {
      const id = rest[0];
      if (!id) { console.error('Usage: hub-change.js note <id> <text>'); process.exit(1); }
      await cmdNote(id, rest.slice(1).join(' '));
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

async function promptForId(action) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(`Change ID to ${action}: `);
  rl.close();
  if (!ans.trim()) { console.error('ID required.'); process.exit(1); }
  return ans.trim();
}

function printUsage() {
  console.log(`
McLellan Hub — change management

Usage:
  hub-change.js new [--type T] [--area A] [--title T] [--desc D] [--reported DATE]
  hub-change.js preflight
  hub-change.js investigate <id> [--reported DATE]
  hub-change.js plan <id>
  hub-change.js branch <id>
  hub-change.js context <id>
  hub-change.js commit <id> [--message MSG]
  hub-change.js push <id>
  hub-change.js pr <id>
  hub-change.js merged <id>
  hub-change.js deploy <id>
  hub-change.js close <id> [--note TEXT]
  hub-change.js status
  hub-change.js show <id>
  hub-change.js log <id>
  hub-change.js note <id> <text>
  hub-change.js help

Types: fix, feature, refactor, incident, emergency, chore
`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  slugify,
  makeId,
  generateId,
  branchNameFor,
  requiredStepsFor,
  defaultCommitSubject,
  formatStep,
  stepsUntilClosed,
  nextStep,
  isTerminal,
  AREAS,
  TYPE_INFO,
  STEPS,
  BRANCH_PREFIX,
};
