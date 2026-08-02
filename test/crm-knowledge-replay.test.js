'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crm-replay-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { resolveSourceEvidence } = require('../lib/source-evidence');
const { upsertAtom } = require('../lib/atoms');
const { getCrmKnowledgeHealth } = require('../lib/crm-knowledge-health');
const {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  listActionOutcomeQueue,
  approveReviewedAction,
  retryCrmKnowledgeErrors,
  writeReceipt,
  _test,
} = require('../lib/crm-knowledge-engine');

const user = 'crm-replay-test';
let messageNumber = 0;

function makeEvidence(body) {
  const id = `crm-replay-email-${++messageNumber}`;
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, `crm-replay-msg-${messageNumber}`, 'Action request', 'Alex', 'alex@example.test', 1771000000 + messageNumber, 'lossy', body);
  return resolveSourceEvidence(user, 'email_summary', id);
}

function makeEvidenceForUser(testUser, id, body) {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, testUser, `${id}-message`, 'Action request', 'Alex', 'alex@example.test', 1771200000 + messageNumber, 'lossy', body);
  return resolveSourceEvidence(testUser, 'email_summary', id);
}

function actionFor(evidence, quote, extra = {}) {
  return {
    title: 'Send requested document',
    // The triage ask is stable even when the projection model refines its
    // provider-facing title on replay.
    triage_action: 'Send requested document',
    actionability: 'explicit_ask',
    confidence: 0.9,
    evidence: quote,
    ...extra,
  };
}

function triageCandidateFor(evidence, action) {
  return _test.decorateCandidate(evidence, evidence.chunks[0], {
    action: action.triage_action || action.title,
    owner: action.owner || '',
    evidence: action.evidence,
    actionability: action.actionability,
    due_date: action.due_date,
    project_slug: action.project_slug,
    confidence: action.confidence,
  }, 0);
}

async function project(evidence, action, dependencies = {}) {
  const candidate = triageCandidateFor(evidence, action);
  const { triage_action: _triageAction, ...projectedAction } = action;
  return _test.createProjectedTasks(user, evidence.source_kind, evidence.source_id, [{
    ...projectedAction,
    candidate_key: candidate.candidate_key,
  }], [], {
    evidence,
    candidates: [candidate],
    chunkById: new Map([[evidence.chunks[0].chunk_id, evidence.chunks[0]]]),
    dependencies,
  });
}

function runReplayAudit(auditUser) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'replay-crm-knowledge.js'),
    '--db', tmpDb,
    '--user', auditUser,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function runReplayApply(auditUser) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'replay-crm-knowledge.js'),
    '--db', tmpDb,
    '--user', auditUser,
    '--apply',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('stable evidence identity makes replay create zero duplicate side effects', async () => {
  const quote = 'Please send the signed contract.';
  const evidence = makeEvidence(`Forwarded note:\n${quote}`);
  let calls = 0;
  const seenSourceIds = [];
  const dependencies = {
    createTaskFn: async (_user, input) => {
      calls += 1;
      seenSourceIds.push(input.sourceId);
      return { localId: 'stable-task-local' };
    },
  };

  const first = await project(evidence, actionFor(evidence, quote), dependencies);
  const second = await project(evidence, actionFor(evidence, quote, { title: 'Email Alex the signed contract' }), dependencies);

  assert.equal(first.created, 1);
  assert.equal(second.created, 1, 'replayed terminal outcome is counted as its original task state');
  assert.equal(calls, 1, 'second replay did not call the external task creator');
  assert.match(seenSourceIds[0], /^crm-action:[a-f0-9]{64}$/);
});

test('an ambiguous side-effect error fails closed and becomes an actionable review', async () => {
  const quote = 'Please review the procurement pack.';
  const evidence = makeEvidence(quote);
  let calls = 0;
  const fail = {
    createTaskFn: async () => {
      calls += 1;
      throw new Error('temporary API outage');
    },
  };
  const first = await project(evidence, actionFor(evidence, quote), fail);
  assert.equal(first.errors, 1);
  assert.ok(listActionOutcomeQueue(user).some(item => item.reason.includes('temporary API outage')));

  const recover = {
    createTaskFn: async () => {
      calls += 1;
      return { localId: 'recovered-task-local' };
    },
  };
  const second = await project(evidence, actionFor(evidence, quote), recover);
  assert.equal(second.review, 1);
  assert.equal(calls, 1, 'automatic replay must not repeat an ambiguous provider call');
  assert.ok(listActionOutcomeQueue(user).some(item =>
    item.source_id === evidence.source_id
      && item.disposition === 'review'
      && item.reason === 'task_side_effect_ambiguous_requires_human_review'
  ));
  const ambiguous = listActionOutcomeQueue(user).find(item =>
    item.source_id === evidence.source_id && item.reason === 'task_side_effect_ambiguous_requires_human_review'
  );
  assert.equal(ambiguous.payload.non_creatable, true);
  assert.equal(ambiguous.payload.side_effect_ambiguity.phase, 'task');
  assert.throws(() => approveReviewedAction(user, ambiguous.id, {
    dependencies: { createTaskFn: async () => { calls += 1; return { localId: 'must-not-run' }; } },
  }), /side_effect_ambiguity_requires_reconciliation/);
  assert.equal(calls, 1, 'approval cannot repeat an ambiguous failed provider call');
});

test('a stale crash-window pending task makes zero second provider calls and becomes reviewable', async () => {
  const quote = 'Please send the signed minutes.';
  const evidence = makeEvidence(quote);
  const action = actionFor(evidence, quote);
  const candidate = triageCandidateFor(evidence, action);
  const { triage_action: _triageAction, ...projectedAction } = action;
  const identity = _test.actionIdentity(evidence, {
    ...projectedAction, candidate_key: candidate.candidate_key,
  }, [candidate], evidence.chunks[0]);
  _test.upsertActionOutcome(user, evidence, identity.action_key, {
    action, identity, disposition: 'pending_task', reason: 'task_side_effect_pending',
  });
  db.hub().prepare(`
    UPDATE crm_action_outcomes SET updated_at = ?
    WHERE user = ? AND source_kind = ? AND source_id = ? AND action_key = ?
  `).run(
    Math.floor(Date.now() / 1000) - _test.SIDE_EFFECT_PENDING_LEASE_SECONDS - 1,
    user, evidence.source_kind, evidence.source_id, identity.action_key,
  );

  let calls = 0;
  const result = await project(evidence, action, {
    createTaskFn: async () => { calls += 1; return { localId: 'must-not-run' }; },
  });
  assert.equal(result.review, 1);
  assert.equal(calls, 0);
  assert.ok(listActionOutcomeQueue(user).some(item =>
    item.source_id === evidence.source_id
      && item.disposition === 'review'
      && item.reason === 'task_side_effect_ambiguous_requires_human_review'
  ));
  const ambiguous = listActionOutcomeQueue(user).find(item =>
    item.source_id === evidence.source_id && item.reason === 'task_side_effect_ambiguous_requires_human_review'
  );
  assert.equal(ambiguous.payload.non_creatable, true);
  assert.throws(() => approveReviewedAction(user, ambiguous.id, {
    dependencies: { createTaskFn: async () => { calls += 1; return { localId: 'must-not-run' }; } },
  }), /side_effect_ambiguity_requires_reconciliation/);
  assert.equal(calls, 0, 'approval cannot reclaim an unreconciled stale task call');
});

