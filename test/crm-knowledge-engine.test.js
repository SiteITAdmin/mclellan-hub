'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/crm-knowledge-engine');
const { PROMPTS } = require('../lib/prompts');

test('completed tasks are terminal and cannot project replacement tasks', () => {
  assert.equal(
    _test.actionProjectionBlockReason('completed_task', null),
    'completed_task_is_terminal',
  );
});

test('a fresh WhatsApp bubble sits inside the settle window', () => {
  const now = 1_786_725_000;
  assert.equal(
    _test.isInsideMessagingSettleWindow({
      source_kind: 'messaging_message',
      ts: now - 60,
    }, now),
    true,
  );
  assert.equal(
    _test.isInsideMessagingSettleWindow({
      source_kind: 'messaging_message',
      ts: now - _test.MESSAGING_SETTLE_SECONDS - 1,
    }, now),
    false,
  );
  assert.equal(
    _test.isInsideMessagingSettleWindow({
      source_kind: 'email_summary',
      ts: now - 10,
    }, now),
    false,
  );
});

test('chat resolution only auto-completes a high-confidence resolve', () => {
  assert.equal(_test.classifyChatResolution({ decision: 'resolves', confidence: 0.9 }), 'apply');
  assert.equal(_test.classifyChatResolution({ decision: 'resolves', confidence: 0.7 }), 'review');
  assert.equal(_test.classifyChatResolution({ decision: 'unrelated', confidence: 0.99 }), 'ignore');
  assert.equal(_test.classifyChatResolution({ decision: 'still_outstanding', confidence: 0.99 }), 'ignore');
});

test('messaging prompts treat an already-answered chat question as not outstanding', () => {
  assert.match(PROMPTS.crm_source_triage, /SAME-CHAT CONTEXT/);
  assert.match(PROMPTS.crm_source_triage, /later same-chat turn already answers/);
  assert.match(PROMPTS.crm_action_projection, /Set actionability to fyi/);
  assert.match(PROMPTS.crm_action_resolution, /decision": "resolves \| still_outstanding \| unrelated/);
  assert.match(_test.ACTION_MESSAGING_GUARD, /neighbouring WhatsApp turns/);
});

test('historical messaging backfills cannot project stale actions', () => {
  assert.equal(
    _test.actionProjectionBlockReason('messaging_message', null, {
      raw_json: JSON.stringify({ raw: { historical_backfill: true } }),
    }),
    'historical_backfill_requires_current_evidence',
  );
});

test('knowledge duplicate reviews do not block action projection', () => {
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.92,
    }),
    null,
  );
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.6,
    }),
    null,
  );
});

test('low confidence and malformed actions become visible review outcomes, never skips', () => {
  assert.equal(
    _test.actionDisposition({ title: 'Check contract', actionability: 'implied', confidence: 0.1 }).disposition,
    'review',
  );
  assert.equal(
    _test.actionDisposition({ title: '', actionability: 'explicit_ask', confidence: 0.9 }).disposition,
    'review',
  );
  assert.equal(
    _test.actionDisposition({ title: 'Read update', actionability: 'fyi', confidence: 0.9 }).disposition,
    'fyi',
  );
});

test('dense action candidates are batched without truncating any candidate', () => {
  const candidates = Array.from({ length: 4 }, (_, index) => ({
    candidate_key: `candidate-${index}`,
    action: `Action ${index}`,
    evidence: 'x'.repeat(55),
  }));
  const batches = _test.candidateBatches(candidates, { maxChars: 180 });
  assert.deepEqual(
    batches.flat().map(candidate => candidate.candidate_key),
    candidates.map(candidate => candidate.candidate_key),
  );
  assert.ok(batches.length > 1, 'the test input should require more than one prompt batch');
});

test('an unmatched projected action retains exact evidence identity for visible review', () => {
  const text = 'Please send the contract before close of business.';
  const chunk = { index: 0, start: 0, end: text.length, text, chunk_id: 'chunk-1' };
  const evidence = {
    source_kind: 'email_summary',
    source_id: 'email-1',
    revision_hash: 'revision-1',
    text,
    chunks: [chunk],
  };
  const identity = _test.actionIdentity(evidence, {
    title: 'Send contract',
    evidence: 'send the contract before close',
  }, [], chunk);
  assert.equal(identity.candidate, null);
  assert.equal(identity.span.exact, true);
  assert.match(identity.action_key, /^[a-f0-9]{64}$/);
});

