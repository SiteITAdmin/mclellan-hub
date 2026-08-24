'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crm-meetings-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const { listCrmMeetings, importCalendarEventsAsMeetings } = require('../lib/crm');
const { TASK_PLANNER_SOURCE, TASK_PLANNER_NOTES_PREFIX } = require('../lib/meeting-kind');

const user = 'meetings-planner-filter';

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertMeeting(row) {
  db.hub().prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, notes, calendar_event_id, source, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, user, row.title, row.date, row.time || '09:00',
    row.notes || '', row.calendarEventId || null, row.source || 'manual', row.sourceId || null
  );
}

test('the CRM meetings list keeps real meetings and drops planner task blocks', () => {
  insertMeeting({
    id: 'real-meeting',
    title: 'Catriona catch-up',
    date: '2026-08-25',
    source: 'calendar',
    calendarEventId: 'cal-real',
  });
  insertMeeting({
    id: 'planner-block',
    title: 'Write the board paper',
    date: '2026-08-25',
    source: TASK_PLANNER_SOURCE,
    sourceId: 'task-board-paper',
    calendarEventId: 'cal-planner',
    notes: `${TASK_PLANNER_NOTES_PREFIX} task-board-paper.`,
  });
  insertMeeting({
    id: 'misimported-planner',
    title: 'Call the GP',
    date: '2026-08-26',
    source: 'calendar',
    calendarEventId: 'cal-misimported',
    notes: `${TASK_PLANNER_NOTES_PREFIX} task-gp.`,
  });

  const listed = listCrmMeetings(user);
  assert.deepEqual(listed.map(row => row.id), ['real-meeting']);
});

test('calendar sync does not import planner events as CRM meetings and retags copies', () => {
  const result = importCalendarEventsAsMeetings(user, [
    {
      id: 'cal-new-planner',
      summary: 'File the return',
      date: '2026-08-27',
      time: '10:00',
      durationMins: 30,
      location: '',
      notes: `${TASK_PLANNER_NOTES_PREFIX} task-return.`,
      hubSource: TASK_PLANNER_SOURCE,
      hubTaskId: 'task-return',
    },
    {
      id: 'cal-misimported',
      summary: 'Call the GP',
      date: '2026-08-26',
      time: '09:00',
      durationMins: 30,
      location: '',
      notes: `${TASK_PLANNER_NOTES_PREFIX} task-gp.`,
      hubSource: TASK_PLANNER_SOURCE,
      hubTaskId: 'task-gp',
    },
    {
      id: 'cal-genuine',
      summary: 'Beacon ops',
      date: '2026-08-28',
      time: '11:00',
      durationMins: 60,
      location: 'Teams',
      notes: '',
      attendeeDetails: [],
    },
  ]);

  assert.equal(result.imported, 1);
  assert.equal(
    db.hub().prepare('SELECT id FROM meetings WHERE user = ? AND calendar_event_id = ?')
      .get(user, 'cal-new-planner'),
    undefined,
    'a new planner event must not become a CRM meeting row'
  );
  const retagged = db.hub().prepare('SELECT source, source_id FROM meetings WHERE id = ?')
    .get('misimported-planner');
  assert.equal(retagged.source, TASK_PLANNER_SOURCE);
  assert.equal(retagged.source_id, 'task-gp');
  const genuine = db.hub().prepare('SELECT title, source FROM meetings WHERE user = ? AND calendar_event_id = ?')
    .get(user, 'cal-genuine');
  assert.equal(genuine.title, 'Beacon ops');
  assert.equal(genuine.source, 'calendar');
  assert.deepEqual(listCrmMeetings(user).map(row => row.title).sort(), ['Beacon ops', 'Catriona catch-up']);
});