test('a stale pending calendar call becomes a permanently non-creatable reconciliation review', async () => {
  const quote = 'Attend the review at 10:00 tomorrow.';
  const evidence = makeEvidence(quote);
  const action = actionFor(evidence, quote, {
    event: { start: '2026-08-03T10:00', end: '2026-08-03T10:30', location: 'Teams' },
  });
  const candidate = triageCandidateFor(evidence, action);
  const { triage_action: _triageAction, ...projectedAction } = action;
  const identity = _test.actionIdentity(evidence, {
    ...projectedAction, candidate_key: candidate.candidate_key,
  }, [candidate], evidence.chunks[0]);
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source, source_id, created_at)
    VALUES (?, ?, ?, '@default', ?, 'needsAction', 'crm-engine', ?, unixepoch())
  `).run('stable-event-task', user, 'stable-event-google', action.title, `crm-action:${identity.action_key}`);
  _test.upsertActionOutcome(user, evidence, identity.action_key, {
    action, identity, disposition: 'pending_event', reason: 'calendar_side_effect_pending', taskId: 'stable-event-task',
  });
  db.hub().prepare(`
    UPDATE crm_action_outcomes SET updated_at = ?
    WHERE user = ? AND source_kind = ? AND source_id = ? AND action_key = ?
  `).run(
    Math.floor(Date.now() / 1000) - _test.SIDE_EFFECT_PENDING_LEASE_SECONDS - 1,
    user, evidence.source_kind, evidence.source_id, identity.action_key,
  );

  let taskCalls = 0;
  let eventCalls = 0;
  const result = await project(evidence, action, {
    createTaskFn: async () => { taskCalls += 1; return { localId: 'must-not-run' }; },
    createCalendarEventFn: async () => { eventCalls += 1; return { localId: 'must-not-run' }; },
  });
  assert.equal(result.review, 1);
  assert.equal(taskCalls, 0);
  assert.equal(eventCalls, 0);
  const ambiguous = listActionOutcomeQueue(user).find(item =>
    item.source_id === evidence.source_id && item.reason === 'event_side_effect_ambiguous_requires_human_review'
  );
  assert.ok(ambiguous);
  assert.equal(ambiguous.payload.non_creatable, true);
  assert.equal(ambiguous.payload.side_effect_ambiguity.phase, 'event');
  assert.throws(() => approveReviewedAction(user, ambiguous.id, {
    dependencies: {
      createTaskFn: async () => { taskCalls += 1; return { localId: 'must-not-run' }; },
      createCalendarEventFn: async () => { eventCalls += 1; return { localId: 'must-not-run' }; },
    },
  }), /side_effect_ambiguity_requires_reconciliation/);
  assert.equal(taskCalls, 0);
  assert.equal(eventCalls, 0, 'approval cannot reclaim an unreconciled stale calendar call');
});

test('concurrent fresh action projection atomically claims one task side effect', async () => {
  const quote = 'Please send the final pack.';
  const evidence = makeEvidence(quote);
  const action = actionFor(evidence, quote);
  let calls = 0;
  let releaseTask;
  let startedTask;
  const release = new Promise(resolve => { releaseTask = resolve; });
  const started = new Promise(resolve => { startedTask = resolve; });
  const dependencies = {
    createTaskFn: async () => {
      calls += 1;
      startedTask();
      await release;
      return { localId: 'concurrent-task-local' };
    },
  };

  const first = project(evidence, action, dependencies);
  await started;
  const second = await project(evidence, action, dependencies);
  assert.equal(calls, 1, 'the losing worker did not call the provider');
  releaseTask();
  const firstResult = await first;
  assert.equal(firstResult.created, 1);
  assert.equal(second.review, 1);
  assert.equal(calls, 1);
});

test('model duplicate_of suppresses only after an actual open task is verified', async () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source, created_at)
    VALUES (?, ?, ?, '@default', ?, 'needsAction', 'manual', unixepoch())
  `).run('verified-open-task', user, 'verified-google-task', 'Already open task');
  const quote = 'Please complete the already open task.';
  const evidence = makeEvidence(quote);
  let calls = 0;
  const result = await project(evidence, actionFor(evidence, quote, { duplicate_of: 'verified-open-task' }), {
    createTaskFn: async () => { calls += 1; return { localId: 'should-not-create' }; },
  });
  assert.equal(result.existing, 1);
  assert.equal(calls, 0);

  const unverified = makeEvidence('Please do the other thing.');
  const review = await project(unverified, actionFor(unverified, 'Please do the other thing.', { duplicate_of: 'not-a-real-open-task' }), {
    createTaskFn: async () => { calls += 1; return { localId: 'should-not-create' }; },
  });
  assert.equal(review.review, 1);
  assert.equal(calls, 0);
});

test('malformed and low-confidence actions stay in the visible review queue', async () => {
  const evidence = makeEvidence('Could you maybe investigate this?');
  const low = await project(evidence, {
    title: 'Investigate this', actionability: 'implied', confidence: 0.1,
    evidence: 'Could you maybe investigate this?',
  });
  assert.equal(low.review, 1);
  const queue = listActionOutcomeQueue(user);
  assert.ok(queue.some(item => item.source_id === evidence.source_id && item.disposition === 'review'));
});

test('non-exact evidence never creates a task and non-creatable reviews cannot be approved', async () => {
  const evidence = makeEvidence('Please send the requested file before Friday.');
  const nonExact = actionFor(evidence, 'this quotation is not in the source');
  let calls = 0;
  const projected = await project(evidence, nonExact, {
    createTaskFn: async () => { calls += 1; return { localId: 'must-not-create' }; },
  });
  assert.equal(projected.review, 1);
  assert.equal(calls, 0);

  const nonExactRow = db.hub().prepare(`
    SELECT id FROM crm_action_outcomes
    WHERE user = ? AND source_id = ? AND reason = 'non_exact_evidence_requires_review'
  `).get(user, evidence.source_id);
  assert.ok(nonExactRow);
  assert.throws(() => approveReviewedAction(user, nonExactRow.id), /cannot create a side effect/);

  const malformed = await project(evidence, {
    title: '   ', actionability: 'explicit_ask', confidence: 0.9,
    evidence: 'Please send the requested file before Friday.',
  });
  assert.equal(malformed.review, 1);
  const malformedRow = db.hub().prepare(`
    SELECT id FROM crm_action_outcomes
    WHERE user = ? AND source_id = ? AND reason = 'malformed_missing_title'
  `).get(user, evidence.source_id);
  assert.ok(malformedRow);
  assert.throws(() => approveReviewedAction(user, malformedRow.id), /cannot create a side effect/);

  const sourceLevel = _test.sourceLevelOutcome(user, evidence, 'incomplete_source', 'review', 'missing_body');
  assert.throws(() => approveReviewedAction(user, sourceLevel.id), /cannot create a side effect/);

  const exactButUnmatched = actionFor(evidence, 'Please send the requested file before Friday.');
  const unmatchedIdentity = _test.actionIdentity(evidence, exactButUnmatched, [], evidence.chunks[0]);
  assert.equal(unmatchedIdentity.span.exact, true);
  const unmatched = _test.upsertActionOutcome(user, evidence, unmatchedIdentity.action_key, {
    action: exactButUnmatched,
    identity: unmatchedIdentity,
    disposition: 'review',
    reason: 'legacy_exact_span_without_candidate',
  });
  assert.throws(
    () => approveReviewedAction(user, unmatched.id),
    /action_not_tied_to_triage_candidate/,
    'an exact quotation without a triage candidate cannot be approved',
  );
});

test('unmatched and omitted projection rows are permanently non-creatable', async () => {
  const text = 'Please send the deck. Please schedule the review.';
  const evidence = makeEvidence(text);
  const candidate = _test.decorateCandidate(evidence, evidence.chunks[0], {
    action: 'Send the deck',
    evidence: 'Please send the deck.',
    actionability: 'explicit_ask',
    confidence: 0.9,
  }, 0);
  let taskCalls = 0;
  const result = await _test.projectCandidates(user, evidence, [candidate], [], {
    projectActionsFn: async () => ({
      parsed: {
        actions: [{
          title: 'Schedule the review',
          actionability: 'explicit_ask',
          confidence: 0.9,
          evidence: 'Please schedule the review.',
        }],
      },
      modelId: 'test-projection',
    }),
    createTaskFn: async () => { taskCalls += 1; return { localId: 'must-not-create' }; },
  });

  assert.equal(result.review, 2);
  assert.equal(taskCalls, 0);
  const rows = listActionOutcomeQueue(user).filter(row => row.source_id === evidence.source_id);
  assert.deepEqual(
    rows.map(row => row.reason).sort(),
    ['projection_action_not_tied_to_triage_candidate', 'projection_omitted_triage_candidate'],
  );
  for (const row of rows) {
    assert.equal(row.payload.non_creatable, true);
    assert.throws(
      () => approveReviewedAction(user, row.id, {
        dependencies: { createTaskFn: async () => { taskCalls += 1; return { localId: 'must-not-create' }; } },
      }),
      /cannot create a side effect/,
    );
  }
  assert.equal(taskCalls, 0, 'neither review can be promoted by approval');
});

