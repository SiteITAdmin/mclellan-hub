'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const db = require('../lib/db');
const { runModelText } = require('../lib/model-transport');
const {
  containJobCadenceLoops,
  jobCadenceStats,
  promptFingerprint,
  workLoopHealth,
  workLoopReportLines,
} = require('../lib/work-loop-guard');
const { usageWatchSection } = require('../lib/system-report');
const jobs = require('../lib/job-queue');

const originalHub = db.hub;
const mem = new Database(':memory:');

mem.exec(`
  CREATE TABLE request_logs (
    id TEXT PRIMARY KEY, ts INTEGER DEFAULT (unixepoch()), user TEXT,
    model_key TEXT, model_id TEXT, endpoint TEXT, search_provider TEXT,
    tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0, duration_ms INTEGER, status TEXT,
    error_msg TEXT, task_code TEXT, prompt_fingerprint TEXT
  );
  CREATE TABLE crm_context (
    id TEXT PRIMARY KEY, user TEXT NOT NULL, key TEXT NOT NULL,
    value TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(user, key)
  );
  CREATE TABLE knowledge_receipts (
    id TEXT PRIMARY KEY, user TEXT, source_kind TEXT, source_id TEXT,
    stage TEXT, status TEXT, summary TEXT, payload TEXT,
    model_key TEXT, model_id TEXT, created_at INTEGER
  );
  CREATE TABLE system_jobs (
    id TEXT PRIMARY KEY, type TEXT, payload TEXT, run_at INTEGER,
    created_at INTEGER, ran_at INTEGER, status TEXT, error TEXT, source TEXT
  );
  CREATE TABLE subscription_agent_jobs (
    id TEXT PRIMARY KEY, feature TEXT, status TEXT, created_at INTEGER
  );
`);

db.hub = () => mem;

test.beforeEach(() => {
  mem.exec('DELETE FROM request_logs; DELETE FROM crm_context; DELETE FROM knowledge_receipts; DELETE FROM system_jobs; DELETE FROM subscription_agent_jobs;');
});

test.after(() => {
  db.hub = originalHub;
  mem.close();
});

test('prompt fingerprints are private, stable identities for exact model work', () => {
  const a = promptFingerprint({ systemPrompt: 'system', userPrompt: 'same evidence' });
  const b = promptFingerprint({ systemPrompt: 'system', userPrompt: 'same evidence' });
  const c = promptFingerprint({ systemPrompt: 'system', userPrompt: 'different evidence' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('a fourth identical CRM adjudication is blocked before the subscription runner is called', async () => {
  let runnerCalls = 0;
  const runner = async () => {
    runnerCalls += 1;
    return { text: '{"same_fact":false}', runner: 'codex', model: 'gpt-5.6-luna', durationMs: 5 };
  };
  const request = () => runModelText({
    feature: 'crm-duplicate-review',
    modelKey: 'crm_atom_duplicate_review',
    messages: [{ role: 'user', content: 'Does exact fact A duplicate exact fact B?' }],
    user: 'loop-test',
    _runner: runner,
  });

  await request();
  await request();
  await request();
  await assert.rejects(request(), error => error.code === 'MODEL_WORK_LOOP_BLOCKED');

  assert.equal(runnerCalls, 3, 'the blocked call must consume no subscription capacity');
  assert.deepEqual(
    mem.prepare('SELECT status, COUNT(*) AS n FROM request_logs GROUP BY status ORDER BY status').all(),
    [{ status: 'blocked_loop', n: 1 }, { status: 'ok', n: 3 }],
  );
  const receipt = mem.prepare("SELECT summary FROM knowledge_receipts WHERE source_kind = 'hub_remediation'").get();
  assert.match(receipt.summary, /contained repeated crm_atom_duplicate_review prompt/);
});

test('the scheduled guard collapses a runaway nightly chain to one correctly timed successor', () => {
  const nowTs = 1788000000;
  const insert = mem.prepare(`
    INSERT INTO system_jobs (id, type, payload, run_at, created_at, ran_at, status, source)
    VALUES (?, 'synthesis_run', '{}', ?, ?, ?, ?, 'self')
  `);
  for (let i = 0; i < 4; i++) {
    insert.run(`done-${i}`, nowTs - 4000 + i, nowTs - 5000 + i, nowTs - 4000 + i, 'done');
  }
  insert.run('pending-a', nowTs + 60, nowTs - 20, null, 'pending');
  insert.run('pending-b', nowTs + 120, nowTs - 10, null, 'pending');

  assert.equal(jobCadenceStats(nowTs)[0].active, true);
  const actions = containJobCadenceLoops(nowTs);
  assert.equal(actions.length, 1);

  const pending = mem.prepare("SELECT * FROM system_jobs WHERE type='synthesis_run' AND status='pending'").all();
  assert.equal(pending.length, 1);
  assert(pending[0].run_at > nowTs + 3600, 'successor is held to the next nightly window');
  assert.equal(
    mem.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE error='contained duplicate job chain by work-loop guard'").get().n,
    1,
  );
  assert.equal(jobCadenceStats(nowTs)[0].contained, true);
});

test('the queue handler runs the guard and leaves exactly one fifteen-minute successor', async () => {
  await jobs._test.handlers.work_loop_guard();
  const pending = mem.prepare("SELECT * FROM system_jobs WHERE type='work_loop_guard' AND status='pending'").all();
  assert.equal(pending.length, 1);
  const delay = pending[0].run_at - Math.floor(Date.now() / 1000);
  assert(delay >= 895 && delay <= 905);
});

test('the daily usage watch names successful call floods and safely contained cadence loops', () => {
  const nowTs = Math.floor(Date.now() / 1000);
  const insertLog = mem.prepare(`
    INSERT INTO request_logs
      (id, ts, user, model_key, model_id, endpoint, tokens_in, tokens_out, duration_ms, status)
    VALUES (?, ?, 'douglas', 'crm_duplicate_review', 'codex/gpt-5.6-luna', 'codex', 500, 10, 15000, 'ok')
  `);
  for (let i = 0; i < 251; i++) insertLog.run(`volume-${i}`, nowTs - i);

  const insertJob = mem.prepare(`
    INSERT INTO system_jobs (id, type, payload, run_at, created_at, ran_at, status, source)
    VALUES (?, 'synthesis_run', '{}', ?, ?, ?, ?, 'self')
  `);
  for (let i = 0; i < 3; i++) insertJob.run(`run-${i}`, nowTs - 1000, nowTs - 1100, nowTs - 1000 + i, 'done');
  insertJob.run('safe-next', nowTs + 36 * 3600, nowTs, null, 'pending');

  const health = workLoopHealth(nowTs);
  assert.equal(health.verdict, 'warn');
  assert.equal(health.featureVolume[0].feature, 'crm_duplicate_review');
  assert(workLoopReportLines(nowTs).some(line => /RECENT LOOP — synthesis_run ran 3×/.test(line)));

  const section = usageWatchSection(nowTs - 86400);
  assert.match(section, /crm_duplicate_review: 251 successful call/);
  assert.doesNotMatch(section, /Usage normal/);
});
