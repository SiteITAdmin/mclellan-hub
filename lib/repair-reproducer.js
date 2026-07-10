'use strict';

// Phase 0 of the self-repair venue: turn narrow runtime failures found in the
// nightly prod snapshot into structured, reproducible packages that the triage
// classifier (lib/repair-triage.js) and the repair venue (lib/repair-venue.js)
// consume. This module runs ONLY on the Mac mini against a snapshot copy of
// the production DB — it never opens the live DB and never writes to it.
//
// Error sources, in priority order:
//   1. processing_failures — per-message failures with attempt counts
//   2. system_jobs.error   — stack/messages from failed job runs
//   3. hub.service.log     — runtime error lines captured with the snapshot
//
// Receipts are JSON files in data/repair-receipts/ (same field shape as
// writeAgentReceipt payloads), NOT rows in the production knowledge_receipts
// table: the venue works against a snapshot, so DB writes would land in the
// copy and silently vanish. Files are the only channel that reaches Douglas.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const QUEUE_DIR = path.join(ROOT, 'data', 'repair-queue');
const RECEIPTS_DIR = path.join(ROOT, 'data', 'repair-receipts');
const SNAPSHOT_DIR = path.join(ROOT, 'data', 'prod-snapshots', 'latest');

const SOURCE_KIND = 'hub_repair';
const STAGE_PREFIX = 'agent:repair';

// Same error can't be re-attempted within this window after a failed repair.
const REPAIR_WINDOW_SECONDS = 7 * 86400;
// Bound the queue per mining run — the venue is a scalpel, not a backlog.
const MAX_REPRODUCERS_PER_RUN = 3;

// Paths a repair may never touch, whatever the stack trace says.
const FORBIDDEN_PATHS = [
  'package.json', 'package-lock.json', 'lib/db.js', '.env', 'config/',
  'data/', 'backups/', 'exports/', 'scripts/deploy.sh', 'scripts/repair/',
];

// Known narrow error classes. `deterministic` says whether re-running the
// failing flow against the snapshot reproduces the error (data-dependent bug)
// or whether the trigger is a model response we can only mock (synthetic test
// is then the primary proof — the model may behave this time).
const ERROR_CLASSES = [
  {
    name: 'response_shape_guard',
    pattern: /(.{0,80}?)\s*must be a JSON object/,
    deterministic: false,
    // parseModelObject received valid JSON of the wrong shape (null / array /
    // scalar). The parsing path must retry or fail visibly — this is code's
    // job regardless of which model is on the slot.
    fixable: true,
  },
  {
    name: 'json_parse_failure',
    pattern: /(.{0,80}?)\s*was not valid JSON/,
    deterministic: false,
    // The model emitted broken JSON that survived every repair pass in
    // parseModelObject — truncation or garbage. That is a model problem, not
    // a code problem; a code "fix" here would be a silent-failure guard.
    fixable: false,
    verdictHint: 'config_fix',
  },
  {
    name: 'undefined_field_access',
    pattern: /Cannot read propert(?:y|ies) of (?:undefined|null)\s*\(reading '([^']+)'\)/,
    deterministic: false,
    fixable: true,
  },
  {
    name: 'missing_null_guard',
    pattern: /(\S+) is not a function/,
    deterministic: false,
    fixable: true,
  },
  {
    name: 'schema_error',
    pattern: /no such (?:column|table): (\S+)/,
    deterministic: true,
    // Schema drift needs a migration in lib/db.js — human territory.
    fixable: false,
    verdictHint: 'escalate',
  },
  {
    name: 'transient_network',
    pattern: /aborted due to timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i,
    deterministic: false,
    // Existing remediation retries cover these; a code fix has nothing to fix.
    fixable: false,
    verdictHint: 'skip',
  },
  {
    name: 'upstream_http_error',
    pattern: /(?:OpenRouter|AgentMail|Gmail API)\s+(\d{3})/,
    deterministic: false,
    fixable: false,
    verdictHint: 'skip',
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function ensureDirs() {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}

function classifyError(message) {
  const text = String(message || '');
  for (const cls of ERROR_CLASSES) {
    const match = cls.pattern.exec(text);
    if (match) {
      // Log lines prefix the real message with routing context ("[email]
      // classify error for message <id>: ..."); the call-site label is
      // whatever follows the last colon.
      const label = (match[1] || '').split(': ').pop().trim() || null;
      return {
        error_class: cls.name,
        deterministic: cls.deterministic,
        fixable: cls.fixable,
        verdictHint: cls.verdictHint || null,
        label,
      };
    }
  }
  return { error_class: 'unclassified', deterministic: false, fixable: false, verdictHint: 'escalate', label: null };
}

// A stable identity for "this exact failure mode" across runs. The same
// failure surfaces with different wrappers (processing_failures stores the
// bare message, service-log lines prefix routing context), so prefer the
// call-site label over the raw message; fall back to the message with
// volatile parts (ids, positions, numbers) normalised out.
function errorSignature(errorClass, message, label = null) {
  if (label) return `${errorClass}::${label}`;
  const normalised = String(message || '')
    .replace(/position \d+/g, 'position N')
    .replace(/line \d+ column \d+/g, 'line N column N')
    .replace(/[0-9a-f]{8,}/gi, 'ID')
    .replace(/\d{3,}/g, 'N')
    .slice(0, 200);
  return `${errorClass}::${normalised}`;
}

// Find which source files raise this error, by grepping lib/ for the literal
// pieces of the message. Error labels in this codebase are call-site string
// literals passed to parseModelObject, so a literal search is a reliable way
// to confine the fix scope without a stack trace — snapshot logs and
// processing_failures store messages only.
function locateErrorSource(message, label) {
  const libDir = path.join(ROOT, 'lib');
  const candidates = [];
  const needles = [];
  if (label) needles.push(label);
  const generic = String(message || '')
    .replace(/^.*?:\s*/, '')
    .replace(/position \d+.*$/, '')
    .trim()
    .slice(0, 60);
  if (generic.length >= 15) needles.push(generic);

  let files = [];
  try {
    // The venue's own modules are never repair targets (and mention error
    // phrases in comments/patterns), so keep them out of the scope search.
    files = fs.readdirSync(libDir).filter(f => f.endsWith('.js') && !f.startsWith('repair-'));
  } catch (_) {
    return [];
  }
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(libDir, file), 'utf8');
    } catch (_) { continue; }
    for (const needle of needles) {
      if (needle && text.includes(needle)) {
        candidates.push(`lib/${file}`);
        break;
      }
    }
  }
  return [...new Set(candidates)].slice(0, 3);
}