test('two unmatched candidates in one chunk retain separate malformed review identities', () => {
  const text = 'The source contains no matching action quotation.';
  const chunk = { index: 0, start: 0, end: text.length, text, chunk_id: 'chunk-unmatched' };
  const evidence = {
    source_kind: 'email_summary', source_id: 'email-unmatched', revision_hash: 'revision-unmatched', text, chunks: [chunk],
  };
  const triage = _test.mergeTriageResults(evidence, [{
    chunk,
    parsed: {
      candidate_actions: [
        { action: 'First unmatched action', evidence: 'quotation absent one', actionability: 'explicit_ask', confidence: 0.9 },
        { action: 'Second unmatched action', evidence: 'quotation absent two', actionability: 'explicit_ask', confidence: 0.9 },
      ],
    },
  }]);
  assert.equal(triage.candidate_actions.length, 2);
  assert.notEqual(triage.candidate_actions[0].candidate_key, triage.candidate_actions[1].candidate_key);
  assert.equal(triage.candidate_actions[0].source_span.exact, false);
  assert.equal(_test.stableActionKey(evidence, triage.candidate_actions[0].source_span), null);
});

test('distinct asks sharing one exact span retain stable semantic candidate identities', () => {
  const text = 'Please send the pack and book the review.';
  const chunk = { index: 0, start: 0, end: text.length, text, chunk_id: 'chunk-shared-span' };
  const evidence = {
    source_kind: 'email_summary', source_id: 'email-shared-span', revision_hash: 'revision-shared-span', text, chunks: [chunk],
  };
  const first = _test.mergeTriageResults(evidence, [{
    chunk,
    parsed: {
      candidate_actions: [
        { action: 'Send the pack', owner: 'Douglas', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
        { action: 'Book the review', owner: 'Douglas', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
      ],
    },
  }]);
  const replay = _test.mergeTriageResults(evidence, [{
    chunk,
    parsed: {
      candidate_actions: [
        { action: 'Send a pack', owner: 'Douglas', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
        { action: 'Book the review', owner: 'Douglas', evidence: text, actionability: 'explicit_ask', confidence: 0.9 },
      ],
    },
  }]);

  assert.equal(first.candidate_actions.length, 2);
  assert.notEqual(first.candidate_actions[0].candidate_key, first.candidate_actions[1].candidate_key);
  assert.equal(first.candidate_actions[0].source_span.exact, true);
  assert.deepEqual(
    replay.candidate_actions.map(candidate => candidate.candidate_key).sort(),
    first.candidate_actions.map(candidate => candidate.candidate_key).sort(),
    'wording-only replays retain the two established candidate identities',
  );
  assert.equal(
    _test.candidateForProjectedAction({ title: 'Book the review', evidence: text }, first.candidate_actions).candidate_key,
    first.candidate_actions[1].candidate_key,
    'semantic matching avoids collapsing a shared quote onto the first ask',
  );
});

test('a safe projection match canonicalises its candidate key and upgrades only its evidence span', () => {
  const text = 'Please send the signed contract to Neil.';
  const chunk = { index: 0, start: 0, end: text.length, text, chunk_id: 'chunk-canonical-link' };
  const evidence = {
    source_kind: 'email_summary', source_id: 'email-canonical-link', revision_hash: 'revision-canonical-link', text, chunks: [chunk],
  };
  const candidate = _test.decorateCandidate(evidence, chunk, {
    action: 'Send the signed contract to Neil',
    // This reproduces triage correctly identifying the ask but quoting a
    // paraphrase that cannot itself be used as provider-side-effect evidence.
    evidence: 'Neil still needs the signed contract',
    actionability: 'explicit_ask',
    confidence: 0.9,
  }, 0);
  const projected = {
    candidate_key: 'stale-model-candidate-key',
    title: 'Send the signed contract to Neil',
    actionability: 'explicit_ask',
    confidence: 0.9,
    evidence: text,
  };

  assert.equal(candidate.source_span.exact, false);
  assert.equal(_test.candidateForProjectedAction(projected, [candidate]), candidate);
  const canonical = _test.canonicaliseProjectedAction(projected, candidate);
  const identity = _test.actionIdentity(evidence, canonical, [candidate], chunk);

  assert.equal(canonical.candidate_key, candidate.candidate_key);
  assert.equal(canonical.projected_candidate_key, 'stale-model-candidate-key');
  assert.equal(identity.action_key, candidate.candidate_key);
  assert.equal(identity.span.exact, true);
  assert.equal(identity.span.text, text);
});

test('closed-task authority moved from the prompt to the deterministic post-check', () => {
  assert.equal(_test.taskState({ status: 'needsAction', deleted_at: 1 }), 'deleted');
  assert.equal(_test.taskState({ status: 'wrong', deleted_at: 1 }), 'wrong');
  assert.equal(_test.taskState({ status: 'completed', deleted_at: null }), 'completed');
  // The projection prompt no longer carries closed-task history; it only shows
  // open tasks, and both prompt and runtime guard tell the model the closed
  // check happens downstream so it must not withhold a genuine ask.
  assert.match(PROMPTS.crm_action_projection, /Currently OPEN tasks/);
  assert.doesNotMatch(PROMPTS.crm_action_projection, /completed, deleted, and wrong task states as authoritative/);
  assert.match(PROMPTS.crm_action_projection, /deterministic check after you respond suppresses anything that matches a task Douglas already completed, deleted, or marked wrong/);
  assert.match(_test.ACTION_STATE_GUARD, /only currently OPEN tasks/);
  assert.match(_test.ACTION_STATE_GUARD, /deterministic check suppresses anything that matches a closed task/);
});

test('taskHistoryForActionProjection sends open tasks only', () => {
  const block = _test.taskHistoryForActionProjection.toString();
  // The query must filter to live tasks and must not re-introduce closed rows.
  assert.match(block, /deleted_at IS NULL AND status NOT IN \('completed', 'wrong'\)/);
  assert.doesNotMatch(block, /\[completed\]|\[deleted\]|\[wrong\]/);
});

test('crm_action_projection schema and runtime guards require event and candidate identity fields', () => {
  assert.match(PROMPTS.crm_action_projection, /"candidate_key": "copy the exact candidate_key from Candidates"/);
  assert.match(PROMPTS.crm_action_projection, /candidate_key is REQUIRED for every action/);
  assert.match(_test.ACTION_EVIDENCE_GUARD, /every object in "actions" MUST include "candidate_key"/);
  assert.match(PROMPTS.crm_action_projection, /"event":/);
  assert.match(PROMPTS.crm_action_projection, /specific date and a specific time/);
  assert.match(_test.ACTION_EVENT_GUARD, /must include an "event" field/);
});

test('eventFromAction requires both a start and an end that parse to real, ordered datetimes', () => {
  assert.equal(_test.eventFromAction({}), null);
  assert.equal(_test.eventFromAction({ event: null }), null);
  assert.equal(_test.eventFromAction({ event: { start: null, end: null } }), null);
  assert.equal(_test.eventFromAction({ event: { start: '2026-07-24T13:30', end: null } }), null);
  assert.equal(
    _test.eventFromAction({ event: { start: 'not-a-date', end: '2026-07-24T14:15' } }),
    null,
  );
  assert.equal(
    _test.eventFromAction({ event: { start: '2026-07-24T14:15', end: '2026-07-24T13:30' } }),
    null,
    'end before start is rejected',
  );
  assert.deepEqual(
    _test.eventFromAction({
      event: { start: '2026-07-24T13:30', end: '2026-07-24T14:15', location: 'Teams' },
    }),
    { start: '2026-07-24T13:30', end: '2026-07-24T14:15', location: 'Teams' },
  );
  assert.deepEqual(
    _test.eventFromAction({ event: { start: '2026-07-24T13:30', end: '2026-07-24T14:15' } }),
    { start: '2026-07-24T13:30', end: '2026-07-24T14:15', location: null },
    'a missing location defaults to null rather than undefined',
  );
});

test('a plain due-by deadline with no time component does not qualify as an event', () => {
  // due_date-only actions never populate `event` at all — this is the shape
  // the model returns for "Send CV by Friday" style deadlines.
  assert.equal(_test.eventFromAction({ due_date: '2026-07-24' }), null);
  assert.equal(_test.eventFromAction({ due_date: '2026-07-24', event: {} }), null);
});
