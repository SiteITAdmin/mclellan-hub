'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-task-meetings-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db'), tasks = require('../lib/crm/tasks'), waits = require('../lib/crm/task-meetings');
const calendar = require('../lib/crm/calendar'), planner = require('../lib/crm/planner'), jobsLib = require('../lib/crm/task-jobs');
const ejs = require('ejs');
const crm = () => db.crm();
const T = Math.floor(Date.now() / 1000);
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

// The next Wednesday at least two days off, so the test holds on any day it runs.
const today = planner.local(T).date;
let WED = planner.addDays(today, 2);
while (new Date(`${WED}T12:00:00Z`).getUTCDay() !== 3) WED = planner.addDays(WED, 1);
const at = (date, hhmm) => planner.epoch(date, planner.minutesOf(hhmm));
function meeting(id, title, date, from = '10:00', to = '11:00', space = 'work') {
  crm().prepare('INSERT OR REPLACE INTO calendar_events (id, calendar_id, space, title, start_at, end_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'cal', space, title, at(date, from), at(date, to));
  return id;
}
const blocks = id => crm().prepare('SELECT * FROM plan_blocks WHERE task_id = ? ORDER BY start_at').all(id);
const mk = title => { const t = tasks.create('work', { title }); crm().prepare('UPDATE tasks SET minutes = 30 WHERE id = ?').run(t.id); return t; };

test('due the next working day after the meeting: Work skips the weekend, Personal does not', () => {
  assert.equal(waits.dueAfter('work', at('2026-11-19', '10:00')), '2026-11-20', 'Thursday → Friday');
  assert.equal(waits.dueAfter('work', at('2026-11-20', '16:00')), '2026-11-23', 'Friday → Monday');
  assert.equal(waits.dueAfter('personal', at('2026-11-20', '19:00')), '2026-11-21', 'Friday → Saturday');
  assert.equal(waits.dueAfter('work', at('2026-11-18', '23:30')), '2026-11-19', 'late evening still counts as that day in Dublin');
});

test('a linked task is due after the meeting, planned only after it ends, and follows it when it moves', () => {
  const free = mk('Tidy the shared drive'), dep = mk('Write up the access decision');
  meeting('e1', 'Roster access call with Sarah', WED);
  const r = waits.link(dep.id, 'e1');
  const THU = planner.addDays(WED, 1);
  assert.deepEqual([r.linked, r.due], [1, THU]);
  assert.equal(tasks.get(dep.id).due, THU);
  calendar.replan();
  assert.ok(blocks(free.id)[0].start_at < at(WED, '10:00'), 'an ordinary task is still planned as soon as there is room');
  assert.ok(blocks(dep.id)[0].start_at >= at(WED, '11:00'), 'never before the meeting ends');
  assert.equal(blocks(dep.id)[0].late, 0);
  assert.equal(tasks.detail(tasks.get(dep.id)).meeting.title, 'Roster access call with Sarah');

  meeting('e1', 'Roster access call with Sarah', WED, '14:00', '15:00');
  calendar.replan();
  assert.equal(tasks.get(dep.id).due, THU, 'same day, later: the date stays');
  assert.ok(blocks(dep.id)[0].start_at >= at(WED, '15:00'));
  tasks.edit(dep.id, { due: planner.addDays(WED, 5) });
  calendar.replan();
  assert.equal(tasks.get(dep.id).due, planner.addDays(WED, 5), 'a date Douglas set himself stands while the meeting stays put');
  meeting('e1', 'Roster access call with Sarah', planner.addDays(WED, 1));
  calendar.replan();
  assert.equal(tasks.get(dep.id).due, planner.addDays(WED, 2), 'moved a day: due moves a day');
  assert.ok(blocks(dep.id)[0].start_at >= at(planner.addDays(WED, 1), '11:00'));

  assert.equal(waits.constraints(at(planner.addDays(WED, 1), '11:30')).has(dep.id), false, 'once it has been held the task is free');
  assert.throws(() => waits.link(free.id, 'nope'), /Choose a meeting/);
  meeting('old', 'Last week', planner.addDays(today, -3));
  assert.throws(() => waits.link(free.id, 'old'), /already over/);
  waits.release(dep.id);
  assert.equal(waits.get(dep.id), null);
});

test('no meeting yet: held out of the plan with one arrange task, shared within a job; linking frees them all', () => {
  const a = mk('Agree the new group names'), b = mk('Decide who keeps draft access'), c = mk('Export the member lists');
  const job = crm().prepare("INSERT INTO task_jobs (id, space, title, made_by) VALUES ('j1', 'work', 'Fix roster access', 'douglas') RETURNING id").get().id;
  for (const t of [a, b, c]) jobsLib.addByHand(t.id, job);
  const arrange = waits.hold(a.id);
  assert.equal(arrange.title, 'Arrange a meeting about: Fix roster access');
  assert.equal(arrange.origin, 'meeting');
  assert.equal(tasks.get(arrange.id).job_id, job, 'the arranging is a step of the same job');
  assert.equal(waits.hold(b.id).id, arrange.id, 'a second task in the job shares the one arrange task');
  assert.equal(waits.hold(a.id).id, arrange.id, 'holding twice adds nothing');
  assert.throws(() => waits.hold(arrange.id), /arranges the meeting/);
  assert.deepEqual(waits.waiting('work').map(w => w.id), [a.id, b.id]);
  calendar.replan();
  assert.equal(blocks(a.id).length + blocks(b.id).length, 0, 'held tasks take no calendar time');
  assert.deepEqual(jobsLib.sitting(job).map(t => t.id), [c.id, arrange.id]);
  assert.equal(jobsLib.lead(job), c.id);
  assert.equal(blocks(c.id).reduce((n, x) => n + (x.end_at - x.start_at) / 60, 0), 30 + planner.DEFAULT_MINUTES, 'the sitting is the two steps that can be done now');

  meeting('e2', 'Roster naming meeting', WED);
  const r = waits.link(b.id, 'e2');
  assert.equal(r.linked, 2, 'both waiting tasks follow the booked meeting');
  assert.equal(tasks.get(arrange.id).status, 'completed', 'booking it was the arrange task');
  assert.equal(tasks.get(a.id).due, planner.addDays(WED, 1));
  calendar.replan();
  for (const t of [a, b]) assert.ok(blocks(t.id)[0].start_at >= at(WED, '11:00'));
  assert.equal(jobsLib.blockTitle(tasks.get(a.id)), a.title, 'its block is named for the task, not the job sitting');
  require('../lib/crm/task-followups').notice();
  assert.equal(crm().prepare('SELECT COUNT(*) AS n FROM task_followups').get().n, 0, 'the Hub does not ask what follows from its own arrange task');

  crm().prepare("DELETE FROM calendar_events WHERE id = 'e2'").run();
  calendar.replan();
  const lost = waits.brief(a.id);
  assert.deepEqual([lost.state, lost.lost, lost.title], ['needs', true, 'Roster naming meeting'], 'a cancelled meeting is not silent');
  assert.equal(blocks(a.id).length, 0);
  assert.equal(lost.arrange.status, 'needsAction');
  assert.notEqual(lost.arrange.id, arrange.id);
  assert.equal(waits.brief(b.id).arrange.id, lost.arrange.id);
  waits.release(a.id);
  assert.equal(tasks.get(lost.arrange.id).status, 'needsAction', 'still needed by the other task');
  waits.release(b.id);
  assert.equal(tasks.get(lost.arrange.id).status, 'deleted', 'nobody needs the meeting, so nobody needs to arrange it');
});

test('the task page, review page and Today show the wait and offer the meetings', () => {
  const dep = mk('Write up the access decision'), held = mk('Plan the training');
  meeting('e1', 'Roster access call', WED);
  meeting('p1', 'Dentist', WED, '18:00', '18:30', 'personal');
  waits.link(dep.id, 'e1'); waits.hold(held.id);
  const views = path.join(__dirname, '../views/crm');
  const review = require('../lib/crm/task-review');
  const list = review.list('work');
  const page = ejs.render(fs.readFileSync(path.join(views, 'tasks-review.ejs'), 'utf8').replace(/<%- include\('_(top|bottom)'\) %>/g, ''),
    { space: 'work', fmt: String, ago: () => 'now', list, counts: review.counts(list), dates: review.quickDates(), meetingChoices: waits.upcoming('work'), follow: { list: [], thinking: 0, failed: [] } }, { filename: path.join(views, 'tasks-review.ejs') });
  assert.match(page, /After a meeting<\/span> Roster access call/);
  assert.match(page, /Needs a meeting first/);
  assert.match(page, /Arrange a meeting about: Plan the training/);
  assert.match(page, /<option value="p1">[^<]*Dentist \(Personal\)/);
  assert.match(page, /value="link">Due after this meeting/);
  const today = require('../lib/crm/views').today('work');
  assert.deepEqual(today.needMeeting.map(w => w.title), ['Plan the training']);
});
