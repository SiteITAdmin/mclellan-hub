'use strict';

/**
 * Hub promises — contract tests written in Douglas's language, not the code's.
 *
 * Every test here names something the Hub promises a human, and drives a real
 * source through the real pipeline to prove it. These are the tests that should
 * have failed on 2 August, when a forwarded email carrying itemised asks
 * produced no tasks: four separate layers each degraded quietly and the health
 * panel stayed green, so the first thing that noticed was Douglas.
 *
 * The rule for this file: if a promise can only be expressed as "stage N sets
 * flag X", it belongs in a stage's own test file. A promise here reads as a
 * sentence about Douglas's day.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-promises-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { resolveSourceEvidence } = require('../lib/source-evidence');
const { runCrmKnowledgeSource, _test } = require('../lib/crm-knowledge-engine');

const user = 'hub-promises-test';
let seq = 0;

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness: a real email row, the real engine, stubbed model + provider calls.
// ---------------------------------------------------------------------------

function inboundEmail({ subject, body, from = 'Neil Brennan', fromEmail = 'neil@beaconhospital.ie', direction = 'received' }) {
  const id = `hub-promise-email-${++seq}`;
  db.hub().prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at,
       summary, body_text, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, `${id}-msg`, subject, from, fromEmail, 1785000000 + seq,
    'multiple items', body, direction,
  );
  return id;
}

// Each model stage is stubbed at the seam the engine already injects, so the
// stubs return exactly the shape the real prompt is contracted to return. The
// triage stub runs its candidates through the engine's own mergeTriageResults,
// which is what stamps each candidate with its stable key and exact source
// span — the evidence gate that both automatic projection and human approval
// depend on. A stub that skipped it would test a pipeline Douglas doesn't have.
async function runEmail(sourceId, { asks = [], duplicate = null, drop = [] } = {}) {
  const created = [];
  const events = [];
  const result = await runCrmKnowledgeSource(user, {
    sourceKind: 'email_summary',
    sourceId,
    dependencies: {
      // Satisfies the engine's "is a model reachable?" guard. Every stage below
      // is stubbed at its own seam, so this is never actually invoked.
      requestModelObject: async () => { throw new Error('unstubbed model stage'); },
      triageSourceFn: async (_u, evidence) => ({
        modelId: 'stub/triage',
        parsed: _test.mergeTriageResults(evidence, [{
          chunk: evidence.chunks[0],
          parsed: {
            should_synthesise: false,
            source_summary: 'stubbed triage',
            candidate_actions: asks.map(ask => ({
              action: ask.action,
              owner: ask.owner || 'Douglas',
              evidence: ask.evidence,
              actionability: ask.actionability,
              confidence: ask.confidence,
            })),
            candidate_entities: [],
            candidate_relationships: [],
            confidence: 0.9,
          },
        }]),
      }),
      reviewDuplicateFn: async () => ({
        modelId: 'stub/duplicate',
        parsed: duplicate || { decision: 'new', target_id: null, reason: 'novel', confidence: 0.9 },
      }),
      // Projection echoes each candidate back with its key intact, which is
      // what a well-behaved model does. `drop` simulates one going missing.
      projectActionsFn: async (_u, _chunk, candidates) => ({
        modelId: 'stub/projection',
        parsed: {
          actions: candidates
            .filter(candidate => !drop.includes(candidate.action))
            .map(candidate => ({
              title: candidate.action,
              owner: candidate.owner,
              evidence: candidate.evidence,
              actionability: candidate.actionability,
              confidence: candidate.confidence,
              candidate_key: candidate.candidate_key,
            })),
        },
      }),
      synthesiseSourceFn: async () => ({ stored: 0, proposed: 0 }),
      createTaskFn: async (_u, options) => {
        created.push(options);
        return { id: `google-${created.length}`, ...options };
      },
      createCalendarEventFn: async (_u, options) => {
        events.push(options);
        return { id: `event-${events.length}` };
      },
    },
  });
  return { result, created, events };
}

function outcomesFor(sourceId) {
  return db.hub().prepare(`
    SELECT disposition, reason, payload FROM crm_action_outcomes
    WHERE user = ? AND source_id = ? ORDER BY created_at ASC
  `).all(user, sourceId);
}

// ---------------------------------------------------------------------------
// The promises.
// ---------------------------------------------------------------------------

test('a forwarded work email with three explicit asks produces three tasks', async () => {
  // The 2 August failure, exactly: itemised asks in a forwarded body. The old
  // path read subject + a one-line summary, flattened all three to "multiple
  // items", and created nothing.
  const body = [
    'Douglas — forwarding this on, three things needed from you:',
    '1. Send the signed contractor agreement to procurement.',
    '2. Confirm the theatre list dates for September.',
    '3. Chase Radiology for the updated equipment quote.',
  ].join('\n');
  const id = inboundEmail({ subject: 'Fwd: Outstanding items', body });

  const asks = [
    'Send the signed contractor agreement to procurement.',
    'Confirm the theatre list dates for September.',
    'Chase Radiology for the updated equipment quote.',
  ];
  const { created } = await runEmail(id, {
    asks: asks.map(quote => ({
      action: quote, evidence: quote, actionability: 'explicit_ask', confidence: 0.9,
    })),
  });

  assert.equal(created.length, 3, `expected three tasks, got ${created.length}`);
  for (const quote of asks) {
    assert.ok(
      created.some(task => String(task.title || '') === quote),
      `no task created for ask: ${quote}`,
    );
  }
});

test('an explicit ask still becomes a task when the model is only moderately confident', async () => {
  // Neil's real request scored 0.6 and was dropped as low_confidence under a
  // green "done". Intent (explicit_ask) decides; confidence only ranks.
  const body = 'Can you send me the updated floor plan before Friday please.';
  const id = inboundEmail({ subject: 'Floor plan', body });

  const { created } = await runEmail(id, {
    asks: [{
      action: 'Send the updated floor plan', evidence: body,
      actionability: 'explicit_ask', confidence: 0.6,
    }],
  });

  assert.equal(created.length, 1, 'a moderately-confident explicit ask must still create a task');
});

test('a borderline implied action is surfaced for review, never silently dropped', async () => {
  const body = 'We should probably revisit the parking arrangement at some point.';
  const id = inboundEmail({ subject: 'Parking', body });

  const { created } = await runEmail(id, {
    asks: [{
      action: 'Revisit the parking arrangement', evidence: body,
      actionability: 'implied', confidence: 0.5,
    }],
  });

  assert.equal(created.length, 0, 'a borderline implied action must not auto-create a task');
  const outcomes = outcomesFor(id);
  assert.ok(outcomes.length > 0, 'the action must leave an outcome behind');
  assert.ok(
    outcomes.some(row => row.disposition === 'review'),
    `expected a review outcome, got: ${outcomes.map(r => r.disposition).join(', ')}`,
  );
});

test("the Hub's own briefing content never becomes one of Douglas's tasks", async () => {
  // 3 August: the sent-mail commitment detector read Nakai's regulatory
  // Watchlist and turned eight rows into eight Google Tasks.
  const body = [
    'Rolling Watchlist',
    '- Central Bank consultation CP159 closes 14 September.',
    '- EBA guidelines on outsourcing under review.',
  ].join('\n');
  const id = inboundEmail({
    subject: 'Daily Briefing — 3 August 2026',
    body,
    from: 'Douglas McLellan',
    fromEmail: 'aio.mclellan@gmail.com',
    direction: 'sent',
  });

  const { result, created } = await runEmail(id, {
    asks: [{
      action: 'Respond to Central Bank consultation CP159',
      evidence: '- Central Bank consultation CP159 closes 14 September.',
      actionability: 'explicit_ask', confidence: 0.9,
    }],
  });

  assert.equal(created.length, 0, 'briefing content must never reach Google Tasks');
  assert.equal(result.reason, 'canonical_source_excluded');
});

test("forwarding the Hub's M365 briefing between Douglas's accounts still creates no tasks", async () => {
  // Exact shape of the 18 August production incident. The body is preserved
  // and searchable, but it is derived Hub output rather than new evidence.
  const evidence = 'Jane Whelan ’ s E3 administrative function/licence gap for RoPA and data-protection work [S25] [S9]';
  const id = inboundEmail({
    subject: 'Fwd: M365 Operations & Security Brief 018 - 18 August 2026',
    body: `MCLELLAN HUB · PRIVATE OPERATIONS INTELLIGENCE\n${evidence}`,
    from: 'Douglas McLellan',
    fromEmail: 'douglas.mclellan@beaconhospital.ie',
    direction: 'sent',
  });

  const { result, created } = await runEmail(id, {
    asks: [{
      action: 'Verify Jane Whelan’s E3 administrative function and licence gap is resolved',
      evidence,
      actionability: 'implied',
      confidence: 0.98,
    }],
  });

  assert.equal(created.length, 0);
  assert.equal(result.reason, 'canonical_source_excluded');
  assert.equal(result.exclusion_reason, 'hub_generated_report');
  assert.deepEqual(outcomesFor(id), [], 'excluded derived output must never reach action outcomes');
});

test('an ask the model forgets to carry forward is left visible, not lost', async () => {
  // Triage found two asks; projection returned only one. The dropped one must
  // surface as a review outcome. Silent loss between two stages is precisely
  // how a real request disappears under a green "done".
  const body = [
    'Two things: please approve the agency invoice,',
    'and book the fire safety inspection for the new wing.',
  ].join('\n');
  const id = inboundEmail({ subject: 'Two things', body });

  const { created } = await runEmail(id, {
    asks: [
      { action: 'Approve the agency invoice', evidence: 'please approve the agency invoice', actionability: 'explicit_ask', confidence: 0.9 },
      { action: 'Book the fire safety inspection', evidence: 'book the fire safety inspection for the new wing', actionability: 'explicit_ask', confidence: 0.9 },
    ],
    drop: ['Book the fire safety inspection'],
  });

  assert.equal(created.length, 1, 'the surviving ask should still become a task');
  const outcomes = outcomesFor(id);
  assert.ok(
    outcomes.some(row => row.disposition !== 'task_created'
      && /fire safety/i.test(String(row.payload || ''))),
    'the dropped ask must leave a visible non-created outcome',
  );
});

test('a task Douglas already completed is never recreated from its own history', async () => {
  // Completed tasks are evidence of state, not a request for replacement work.
  const taskId = `hub-promise-done-${++seq}`;
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, status, source, source_id, created_at, completed_at)
    VALUES (?, ?, ?, '@default', ?, ?, 'completed', 'manual', ?, unixepoch(), unixepoch())
  `).run(taskId, user, `${taskId}-google`, 'Chase Radiology for the equipment quote',
    'Completed task evidence', `${taskId}-source`);

  const created = [];
  const result = await runCrmKnowledgeSource(user, {
    sourceKind: 'completed_task',
    sourceId: taskId,
    dependencies: {
      requestModelObject: async () => { throw new Error('unstubbed model stage'); },
      triageSourceFn: async (_u, evidence) => ({
        modelId: 'stub/triage',
        parsed: _test.mergeTriageResults(evidence, [{
          chunk: evidence.chunks[0],
          parsed: {
            should_synthesise: false,
            candidate_actions: [{
              action: 'Chase Radiology for the equipment quote',
              owner: 'Douglas',
              evidence: 'Chase Radiology for the equipment quote',
              actionability: 'explicit_ask',
              confidence: 0.9,
            }],
            candidate_entities: [], candidate_relationships: [], confidence: 0.9,
          },
        }]),
      }),
      reviewDuplicateFn: async () => ({ modelId: 'stub/duplicate', parsed: { decision: 'new', target_id: null, reason: '', confidence: 0.9 } }),
      projectActionsFn: async (_u, _chunk, candidates) => ({
        modelId: 'stub/projection',
        parsed: {
          actions: candidates.map(candidate => ({
            title: candidate.action, owner: candidate.owner, evidence: candidate.evidence,
            actionability: candidate.actionability, confidence: candidate.confidence,
            candidate_key: candidate.candidate_key,
          })),
        },
      }),
      synthesiseSourceFn: async () => ({ stored: 0, proposed: 0 }),
      createTaskFn: async (_u, options) => { created.push(options); return { id: 'google-x', ...options }; },
      createCalendarEventFn: async () => ({ id: 'event-stub' }),
    },
  });

  assert.equal(
    created.length, 0,
    `a completed task must not be projected back into a new task (reason: ${result.reason || 'none'})`,
  );
});

test('an email whose body was never captured is visibly incomplete, not quietly processed', async () => {
  // The root cause of the 2 August failure was a missing body that nothing
  // downstream could tell apart from a genuinely empty email.
  const id = `hub-promise-nobody-${++seq}`;
  db.hub().prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(id, user, `${id}-msg`, 'Outstanding items', 'Neil Brennan', 'neil@beaconhospital.ie', 1785500000, 'multiple items');

  const evidence = resolveSourceEvidence(user, 'email_summary', id);
  assert.equal(evidence.complete, false, 'a body-less email must not report itself complete');
  assert.equal(evidence.completeness, 'summary_only_missing_raw_body');
  assert.notEqual(
    evidence.body_source, 'email_summaries.body_text',
    'the lossy summary must never be recorded as if it were the captured body',
  );
});
