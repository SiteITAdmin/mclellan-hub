'use strict';

// The quick review of open steps: every open task in a space on one page, each
// with one-tap dates, Done (with an optional word on what happened, which the
// follow-up guess reads) and Drop.

const { now } = require('./db');
const planner = require('./planner');
const tasks = require('./tasks');

function quickDates(ts = now()) {
  const today = planner.local(ts).date;
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return { today, tomorrow: planner.addDays(today, 1), nextWeek: planner.addDays(today, (8 - weekday) % 7 || 7) };
}

// Late first, then undated (the ones that most need a decision), then by date.
function list(space, ts = now()) {
  const { today } = quickDates(ts);
  const rank = t => (t.due && t.due < today ? 0 : t.due ? 2 : 1);
  return tasks.list(space).sort((a, b) => rank(a) - rank(b) || String(a.due || '').localeCompare(String(b.due || '')) || a.created_at - b.created_at);
}

function counts(rows, ts = now()) {
  const { today } = quickDates(ts);
  return { open: rows.length, undated: rows.filter(t => !t.due).length, late: rows.filter(t => t.due && t.due < today).length };
}

const label = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

function act(space, input, ts = now()) {
  const t = tasks.get(String(input.task || ''));
  if (!t || t.space !== space) throw new Error('Task not found');
  if (t.status !== 'needsAction') throw new Error('That task is no longer open');
  const revision = input.revision;
  const d = quickDates(ts);
  const due = { today: d.today, tomorrow: d.tomorrow, nextweek: d.nextWeek, date: input.due || null, clear: null };
  if (input.do in due) {
    if (input.do === 'date' && !input.due) throw new Error('Choose a date first');
    tasks.edit(t.id, { due: due[input.do], revision });
    return due[input.do] ? `“${t.title}” is now due ${label(due[input.do])}.` : `“${t.title}” has no date now.`;
  }
  if (input.do === 'done') {
    tasks.edit(t.id, { status: 'completed', revision });
    require('./task-followups').record(t.id, input.said);
    return `Done: “${t.title}”. The Hub will suggest what follows from it in a few minutes.`;
  }
  if (input.do === 'drop') {
    tasks.edit(t.id, { status: 'deleted', revision });
    return `Dropped “${t.title}”. It is deleted in Google Tasks at the next sync.`;
  }
  throw new Error('Choose what to do with the task');
}

module.exports = { quickDates, list, counts, act, label };
