'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crm-job-queue-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const engine = require('../lib/crm-knowledge-engine');
const attribution = require('../lib/attribution-reconciliation');
const { CRM_KNOWLEDGE_PIPELINE_VERSION } = require('../lib/source-evidence');
const { queueCrmKnowledgeEngine } = require('../lib/crm-knowledge-queue');
const jobs = require('../lib/job-queue');

function clearJobs() {
  // This is an isolated copied database. Clearing its scheduled fixtures keeps
  // processJobs focused on the one target payload and avoids invoking unrelated
  // recurring handlers during this queue unit test.
  db.hub().prepare('DELETE FROM system_jobs').run();
}

function ensureGlobalSuccessorInChild(runAt) {
  const jobQueuePath = path.join(__dirname, '..', 'lib', 'job-queue.js');
  const script = [
    `process.env.HUB_DB_PATH = ${JSON.stringify(tmpDb)};`,
    `const jobs = require(${JSON.stringify(jobQueuePath)});`,
    `const jobId = jobs._test.ensureGlobalCrmKnowledgeSuccessor(${Math.floor(runAt)}, 'atomic-successor-child');`,
    'process.stdout.write(JSON.stringify({ jobId }));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`successor child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (err) { reject(new Error(`invalid successor child output: ${stdout}\n${err.message}`)); }
    });
  });
}

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('CRM knowledge queue keeps one global singleton but separates exact source targets', () => {
  clearJobs();
  const global = queueCrmKnowledgeEngine({ user: 'global-user', requestedBy: 'global-test' });
  assert.equal(global.existing, false);
  assert.deepEqual(global.payload, {
    user: 'global-user',
    source_kind: null,
    source_id: null,
    pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
    requested_by: 'global-test',
  });

  const firstTarget = queueCrmKnowledgeEngine({
    user: 'neil', sourceKind: 'email_summary', sourceId: 'neil-message-1', requestedBy: 'target-test',
  });
  assert.equal(firstTarget.existing, false, 'an unrelated global job cannot swallow a target repair');
  assert.notEqual(firstTarget.jobId, global.jobId);
  const sameTarget = queueCrmKnowledgeEngine({
    user: 'neil', sourceKind: 'email_summary', sourceId: 'neil-message-1', requestedBy: 'target-repeat',
  });
  assert.equal(sameTarget.existing, true);
  assert.equal(sameTarget.jobId, firstTarget.jobId);

  const otherTarget = queueCrmKnowledgeEngine({
    user: 'neil', sourceKind: 'email_summary', sourceId: 'neil-message-2', requestedBy: 'target-test',
  });
  const sameSourceOtherUser = queueCrmKnowledgeEngine({
    user: 'other-neil', sourceKind: 'email_summary', sourceId: 'neil-message-1', requestedBy: 'target-test',
  });
  assert.equal(otherTarget.existing, false);
  assert.equal(sameSourceOtherUser.existing, false);
  const globalRepeat = queueCrmKnowledgeEngine({ user: 'different-global-user', requestedBy: 'global-repeat' });
  assert.equal(globalRepeat.existing, true, 'global singleton is independent of request metadata');
  assert.equal(globalRepeat.jobId, global.jobId);

  const rows = db.hub().prepare(`
    SELECT payload FROM system_jobs
    WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
  `).all();
  assert.equal(rows.length, 4, 'one global plus three distinct exact source targets');
  clearJobs();
});

test('legacy partial source library calls normalize to the global CRM worker', () => {
  clearJobs();
  const legacy = queueCrmKnowledgeEngine({
    user: 'legacy-atoms-user', sourceKind: 'crm_fact', requestedBy: 'legacy-atoms-test',
  });
  assert.equal(legacy.existing, false);
  assert.deepEqual(legacy.payload, {
    user: 'legacy-atoms-user',
    source_kind: null,
    source_id: null,
    pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
    requested_by: 'legacy-atoms-test',
  });
  const repeatedLegacy = queueCrmKnowledgeEngine({
    user: 'legacy-atoms-user', sourceKind: 'crm_fact', requestedBy: 'legacy-atoms-repeat',
  });
  assert.equal(repeatedLegacy.existing, true);
  assert.equal(repeatedLegacy.jobId, legacy.jobId);

  const target = queueCrmKnowledgeEngine({
    user: 'legacy-atoms-user', sourceKind: 'crm_fact', sourceId: 'actual-fact-id', requestedBy: 'exact-target-test',
  });
  assert.equal(target.existing, false, 'only a complete source pair creates an exact target job');
  assert.notEqual(target.jobId, legacy.jobId);
  assert.equal(target.payload.source_kind, 'crm_fact');
  assert.equal(target.payload.source_id, 'actual-fact-id');
  clearJobs();
});

