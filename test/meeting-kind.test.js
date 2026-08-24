'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_PLANNER_SOURCE,
  TASK_PLANNER_NOTES_PREFIX,
  isTaskPlannerMeetingRow,
  isTaskPlannerCalendarEvent,
  plannerTaskIdFromMeeting,
  crmMeetingSql,
} = require('../lib/meeting-kind');

test('planner source and Hub-written notes are occupancy, not CRM meetings', () => {
  assert.equal(isTaskPlannerMeetingRow({ source: TASK_PLANNER_SOURCE, notes: '' }), true);
  assert.equal(isTaskPlannerMeetingRow({
    source: 'calendar',
    notes: `${TASK_PLANNER_NOTES_PREFIX} task-123.`,
  }), true);
  assert.equal(isTaskPlannerMeetingRow({ source: 'calendar', notes: 'Board catch-up' }), false);
  assert.equal(isTaskPlannerMeetingRow({ source: 'manual', title: 'Standup' }), false);
});

test('planner calendar events are recognised from Hub private properties', () => {
  assert.equal(isTaskPlannerCalendarEvent({
    summary: 'Write the paper',
    hubSource: TASK_PLANNER_SOURCE,
    hubTaskId: 'task-123',
  }), true);
  assert.equal(isTaskPlannerCalendarEvent({
    summary: 'Write the paper',
    extendedProperties: { private: { hubSource: TASK_PLANNER_SOURCE, hubTaskId: 'task-123' } },
  }), true);
  assert.equal(isTaskPlannerCalendarEvent({
    summary: 'Write the paper',
    isTask: true,
  }), true);
  assert.equal(isTaskPlannerCalendarEvent({
    summary: 'Catriona catch-up',
    hubSource: null,
  }), false);
});

test('task id is recovered from planner source_id or the Hub notes prefix', () => {
  assert.equal(plannerTaskIdFromMeeting({
    source: TASK_PLANNER_SOURCE,
    source_id: 'task-123',
  }), 'task-123');
  assert.equal(plannerTaskIdFromMeeting({
    source: 'calendar',
    notes: `${TASK_PLANNER_NOTES_PREFIX} task-123.`,
  }), 'task-123');
  assert.equal(plannerTaskIdFromMeeting({ source: 'calendar', notes: 'hello' }), null);
});

test('CRM meeting SQL excludes the planner source and notes prefix', () => {
  assert.match(crmMeetingSql('m'), /m\.source/);
  assert.match(crmMeetingSql('m'), /task_planner/);
  assert.match(crmMeetingSql(''), /COALESCE\(source, ''\)/);
  assert.doesNotMatch(crmMeetingSql(''), /undefined/);
});
