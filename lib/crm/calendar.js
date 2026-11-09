'use strict';

// The calendar: reads Google Calendar, plans open tasks into the free time
// around it (lib/crm/planner.js), and writes each planned block back to Google
// so it is on Douglas's phone. Every run works on the current 14 days only and
// replaces the whole plan, so nothing queues up behind an outage.

const { crm, now, setting, setSetting } = require('./db');
const { uuid } = require('../id');
const config = require('./config');
const planner = require('./planner');
const runs = require('./runs');

const options = { timeout: 30000, retry: false };
const code = e => Number(e.response?.status || e.code);
const COLOUR = { work: '9', personal: '2' };

function hours() {
  try { return planner.normaliseHours(JSON.parse(setting('plan_hours', '{}'))); }
  catch (_) { return { ...planner.DEFAULT_HOURS }; }
}

function saveHours(input) {
  const value = planner.normaliseHours(input);
  setSetting('plan_hours', JSON.stringify(value));
  replan();
  return value;
}

function openTasks() {
  return crm().prepare("SELECT id, space, title, minutes, due, created_at FROM tasks WHERE status = 'needsAction'").all()
    .map(t => ({ id: t.id, space: t.space, title: t.title, minutes: t.minutes || planner.DEFAULT_MINUTES, due: t.due, createdAt: t.created_at }));
}

// Rebuilds the plan from what the Hub already holds. No Google call, so a
// change made on a CRM screen shows straight away; the next run carries it out.
function replan(t = now()) {
  const db = crm();
  const tasks = openTasks();
  const events = db.prepare('SELECT * FROM calendar_events WHERE end_at > ? AND busy = 1').all(t);
  const existing = db.prepare('SELECT * FROM plan_blocks').all();
  const result = planner.plan({
    now: t, tasks, hours: hours(),
    busy: events.filter(e => !e.flexible).map(e => ({ start: e.start_at, end: e.end_at })),
    flexible: events.filter(e => e.flexible).map(e => ({ id: e.id, start: e.start_at, end: e.end_at })),
    existing: existing.map(b => ({ id: b.id, taskId: b.task_id, start: b.start_at, end: b.end_at, pinned: b.pinned })),
  });
  db.transaction(() => {
    const keep = new Set(result.blocks.map(b => b.id));
    for (const b of existing) if (!keep.has(b.id)) db.prepare('DELETE FROM plan_blocks WHERE id = ?').run(b.id);
    for (const b of result.blocks) {
      db.prepare(`INSERT INTO plan_blocks (id, task_id, space, start_at, end_at, pinned, late) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, space = excluded.space, start_at = excluded.start_at,
          end_at = excluded.end_at, pinned = excluded.pinned, late = excluded.late`)
        .run(b.id, b.taskId, b.space, b.start, b.end, b.pinned, b.late);
    }
    setSetting('plan_state', JSON.stringify({ at: t, unplanned: result.unplanned }));
  })();
  return result;
}

async function effect(entityId, operation, request, fn) {
  const id = uuid();
  crm().prepare("INSERT INTO effects (id, module, entity_id, operation, request, status) VALUES (?, 'crm_calendar', ?, ?, ?, 'started')")
    .run(id, entityId, operation, JSON.stringify(request));
  try {
    const result = await fn();
    crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify({ id: result?.data?.id || '' }), now(), id);
    return result?.data || {};
  } catch (err) {
    const definite = code(err) >= 400 && code(err) < 500 && code(err) !== 408;
    crm().prepare('UPDATE effects SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(definite ? 'failed' : 'uncertain', String(err.message).slice(0, 500), now(), id);
    throw err;
  }
}

const at = v => (v?.dateTime ? Math.floor(Date.parse(v.dateTime) / 1000) : planner.epoch(v.date));
const when = ts => ({ dateTime: new Date(ts * 1000).toISOString(), timeZone: planner.TZ });

