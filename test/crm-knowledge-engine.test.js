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

test('task history exposes authoritative human state to action synthesis', () => {
  assert.equal(_test.taskState({ status: 'needsAction', deleted_at: 1 }), 'deleted');
  assert.equal(_test.taskState({ status: 'wrong', deleted_at: 1 }), 'wrong');
  assert.equal(_test.taskState({ status: 'completed', deleted_at: null }), 'completed');
  assert.match(PROMPTS.crm_action_projection, /deleted, and wrong task states as authoritative human decisions/);
  assert.match(_test.ACTION_STATE_GUARD, /authoritative human decisions/);
});

test('crm_action_projection schema and event guard both describe the event field', () => {
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
