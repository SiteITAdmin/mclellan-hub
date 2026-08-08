'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-task-planner-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const {
  PLANNER_SOURCE,
  listPlannerCalendarEvents,
  scheduleTask,
  unscheduleTask,
} = require('../lib/task-calendar-planner');

const user = 'task-planner-integration';
const taskId = 'planner-task-1';
const remoteEvents = new Map();
let inserts = 0;
let patches = 0;
let deletes = 0;

const calendar = {
  events: {
    list: async ({ privateExtendedProperty }) => {
      const task = String(privateExtendedProperty || '').split('=').slice(1).join('=');
      return {
        data: {
          items: [...remoteEvents.values()].filter(event =>
            !task || event.extendedProperties?.private?.hubTaskId === task
          ),
        },
      };
    },
    insert: async ({ requestBody }) => {
      inserts += 1;
      const event = {
        id: `calendar-${inserts}`,
        status: 'confirmed',
        htmlLink: `https://calendar.test/calendar-${inserts}`,
        ...requestBody,
      };
      remoteEvents.set(event.id, event);
      return { data: event };
    },
    patch: async ({ eventId, requestBody }) => {
      patches += 1;
      const event = { ...remoteEvents.get(eventId), ...requestBody, id: eventId, status: 'confirmed' };
      remoteEvents.set(eventId, event);
      return { data: event };
    },
    delete: async ({ eventId }) => {
      deletes += 1;
      remoteEvents.delete(eventId);
      return { data: {} };
    },
  },
};

test.before(() => {
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, status, source)
    VALUES (?, ?, ?, '@default', ?, ?, '2026-08-12', 'needsAction', 'manual')
  `).run(taskId, user, 'google-task-1', 'Write board paper', '[priority: high] [effort: 60m]');
});

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a CRM task schedules, moves, and unschedules through one Google Calendar block', async () => {
  const created = await scheduleTask(user, taskId, {
    startAt: '2026-08-10T09:00',
    durationMinutes: 60,
  }, { calendarClient: calendar });
  assert.equal(created.created, true);
  assert.equal(inserts, 1);
  assert.equal(remoteEvents.size, 1);

  let meeting = db.hub().prepare(
    'SELECT * FROM meetings WHERE user = ? AND source = ? AND source_id = ?'
  ).get(user, PLANNER_SOURCE, taskId);
  assert.equal(meeting.calendar_event_id, 'calendar-1');
  assert.equal(meeting.meeting_date, '2026-08-10');
  assert.equal(meeting.meeting_time, '09:00');

  const moved = await scheduleTask(user, taskId, {
    startAt: '2026-08-10T11:15',
    durationMinutes: 60,
  }, { calendarClient: calendar });
  assert.equal(moved.created, false);
  assert.equal(inserts, 1, 'moving never creates a second event');
  assert.equal(patches, 1);
  assert.equal(remoteEvents.size, 1);
  meeting = db.hub().prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
  assert.equal(meeting.meeting_time, '11:15');

  const removed = await unscheduleTask(user, taskId, { calendarClient: calendar });
  assert.equal(removed.removed, true);
  assert.equal(deletes, 1);
  assert.equal(remoteEvents.size, 0);
  assert.equal(db.hub().prepare('SELECT id FROM meetings WHERE id = ?').get(meeting.id), undefined);
  const task = db.hub().prepare('SELECT status FROM google_tasks WHERE id = ?').get(taskId);
  assert.equal(task.status, 'needsAction', 'unscheduling never deletes or completes the task');
});

test('an interrupted insert reconciles the remote block instead of duplicating it', async () => {
  const secondTask = 'planner-task-ambiguous';
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source)
    VALUES (?, ?, ?, '@default', 'Reconcile me', 'needsAction', 'manual')
  `).run(secondTask, user, 'google-task-ambiguous');

  let insertAttempted = false;
  const ambiguousCalendar = {
    events: {
      list: calendar.events.list,
      patch: calendar.events.patch,
      delete: calendar.events.delete,
      insert: async ({ requestBody }) => {
        insertAttempted = true;
        const event = { id: 'calendar-ambiguous', status: 'confirmed', ...requestBody };
        remoteEvents.set(event.id, event);
        throw new Error('socket closed after provider accepted event');
      },
    },
  };

  const result = await scheduleTask(user, secondTask, {
    startAt: '2026-08-11T10:00',
    durationMinutes: 30,
  }, { calendarClient: ambiguousCalendar });
  assert.equal(insertAttempted, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.event.id, 'calendar-ambiguous');
  assert.ok(db.hub().prepare(
    'SELECT id FROM meetings WHERE user = ? AND source = ? AND source_id = ?'
  ).get(user, PLANNER_SOURCE, secondTask));
});