test('two same-span candidate asks project once each and replay without duplicate providers', async () => {
  const text = 'Please send the pack and book the review.';
  const evidence = makeEvidence(text);
  const decision = _test.mergeTriageResults(evidence, [{
    chunk: evidence.chunks[0],
    parsed: {
      candidate_actions: [
        { action: 'Send the pack', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
        { action: 'Book the review', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
      ],
    },
  }]);
  const actions = decision.candidate_actions.map(candidate => ({
    candidate_key: candidate.candidate_key,
    title: candidate.action,
    actionability: candidate.actionability,
    confidence: candidate.confidence,
    evidence: candidate.evidence,
  }));
  let calls = 0;
  const dependencies = {
    projectActionsFn: async () => ({ parsed: { actions }, modelId: 'test-projection' }),
    createTaskFn: async (_user, input) => {
      calls += 1;
      return { localId: `same-span-${input.sourceId}` };
    },
  };

  const first = await _test.projectCandidates(user, evidence, decision.candidate_actions, [], dependencies);
  const second = await _test.projectCandidates(user, evidence, decision.candidate_actions, [], dependencies);

  assert.equal(first.created, 2);
  assert.equal(second.created, 2, 'terminal outcomes are replay-counted without another provider call');
  assert.equal(calls, 2);
  const outcomes = db.hub().prepare(`
    SELECT action_key FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ?
  `).all(user, evidence.source_kind, evidence.source_id);
  assert.equal(outcomes.length, 2);
  assert.equal(new Set(outcomes.map(row => row.action_key)).size, 2);
});

test('recovery selects only incomplete/error sources and resumes a saved triage without rerunning it', async () => {
  const recoveryUser = 'crm-recovery-selection';
  const fresh = makeEvidenceForUser(recoveryUser, 'recovery-fresh', 'Fresh source needs triage.');
  const crash = makeEvidenceForUser(recoveryUser, 'recovery-post-triage-crash', 'Please send the recovery pack.');
  const errored = makeEvidenceForUser(recoveryUser, 'recovery-error', 'Source with a recorded triage error.');
  const complete = makeEvidenceForUser(recoveryUser, 'recovery-complete', 'Fully processed source.');
  const review = makeEvidenceForUser(recoveryUser, 'recovery-review', 'Human-review source.');
  const noActions = { should_synthesise: false, candidate_actions: [] };
  const crashCandidate = _test.decorateCandidate(crash, crash.chunks[0], {
    action: 'Send the recovery pack',
    evidence: 'Please send the recovery pack.',
    actionability: 'explicit_ask',
    confidence: 0.9,
  }, 0);
  const crashDecision = {
    should_synthesise: true,
    source_summary: 'Saved before projection',
    candidate_entities: [],
    candidate_relationships: [],
    candidate_actions: [crashCandidate],
    routing_notes: '',
    confidence: 0.9,
  };
  const receipt = (evidence, stage, status, payload) => writeReceipt(
    recoveryUser, evidence.source_kind, evidence.source_id, stage,
    { status, payload, sourceRevision: evidence.revision_hash },
  );
  receipt(crash, 'crm_source_triage', 'done', crashDecision);
  receipt(crash, 'crm_duplicate_reviewed', 'new', { decision: 'new', reason: 'already decided', confidence: 0.9 });
  receipt(errored, 'crm_source_triage', 'error', { error: 'triage unavailable' });
  receipt(complete, 'crm_source_triage', 'done', noActions);
  receipt(complete, 'crm_action_projected', 'done', { candidates: [] });
  receipt(review, 'crm_source_triage', 'review', noActions);
  const dueRecoveryOptions = {
    referenceNow: Math.floor(Date.now() / 1000) + (2 * _test.AUTO_ERROR_RETRY_MAX_SECONDS),
  };

  assert.deepEqual(
    _test.candidateSources(recoveryUser, 10, dueRecoveryOptions).map(item => item.source_id).sort(),
    [fresh.source_id, crash.source_id, errored.source_id].sort(),
    'fresh, post-triage crash, and error sources resume; complete/review sources do not',
  );

  let triageCalls = 0;
  let duplicateCalls = 0;
  let projectionCalls = 0;
  let synthesisCalls = 0;
  let taskCalls = 0;
  const resumed = await _test.processSource(recoveryUser, crash, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    retry: true,
    dependencies: {
      triageSourceFn: async () => { triageCalls += 1; throw new Error('must not re-triage saved evidence'); },
      reviewDuplicateFn: async () => { duplicateCalls += 1; throw new Error('must not re-review saved duplicate result'); },
      projectActionsFn: async () => {
        projectionCalls += 1;
        return {
          parsed: {
            actions: [{
              candidate_key: crashCandidate.candidate_key,
              title: 'Send the recovery pack',
              actionability: 'explicit_ask',
              confidence: 0.9,
              evidence: 'Please send the recovery pack.',
            }],
          },
          modelId: 'test-projection',
        };
      },
      createTaskFn: async () => { taskCalls += 1; return { localId: 'recovery-task' }; },
      synthesiseSourceFn: async () => { synthesisCalls += 1; return { stored: 0, proposed: 0 }; },
    },
  });

  assert.equal(resumed.triaged, 0);
  assert.equal(triageCalls, 0);
  assert.equal(duplicateCalls, 0);
  assert.equal(projectionCalls, 1);
  assert.equal(synthesisCalls, 1);
  assert.equal(taskCalls, 1);
  assert.equal(
    db.hub().prepare(`
      SELECT COUNT(*) AS n FROM knowledge_receipts
      WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = 'crm_source_triage'
    `).get(recoveryUser, crash.source_kind, crash.source_id).n,
    1,
    'recovery did not append a second triage decision for the same revision',
  );
  assert.deepEqual(
    _test.candidateSources(recoveryUser, 10, dueRecoveryOptions).map(item => item.source_id).sort(),
    [fresh.source_id, errored.source_id].sort(),
    'the resumed source is complete while remaining recoverable sources stay selected',
  );
});

test('scheduler round-robins newest and oldest incomplete evidence with due errors', () => {
  const fairnessUser = 'crm-recovery-fairness';
  const oldIncomplete = [];
  const permanentErrors = [];
  for (let index = 0; index < 9; index += 1) {
    oldIncomplete.push(makeEvidenceForUser(
      fairnessUser,
      `fairness-old-incomplete-${index}`,
      `Old untouched source ${index}.`,
    ));
  }
  for (let index = 0; index < 9; index += 1) {
    const evidence = makeEvidenceForUser(
      fairnessUser,
      `fairness-permanent-error-${index}`,
      `Permanent error source ${index}.`,
    );
    permanentErrors.push(evidence);
    writeReceipt(fairnessUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
      status: 'error',
      summary: 'Permanent test failure.',
      payload: { error: 'permanent test failure' },
      sourceRevision: evidence.revision_hash,
    });
  }
  const newest = makeEvidenceForUser(
    fairnessUser,
    'fairness-new-neil-resend',
    'Neil resent this new request and needs an answer.',
  );
  const selected = _test.candidateSources(fairnessUser, 6, {
    referenceNow: Math.floor(Date.now() / 1000) + (2 * _test.AUTO_ERROR_RETRY_MAX_SECONDS),
  });
  const selectedIds = selected.map(item => item.source_id);

  assert.equal(selected.length, 6);
  assert.ok(selectedIds.includes(newest.source_id), 'the newest resend receives a current scheduler slot');
  assert.ok(selectedIds.includes(oldIncomplete[0].source_id), 'an old untouched source still receives a recovery slot');
  assert.ok(
    selectedIds.some(id => permanentErrors.some(item => item.source_id === id)),
    'due errors receive a separately budgeted retry slot',
  );
  assert.equal(new Set(selectedIds).size, selectedIds.length, 'lanes are de-duplicated before the limit is applied');
});