async function fetchEvents(api, calendarId, from, to) {
  const items = [];
  let pageToken;
  do {
    const { data } = await api.events.list({
      calendarId, singleEvents: true, showDeleted: false, maxResults: 250, pageToken,
      timeMin: new Date(from * 1000).toISOString(), timeMax: new Date(to * 1000).toISOString(),
    }, options);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

function storeEvents(calendar, items, t) {
  const db = crm();
  const upsert = db.prepare(`INSERT INTO calendar_events (id, calendar_id, space, title, start_at, end_at, all_day, busy, solo, link, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at, all_day = excluded.all_day,
      busy = excluded.busy, solo = excluded.solo, link = excluded.link, seen_at = excluded.seen_at,
      flexible = CASE WHEN excluded.solo = 1 THEN flexible ELSE 0 END`);
  let n = 0;
  for (const e of items) {
    if (e.status === 'cancelled' || e.eventType === 'workingLocation' || !e.start) continue;
    const mine = (e.attendees || []).find(a => a.self);
    if (mine?.responseStatus === 'declined') continue;
    const others = (e.attendees || []).filter(a => !a.self && !a.resource).length;
    // Only something Douglas made for himself alone may ever be moved.
    const solo = (e.organizer?.self || e.creator?.self) && !others ? 1 : 0;
    upsert.run(e.id, calendar.id, calendar.space, e.summary || '(No title)', at(e.start), at(e.end || e.start), e.start.date ? 1 : 0,
      e.transparency === 'transparent' ? 0 : 1, solo, e.htmlLink || '', t);
    n += 1;
  }
  db.prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND seen_at < ?').run(calendar.id, t);
  return n;
}

// A block whose Google event no longer sits where the Hub put it was dragged
// by Douglas: that is his choice of time, so it stays there.
function noticeMoves(hubEvents) {
  const db = crm();
  const byId = new Map(hubEvents.map(e => [e.id, e]));
  let pinned = 0;
  for (const b of db.prepare('SELECT * FROM plan_blocks WHERE google_event_id IS NOT NULL').all()) {
    const g = byId.get(b.google_event_id);
    if (!g) {
      db.prepare('UPDATE plan_blocks SET google_event_id = NULL, pushed_start = NULL, pushed_end = NULL, pushed_title = NULL, pinned = 0 WHERE id = ?').run(b.id);
      continue;
    }
    const s = at(g.start), e = at(g.end);
    if (b.pushed_start !== null && (s !== b.pushed_start || e !== b.pushed_end)) {
      db.prepare('UPDATE plan_blocks SET start_at = ?, end_at = ?, pushed_start = ?, pushed_end = ?, pinned = 1 WHERE id = ?').run(s, e, s, e, b.id);
      pinned += 1;
    }
  }
  return pinned;
}

function eventBody(block, task) {
  return {
    summary: task.title,
    description: `Planned by the Hub. It moves by itself as your diary changes; drag it to keep it at a time you choose.\n${require('./tasks').url(task)}`,
    start: when(block.start_at), end: when(block.end_at),
    colorId: COLOUR[block.space],
    extendedProperties: { private: { hubBlock: block.id, hubTask: block.task_id } },
  };
}

async function push(api, calendarId, hubEvents, moved, t) {
  const db = crm();
  const detail = { created: 0, changed: 0, removed: 0, appointmentsMoved: 0 };
  const errors = [];
  const attempt = async fn => { try { await fn(); } catch (err) { errors.push(err.message); } };

  // An event the Hub made but lost track of (a reply that never arrived) is
  // taken back rather than made twice.
  const claimed = new Set(db.prepare('SELECT google_event_id FROM plan_blocks WHERE google_event_id IS NOT NULL').all().map(r => r.google_event_id));
  for (const b of db.prepare('SELECT * FROM plan_blocks WHERE google_event_id IS NULL').all()) {
    const g = hubEvents.find(e => e.extendedProperties.private.hubBlock === b.id && !claimed.has(e.id));
    if (!g) continue;
    db.prepare('UPDATE plan_blocks SET google_event_id = ?, pushed_start = ?, pushed_end = ?, pushed_title = ? WHERE id = ?').run(g.id, at(g.start), at(g.end), g.summary || '', b.id);
    claimed.add(g.id);
  }
  // Blocks no longer in the plan. One already started is left as a record of the work.
  for (const g of hubEvents) {
    if (claimed.has(g.id) || at(g.start) < t) continue;
    await attempt(async () => {
      await effect(g.extendedProperties.private.hubTask || g.id, 'event.delete', { eventId: g.id },
        () => api.events.delete({ calendarId, eventId: g.id }, options)).catch(err => { if (![404, 410].includes(code(err))) throw err; });
      detail.removed += 1;
    });
  }

  for (const b of db.prepare('SELECT * FROM plan_blocks ORDER BY start_at').all()) {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(b.task_id);
    const body = eventBody(b, task);
    const done = id => db.prepare('UPDATE plan_blocks SET google_event_id = ?, pushed_start = ?, pushed_end = ?, pushed_title = ? WHERE id = ?').run(id, b.start_at, b.end_at, task.title, b.id);
    if (!b.google_event_id) {
      await attempt(async () => {
        const made = await effect(b.task_id, 'event.insert', { block: b.id, start: b.start_at, end: b.end_at }, () => api.events.insert({ calendarId, requestBody: body }, options));
        done(made.id);
        detail.created += 1;
      });
    } else if (b.pushed_start !== b.start_at || b.pushed_end !== b.end_at || b.pushed_title !== task.title) {
      await attempt(async () => {
        try {
          await effect(b.task_id, 'event.patch', { block: b.id, eventId: b.google_event_id, start: b.start_at, end: b.end_at },
            () => api.events.patch({ calendarId, eventId: b.google_event_id, requestBody: { summary: body.summary, start: body.start, end: body.end } }, options));
          done(b.google_event_id);
          detail.changed += 1;
        } catch (err) {
          // Gone from Google: forget it and the next run makes a new one.
          if ([404, 410].includes(code(err))) db.prepare('UPDATE plan_blocks SET google_event_id = NULL, pushed_start = NULL, pushed_end = NULL WHERE id = ?').run(b.id);
          throw err;
        }
      });
    }
  }

  for (const m of moved) {
    const e = db.prepare('SELECT * FROM calendar_events WHERE id = ? AND flexible = 1 AND solo = 1').get(m.id);
    if (!e) continue;
    await attempt(async () => {
      await effect(e.id, 'appointment.move', { eventId: e.id, title: e.title, from: e.start_at, to: m.start },
        () => api.events.patch({ calendarId: e.calendar_id, eventId: e.id, requestBody: { start: when(m.start), end: when(m.end) } }, options));
      db.prepare('UPDATE calendar_events SET start_at = ?, end_at = ? WHERE id = ?').run(m.start, m.end, e.id);
      detail.appointmentsMoved += 1;
    });
  }
  if (errors.length) throw new Error(`Google Calendar: ${[...new Set(errors)].slice(0, 3).join('; ')}`);
  return detail;
}

let running = false;

async function run({ api, at: t = now() } = {}) {
  if (running) return { busy: true };
  running = true;
  try {
    return await runs.track('calendar_sync', async () => {
      api ||= require('./google').calendar();
      const from = planner.epoch(planner.local(t).date);
      const to = planner.epoch(planner.addDays(planner.local(t).date, planner.HORIZON_DAYS));
      const hubEvents = [];
      let events = 0;
      for (const calendar of config.calendars) {
        const items = await fetchEvents(api, calendar.id, from, to);
        const ours = items.filter(e => e.extendedProperties?.private?.hubBlock && e.status !== 'cancelled');
        if (calendar === config.calendars[0]) hubEvents.push(...ours);
        events += storeEvents(calendar, items.filter(e => !e.extendedProperties?.private?.hubBlock), t);
      }
      const pinned = noticeMoves(hubEvents);
      const result = replan(t);
      const pushed = await push(api, config.calendars[0].id, hubEvents, result.moved, t);
      return { events, blocks: result.blocks.length, unplanned: result.unplanned.length, late: result.blocks.filter(b => b.late).length, pinned, ...pushed };
    });
  } finally {
    running = false;
  }
}

function setFlexible(eventId, on) {
  const changed = crm().prepare('UPDATE calendar_events SET flexible = ? WHERE id = ? AND solo = 1 AND all_day = 0').run(on ? 1 : 0, eventId).changes;
  if (changed) replan();
  return changed;
}

function unpin(taskId) {
  const changed = crm().prepare('UPDATE plan_blocks SET pinned = 0 WHERE task_id = ?').run(taskId).changes;
  if (changed) replan();
  return changed;
}

// Brings the next run forward so a change on a CRM screen reaches Google within the minute.
function soon() {
  if (process.env.HUB_DISABLE_JOBS === '1') return;
  const jobs = require('../jobs');
  if (jobs.hasPending('crm_calendar_sync')) require('../db').hub().prepare("UPDATE system_jobs SET run_at = unixepoch() WHERE type = 'crm_calendar_sync' AND status = 'pending'").run();
  else jobs.scheduleJob('crm_calendar_sync', {}, null, 'crm_calendar_ui');
}

// ── Views ──────────────────────────────────────────────────────────────────

function blocksFor(taskId) {
  return crm().prepare('SELECT * FROM plan_blocks WHERE task_id = ? ORDER BY start_at').all(taskId);
}

// One day's items for a space. The other space's appointments show only as
// "Busy", so the two never mix but the plan still makes sense.
function day(space, date) {
  const db = crm();
  const from = planner.epoch(date), to = planner.epoch(planner.addDays(date, 1));
  const items = [];
  const banners = [];
  for (const e of db.prepare('SELECT * FROM calendar_events WHERE start_at < ? AND end_at > ? ORDER BY start_at').all(to, from)) {
    const own = e.space === space;
    if (e.all_day) { if (own) banners.push(e); continue; }
    if (!own && !e.busy) continue;
    items.push({ type: own ? 'event' : 'busy', id: e.id, title: own ? e.title : `Busy (${e.space === 'work' ? 'Work' : 'Personal'})`, start: e.start_at, end: e.end_at,
      link: own ? e.link : '', flexible: own && !!e.flexible, solo: own && !!e.solo, free: !e.busy });
  }
  for (const b of db.prepare(`SELECT b.*, t.title, t.due, t.minutes_by FROM plan_blocks b JOIN tasks t ON t.id = b.task_id
      WHERE b.space = ? AND t.status = 'needsAction' AND b.start_at < ? AND b.end_at > ? ORDER BY b.start_at`).all(space, to, from)) {
    items.push({ type: 'task', id: b.task_id, title: b.title, start: b.start_at, end: b.end_at, pinned: !!b.pinned, late: !!b.late, due: b.due });
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  for (const i of items) {
    i.from = Math.max(0, Math.round((Math.max(i.start, from) - from) / 60));
    i.until = Math.min(1440, Math.round((Math.min(i.end, to) - from) / 60));
  }
  const l = planner.local(from + 12 * 3600);
  return { date, weekday: l.weekday, weekend: l.weekend, items, banners, window: planner.windowFor(space, date, hours()) };
}

function state(space) {
  const db = crm();
  const plan = JSON.parse(setting('plan_state', '{}'));
  const ids = plan.unplanned || [];
  const unplanned = ids.length ? db.prepare(`SELECT id, title, due, minutes FROM tasks WHERE id IN (${ids.map(() => '?').join(',')}) AND space = ? AND status = 'needsAction'`).all(...ids, space) : [];
  const late = db.prepare(`SELECT t.id, t.title, t.due, MAX(b.end_at) AS ends FROM plan_blocks b JOIN tasks t ON t.id = b.task_id
    WHERE b.space = ? AND b.late = 1 AND t.status = 'needsAction' GROUP BY t.id ORDER BY t.due`).all(space);
  return { plannedAt: plan.at || null, unplanned, late, run: runs.all().calendar_sync || null };
}

function week(space, start, days = 7) {
  return Array.from({ length: days }, (_, i) => day(space, planner.addDays(start, i)));
}

function health(space) {
  const out = [];
  const t = now();
  const href = `/crm/${space}/calendar`;
  const r = runs.all().calendar_sync;
  if (!r?.last_started) out.push({ level: 'warn', text: 'The calendar has not been planned yet', href });
  else if (r.last_error && (!r.last_ok || r.last_error_at >= r.last_ok)) out.push({ level: 'bad', text: `Calendar: ${r.last_error}`, href });
  else if (!r.last_ok || r.last_ok < t - 30 * 60) out.push({ level: 'bad', text: `The calendar was last planned ${require('./views').ago(r.last_ok)}`, href });
  const s = state(space);
  if (s.late.length) out.push({ level: 'warn', text: `${s.late.length} task${s.late.length === 1 ? " won't" : "s won't"} fit before ${s.late.length === 1 ? 'its' : 'their'} due date`, href });
  if (s.unplanned.length) out.push({ level: 'warn', text: `${s.unplanned.length} task${s.unplanned.length === 1 ? '' : 's'} found no free time in the next ${planner.HORIZON_DAYS} days`, href });
  const unsized = require('./task-length').failedCount(space);
  if (unsized) out.push({ level: 'warn', text: `${unsized} task${unsized === 1 ? '' : 's'} couldn't be given a length, so ${unsized === 1 ? 'it is' : 'they are'} planned at 30 minutes`, href });
  return out;
}

module.exports = { run, replan, hours, saveHours, setFlexible, unpin, soon, day, week, state, health, blocksFor, storeEvents, noticeMoves };