test('a block moved or deleted directly in Google Calendar reconciles the local cache', async () => {
  const event = remoteEvents.get('calendar-ambiguous');
  event.start = { dateTime: '2026-08-18T13:00:00+01:00', timeZone: 'Europe/Dublin' };
  event.end = { dateTime: '2026-08-18T13:30:00+01:00', timeZone: 'Europe/Dublin' };
  const reconciliationCalendar = {
    events: {
      list: async () => ({ data: { items: [] } }),
      get: async ({ eventId }) => {
        const found = remoteEvents.get(eventId);
        if (!found) {
          const error = new Error('not found');
          error.code = 404;
          throw error;
        }
        return { data: found };
      },
    },
  };

  const oldWeek = await listPlannerCalendarEvents(user, {
    startDate: '2026-08-10', endDate: '2026-08-12',
  }, { calendarClient: reconciliationCalendar });
  assert.deepEqual(oldWeek, []);
  let meeting = db.hub().prepare(
    'SELECT * FROM meetings WHERE user = ? AND source = ? AND source_id = ?'
  ).get(user, PLANNER_SOURCE, 'planner-task-ambiguous');
  assert.equal(meeting.meeting_date, '2026-08-18', 'a remote move updates the compiled cache');

  remoteEvents.delete('calendar-ambiguous');
  await listPlannerCalendarEvents(user, {
    startDate: '2026-08-17', endDate: '2026-08-19',
  }, { calendarClient: reconciliationCalendar });
  meeting = db.hub().prepare(
    'SELECT * FROM meetings WHERE user = ? AND source = ? AND source_id = ?'
  ).get(user, PLANNER_SOURCE, 'planner-task-ambiguous');
  assert.equal(meeting, undefined, 'a remote delete removes only the stale planner cache row');
});

test('a remotely-created block already cached as a generic event is adopted, not duplicated', async () => {
  const recoveredTask = 'planner-task-generic-cache';
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source)
    VALUES (?, ?, ?, '@default', 'Adopt cached event', 'needsAction', 'manual')
  `).run(recoveredTask, user, 'google-task-generic-cache');
  const remote = {
    id: 'calendar-generic-cache',
    status: 'confirmed',
    summary: 'Adopt cached event',
    start: { dateTime: '2026-08-20T09:00:00+01:00', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-08-20T09:30:00+01:00', timeZone: 'Europe/Dublin' },
    extendedProperties: { private: { hubSource: PLANNER_SOURCE, hubTaskId: recoveredTask } },
  };
  remoteEvents.set(remote.id, remote);
  db.hub().prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, duration_mins, calendar_event_id, source)
    VALUES ('generic-cached-meeting', ?, ?, '2026-08-20', '09:00', 30, ?, 'calendar')
  `).run(user, remote.summary, remote.id);

  const insertCountBefore = inserts;
  const result = await scheduleTask(user, recoveredTask, {
    startAt: '2026-08-20T10:00', durationMinutes: 30,
  }, { calendarClient: calendar });
  assert.equal(result.created, false);
  assert.equal(inserts, insertCountBefore, 'the generic cache row is adopted before any insert');
  const meeting = db.hub().prepare('SELECT source, source_id FROM meetings WHERE id = ?').get('generic-cached-meeting');
  assert.deepEqual(meeting, { source: PLANNER_SOURCE, source_id: recoveredTask });
});
