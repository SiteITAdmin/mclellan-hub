'use strict';

const assert = require('assert');
const db = require('../lib/db');
const {
  enqueueContentResearchJob,
  claimContentResearchJobs,
  completeContentResearchJob,
  failContentResearchJob,
  recoverStaleClaims,
  recordWorkerHeartbeat,
  getWorkerHeartbeat,
  contentResearchHealthWarnings,
} = require('../lib/content-research-jobs');

const USER = 'content-research-jobs-test';
const DATE = '2026-07-15';
const TOPIC = 'EU Policy & Regulation';
const hub = db.hub();

function cleanup() {
  hub.prepare('DELETE FROM content_research_jobs WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM content_research_suggestions WHERE user = ?').run(USER);
  hub.prepare(
    "DELETE FROM crm_context WHERE user = 'system' AND key = 'content_research_worker_heartbeat'"
  ).run();
}

cleanup();

// Enqueue with topic context (description + searchQuery for the Mac worker)
const q1 = enqueueContentResearchJob(USER, {
  planDate: DATE,
  topic: TOPIC,
  tone: 'professional',
  limit: 3,
  topicContext: {
    description: 'EU and Ireland policy, data regulation, AI governance.',
    searchQuery: 'EU AI Act GDPR DORA NIS2',
  },
});
assert.strictEqual(q1.ok, true);
assert.strictEqual(q1.queued, true);
assert.ok(q1.jobId);
assert.strictEqual(q1.existing, false);

const storedCtx = hub.prepare(
  'SELECT topic_context FROM content_research_jobs WHERE id = ?'
).get(q1.jobId);
assert.ok(storedCtx.topic_context);
assert.match(storedCtx.topic_context, /EU AI Act/);

// Idempotent while pending
const q2 = enqueueContentResearchJob(USER, { planDate: DATE, topic: TOPIC, tone: 'professional', limit: 3 });
assert.strictEqual(q2.jobId, q1.jobId);
assert.strictEqual(q2.existing, true);

// Claim
const claimed = claimContentResearchJobs({ workerId: 'test-worker', limit: 1 });
assert.strictEqual(claimed.ok, true);
assert.strictEqual(claimed.jobs.length, 1);
assert.strictEqual(claimed.jobs[0].id, q1.jobId);
assert.ok(claimed.jobs[0].claim_token);
assert.strictEqual(claimed.jobs[0].searchQuery, 'EU AI Act GDPR DORA NIS2');
assert.match(claimed.jobs[0].description, /Ireland policy/);
const token = claimed.jobs[0].claim_token;

// Second claim finds nothing for same job
const claimed2 = claimContentResearchJobs({ workerId: 'test-worker', limit: 1 });
assert.strictEqual(claimed2.jobs.length, 0);

// Complete
const done = completeContentResearchJob({
  jobId: q1.jobId,
  claimToken: token,
  suggestions: [
    {
      title: 'EU AI Act enforcement is live',
      summary: 'Supervisory bodies started first actions this week.',
      source_url: 'https://example.com/eu-ai',
      source_title: 'Example',
      source_provider: 'grok+last30days',
    },
    {
      title: 'Boards scramble on governance',
      summary: 'Practitioners report board packs doubled overnight.',
      source_url: 'https://example.com/boards',
    },
  ],
});
assert.strictEqual(done.ok, true);
assert.strictEqual(done.count, 2);

const stored = hub.prepare(`
  SELECT COUNT(*) AS n FROM content_research_suggestions
  WHERE user = ? AND plan_date = ? AND topic = ?
`).get(USER, DATE, TOPIC);
assert.strictEqual(stored.n, 2);

// Bad token rejected
const bad = completeContentResearchJob({
  jobId: q1.jobId,
  claimToken: 'not-the-token',
  suggestions: [{ title: 'x' }],
});
assert.strictEqual(bad.ok, false);

// Fail path: re-queue under 3 attempts
const q3 = enqueueContentResearchJob(USER, {
  planDate: DATE,
  topic: 'Digital Transformation',
  tone: 'challenging',
});
const c3 = claimContentResearchJobs({ workerId: 'w', limit: 1 });
assert.strictEqual(c3.jobs[0].id, q3.jobId);
const failed = failContentResearchJob({
  jobId: q3.jobId,
  claimToken: c3.jobs[0].claim_token,
  error: 'engine timeout',
});
assert.strictEqual(failed.ok, true);
assert.strictEqual(failed.status, 'pending');

// Stale claim recovery
const c4 = claimContentResearchJobs({ workerId: 'w', limit: 1 });
const staleAt = Math.floor(Date.now() / 1000) - (50 * 60);
hub.prepare('UPDATE content_research_jobs SET claimed_at = ? WHERE id = ?')
  .run(staleAt, c4.jobs[0].id);
const recovered = recoverStaleClaims();
assert.ok(recovered.requeued >= 1);
const row = hub.prepare('SELECT status FROM content_research_jobs WHERE id = ?').get(c4.jobs[0].id);
assert.strictEqual(row.status, 'pending');

// Heartbeat + health warnings when driver=mac
recordWorkerHeartbeat({ workerId: 'test-worker' });
const hb = getWorkerHeartbeat();
assert.ok(hb);
assert.strictEqual(hb.worker_id, 'test-worker');
assert.ok(hb.at);

const prev = process.env.CONTENT_RESEARCH_DRIVER;
const prevSecret = process.env.CONTENT_RESEARCH_WORKER_SECRET;
process.env.CONTENT_RESEARCH_DRIVER = 'mac';
process.env.CONTENT_RESEARCH_WORKER_SECRET = 'test-secret';
assert.deepStrictEqual(contentResearchHealthWarnings(), []);
delete process.env.CONTENT_RESEARCH_WORKER_SECRET;
const warns = contentResearchHealthWarnings();
assert.ok(warns.some((w) => /WORKER_SECRET/.test(w)));
process.env.CONTENT_RESEARCH_DRIVER = prev;
if (prevSecret === undefined) delete process.env.CONTENT_RESEARCH_WORKER_SECRET;
else process.env.CONTENT_RESEARCH_WORKER_SECRET = prevSecret;

cleanup();
console.log('Content research jobs tests passed.');