test('automatic error retry is receipt-backed, backs off, and manual retry bypasses its due time', async () => {
  const retryUser = 'crm-recovery-error-backoff';
  const evidence = makeEvidenceForUser(retryUser, 'error-backoff-source', 'A source whose triage service is unavailable.');
  writeReceipt(retryUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'error',
    summary: 'First unavailable response.',
    payload: { error: 'unavailable' },
    sourceRevision: evidence.revision_hash,
  });
  const referenceNow = Math.floor(Date.now() / 1000);
  const first = _test.sourceErrorRetryState(retryUser, evidence, referenceNow);
  assert.equal(first.attempts, 1);
  assert.equal(first.due, false);
  assert.equal(
    _test.candidateSources(retryUser, 8, { referenceNow: first.next_retry_at - 1 })
      .some(item => item.source_id === evidence.source_id),
    false,
    'a persistent error is absent until its receipt-derived retry time',
  );
  assert.equal(
    _test.candidateSources(retryUser, 8, { referenceNow: first.next_retry_at })
      .some(item => item.source_id === evidence.source_id),
    true,
    'the error remains retryable once due',
  );

  writeReceipt(retryUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'error',
    summary: 'Second unavailable response.',
    payload: { error: 'still unavailable' },
    sourceRevision: evidence.revision_hash,
  });
  const second = _test.sourceErrorRetryState(retryUser, evidence, referenceNow);
  assert.equal(second.attempts, 2);
  assert.equal(second.retry_delay_seconds, first.retry_delay_seconds * 2);
  assert.equal(second.due, false, 'the second receipt prevents a hot automatic retry loop');

  let triageCalls = 0;
  const manuallyRetried = await retryCrmKnowledgeErrors(retryUser, {
    limit: 1,
    dependencies: {
      requestModelObject: async () => ({}),
      triageSourceFn: async () => {
        triageCalls += 1;
        return {
          parsed: {
            should_synthesise: false,
            source_summary: 'Manual retry reached the source.',
            candidate_entities: [],
            candidate_relationships: [],
            candidate_actions: [],
            routing_notes: '',
            confidence: 1,
          },
          modelId: 'test-manual-retry',
        };
      },
    },
  });
  assert.equal(manuallyRetried.retried, 1, 'explicit retry bypasses automatic backoff');
  assert.equal(triageCalls, 1);
});

test('replay audit counts only exact-current revisions and saved debrief transcripts', () => {
  const auditUser = 'crm-replay-audit-current-revision';
  const hub = db.hub();
  const insertEmail = hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, 'Audit source', 'Alex', 'alex@example.test', ?, 'lossy', ?)
  `);
  insertEmail.run('replay-audit-stale-email', auditUser, 'replay-audit-stale-msg', 1771010000, 'Original evidence body.');
  insertEmail.run('replay-audit-current-email', auditUser, 'replay-audit-current-msg', 1771010001, 'Current evidence body.');
  insertEmail.run('replay-audit-report-email', auditUser, 'replay-audit-report-msg', 1771010002, 'Report body must be excluded.');
  hub.prepare("UPDATE email_summaries SET subject = 'Hub Daily Report: audit' WHERE id = ?")
    .run('replay-audit-report-email');
  hub.prepare(`
    INSERT INTO debrief_sessions (id, user, started_at, ended_at, transcript, note_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'replay-audit-debrief', auditUser, 1771010100, 1771010200,
    'Saved debrief transcript that is canonical evidence.', 'Debriefs/audit.md',
  );
  hub.prepare(`
    INSERT INTO debrief_sessions (id, user, started_at, transcript)
    VALUES (?, ?, ?, ?)
  `).run('replay-audit-in-progress', auditUser, 1771010300, 'In-progress debrief must stay ineligible.');

  const currentEmail = resolveSourceEvidence(auditUser, 'email_summary', 'replay-audit-current-email');
  const savedDebrief = resolveSourceEvidence(auditUser, 'debrief_session', 'replay-audit-debrief');
  const insertReceipt = hub.prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
    VALUES (?, ?, ?, ?, 'crm_source_triage', 'done', 'audit', ?, unixepoch())
  `);
  insertReceipt.run(
    'replay-audit-stale-receipt', auditUser, 'email_summary', 'replay-audit-stale-email',
    JSON.stringify({ pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION, source_revision: 'stale-revision' }),
  );
  insertReceipt.run(
    'replay-audit-current-receipt', auditUser, 'email_summary', 'replay-audit-current-email',
    JSON.stringify({
      pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
      source_revision: currentEmail.revision_hash,
      should_synthesise: false,
      candidate_actions: [],
    }),
  );
  // Same revision, later receipt: replay must use the latest state for a
  // source/stage rather than summing historical attempts.
  hub.prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
    VALUES (?, ?, ?, ?, 'crm_source_triage', 'done', 'audit retry complete', ?, unixepoch())
  `).run(
    'replay-audit-current-review', auditUser, 'email_summary', 'replay-audit-current-email',
    JSON.stringify({
      pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
      source_revision: currentEmail.revision_hash,
      should_synthesise: false,
      candidate_actions: [],
    }),
  );
  insertReceipt.run(
    'replay-audit-debrief-receipt', auditUser, 'debrief_session', 'replay-audit-debrief',
    JSON.stringify({
      pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
      source_revision: savedDebrief.revision_hash,
      should_synthesise: false,
      candidate_actions: [],
    }),
  );

  const insertActionReceipt = hub.prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
    VALUES (?, ?, ?, ?, 'crm_action_projected', 'done', 'no actions', ?, unixepoch())
  `);
  insertActionReceipt.run(
    'replay-audit-current-action', auditUser, 'email_summary', 'replay-audit-current-email',
    JSON.stringify({ pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION, source_revision: currentEmail.revision_hash, candidates: [] }),
  );
  insertActionReceipt.run(
    'replay-audit-debrief-action', auditUser, 'debrief_session', 'replay-audit-debrief',
    JSON.stringify({ pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION, source_revision: savedDebrief.revision_hash, candidates: [] }),
  );

  const output = runReplayAudit(auditUser);
  assert.match(output, /before: eligible=3 current=2 error=0 review=0 incomplete=1/);
  assert.match(output, /after: eligible=3 current=2 error=0 review=0 incomplete=1/);
});

test('replay apply queues one canonical engine job and is idempotent', () => {
  const auditUser = 'crm-replay-apply-idempotent';
  const hub = db.hub();
  hub.prepare("DELETE FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").run();
  const beforeJobs = hub.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine'").get().n;
  const first = runReplayApply(auditUser);
  assert.match(first, /apply: queued crm_knowledge_engine job/);
  const afterFirst = hub.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").get().n;
  assert.equal(afterFirst, 1);
  const second = runReplayApply(auditUser);
  assert.match(second, /apply: existing versioned replay path already queued as/);
  const afterSecond = hub.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").get().n;
  assert.equal(afterSecond, 1);
  assert.equal(hub.prepare("SELECT COUNT(*) AS n FROM google_tasks WHERE user = ?").get(auditUser).n, 0);
  assert.equal(hub.prepare("SELECT COUNT(*) AS n FROM crm_action_outcomes WHERE user = ?").get(auditUser).n, 0);
  assert.ok(beforeJobs >= 0);
  hub.prepare("DELETE FROM system_jobs WHERE type = 'crm_knowledge_engine' AND json_extract(payload, '$.user') = ?").run(auditUser);
});

test('a non-provider projection failure is atomically retried once and then creates one task', async () => {
  const retryUser = 'crm-projection-retryable-error';
  const quote = 'Please send the retryable projection pack.';
  const evidence = makeEvidenceForUser(retryUser, 'projection-retryable-error', quote);
  const action = actionFor(evidence, quote);
  const candidate = triageCandidateFor(evidence, action);

  const failed = await _test.projectCandidates(retryUser, evidence, [candidate], [], {
    projectActionsFn: async () => { throw new Error('projection model temporarily unavailable'); },
  });
  assert.equal(failed.errors, 1);
  const failedOutcome = _test.getActionOutcome(retryUser, evidence, candidate.candidate_key);
  assert.equal(failedOutcome.disposition, 'error');
  assert.match(failedOutcome.reason, /^action_projection_failed:/);

  let providerCalls = 0;
  const recovered = await _test.projectCandidates(retryUser, evidence, [candidate], [], {
    projectActionsFn: async () => ({
      parsed: { actions: [{
        title: action.title,
        candidate_key: candidate.candidate_key,
        actionability: action.actionability,
        confidence: action.confidence,
        evidence: quote,
      }] },
      modelId: 'projection-retry-success',
    }),
    createTaskFn: async () => {
      providerCalls += 1;
      return { localId: 'retryable-projection-task' };
    },
  });
  assert.equal(recovered.created, 1);
  assert.equal(providerCalls, 1);
  const terminal = _test.getActionOutcome(retryUser, evidence, candidate.candidate_key);
  assert.equal(terminal.disposition, 'task_created');

  const replay = await _test.projectCandidates(retryUser, evidence, [candidate], [], {
    projectActionsFn: async () => ({
      parsed: { actions: [{
        title: action.title,
        candidate_key: candidate.candidate_key,
        actionability: action.actionability,
        confidence: action.confidence,
        evidence: quote,
      }] },
      modelId: 'projection-retry-replay',
    }),
    createTaskFn: async () => {
      providerCalls += 1;
      return { localId: 'must-not-run' };
    },
  });
  assert.equal(replay.created, 1, 'the terminal outcome is replay-counted');
  assert.equal(providerCalls, 1, 'only the recovered projection reached the provider');
});

test('a source processing lease lets one concurrent worker triage a revision', async () => {
  const leaseUser = 'crm-source-lease-concurrent';
  const evidence = makeEvidenceForUser(leaseUser, 'source-lease-concurrent', 'No durable knowledge in this source.');
  let triageCalls = 0;
  let releaseTriage;
  let signalTriage;
  const release = new Promise(resolve => { releaseTriage = resolve; });
  const started = new Promise(resolve => { signalTriage = resolve; });
  const context = { entities: [], entityFacts: [], budget: { n: 0 } };
  const dependencies = {
    triageSourceFn: async () => {
      triageCalls += 1;
      signalTriage();
      await release;
      return { parsed: { should_synthesise: false, candidate_actions: [], source_summary: 'No durable knowledge.' }, modelId: 'lease-test' };
    },
  };

  const first = _test.processSource(leaseUser, evidence, context, { lease: { leaseSeconds: 30 }, dependencies });
  await started;
  const second = await _test.processSource(leaseUser, evidence, context, { lease: { leaseSeconds: 30 }, dependencies });
  assert.equal(second.lease_held, true);
  assert.equal(triageCalls, 1, 'the losing worker never enters source triage');
  releaseTriage();
  const completed = await first;
  assert.equal(completed.triaged, 1);
  assert.equal(triageCalls, 1);
});

test('a worker that loses the source lease after a model response writes no stale receipt', async () => {
  const leaseUser = 'crm-source-lease-lost-after-model';
  const evidence = makeEvidenceForUser(leaseUser, 'source-lease-lost-after-model', 'Late model response must not be persisted.');
  let releaseTriage;
  let signalTriage;
  const release = new Promise(resolve => { releaseTriage = resolve; });
  const started = new Promise(resolve => { signalTriage = resolve; });
  const pending = _test.processSource(leaseUser, evidence, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    lease: { leaseSeconds: 30 },
    dependencies: {
      triageSourceFn: async () => {
        signalTriage();
        await release;
        return { parsed: { should_synthesise: false, candidate_actions: [], source_summary: 'Late response' }, modelId: 'lease-test' };
      },
    },
  });
  await started;
  // Simulate another worker reclaiming ownership. The original token can no
  // longer refresh, so its post-await assertion must abort before receipts.
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-worker-token', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(leaseUser, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseTriage();
  await assert.rejects(pending, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  assert.equal(
    db.hub().prepare(`
      SELECT COUNT(*) AS n FROM knowledge_receipts
      WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = 'crm_source_triage'
    `).get(leaseUser, evidence.source_kind, evidence.source_id).n,
    0,
    'the stale model response did not write a triage receipt',
  );
});

test('only an expired source lease is reclaimable and an old token cannot finish it', () => {
  const leaseUser = 'crm-source-lease-stale-reclaim';
  const evidence = makeEvidenceForUser(leaseUser, 'source-lease-stale-reclaim', 'Stale lease recovery evidence.');
  const first = _test.claimSourceProcessingLease(leaseUser, evidence, { leaseSeconds: 30 });
  assert.equal(first.claimed, true);
  assert.equal(_test.claimSourceProcessingLease(leaseUser, evidence, { leaseSeconds: 30 }).claimed, false);
  db.hub().prepare(`
    UPDATE crm_source_processing_leases SET expires_at = unixepoch() - 1
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(leaseUser, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  const replacement = _test.claimSourceProcessingLease(leaseUser, evidence, { leaseSeconds: 30 });
  assert.equal(replacement.claimed, true);
  assert.equal(replacement.reclaimed_stale, true);
  assert.equal(_test.finishSourceProcessingLease(leaseUser, evidence, first.token, { status: 'done' }), false);
  assert.equal(_test.finishSourceProcessingLease(leaseUser, evidence, replacement.token, { status: 'done' }), true);
});