test('CRM knowledge job handler invokes only the scoped engine entrypoint for a target payload', async () => {
  clearJobs();
  const scopedCalls = [];
  let globalCalls = 0;
  const originalScoped = engine.runCrmKnowledgeSource;
  const originalGlobal = engine.runCrmKnowledgeEngine;
  engine.runCrmKnowledgeSource = async (user, options) => {
    scopedCalls.push({ user, options });
    return { considered: 1, triaged: 0, synthesised: 0, skipped: 1, errors: 0, reviews: 0 };
  };
  engine.runCrmKnowledgeEngine = async () => {
    globalCalls += 1;
    return { considered: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 0 };
  };

  try {
    const queued = queueCrmKnowledgeEngine({
      user: 'neil', sourceKind: 'email_summary', sourceId: 'neil-review-message', requestedBy: 'handler-test',
    });
    await jobs.processJobs();

    assert.deepEqual(scopedCalls, [{
      user: 'neil',
      options: { sourceKind: 'email_summary', sourceId: 'neil-review-message', linkBudget: 12 },
    }]);
    assert.equal(globalCalls, 0, 'a scoped payload never falls back to the all-user scan');
    assert.equal(db.hub().prepare('SELECT status FROM system_jobs WHERE id = ?').get(queued.jobId).status, 'done');
    const successor = db.hub().prepare(`
      SELECT payload FROM system_jobs
      WHERE type = 'crm_knowledge_engine' AND status = 'pending'
        AND json_extract(payload, '$.source_kind') IS NULL
        AND json_extract(payload, '$.source_id') IS NULL
      LIMIT 1
    `).get();
    assert.ok(successor, 'target execution leaves a regular global successor');

    await assert.rejects(
      jobs._test.handlers.crm_knowledge_engine({ user: 'neil', source_kind: 'email_summary' }),
      /requires both source_kind and source_id/,
    );
  } finally {
    engine.runCrmKnowledgeSource = originalScoped;
    engine.runCrmKnowledgeEngine = originalGlobal;
    clearJobs();
  }
});

test('global CRM successors use the queue transaction so concurrent target handlers leave one active job', async () => {
  clearJobs();
  const delayedRunAt = Math.floor(Date.now() / 1000) + 600;
  const first = jobs._test.ensureGlobalCrmKnowledgeSuccessor(delayedRunAt, 'atomic-successor-test');
  const second = jobs._test.ensureGlobalCrmKnowledgeSuccessor(delayedRunAt + 1, 'atomic-successor-test');
  assert.equal(first, second, 'the actual successor helper reuses the queue transaction result');
  let rows = db.hub().prepare(`
    SELECT id, run_at FROM system_jobs
    WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
      AND json_extract(payload, '$.source_kind') IS NULL
      AND json_extract(payload, '$.source_id') IS NULL
  `).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_at, delayedRunAt, 'the first delayed successor retains its requested schedule');

  clearJobs();
  const [left, right] = await Promise.all([
    ensureGlobalSuccessorInChild(delayedRunAt),
    ensureGlobalSuccessorInChild(delayedRunAt),
  ]);
  assert.equal(left.jobId, right.jobId, 'separate processes observe the same singleton job');
  rows = db.hub().prepare(`
    SELECT id FROM system_jobs
    WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
      AND json_extract(payload, '$.source_kind') IS NULL
      AND json_extract(payload, '$.source_id') IS NULL
  `).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, left.jobId);
  clearJobs();
});

test('attribution reconciliation processes one source per user and keeps a recurring successor', async () => {
  clearJobs();
  const calls = [];
  const original = attribution.runAttributionReconciliation;
  attribution.runAttributionReconciliation = async (user, options) => {
    calls.push({ user, options });
    return { processed: user === 'douglas' ? 1 : 0, applied: 0, reviews: 0, errors: 0, remaining: user === 'douglas' ? 2 : 0 };
  };
  const started = Math.floor(Date.now() / 1000);
  try {
    await jobs._test.handlers.attribution_reconciliation();
    assert.deepEqual(calls, [
      { user: 'douglas', options: { limit: 1 } },
      { user: 'nakai', options: { limit: 1 } },
    ]);
    const successor = db.hub().prepare(`
      SELECT run_at FROM system_jobs
      WHERE type = 'attribution_reconciliation' AND status = 'pending'
    `).get();
    assert.ok(successor);
    assert.ok(successor.run_at >= started + 295 && successor.run_at <= started + 305);
  } finally {
    attribution.runAttributionReconciliation = original;
    clearJobs();
  }
});
