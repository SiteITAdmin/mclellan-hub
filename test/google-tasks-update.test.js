'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _test, stripTaskTags, withTaskTags, withPlannerTag, withDefaultTaskEffort, parseTaskTags,
} = require('../lib/google-tasks');

test('toGoogleDueDate normalises date-only and datetime to midnight UTC', () => {
  assert.equal(_test.toGoogleDueDate('2026-08-04'), '2026-08-04T00:00:00.000Z');
  assert.equal(_test.toGoogleDueDate('2026-08-04T14:30'), '2026-08-04T00:00:00.000Z');
  assert.equal(_test.toGoogleDueDate(null), undefined);
  assert.equal(_test.toGoogleDueDate(''), undefined);
});

test('isNotFoundError recognises Google 404 shapes', () => {
  assert.equal(_test.isNotFoundError({ code: 404 }), true);
  assert.equal(_test.isNotFoundError({ response: { status: 404 } }), true);
  assert.equal(_test.isNotFoundError({ message: 'Task not found' }), true);
  assert.equal(_test.isNotFoundError({ code: 400, message: 'bad' }), false);
  assert.equal(_test.isNotFoundError(null), false);
});

test('priority/effort tags round-trip through notes without clobbering body', () => {
  const notes = withTaskTags('Call the hospital about the bed.', {
    priority: 'high',
    effortMinutes: 30,
  });
  assert.match(notes, /Call the hospital about the bed/);
  assert.match(notes, /\[priority: high\]/);
  assert.match(notes, /\[effort: 30m\]/);

  const parsed = parseTaskTags(notes);
  assert.equal(parsed.priority, 'high');
  assert.equal(parsed.effort_minutes, 30);
  assert.equal(stripTaskTags(notes).trim(), 'Call the hospital about the bed.');

  // Clearing priority/effort strips tags
  const cleared = withTaskTags(notes, { priority: '', effortMinutes: '' });
  assert.equal(cleared.trim(), 'Call the hospital about the bed.');
  assert.equal(parseTaskTags(cleared).priority, null);
});

test('planner lane round-trips independently from priority and effort', () => {
  const planned = withPlannerTag('[priority: high] [effort: 60m]\n\nPrepare paper', 'personal');
  assert.deepEqual(parseTaskTags(planned), {
    priority: 'high', effort_minutes: 60, planner_lane: 'personal',
  });
  assert.equal(stripTaskTags(planned), 'Prepare paper');

  const edited = withTaskTags(planned, { priority: 'medium', effortMinutes: 30 });
  assert.equal(parseTaskTags(edited).planner_lane, 'personal', 'ordinary edits preserve planner selection');
  assert.equal(parseTaskTags(withPlannerTag(edited, null)).planner_lane, null);
});

test('new-task effort helper defaults unsized notes to 30 minutes without overwriting estimates', () => {
  assert.equal(parseTaskTags(withDefaultTaskEffort('New task')).effort_minutes, 30);
  assert.equal(parseTaskTags(withDefaultTaskEffort('[effort: 60m]\n\nLong task')).effort_minutes, 60);
  assert.equal(parseTaskTags(withDefaultTaskEffort('[planner: work]')).planner_lane, 'work');
});

test('slugify matches project list titles', () => {
  assert.equal(_test.slugify('M365 Rollout'), 'm365-rollout');
  assert.equal(_test.slugify('Beacon'), 'beacon');
  assert.equal(_test.slugify('  VIP Backups!! '), 'vip-backups');
});