test('duplicate review failure blocks atom synthesis but still projects its triage action', async () => {
  const duplicateUser = 'crm-duplicate-error-action-projection';
  const quote = 'Please send the duplicate-review pack.';
  const evidence = makeEvidenceForUser(duplicateUser, 'duplicate-review-error-action', quote);
  const action = actionFor(evidence, quote);
  const candidate = triageCandidateFor(evidence, action);
  let synthesisCalls = 0;
  let taskCalls = 0;
  const result = await _test.processSource(duplicateUser, evidence, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    dependencies: {
      triageSourceFn: async () => ({
        parsed: { should_synthesise: true, candidate_actions: [candidate], source_summary: 'Knowledge plus action.' },
        modelId: 'duplicate-gate-test',
      }),
      reviewDuplicateFn: async () => { throw new Error('duplicate model unavailable'); },
      projectActionsFn: async () => ({
        parsed: { actions: [{
          title: action.title,
          candidate_key: candidate.candidate_key,
          actionability: action.actionability,
          confidence: action.confidence,
          evidence: quote,
        }] },
        modelId: 'action-projection-test',
      }),
      createTaskFn: async () => { taskCalls += 1; return { localId: 'duplicate-gate-task' }; },
      synthesiseSourceFn: async () => { synthesisCalls += 1; return { stored: 0, proposed: 0, atom_ids: [] }; },
    },
  });
  assert.equal(taskCalls, 1);
  assert.equal(synthesisCalls, 0);
  assert.equal(result.errors, 1);
  const synthesisReceipt = _test.currentSourceReceipt(duplicateUser, evidence, 'crm_knowledge_synthesised');
  assert.equal(synthesisReceipt.status, 'error');
  assert.equal(_test.getActionOutcome(duplicateUser, evidence, candidate.candidate_key).disposition, 'task_created');
});

