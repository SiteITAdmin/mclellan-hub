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

test('high-confidence duplicate reviews block action projection', () => {
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.92,
    }),
    'duplicate_review_duplicate',
  );
  assert.equal(
    _test.actionProjectionBlockReason('email_summary', {
      decision: 'duplicate',
      confidence: 0.6,
    }),
    null,
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