function stripJournalPrefix(line) {
  return String(line || '').replace(/^\w{3}\s+\d+\s+[\d:]{8}\s+\S+\s+\S+\[\d+\]:\s*/, '');
}

// Tag → subsystem attribution for service-log lines.
const LOG_TAGS = {
  '[email]': { capo: 'email', job_type: 'email_process' },
  '[email-sent]': { capo: 'email', job_type: 'email_process' },
  '[agentmail]': { capo: 'agentmail', job_type: 'agentmail_process' },
  '[newsletter]': { capo: 'intelligence', job_type: 'newsletter_poll' },
  '[content]': { capo: 'content', job_type: 'content_pipeline' },
  '[crm]': { capo: 'crm', job_type: 'crm_knowledge_engine' },
  '[tasks]': { capo: 'tasks', job_type: 'task_route_run' },
};

function sourceForJobType(type) {
  const t = String(type || '');
  if (t.includes('email')) return { capo: 'email' };
  if (t.includes('agentmail')) return { capo: 'agentmail' };
  if (t.includes('task')) return { capo: 'tasks' };
  if (t.includes('crm')) return { capo: 'crm' };
  return { capo: 'hub' };
}

// Mine the three snapshot sources for candidate failures. Returns raw
// candidates; buildReproducers dedupes, filters, and packages them.
function mineSnapshot({ snapshotDir = SNAPSHOT_DIR, sinceSeconds = 3 * 86400 } = {}) {
  const dbPath = path.join(snapshotDir, 'hub.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No snapshot DB at ${dbPath} — run scripts/pull-prod-snapshot.sh first`);
  }
  const since = Math.floor(Date.now() / 1000) - sinceSeconds;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const candidates = [];

  try {
    const failures = db.prepare(`
      SELECT source, external_id, attempts, last_error, last_failed_at, resolved_at
      FROM processing_failures
      WHERE last_failed_at >= ?
      ORDER BY (resolved_at IS NULL) DESC, attempts DESC, last_failed_at DESC
      LIMIT 50
    `).all(since);
    for (const row of failures) {
      candidates.push({
        origin: 'processing_failures',
        capo: row.source === 'gmail' ? 'email' : row.source,
        job_type: row.source === 'gmail' ? 'email_process' : `${row.source}_process`,
        message: row.last_error,
        attempts: row.attempts,
        resolved: row.resolved_at != null,
        // Never the raw content — a hash is enough to point at the instance.
        sample_input_hash: sha256(`${row.source}:${row.external_id}`),
        observed_at: row.last_failed_at,
      });
    }
  } catch (_) { /* table may not exist in old snapshots */ }

  try {
    const jobs = db.prepare(`
      SELECT type, error, ran_at
      FROM system_jobs
      WHERE status = 'failed' AND error IS NOT NULL AND ran_at >= ?
      ORDER BY ran_at DESC
      LIMIT 50
    `).all(since);
    for (const row of jobs) {
      candidates.push({
        origin: 'system_jobs',
        ...sourceForJobType(row.type),
        job_type: row.type,
        message: row.error,
        attempts: 1,
        resolved: false,
        sample_input_hash: null,
        observed_at: row.ran_at,
      });
    }
  } catch (_) { /* ignore */ }

  // Which models served each model slot recently — triage Step 0 uses this to
  // judge whether a failure correlates with a single model.
  let modelUsage = [];
  try {
    modelUsage = db.prepare(`
      SELECT model_key, model_id, COUNT(*) AS calls
      FROM request_logs
      WHERE created_at >= datetime(?, 'unixepoch')
      GROUP BY model_key, model_id
    `).all(since);
  } catch (_) {
    try {
      modelUsage = db.prepare(`
        SELECT model_key, model_id, COUNT(*) AS calls
        FROM request_logs
        GROUP BY model_key, model_id
        LIMIT 100
      `).all();
    } catch (_2) { /* ignore */ }
  }

  db.close();

  const logPath = path.join(snapshotDir, 'hub.service.log');
  if (fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const raw of lines) {
      if (!/error|failed|exception/i.test(raw)) continue;
      const line = stripJournalPrefix(raw);
      // Skip content that merely talks about errors (briefing/report bodies).
      const tag = Object.keys(LOG_TAGS).find(t => line.startsWith(t));
      if (!tag) continue;
      const cls = classifyError(line);
      if (cls.error_class === 'unclassified') continue;
      candidates.push({
        origin: 'service_log',
        ...LOG_TAGS[tag],
        message: line.slice(0, 500),
        attempts: 1,
        resolved: false,
        sample_input_hash: null,
        observed_at: null,
      });
    }
  }

  return { candidates, modelUsage };
}