test('a source-wide duplicate decision still synthesises a novel claim and merges only per-claim provenance', async () => {
  const duplicateUser = 'crm-duplicate-provenance-merge';
  const evidence = makeEvidenceForUser(
    duplicateUser,
    'duplicate-provenance-merge',
    'Alex confirmed the agreement remains approved. Morgan now leads the renewal work.',
  );
  const atomId = upsertAtom(duplicateUser, {
    subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
    sourceRef: { kind: 'crm_fact', id: 'legacy-approved' }, confidence: 0.8, derivedBy: 'synthesis',
  });
  let synthesisCalls = 0;
  let novelAtomId = null;
  const result = await _test.processSource(duplicateUser, evidence, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    dependencies: {
      triageSourceFn: async () => ({ parsed: { should_synthesise: true, candidate_actions: [], source_summary: 'Confirmation.' }, modelId: 'duplicate-test' }),
      reviewDuplicateFn: async () => ({ parsed: { decision: 'duplicate', target_id: atomId, confidence: 0.96, reason: 'Same claim.' }, modelId: 'duplicate-test' }),
      synthesiseSourceFn: async (_user, sourceKind, sourceId, source, _entities, _budget, _facts, _context, options) => {
        synthesisCalls += 1;
        assert.deepEqual(options.excludeAtomIds || [], [], 'confirmation does not exclude the existing atom and manufacture a duplicate');
        const before = JSON.parse(db.hub().prepare('SELECT source_refs FROM knowledge_atoms WHERE id = ?').get(atomId).source_refs);
        assert.ok(!before.some(ref => ref.kind === sourceKind && ref.id === sourceId && ref.revision === source.revision_hash), 'source-wide review did not pre-merge full-source provenance');
        const sourceRef = {
          kind: sourceKind, id: sourceId, revision: source.revision_hash,
          chunk_index: source.chunks[0].index, chunk_id: source.chunks[0].chunk_id,
          start: source.chunks[0].start, end: source.chunks[0].end,
        };
        const confirmedId = upsertAtom(duplicateUser, {
          subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
          sourceRef, confidence: 0.96, derivedBy: 'synthesis',
        });
        novelAtomId = upsertAtom(duplicateUser, {
          subjectKind: 'contact', subjectLabel: 'Morgan', predicate: 'responsibility', value: 'leads the renewal work',
          sourceRef, confidence: 0.91, derivedBy: 'synthesis',
        });
        return { stored: 2, proposed: 0, atom_ids: [confirmedId, novelAtomId] };
      },
    },
  });
  assert.equal(result.skipped, 0);
  assert.equal(result.synthesised, 1);
  assert.equal(synthesisCalls, 1, 'a duplicate target never suppresses the rest of the source');
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(atomId);
  const refs = JSON.parse(atom.source_refs);
  assert.ok(refs.some(ref => ref.kind === 'crm_fact' && ref.id === 'legacy-approved'));
  assert.ok(refs.some(ref => ref.kind === evidence.source_kind
    && ref.id === evidence.source_id
    && ref.revision === evidence.revision_hash
    && ref.chunk_id === evidence.chunks[0].chunk_id
    && ref.start === evidence.chunks[0].start
    && ref.end === evidence.chunks[0].end));
  assert.equal(
    db.hub().prepare(`
      SELECT COUNT(*) AS n FROM knowledge_atoms
      WHERE user = ? AND lower(subject_label) = 'alex' AND predicate = 'agreement_status' AND lower(value) = 'approved'
    `).get(duplicateUser).n,
    1,
    'the confirmation reuses the existing atom rather than creating a duplicate',
  );
  assert.notEqual(novelAtomId, atomId);
  assert.ok(db.hub().prepare('SELECT id FROM knowledge_atoms WHERE id = ?').get(novelAtomId), 'the novel claim remains in the compiled knowledge layer');
  const receipt = _test.currentSourceReceipt(duplicateUser, evidence, 'crm_knowledge_synthesised');
  assert.equal(receipt.status, 'done');
  assert.equal(JSON.parse(receipt.payload).duplicate_confirmation.per_claim_proven, true);
});

test('an unproven duplicate confirmation keeps novel atoms but leaves a dedicated source review visible', async () => {
  const duplicateUser = 'crm-duplicate-confirmation-unproven';
  const evidence = makeEvidenceForUser(
    duplicateUser,
    'duplicate-confirmation-unproven',
    'Alex may still have the agreement. Morgan now owns the new renewal project.',
  );
  const targetId = upsertAtom(duplicateUser, {
    subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
    sourceRef: { kind: 'crm_fact', id: 'legacy-agreement' }, confidence: 0.8, derivedBy: 'synthesis',
  });
  let novelAtomId = null;
  const result = await _test.processSource(duplicateUser, evidence, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    dependencies: {
      triageSourceFn: async () => ({ parsed: { should_synthesise: true, candidate_actions: [], source_summary: 'Mixed durable claims.' }, modelId: 'duplicate-test' }),
      reviewDuplicateFn: async () => ({ parsed: { decision: 'confirms_existing', target_id: targetId, confidence: 0.96, reason: 'Likely existing agreement.' }, modelId: 'duplicate-test' }),
      synthesiseSourceFn: async (_user, sourceKind, sourceId, source) => {
        const sourceRef = {
          kind: sourceKind, id: sourceId, revision: source.revision_hash,
          chunk_index: source.chunks[0].index, chunk_id: source.chunks[0].chunk_id,
          start: source.chunks[0].start, end: source.chunks[0].end,
        };
        // The per-claim extractor found only the unrelated novel claim. It
        // must not cause the source-wide duplicate decision to mutate Alex.
        novelAtomId = upsertAtom(duplicateUser, {
          subjectKind: 'contact', subjectLabel: 'Morgan', predicate: 'responsibility', value: 'owns the new renewal project',
          sourceRef, confidence: 0.91, derivedBy: 'synthesis',
        });
        return { stored: 1, proposed: 0, atom_ids: [novelAtomId] };
      },
    },
  });

  assert.equal(result.synthesised, 1);
  assert.equal(result.reviews, 1);
  assert.ok(db.hub().prepare('SELECT id FROM knowledge_atoms WHERE id = ?').get(novelAtomId), 'the novel claim was retained instead of being skipped');
  const targetRefs = JSON.parse(db.hub().prepare('SELECT source_refs FROM knowledge_atoms WHERE id = ?').get(targetId).source_refs);
  assert.ok(!targetRefs.some(ref => ref.kind === evidence.source_kind && ref.id === evidence.source_id && ref.revision === evidence.revision_hash), 'the target was not merged without per-claim proof');
  const synthesisReceipt = _test.currentSourceReceipt(duplicateUser, evidence, 'crm_knowledge_synthesised');
  assert.equal(synthesisReceipt.status, 'review');
  assert.equal(JSON.parse(synthesisReceipt.payload).duplicate_confirmation.per_claim_proven, false);
  const gate = listActionOutcomeQueue(duplicateUser).find(row =>
    row.source_id === evidence.source_id && row.payload.source_stage === 'duplicate_confirmation_unproven',
  );
  assert.ok(gate, 'the source remains resolvable through the dedicated duplicate review queue');
  assert.throws(
    () => require('../lib/crm-knowledge-engine').dismissActionOutcome(duplicateUser, gate.id, 'hide it'),
    /requires Skip atom synthesis or Re-run duplicate review/,
  );
  assert.equal(getCrmKnowledgeHealth(duplicateUser).coverage.sources.find(row => row.source_id === evidence.source_id).state, 'review');
});

test('supersession retires only after a distinct same-slot replacement, not an unrelated atom', async () => {
  const supersessionUser = 'crm-supersession-claim-slot';
  const evidence = makeEvidenceForUser(supersessionUser, 'supersession-claim-slot', 'Alex confirmed the corrected agreement status.');
  const targetId = upsertAtom(supersessionUser, {
    subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
    sourceRef: { kind: 'crm_fact', id: 'superseded-agreement' }, confidence: 0.8, derivedBy: 'synthesis',
  });
  let replacementId = null;
  const result = await _test.processSource(supersessionUser, evidence, {
    entities: [], entityFacts: [], budget: { n: 0 },
  }, {
    dependencies: {
      triageSourceFn: async () => ({ parsed: { should_synthesise: true, candidate_actions: [], source_summary: 'Correction.' }, modelId: 'supersession-test' }),
      reviewDuplicateFn: async () => ({ parsed: { decision: 'corrects_existing', target_id: targetId, confidence: 0.97, reason: 'Corrected claim.' }, modelId: 'supersession-test' }),
      synthesiseSourceFn: async (_user, sourceKind, sourceId, source, _entities, _budget, _facts, _context, options) => {
        const sourceRef = {
          kind: sourceKind, id: sourceId, revision: source.revision_hash,
          chunk_index: source.chunks[0].index, chunk_id: source.chunks[0].chunk_id,
          start: source.chunks[0].start, end: source.chunks[0].end,
        };
        // This ref alone must never prove a replacement for Alex's agreement.
        upsertAtom(supersessionUser, {
          subjectKind: 'contact', subjectLabel: 'Morgan', predicate: 'agreement_status', value: 'approved',
          sourceRef, confidence: 0.8, derivedBy: 'synthesis',
        });
        // Deliberately use the same normalized claim as the target: options'
        // exclusion proves a correction creates a distinct replacement rather
        // than reconfirming the soon-to-be-retired target.
        replacementId = upsertAtom(supersessionUser, {
          subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
          sourceRef, confidence: 0.9, derivedBy: 'synthesis', excludeAtomIds: options.excludeAtomIds,
        });
        return { stored: 2, proposed: 0, atom_ids: [replacementId] };
      },
    },
  });
  assert.equal(result.reviews, 0);
  assert.notEqual(replacementId, targetId);
  const target = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(targetId);
  const replacement = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(replacementId);
  assert.equal(target.status, 'retired');
  assert.equal(replacement.status, 'active');
  assert.ok(JSON.parse(replacement.source_refs).some(ref => ref.revision === evidence.revision_hash && ref.chunk_id));
  assert.ok(JSON.parse(target.source_refs).some(ref => ref.revision === evidence.revision_hash && ref.start === 0));
});

