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
const { getCachedTasks } = require('../lib/google-tasks');
const {
  PLANNER_SOURCE,
  listPlannerCalendarEvents,
  scheduleTask,
  unscheduleTask,
  getPlannerPreferences,
  savePlannerPreferences,
  reflowPlannerConflicts,
  applyTaskDependencyTiming,
  isTaskEffectivelyOverdue,
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
  `).run(taskId, user, 'google-task-1', 'Write board paper', '[priority: high] [effort: 60m] [planner: work]');
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

test('planner hours persist in the existing CRM context store', () => {
  assert.deepEqual(getPlannerPreferences(user), {
    workStart: '08:00', workEnd: '16:00',
    eveningStart: '18:30', eveningEnd: '21:00',
    weekendStart: '10:00', weekendEnd: '17:00',
  });
  const saved = savePlannerPreferences(user, {
    workStart: '08:30', workEnd: '16:30',
    eveningStart: '18:00', eveningEnd: '22:00',
    weekendStart: '09:30', weekendEnd: '18:00',
  });
  assert.equal(saved.workStart, '08:30');
  assert.deepEqual(getPlannerPreferences(user), saved);
  assert.ok(db.hub().prepare(
    "SELECT 1 FROM crm_context WHERE user = ? AND key = 'task_planner_preferences'"
  ).get(user));
  // Restore defaults expected by the scheduling scenarios below.
  savePlannerPreferences(user, {
    workStart: '08:00', workEnd: '16:00',
    eveningStart: '18:30', eveningEnd: '21:00',
    weekendStart: '10:00', weekendEnd: '17:00',
  });
});

test('cached meeting and start-date floors defer due and reminder timing without rewriting either', () => {
  const meetingTaskId = 'planner-task-deferred-reminder';
  db.hub().prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, duration_mins, calendar_event_id, source)
    VALUES ('meeting-deferred-reminder', ?, 'REDACTION/PURVIEW', '2026-08-25', '11:30', 60, 'calendar-deferred-reminder', 'calendar')
  `).run(user);
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, deadline, status, source)
    VALUES (?, ?, 'google-task-deferred-reminder', '@default', 'Demonstrate redaction',
      '[after: cal:calendar-deferred-reminder]', '2026-08-25', '2026-08-20T09:00', 'needsAction', 'manual')
  `).run(meetingTaskId, user);
  const meetingTask = db.hub().prepare('SELECT * FROM google_tasks WHERE id = ?').get(meetingTaskId);
  const timedMeetingTask = applyTaskDependencyTiming(user, meetingTask);
  assert.equal(timedMeetingTask.dep_not_before, '2026-08-25T12:30', 'Dublin summer time must not add a second UTC offset');
  assert.equal(timedMeetingTask.effective_due, undefined, 'the stored due date already matches the dependency day');
  assert.equal(timedMeetingTask.effective_deadline, '2026-08-25T12:30');
  assert.equal(isTaskEffectivelyOverdue(timedMeetingTask, new Date('2026-08-21T12:00:00Z')), false);
  assert.equal(isTaskEffectivelyOverdue(timedMeetingTask, new Date('2026-08-25T11:31:00Z')), true);
  const cachedMeetingTask = getCachedTasks(user).find(task => task.id === meetingTaskId);
  assert.equal(cachedMeetingTask.effective_deadline, '2026-08-25T12:30');
  assert.equal(typeof cachedMeetingTask.is_overdue, 'boolean');

  const startTask = {
    id: 'start-deferred', user, title: 'Write policies', status: 'needsAction', deleted_at: null,
    notes: '[start: 2026-10-05]', due: '2026-08-16', deadline: '2026-08-16T09:00',
  };
  const timedStartTask = applyTaskDependencyTiming(user, startTask);
  assert.equal(timedStartTask.effective_due, '2026-10-05');
  assert.equal(timedStartTask.effective_deadline, '2026-10-05T00:00');
  assert.equal(timedStartTask.dependency_deferred, true);
});

test('an interrupted insert reconciles the remote block instead of duplicating it', async () => {
  const secondTask = 'planner-task-ambiguous';
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, status, source)
    VALUES (?, ?, ?, '@default', 'Reconcile me', '[planner: work]', 'needsAction', 'manual')
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
      (id, user, google_task_id, task_list_id, title, notes, status, source)
    VALUES (?, ?, ?, '@default', 'Adopt cached event', '[planner: work]', 'needsAction', 'manual')
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

test('automatic reflow patches the existing Calendar task event instead of recreating it', async () => {
  const reflowTask = 'planner-task-reflow';
  db.hub().prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, status, source)
    VALUES (?, ?, ?, '@default', 'Move after appointment', '[effort: 30m] [planner: work]', '2026-08-24', 'needsAction', 'manual')
  `).run(reflowTask, user, 'google-task-reflow');
  const taskEvent = {
    id: 'calendar-reflow-task', status: 'confirmed', summary: 'Move after appointment',
    start: { dateTime: '2026-08-24T09:00:00+01:00', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-08-24T09:30:00+01:00', timeZone: 'Europe/Dublin' },
    extendedProperties: { private: { hubSource: PLANNER_SOURCE, hubTaskId: reflowTask } },
  };
  remoteEvents.set(taskEvent.id, taskEvent);
  db.hub().prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, duration_mins, calendar_event_id, source, source_id)
    VALUES ('meeting-reflow-task', ?, 'Move after appointment', '2026-08-24', '09:00', 30, ?, ?, ?)
  `).run(user, taskEvent.id, PLANNER_SOURCE, reflowTask);
  remoteEvents.set('calendar-fixed-appointment', {
    id: 'calendar-fixed-appointment', status: 'confirmed', summary: 'Fixed appointment',
    start: { dateTime: '2026-08-24T09:00:00+01:00', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-08-24T10:00:00+01:00', timeZone: 'Europe/Dublin' },
  });

  const insertsBefore = inserts;
  const patchesBefore = patches;
  const result = await reflowPlannerConflicts(user, {
    startDate: '2026-08-24', endDate: '2026-08-26', now: new Date('2026-08-24T06:00:00Z'),
  }, { calendarClient: calendar, syncTasksFn: async () => {} });

  assert.equal(result.moved.length, 1);
  assert.equal(result.moved[0].startAt, '2026-08-24T10:00');
  assert.equal(inserts, insertsBefore, 'automatic movement must not create a replacement event');
  assert.equal(patches, patchesBefore + 1);
  assert.equal(remoteEvents.get(taskEvent.id).start.dateTime, '2026-08-24T10:00:00');
  const meeting = db.hub().prepare('SELECT meeting_time FROM meetings WHERE id = ?').get('meeting-reflow-task');
  assert.equal(meeting.meeting_time, '10:00');
  const receipt = db.hub().prepare(`
    SELECT payload FROM knowledge_receipts
     WHERE user = ? AND source_kind = 'google_task' AND source_id = ?
       AND stage = 'calendar_planner_effect'
     ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(user, reflowTask);
  assert.equal(JSON.parse(receipt.payload).reason, 'calendar_conflict');
});