function receiptPath(id) {
  return path.join(RECEIPTS_DIR, `${id}.json`);
}

function writeRepairReceipt({ sourceId, stage, status, summary, payload }) {
  ensureDirs();
  const receipt = {
    sourceKind: SOURCE_KIND,
    sourceId,
    stage: `${STAGE_PREFIX}:${stage}`,
    status,
    summary,
    payload,
    created_at: new Date().toISOString(),
  };
  const file = receiptPath(`${sourceId}-${stage}-${Date.now()}`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
  return file;
}

function listReceipts() {
  ensureDirs();
  const out = [];
  for (const file of fs.readdirSync(RECEIPTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, file), 'utf8')));
    } catch (_) { /* skip corrupt receipts */ }
  }
  return out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// History of the venue's own past work on a failure signature, from the
// receipt files. Drives the recurrence rule (a previously "fixed" error that
// comes back means the fix was wrong — escalate, don't loop) and the 7-day
// re-attempt window.
function repairHistory(signature) {
  const receipts = listReceipts().filter(r => r.payload?.error_signature === signature);
  const now = Date.now() / 1000;
  const windowStart = now - REPAIR_WINDOW_SECONDS;
  return {
    everFixed: receipts.some(r => r.stage.endsWith(':fix') && r.status === 'pass'),
    failedRecently: receipts.some(r =>
      r.stage.endsWith(':fix') && r.status === 'fail'
      && Date.parse(r.created_at) / 1000 >= windowStart),
    attempts: receipts.filter(r => r.stage.endsWith(':fix')).length,
  };
}

function reproducerId(errorClass, label, signature) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = String(label || errorClass)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  // Signature hash keeps same-day ids for different failures from colliding.
  return `repair-${day}-${slug || errorClass}-${sha256(signature).slice(0, 8)}`;
}

// The synthetic mock test for nondeterministic model-response errors. It
// reproduces the error class by feeding the recorded bad shape into the guard
// path — it never calls a model. Written next to the reproducer so
// scripts/test-repair.js and Gate 1 of the check harness can run it.
function syntheticTestSource(reproducer) {
  const label = reproducer.triggering_input.label || 'AI response';
  if (reproducer.error_class === 'response_shape_guard') {
    return `'use strict';
// Auto-generated Gate 1 reproduction for ${reproducer.id}.
// Proves the recorded error occurs when the model returns a wrong-shape
// (but valid) JSON response. Passing = error reproduced.
const test = require('node:test');
const assert = require('node:assert');
const { parseModelObject } = require(process.env.REPAIR_TARGET_ROOT + '/lib/model-response.js');

for (const bad of ['null', '[]', '[1,2]', '"just a string"', '42']) {
  test('parseModelObject rejects wrong-shape response ' + bad, () => {
    assert.throws(
      () => parseModelObject(bad, {}, ${JSON.stringify(label)}),
      /must be a JSON object/,
    );
  });
}
`;
  }
  return null;
}