test('duplicate-review skip is audited, terminalizes the source gate, and generic dismissal cannot hide it', () => {
  const resolutionUser = 'crm-duplicate-review-skip-resolution';
  const evidence = makeEvidenceForUser(resolutionUser, 'duplicate-review-skip', 'A potentially duplicate durable claim.');
  const decision = { should_synthesise: true, candidate_actions: [], source_summary: 'Durable claim.' };
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'done', payload: decision, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
    status: 'done', payload: { candidates: [] }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_duplicate_reviewed', {
    status: 'uncertain', payload: { decision: 'uncertain', confidence: 0.4 }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
    status: 'review', payload: { triage: decision, synthesis_gate: 'duplicate_review_uncertain' }, sourceRevision: evidence.revision_hash,
  });
  const gate = _test.sourceLevelOutcome(resolutionUser, evidence, 'duplicate_review_gate', 'review', 'duplicate_review_uncertain', {
    synthesis_gate: { mode: 'review', reason: 'duplicate_review_uncertain' },
  });

  assert.throws(
    () => require('../lib/crm-knowledge-engine').dismissActionOutcome(resolutionUser, gate.id, 'not an action'),
    /requires Skip atom synthesis or Re-run duplicate review/,
  );
  assert.equal(getCrmKnowledgeHealth(resolutionUser).coverage.sources.find(row => row.source_id === evidence.source_id).state, 'review');

  const skipped = _test.skipDuplicateReviewSynthesis(resolutionUser, gate.id, { reason: 'Reviewed source; retain no atom.' });
  assert.equal(skipped.resolved, 1);
  assert.equal(_test.currentSourceReceipt(resolutionUser, evidence, 'crm_duplicate_reviewed').status, 'skipped');
  assert.equal(_test.currentSourceReceipt(resolutionUser, evidence, 'crm_knowledge_synthesised').status, 'skipped');
  assert.equal(db.hub().prepare('SELECT disposition FROM crm_action_outcomes WHERE id = ?').get(gate.id).disposition, 'dismissed');
  assert.ok(!listActionOutcomeQueue(resolutionUser).some(row => row.id === gate.id));
  const coverage = getCrmKnowledgeHealth(resolutionUser).coverage.sources.find(row => row.source_id === evidence.source_id);
  assert.deepEqual(coverage, {
    source_kind: evidence.source_kind,
    source_id: evidence.source_id,
    source_revision: evidence.revision_hash,
    completeness: evidence.completeness,
    state: 'complete',
    reason: 'skipped',
  });
});

test('duplicate-review retry re-runs only the selected source and resumes its gated synthesis', async () => {
  const resolutionUser = 'crm-duplicate-review-retry-resolution';
  const evidence = makeEvidenceForUser(resolutionUser, 'duplicate-review-retry', 'A source needing a fresh duplicate decision.');
  const decision = { should_synthesise: true, candidate_actions: [], source_summary: 'Durable claim.' };
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'done', payload: decision, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
    status: 'done', payload: { candidates: [] }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_duplicate_reviewed', {
    status: 'uncertain', payload: { decision: 'uncertain', confidence: 0.4 }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
    status: 'review', payload: { triage: decision, synthesis_gate: 'duplicate_review_uncertain' }, sourceRevision: evidence.revision_hash,
  });
  const gate = _test.sourceLevelOutcome(resolutionUser, evidence, 'duplicate_review_gate', 'review', 'duplicate_review_uncertain', {
    synthesis_gate: { mode: 'review', reason: 'duplicate_review_uncertain' },
  });
  const unrelated = makeEvidenceForUser(resolutionUser, 'duplicate-review-unrelated', 'An unrelated source that must remain untouched.');
  writeReceipt(resolutionUser, unrelated.source_kind, unrelated.source_id, 'crm_source_triage', {
    status: 'review', payload: { should_synthesise: false, candidate_actions: [] }, sourceRevision: unrelated.revision_hash,
  });

  const queued = _test.queueDuplicateReviewRetry(resolutionUser, gate.id);
  assert.equal(queued.queued, true);
  assert.equal(_test.currentSourceReceipt(resolutionUser, evidence, 'crm_duplicate_reviewed').status, 'pending');
  let reviewed = 0;
  let synthesised = 0;
  const retried = await _test.retryDuplicateReview(resolutionUser, gate.id, {
    dependencies: {
      reviewDuplicateFn: async () => {
        reviewed += 1;
        return { parsed: { decision: 'new', confidence: 0.95, reason: 'Fresh semantic review.' }, modelId: 'duplicate-retry-test' };
      },
      synthesiseSourceFn: async () => {
        synthesised += 1;
        return { stored: 0, proposed: 0, atom_ids: [] };
      },
    },
  });
  assert.equal(retried.retry_duplicate_reviewed, true);
  assert.equal(reviewed, 1);
  assert.equal(synthesised, 1);
  assert.equal(_test.currentSourceReceipt(resolutionUser, evidence, 'crm_knowledge_synthesised').status, 'done');
  assert.equal(db.hub().prepare('SELECT disposition FROM crm_action_outcomes WHERE id = ?').get(gate.id).disposition, 'dismissed');
  assert.equal(
    db.hub().prepare(`SELECT COUNT(*) AS n FROM knowledge_receipts WHERE user = ? AND source_id = ?`).get(resolutionUser, unrelated.source_id).n,
    1,
    'targeted retry did not process the unrelated review source',
  );
  assert.equal(getCrmKnowledgeHealth(resolutionUser).coverage.sources.find(row => row.source_id === evidence.source_id).state, 'complete');
});

test('duplicate-review retry keeps the existing source gate visible when its lease is lost', async () => {
  const resolutionUser = 'crm-duplicate-review-retry-lease-loss';
  const evidence = makeEvidenceForUser(resolutionUser, 'duplicate-review-retry-lease-loss', 'A source whose re-review lease will be replaced.');
  const decision = { should_synthesise: true, candidate_actions: [], source_summary: 'Durable claim.' };
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
    status: 'done', payload: decision, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
    status: 'done', payload: { candidates: [] }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_duplicate_reviewed', {
    status: 'uncertain', payload: { decision: 'uncertain', confidence: 0.4 }, sourceRevision: evidence.revision_hash,
  });
  writeReceipt(resolutionUser, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
    status: 'review', payload: { triage: decision, synthesis_gate: 'duplicate_review_uncertain' }, sourceRevision: evidence.revision_hash,
  });
  const gate = _test.sourceLevelOutcome(resolutionUser, evidence, 'duplicate_review_gate', 'review', 'duplicate_review_uncertain', {
    synthesis_gate: { mode: 'review', reason: 'duplicate_review_uncertain' },
  });
  _test.queueDuplicateReviewRetry(resolutionUser, gate.id);

  let releaseReview;
  let signalReview;
  const release = new Promise(resolve => { releaseReview = resolve; });
  const started = new Promise(resolve => { signalReview = resolve; });
  const retry = _test.retryDuplicateReview(resolutionUser, gate.id, {
    dependencies: {
      reviewDuplicateFn: async () => {
        signalReview();
        await release;
        return { parsed: { decision: 'new', confidence: 0.96, reason: 'Late review.' }, modelId: 'duplicate-retry-test' };
      },
    },
  });
  await started;
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-duplicate-review-owner', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(resolutionUser, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseReview();

  await assert.rejects(retry, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  const preserved = db.hub().prepare('SELECT disposition FROM crm_action_outcomes WHERE id = ?').get(gate.id);
  assert.equal(preserved.disposition, 'review', 'a stale retry did not dismiss the only source-level resolution control');
  assert.ok(listActionOutcomeQueue(resolutionUser).some(row => row.id === gate.id && row.disposition === 'review'), 'the duplicate gate remains in the visible queue');
  assert.equal(_test.currentSourceReceipt(resolutionUser, evidence, 'crm_knowledge_synthesised').status, 'review');
  assert.equal(getCrmKnowledgeHealth(resolutionUser).coverage.sources.find(row => row.source_id === evidence.source_id).state, 'review');
});

