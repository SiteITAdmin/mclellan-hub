'use strict';

// Works out when each open task gets done, around what is already in the
// diary. Pure: it is handed the current state and returns a whole new plan, so
// the plan can be thrown away and rebuilt on every run.

const TZ = 'Europe/Dublin';
const GRID = 5 * 60;
const DEFAULT_MINUTES = 30;
const MAX_PIECE = 90;
const WHOLE_UP_TO = 120;
const HORIZON_DAYS = 14;
const DEFAULT_HOURS = Object.freeze({
  workStart: '08:00', workEnd: '16:00',
  eveningStart: '18:30', eveningEnd: '21:00',
  weekendStart: '10:00', weekendEnd: '17:00',
});
// A flexible appointment may land anywhere in the waking day, whichever space it is in.
const DAY_START = 8 * 60, DAY_END = 21 * 60;

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false,
});

function local(ts) {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(ts * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute), weekend: p.weekday === 'Sat' || p.weekday === 'Sun', weekday: p.weekday };
}

// Dublin wall-clock time to epoch seconds. The offset is read at the guess and
// again at the answer, so the hour either side of a clock change comes out right.
function epoch(date, minutes = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes) / 1000;
  const offset = ts => {
    const l = local(ts);
    const [ly, lm, ld] = l.date.split('-').map(Number);
    return Date.UTC(ly, lm - 1, ld, 0, l.minutes) / 1000 - Math.floor(ts / 60) * 60;
  };
  const first = wall - offset(wall);
  return wall - offset(first);
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Use times like 08:30');
  return Number(m[1]) * 60 + Number(m[2]);
}

function normaliseHours(value = {}) {
  const hours = { ...DEFAULT_HOURS };
  for (const key of Object.keys(DEFAULT_HOURS)) if (value[key]) hours[key] = String(value[key]).trim();
  for (const [label, a, b] of [['Work hours', 'workStart', 'workEnd'], ['Evening hours', 'eveningStart', 'eveningEnd'], ['Weekend hours', 'weekendStart', 'weekendEnd']]) {
    if (minutesOf(hours[b]) - minutesOf(hours[a]) < 15) throw new Error(`${label} must end after they start`);
  }
  return hours;
}

// When a space's tasks may be planned on one day, as [startMinute, endMinute] or null.
function windowFor(space, date, hours) {
  const weekend = local(epoch(date, 12 * 60)).weekend;
  if (space === 'work') return weekend ? null : [minutesOf(hours.workStart), minutesOf(hours.workEnd)];
  if (space === 'personal') return weekend ? [minutesOf(hours.weekendStart), minutesOf(hours.weekendEnd)] : [minutesOf(hours.eveningStart), minutesOf(hours.eveningEnd)];
  return [DAY_START, DAY_END];
}

const ceil = ts => Math.ceil(ts / GRID) * GRID;

// Long tasks are done in sittings of at most 90 minutes, evenly sized.
function pieces(minutes) {
  if (minutes <= WHOLE_UP_TO) return minutes > 0 ? [minutes] : [];
  const n = Math.ceil(minutes / MAX_PIECE);
  const out = [];
  for (let i = 0, left = minutes; i < n; i += 1) {
    const size = Math.ceil(left / (n - i) / 5) * 5;
    out.push(size);
    left -= size;
  }
  return out;
}

/**
 * tasks:    [{ id, space, minutes, due, createdAt }]             open tasks
 * busy:     [{ start, end }]                                   fixed diary time, any space
 * flexible: [{ id, start, end }]                               appointments the Hub may move
 * existing: [{ id, taskId, start, end, pinned }]               the plan as it stands
 */
function plan({ now, tasks = [], busy = [], flexible = [], existing = [], hours = DEFAULT_HOURS, days = HORIZON_DAYS }) {
  const today = local(now).date;
  const horizon = epoch(addDays(today, days));
  const taken = busy.filter(b => b.end > now).map(b => ({ start: b.start, end: b.end }));
  const clash = (s, e) => taken.find(t => t.start < e && t.end > s);
  const take = (s, e) => taken.push({ start: s, end: e });

  function findSlot(space, seconds, from) {
    let date = local(Math.max(from, now)).date;
    for (; epoch(date) < horizon; date = addDays(date, 1)) {
      const w = windowFor(space, date, hours);
      if (!w) continue;
      const end = epoch(date, w[1]);
      let cursor = ceil(Math.max(epoch(date, w[0]), from, now));
      while (cursor + seconds <= end) {
        const hit = clash(cursor, cursor + seconds);
        if (!hit) return cursor;
        cursor = ceil(hit.end);
      }
    }
    return null;
  }

  // Flexible appointments stay where they are unless something fixed lands on them.
  const moved = [];
  for (const f of [...flexible].sort((a, b) => a.start - b.start)) {
    if (f.start <= now) { take(f.start, f.end); continue; }
    if (!clash(f.start, f.end)) { take(f.start, f.end); continue; }
    const start = findSlot('any', f.end - f.start, f.start);
    if (start === null) { take(f.start, f.end); continue; }
    take(start, start + (f.end - f.start));
    moved.push({ id: f.id, start, end: start + (f.end - f.start) });
  }

  const open = new Map(tasks.map(t => [t.id, t]));
  const blocks = [];
  const covered = new Map();
  // A block Douglas placed himself, or one already under way, is not moved.
  for (const b of existing) {
    const task = open.get(b.taskId);
    if (!task || b.end <= now) continue;
    if (!b.pinned && !(b.start <= now)) continue;
    blocks.push({ id: b.id, taskId: b.taskId, space: task.space, start: b.start, end: b.end, pinned: b.pinned ? 1 : 0 });
    take(b.start, b.end);
    covered.set(b.taskId, (covered.get(b.taskId) || 0) + (b.end - b.start) / 60);
  }

  const unplanned = [];
  const order = [...tasks].sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : a.createdAt - b.createdAt);
  for (const task of order) {
    const used = new Set(blocks.filter(b => b.taskId === task.id).map(b => b.id));
    const left = Math.max(0, (task.minutes || DEFAULT_MINUTES) - (covered.get(task.id) || 0));
    let from = now;
    let n = 0;
    for (const minutes of pieces(Math.ceil(left / 5) * 5)) {
      const start = findSlot(task.space, minutes * 60, from);
      if (start === null) { unplanned.push(task.id); break; }
      while (used.has(`${task.id}:${n}`)) n += 1;
      const id = `${task.id}:${n}`;
      used.add(id);
      blocks.push({ id, taskId: task.id, space: task.space, start, end: start + minutes * 60, pinned: 0 });
      take(start, start + minutes * 60);
      from = start + minutes * 60;
    }
  }

  for (const b of blocks) {
    const due = open.get(b.taskId).due;
    b.late = due && b.end > epoch(addDays(due, 1)) ? 1 : 0;
  }
  blocks.sort((a, b) => a.start - b.start);
  return { blocks, moved, unplanned: [...new Set(unplanned)] };
}

module.exports = { plan, local, epoch, addDays, minutesOf, normaliseHours, windowFor, pieces, DEFAULT_HOURS, DEFAULT_MINUTES, HORIZON_DAYS, TZ };