// Build reproducer packages from the mined candidates. One per distinct error
// signature; skips signatures already queued, recently failed, or previously
// "fixed" (recurrence — those escalate via triage instead of re-entering).
function buildReproducers({ snapshotDir = SNAPSHOT_DIR, limit = MAX_REPRODUCERS_PER_RUN } = {}) {
  ensureDirs();
  const { candidates, modelUsage } = mineSnapshot({ snapshotDir });
  const dbPath = path.join(snapshotDir, 'hub.db');
  const dbHash = sha256(fs.readFileSync(dbPath));

  const seen = new Set();
  const queued = new Set(
    fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, f), 'utf8')).error_signature; }
        catch (_) { return null; }
      }).filter(Boolean),
  );

  const built = [];
  const skipped = [];

  for (const candidate of candidates) {
    if (built.length >= limit) break;
    const cls = classifyError(candidate.message);
    const signature = errorSignature(cls.error_class, candidate.message, cls.label);
    if (seen.has(signature)) continue;
    seen.add(signature);

    if (queued.has(signature)) { skipped.push({ signature, reason: 'already_queued' }); continue; }
    const history = repairHistory(signature);
    if (history.failedRecently) { skipped.push({ signature, reason: 'failed_within_window' }); continue; }

    const allowedPaths = locateErrorSource(candidate.message, cls.label);
    const id = reproducerId(cls.error_class, cls.label, signature);

    const reproducer = {
      id,
      created_at: new Date().toISOString(),
      error_class: cls.error_class,
      error_signature: signature,
      source: {
        origin: candidate.origin,
        capo: candidate.capo,
        job_type: candidate.job_type,
        attempts_observed: candidate.attempts,
        resolved_in_prod: candidate.resolved,
      },
      error: {
        message: String(candidate.message).slice(0, 1000),
        located_files: allowedPaths,
      },
      triggering_input: {
        label: cls.label,
        sample_input_hash: candidate.sample_input_hash,
        description: `${cls.error_class} observed via ${candidate.origin}`,
      },
      model_usage: modelUsage,
      snapshot: {
        path: path.relative(ROOT, snapshotDir),
        db_hash: dbHash,
      },
      reproduction: {
        deterministic: cls.deterministic,
        synthetic_test: null,
        command: `node scripts/test-repair.js --reproducer ${id}`,
      },
      classification: {
        fixable: cls.fixable,
        verdict_hint: cls.verdictHint,
      },
      history,
      repair_attempts: 0,
      constraints: {
        max_files_changed: 3,
        allowed_paths: allowedPaths,
        forbidden: FORBIDDEN_PATHS,
      },
    };

    const testSource = syntheticTestSource(reproducer);
    if (testSource) {
      const testFile = path.join(QUEUE_DIR, `${id}.gate1.test.js`);
      fs.writeFileSync(testFile, testSource);
      reproducer.reproduction.synthetic_test = path.relative(ROOT, testFile);
    }

    fs.writeFileSync(path.join(QUEUE_DIR, `${id}.json`), JSON.stringify(reproducer, null, 2) + '\n');
    writeRepairReceipt({
      sourceId: id,
      stage: 'reproducer',
      status: 'pass',
      summary: `Self-repair: built reproducer for ${cls.error_class} (${candidate.origin})`,
      payload: {
        agent: SOURCE_KIND,
        error_class: cls.error_class,
        error_signature: signature,
        origin: candidate.origin,
        capo: candidate.capo,
        located_files: allowedPaths,
        synthetic_test: reproducer.reproduction.synthetic_test,
        snapshot_hash: dbHash,
        run_at: new Date().toISOString(),
      },
    });
    built.push(reproducer);
  }

  return { built, skipped, candidatesFound: candidates.length };
}

function loadReproducer(id) {
  const file = path.join(QUEUE_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`No reproducer at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveReproducer(reproducer) {
  ensureDirs();
  fs.writeFileSync(
    path.join(QUEUE_DIR, `${reproducer.id}.json`),
    JSON.stringify(reproducer, null, 2) + '\n',
  );
}

function listReproducers() {
  ensureDirs();
  return fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(QUEUE_DIR, f), 'utf8')); }
      catch (_) { return null; }
    })
    .filter(Boolean);
}

module.exports = {
  ERROR_CLASSES,
  FORBIDDEN_PATHS,
  MAX_REPRODUCERS_PER_RUN,
  REPAIR_WINDOW_SECONDS,
  QUEUE_DIR,
  RECEIPTS_DIR,
  SNAPSHOT_DIR,
  SOURCE_KIND,
  classifyError,
  errorSignature,
  locateErrorSource,
  mineSnapshot,
  buildReproducers,
  loadReproducer,
  saveReproducer,
  listReproducers,
  writeRepairReceipt,
  listReceipts,
  repairHistory,
};