test('lease loss during task creation leaves the pending task outcome untouched', async () => {
  const leaseUser = 'crm-post-provider-task-lease-loss';
  const quote = 'Please send the lease-guarded task.';
  const evidence = makeEvidenceForUser(leaseUser, 'post-provider-task-lease-loss', quote);
  const action = actionFor(evidence, quote);
  const candidate = triageCandidateFor(evidence, action);
  let releaseProvider;
  let signalProvider;
  const release = new Promise(resolve => { releaseProvider = resolve; });
  const started = new Promise(resolve => { signalProvider = resolve; });
  let providerCalls = 0;
  const dependencies = {
    triageSourceFn: async () => ({ parsed: { should_synthesise: false, candidate_actions: [candidate], source_summary: 'Task only.' }, modelId: 'lease-test' }),
    reviewDuplicateFn: async () => ({ parsed: { decision: 'new', confidence: 0.95, reason: 'New action source.' }, modelId: 'lease-test' }),
    projectActionsFn: async () => ({
      parsed: { actions: [{ title: action.title, candidate_key: candidate.candidate_key, actionability: action.actionability, confidence: action.confidence, evidence: quote }] },
      modelId: 'lease-test',
    }),
    createTaskFn: async () => {
      providerCalls += 1;
      signalProvider();
      await release;
      return { localId: 'late-task-created' };
    },
  };
  const pending = _test.processSource(leaseUser, evidence, { entities: [], entityFacts: [], budget: { n: 0 } }, { dependencies });
  await started;
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-task-owner', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(leaseUser, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseProvider();
  await assert.rejects(pending, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  const outcome = _test.getActionOutcome(leaseUser, evidence, candidate.candidate_key);
  assert.equal(outcome.disposition, 'pending_task');
  assert.equal(outcome.reason, 'task_side_effect_pending');
  assert.equal(providerCalls, 1);
  const later = await _test.processSource(leaseUser, evidence, { entities: [], entityFacts: [], budget: { n: 0 } }, { dependencies });
  assert.equal(later.lease_held, true);
  assert.equal(providerCalls, 1, 'a second worker never repeats the provider task call');
});

test('lease loss during calendar creation leaves the pending event outcome untouched', async () => {
  const leaseUser = 'crm-post-provider-event-lease-loss';
  const quote = 'Please attend the lease-guarded calendar review.';
  const evidence = makeEvidenceForUser(leaseUser, 'post-provider-event-lease-loss', quote);
  const action = actionFor(evidence, quote, {
    event: { start: '2026-08-03T10:00', end: '2026-08-03T10:30', location: 'Teams' },
  });
  const candidate = triageCandidateFor(evidence, action);
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source, source_id, created_at)
    VALUES (?, ?, ?, '@default', ?, 'needsAction', 'crm-engine', ?, unixepoch())
  `).run('late-event-stable-task', leaseUser, 'late-event-stable-google', action.title, `crm-action:${candidate.candidate_key}`);
  let releaseProvider;
  let signalProvider;
  const release = new Promise(resolve => { releaseProvider = resolve; });
  const started = new Promise(resolve => { signalProvider = resolve; });
  let eventCalls = 0;
  const dependencies = {
    triageSourceFn: async () => ({ parsed: { should_synthesise: false, candidate_actions: [candidate], source_summary: 'Calendar only.' }, modelId: 'lease-test' }),
    reviewDuplicateFn: async () => ({ parsed: { decision: 'new', confidence: 0.95, reason: 'New action source.' }, modelId: 'lease-test' }),
    projectActionsFn: async () => ({
      parsed: { actions: [{ ...action, candidate_key: candidate.candidate_key }] },
      modelId: 'lease-test',
    }),
    createCalendarEventFn: async () => {
      eventCalls += 1;
      signalProvider();
      await release;
      return { localId: 'late-event-created' };
    },
  };
  const pending = _test.processSource(leaseUser, evidence, { entities: [], entityFacts: [], budget: { n: 0 } }, { dependencies });
  await started;
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-event-owner', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(leaseUser, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseProvider();
  await assert.rejects(pending, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  const outcome = _test.getActionOutcome(leaseUser, evidence, candidate.candidate_key);
  assert.equal(outcome.disposition, 'pending_event');
  assert.equal(outcome.reason, 'calendar_side_effect_pending');
  assert.equal(eventCalls, 1);
  const later = await _test.processSource(leaseUser, evidence, { entities: [], entityFacts: [], budget: { n: 0 } }, { dependencies });
  assert.equal(later.lease_held, true);
  assert.equal(eventCalls, 1, 'a second worker never repeats the provider calendar call');
});

test('human approval uses the full source lease and leaves its pending task on post-provider lease loss', async () => {
  const quote = 'Could you send the approval lease task?';
  const evidence = makeEvidence(quote);
  const action = actionFor(evidence, quote, { actionability: 'implied', confidence: 0.5 });
  const candidate = triageCandidateFor(evidence, action);
  const review = await project(evidence, action);
  assert.equal(review.review, 1);
  const outcome = _test.getActionOutcome(user, evidence, candidate.candidate_key);
  assert.equal(outcome.disposition, 'review');

  let releaseProvider;
  let signalProvider;
  const release = new Promise(resolve => { releaseProvider = resolve; });
  const started = new Promise(resolve => { signalProvider = resolve; });
  let providerCalls = 0;
  const dependencies = {
    createTaskFn: async () => {
      providerCalls += 1;
      signalProvider();
      await release;
      return { localId: 'late-approved-task' };
    },
  };

  const competing = _test.claimSourceProcessingLease(user, evidence);
  assert.equal(competing.claimed, true);
  assert.throws(
    () => approveReviewedAction(user, outcome.id, { dependencies }),
    err => err?.code === 'SOURCE_PROCESSING_LEASE_HELD',
    'approval must not bypass a running source worker',
  );
  assert.equal(providerCalls, 0);
  assert.equal(_test.finishSourceProcessingLease(user, evidence, competing.token, { status: 'done' }), true);

  const pending = approveReviewedAction(user, outcome.id, { dependencies });
  await started;
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-approved-task-owner', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(user, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseProvider();

  await assert.rejects(pending, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  const persisted = _test.getActionOutcome(user, evidence, candidate.candidate_key);
  assert.equal(persisted.disposition, 'pending_task');
  assert.equal(persisted.reason, 'task_side_effect_pending');
  assert.equal(providerCalls, 1);
});

test('human approval leaves its pending calendar event on post-provider lease loss', async () => {
  const quote = 'Could you attend the approval lease review at 10:00?';
  const evidence = makeEvidence(quote);
  const action = actionFor(evidence, quote, {
    actionability: 'implied',
    confidence: 0.5,
    event: { start: '2026-08-03T10:00', end: '2026-08-03T10:30', location: 'Teams' },
  });
  const candidate = triageCandidateFor(evidence, action);
  const review = await project(evidence, action);
  assert.equal(review.review, 1);
  const outcome = _test.getActionOutcome(user, evidence, candidate.candidate_key);
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source, source_id, created_at)
    VALUES (?, ?, ?, '@default', ?, 'needsAction', 'crm-engine', ?, unixepoch())
  `).run(`approved-calendar-stable-task-${messageNumber}`, user, `approved-calendar-google-${messageNumber}`, action.title, `crm-action:${candidate.candidate_key}`);

  let releaseProvider;
  let signalProvider;
  const release = new Promise(resolve => { releaseProvider = resolve; });
  const started = new Promise(resolve => { signalProvider = resolve; });
  let eventCalls = 0;
  const pending = approveReviewedAction(user, outcome.id, {
    dependencies: {
      createCalendarEventFn: async () => {
        eventCalls += 1;
        signalProvider();
        await release;
        return { localId: 'late-approved-event' };
      },
    },
  });
  await started;
  db.hub().prepare(`
    UPDATE crm_source_processing_leases
       SET lease_token = 'replacement-approved-event-owner', heartbeat_at = unixepoch(), expires_at = unixepoch() + 60
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
  `).run(user, evidence.source_kind, evidence.source_id, evidence.revision_hash);
  releaseProvider();

  await assert.rejects(pending, err => err?.code === 'SOURCE_PROCESSING_LEASE_LOST');
  const persisted = _test.getActionOutcome(user, evidence, candidate.candidate_key);
  assert.equal(persisted.disposition, 'pending_event');
  assert.equal(persisted.reason, 'calendar_side_effect_pending');
  assert.equal(eventCalls, 1);
});
