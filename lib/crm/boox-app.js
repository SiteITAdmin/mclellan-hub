'use strict';

// What the Boox app is given, and what it reports back. The app only reads:
// everything here comes from the same views the CRM screens use. Its one
// effect is opening a day note in the tablet's own Notes app, which it reports
// so the Hub can say when a note that was started never reached Drive.

const crypto = require('crypto');
const { crm, now, setting, setSetting } = require('./db');
const { uuid } = require('../id');
const planner = require('./planner');
const boox = require('./boox');

const SPACES = ['work', 'personal'];
// As far back and ahead as the calendar sync keeps appointments and the plan.
const BACK_DAYS = 7;
const AHEAD_DAYS = planner.HORIZON_DAYS;
const ARRIVE_WITHIN = 3 * 3600;
const WATCH_DAYS = 7;

function secretOk(header) {
  const want = process.env.HUB_BOOX_TOKEN || '';
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const clock = ts => new Date(ts * 1000).toLocaleTimeString('en-GB', { timeZone: planner.TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayText = (date, options) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IE', { timeZone: 'UTC', ...options });
const sentence = s => s.charAt(0).toUpperCase() + s.slice(1);

function promiseLine(p) {
  const mine = p.direction === 'mine';
  const who = p.person_name || p.who || '';
  return {
    text: mine ? sentence(p.action) : `${who || 'They'} will ${p.action}`,
    to: mine ? who : '',
    when: p.due ? `Due ${p.due_label || p.due}` : p.days === undefined ? '' : mine
      ? (p.days === 0 ? 'Said today' : `Said ${p.days} ${p.days === 1 ? 'day' : 'days'} ago`)
      : (p.days === 0 ? 'Since today' : `Waiting ${p.days} ${p.days === 1 ? 'day' : 'days'}`),
    overdue: !!p.overdue, unsure: p.certainty === 'unsure', personId: p.person_id || null,
  };
}

function openedNotes(from, to) {
  const out = {};
  for (const r of crm().prepare(`SELECT entity_id, MIN(created_at) AS first FROM effects WHERE module = 'boox_app'
      AND entity_id >= ? AND entity_id < ? GROUP BY entity_id`).all(`${from}:`, `${planner.addDays(to, 1)}:`)) out[r.entity_id] = r.first;
  return out;
}

function spaceDetails(space, t) {
  const db = crm();
  const ledger = require('./promises').ledger(space);
  const promiseTasks = new Set([...ledger.mine, ...ledger.owed].map(p => p.task_id).filter(Boolean));
  const today = planner.local(t).date;
  const planned = db.prepare('SELECT MIN(start_at) AS at FROM plan_blocks WHERE task_id = ?');
  return {
    tasks: require('./tasks').list(space).filter(x => !promiseTasks.has(x.id)).map(x => {
      const at = planned.get(x.id).at;
      return { id: x.id, title: x.title, due: x.due || '', dueLabel: x.due ? dayText(x.due, { weekday: 'short', day: 'numeric', month: 'short' }) : '',
        overdue: !!x.due && x.due < today, planned: at ? `${dayText(planner.local(at).date, { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(at)}` : '',
        people: x.people.map(p => p.name) };
    }),
    owe: ledger.mine.map(promiseLine),
    owed: ledger.owed.map(promiseLine),
    drifting: require('./keepintouch').drifting(space, t).map(d => ({ id: d.person.id, name: d.person.name, sinceDays: d.sinceDays, every: d.every })),
    dates: require('./dates').upcoming(space, 7, t).map(d => ({ text: d.statement, on: d.on, label: dayText(d.on, { weekday: 'short', day: 'numeric', month: 'short' }), inDays: d.inDays })),
  };
}

function sync({ t = now(), app = '' } = {}) {
  const calendar = require('./calendar'), meetings = require('./meetings');
  const today = planner.local(t).date;
  const from = planner.addDays(today, -BACK_DAYS), to = planner.addDays(today, AHEAD_DAYS - 1);
  const prep = new Map();
  for (const space of SPACES) for (const m of meetings.today(space, t)) prep.set(m.id, m.lines.map(l => l.text));
  const notes = boox.dayNotes(from, to);
  const opened = openedNotes(from, to);
  const people = new Map();
  const seen = p => { if (!people.has(p.id)) people.set(p.id, p); return p.id; };

  const event = (e, detail) => ({
    people: detail.people.map(seen), guests: detail.guests.map(g => g.name || g.email).filter(Boolean),
    prep: prep.get(e.id) || [],
    happened: detail.happened.slice(0, 8).map(f => f.statement),
    tasks: detail.tasks.map(x => ({ title: x.title, done: x.status === 'completed', due: x.due || '' })),
    promises: detail.promises.map(promiseLine),
  });
  const days = [];
  for (let n = -BACK_DAYS; n < AHEAD_DAYS; n += 1) {
    const date = planner.addDays(today, n);
    const d = calendar.day('personal', date, { details: true });
    days.push({
      date, weekend: d.weekend,
      label: dayText(date, { weekday: 'long', day: 'numeric', month: 'long' }),
      short: dayText(date, { weekday: 'short' }), dayNumber: Number(date.slice(8)),
      allDay: d.banners.map(b => ({ id: b.id, space: b.space, title: b.title, ...event(b, b.detail) })),
      items: d.items.map(i => ({ type: i.type, id: i.id, space: i.space, title: i.title, from: clock(i.start), until: clock(i.end), start: i.start, end: i.end,
        ...(i.type === 'event' ? event(i, i.detail) : { late: !!i.late, due: i.due || '' }) })),
      notes: Object.fromEntries(SPACES.map(space => {
        const note = notes[date]?.[space];
        const pages = note ? note.pages.filter(p => !p.blank).length : 0;
        return [space, { title: boox.dayNoteTitle(date, space), opened: opened[`${date}:${space}`] || null, pages,
          state: !note ? 'none' : note.checking ? 'check' : note.failed ? 'failed' : note.waiting ? 'reading' : 'read' }];
      })),
    });
  }

  const spaces = Object.fromEntries(SPACES.map(space => [space, spaceDetails(space, t)]));
  for (const space of SPACES) for (const p of [...spaces[space].owe, ...spaces[space].owed]) if (p.personId) seen({ id: p.personId, space });
  const standings = require('./standings'), views = require('./views');
  const directory = {};
  for (const { id } of people.values()) {
    const p = crm().prepare('SELECT * FROM people_v WHERE id = ?').get(id);
    if (!p) continue;
    const last = views.lastContact(p.id, p.space);
    directory[id] = { name: p.name, space: p.space, role: p.role || '', org: p.org || '',
      lastContact: last ? dayText(planner.local(last).date, { day: 'numeric', month: 'short', year: 'numeric' }) : '',
      standing: (standings.forEntity('person', p.id)?.lines || []).map(l => l.text),
      owe: spaces[p.space].owe.filter(x => x.personId === id), owed: spaces[p.space].owed.filter(x => x.personId === id) };
  }

  setSetting('boox_app_seen', JSON.stringify({ at: t, app: String(app).slice(0, 40) }));
  return { ok: true, serverTime: t, today, days, spaces, people: directory,
    calendarSyncedAt: require('./runs').all().calendar_sync?.last_ok || null };
}

// The app says it opened (or made) the note for a day. The receipt's id comes
// from the app, so a report resent after a dropped connection is stored once.
function opened(body, t = now()) {
  const date = String(body?.date || ''), space = String(body?.space || '');
  const title = boox.dayNoteTitle(date, space);
  const given = String(body?.id || '');
  const id = /^[A-Za-z0-9-]{8,64}$/.test(given) ? `boox-app:${given}` : uuid();
  const at = Number(body?.at);
  const when = Number.isFinite(at) && at > t - WATCH_DAYS * 86400 && at <= t + 300 ? Math.floor(at) : t;
  crm().prepare(`INSERT OR IGNORE INTO effects (id, module, entity_id, operation, request, status, created_at, finished_at)
    VALUES (?, 'boox_app', ?, ?, ?, 'done', ?, ?)`).run(id, `${date}:${space}`, body?.created ? 'day_note.create' : 'day_note.open', JSON.stringify({ title }), when, t);
  return { ok: true, title };
}

function lastSeen() {
  try { return JSON.parse(setting('boox_app_seen', 'null')); } catch { return null; }
}

// A note started on the Boox whose PDF has not turned up in Drive. Watched for
// a week; after that it is no longer news.
function health(space, t = now()) {
  const out = [];
  for (const r of crm().prepare(`SELECT entity_id, MIN(created_at) AS first FROM effects WHERE module = 'boox_app' AND created_at > ? GROUP BY entity_id`).all(t - WATCH_DAYS * 86400)) {
    const [day, noteSpace] = r.entity_id.split(':');
    if (noteSpace !== space || r.first > t - ARRIVE_WITHIN) continue;
    if (crm().prepare("SELECT 1 FROM notebooks WHERE kind = 'day' AND day = ? AND space = ?").get(day, space)) continue;
    out.push({ level: 'warn', href: '/crm/notebooks',
      text: `The Boox note for ${boox.dayLabel(day)} was started ${require('./views').ago(r.first)} and hasn't reached Google Drive. If you wrote in it, sync it from the Boox` });
  }
  return out;
}

module.exports = { secretOk, sync, opened, lastSeen, health, BACK_DAYS, AHEAD_DAYS };
