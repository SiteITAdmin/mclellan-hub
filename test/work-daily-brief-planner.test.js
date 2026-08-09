'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-work-brief-planner-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const { gatherData } = require('../lib/work-daily-brief');

const user = 'work-brief-planner-test';

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('work brief calendar excludes task-planner meeting mirrors', () => {
  const today = gatherData(user).today;
  const insert = db.hub().prepare(`
    INSERT INTO meetings (id, user, title, meeting_date, meeting_time, source, source_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('brief-real-meeting', user, 'Real appointment', today, '09:00', 'google_calendar', 'calendar-1');
  insert.run('brief-task-mirror', user, 'Planned task', today, '10:00', 'task_planner', 'task-1');

  const data = gatherData(user);
  assert.deepEqual(data.meetingsToday.map(meeting => meeting.title), ['Real appointment']);
});
