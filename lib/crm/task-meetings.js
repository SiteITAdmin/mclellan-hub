'use strict';

// A task that has to wait for a meeting. Linked to a calendar entry, it is due
// the next working day after it and never planned before it ends, and it
// follows the meeting if that moves. With no meeting booked yet it is held out
// of the plan, and the Hub adds one "Arrange a meeting" task so the booking
// itself is not forgotten; tasks of one job waiting on the same meeting share it.

const { crm, now } = require('./db');
const planner = require('./planner');

const get = taskId => crm().prepare('SELECT * FROM task_meetings WHERE task_id = ?').get(taskId) || null;
const when = ts => new Date(ts * 1000).toLocaleString('en-IE', { timeZone: planner.TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Work waits for a working day; Personal can be the very next day.
function dueAfter(space, startAt) {
  let date = planner.addDays(planner.local(startAt).date, 1);
  while (space === 'work' && planner.local(planner.epoch(date, 12 * 60)).weekend) date = planner.addDays(date, 1);
  return date;
}

function upcoming(space, t = now()) {
  return crm().prepare('SELECT id, title, start_at, end_at, space FROM calendar_events WHERE end_at > ? AND all_day = 0 ORDER BY start_at LIMIT 80').all(t)
    .map(e => ({ ...e, label: `${when(e.start_at)} · ${e.title}${e.space === space ? '' : ` (${e.space === 'work' ? 'Work' : 'Personal'})`}` }));
}

function openTask(taskId) {
  const t = require('./tasks').get(String(taskId || ''));
  if (!t) throw new Error('Task not found');
  if (t.status !== 'needsAction') throw new Error('That task is no longer open');
  return t;
}

const sharers = arrangeId => crm().prepare(`SELECT m.task_id FROM task_meetings m JOIN tasks t ON t.id = m.task_id
  WHERE m.arrange_task_id = ? AND m.state = 'needs' AND t.status = 'needsAction'`).all(arrangeId).map(r => r.task_id);

function arrangeFor(task) {
  const db = crm(), tasks = require('./tasks');
  if (task.job_id) {
    const shared = db.prepare(`SELECT m.arrange_task_id AS id FROM task_meetings m JOIN tasks t ON t.id = m.task_id JOIN tasks a ON a.id = m.arrange_task_id
      WHERE m.state = 'needs' AND t.job_id = ? AND t.status = 'needsAction' AND a.status = 'needsAction' LIMIT 1`).get(task.job_id);
    if (shared) return shared.id;
  }
  const job = task.job_id ? require('./task-jobs').get(task.job_id) : null;
  const context = JSON.parse(task.context || '{}');
  delete context.sourceId;
  const made = tasks.create(task.space, { title: `Arrange a meeting about: ${job?.title || task.title}`.slice(0, 1024),
    notes: `Added by the Hub because this is waiting for a meeting: ${task.title}`.slice(0, 6000), context }, 'meeting');
  if (job) require('./task-jobs').addByHand(made.id, job.id);
  return made.id;
}

function hold(taskId, { lost = 0, t = now() } = {}) {
  const task = openTask(taskId);
  if (task.origin === 'meeting') throw new Error('This task is the one that arranges the meeting');
  return crm().transaction(() => {
    const old = get(task.id);
    const kept = old?.arrange_task_id && require('./tasks').get(old.arrange_task_id)?.status === 'needsAction' ? old.arrange_task_id : null;
    const arrange = kept || arrangeFor(task);
    crm().prepare(`INSERT INTO task_meetings (task_id, state, arrange_task_id, lost, event_title, created_at) VALUES (?, 'needs', ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET state = 'needs', event_id = NULL, event_start = NULL, event_end = NULL,
        arrange_task_id = excluded.arrange_task_id, lost = excluded.lost, event_title = excluded.event_title`)
      .run(task.id, arrange, lost ? 1 : 0, lost ? old?.event_title || '' : '', t);
    return require('./tasks').get(arrange);
  })();
}

function setDue(task, due) {
  if (task.due !== due) require('./tasks').edit(task.id, { due });
}

// Linking one task also links the others that were waiting on the same meeting to be arranged.
function link(taskId, eventId, t = now()) {
  const task = openTask(taskId);
  const e = crm().prepare('SELECT * FROM calendar_events WHERE id = ?').get(String(eventId || ''));
  if (!e) throw new Error('Choose a meeting from your calendar');
  if (e.end_at <= t) throw new Error('That meeting is already over');
  return crm().transaction(() => {
    const row = get(task.id);
    const ids = [...new Set([task.id, ...(row?.state === 'needs' && row.arrange_task_id ? sharers(row.arrange_task_id) : [])])];
    for (const id of ids) {
      const one = openTask(id);
      crm().prepare(`INSERT INTO task_meetings (task_id, state, event_id, event_title, event_start, event_end, created_at) VALUES (?, 'linked', ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET state = 'linked', event_id = excluded.event_id, event_title = excluded.event_title,
          event_start = excluded.event_start, event_end = excluded.event_end, lost = 0`).run(id, e.id, e.title, e.start_at, e.end_at, t);
      setDue(one, dueAfter(one.space, e.start_at));
    }
    // The meeting is booked, so the task to arrange it is done.
    const arrange = row?.arrange_task_id && require('./tasks').get(row.arrange_task_id);
    if (arrange?.status === 'needsAction' && arrange.origin === 'meeting') require('./tasks').edit(arrange.id, { status: 'completed' });
    return { linked: ids.length, due: dueAfter(task.space, e.start_at), event: e, arranged: arrange?.status === 'needsAction' };
  })();
}

function release(taskId) {
  const row = get(taskId);
  if (!row) return false;
  crm().transaction(() => {
    crm().prepare('DELETE FROM task_meetings WHERE task_id = ?').run(taskId);
    const arrange = row.state === 'needs' && row.arrange_task_id && require('./tasks').get(row.arrange_task_id);
    if (arrange?.status === 'needsAction' && arrange.origin === 'meeting' && !sharers(arrange.id).length) require('./tasks').edit(arrange.id, { status: 'deleted' });
  })();
  return true;
}

// Run before every plan. A moved meeting moves the due date; one that has gone
// from the calendar puts its tasks back to waiting, where Today shows them.
function settle(t = now()) {
  const db = crm();
  const rows = db.prepare(`SELECT m.* FROM task_meetings m JOIN tasks k ON k.id = m.task_id
    WHERE m.state = 'linked' AND k.status = 'needsAction' AND m.event_end > ?`).all(t);
  const out = { moved: 0, lost: 0 };
  for (const m of rows) {
    const e = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(m.event_id);
    const task = require('./tasks').get(m.task_id);
    if (!e) { hold(m.task_id, { lost: 1, t }); out.lost += 1; continue; }
    if (e.start_at === m.event_start && e.end_at === m.event_end && e.title === m.event_title) continue;
    db.prepare('UPDATE task_meetings SET event_title = ?, event_start = ?, event_end = ? WHERE task_id = ?').run(e.title, e.start_at, e.end_at, m.task_id);
    const before = dueAfter(task.space, m.event_start), after = dueAfter(task.space, e.start_at);
    // A date Douglas set by hand since stands until the meeting changes day.
    if (before !== after) { setDue(task, after); out.moved += 1; }
  }
  return out;
}

// What the planner needs: tasks held out of the plan, and the earliest a linked task may start.
function constraints(t = now()) {
  const map = new Map();
  for (const m of crm().prepare(`SELECT m.* FROM task_meetings m JOIN tasks k ON k.id = m.task_id WHERE k.status = 'needsAction'`).all()) {
    if (m.state === 'needs') map.set(m.task_id, { held: true });
    else if (m.event_end > t) map.set(m.task_id, { notBefore: m.event_end });
  }
  return map;
}

function brief(taskId, t = now()) {
  const m = get(taskId);
  if (!m) return null;
  const a = m.arrange_task_id ? crm().prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(m.arrange_task_id) : null;
  return { state: m.state, lost: !!m.lost, eventId: m.event_id, title: m.event_title, start: m.event_start, end: m.event_end,
    when: m.event_start ? when(m.event_start) : '', past: m.state === 'linked' && m.event_end <= t, arrange: a };
}

function waiting(space) {
  return crm().prepare(`SELECT k.id, k.title, m.lost, m.event_title FROM task_meetings m JOIN tasks k ON k.id = m.task_id
    WHERE m.state = 'needs' AND k.status = 'needsAction' AND k.space = ? ORDER BY m.created_at`).all(space);
}

module.exports = { get, dueAfter, upcoming, hold, link, release, settle, constraints, brief, waiting, when };
