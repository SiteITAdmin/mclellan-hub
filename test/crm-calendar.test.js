'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-calendar-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const tasks = require('../lib/crm/tasks');
const planner = require('../lib/crm/planner');
const calendar = require('../lib/crm/calendar');
const taskLength = require('../lib/crm/task-length');

const MON = '2026-11-09';
const at = (date, hhmm) => planner.epoch(date, planner.minutesOf(hhmm));
const clock = ts => { const l = planner.local(ts); return `${l.date} ${String(Math.floor(l.minutes / 60)).padStart(2, '0')}:${String(l.minutes % 60).padStart(2, '0')}`; };
const iso = ts => ({ dateTime: new Date(ts * 1000).toISOString() });
let api;

function fakeGoogle() {
  let n = 0;
  const events = [], calls = [];
  const copy = x => JSON.parse(JSON.stringify(x));
  const find = id => { const e = events.find(x => x.id === id); if (!e) throw Object.assign(new Error('Not Found'), { code: 404 }); return e; };
  return { rows: events, calls,
    add: fields => { const e = { id: `g${++n}`, status: 'confirmed', organizer: { self: true }, ...fields }; events.push(e); return e; },
    events: {
      list: async p => { assert.equal(p.singleEvents, true); return { data: { items: copy(events.filter(e => Date.parse(e.start.dateTime || e.start.date) < Date.parse(p.timeMax) && Date.parse(e.end.dateTime || e.end.date) > Date.parse(p.timeMin))) } }; },
      insert: async p => { calls.push(['insert', copy(p)]); const e = { id: `g${++n}`, status: 'confirmed', organizer: { self: true }, ...copy(p.requestBody) }; events.push(e); return { data: copy(e) }; },
      patch: async p => { calls.push(['patch', copy(p)]); Object.assign(find(p.eventId), copy(p.requestBody)); return { data: copy(find(p.eventId)) }; },
      delete: async p => { calls.push(['delete', copy(p)]); events.splice(events.indexOf(find(p.eventId)), 1); return { data: {} }; },
    },
  };
}

beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); api = fakeGoogle(); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Dublin wall-clock times convert correctly in winter and summer', () => {
  assert.equal(new Date(at('2026-11-09', '08:00') * 1000).toISOString(), '2026-11-09T08:00:00.000Z');
  assert.equal(new Date(at('2026-07-01', '08:00') * 1000).toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(new Date(at('2027-03-28', '09:00') * 1000).toISOString(), '2027-03-28T08:00:00.000Z');
});

test('tasks are planned in due order around fixed appointments, in their own hours', () => {
  const r = planner.plan({ now: at(MON, '09:02'),
    tasks: [
      { id: 'later', space: 'work', minutes: 60, due: '2026-11-12', createdAt: 1 },
      { id: 'nodate', space: 'work', minutes: 30, due: null, createdAt: 2 },
      { id: 'today', space: 'work', minutes: 30, due: MON, createdAt: 3 },
      { id: 'home', space: 'personal', minutes: 45, due: null, createdAt: 4 },
    ],
    busy: [{ start: at(MON, '09:30'), end: at(MON, '10:30') }] });
  const got = Object.fromEntries(r.blocks.map(b => [b.id, `${clock(b.start)}-${clock(b.end).slice(11)}`]));
  assert.deepEqual(got, {
    'today:0': '2026-11-09 10:30-11:00',   // 09:05 to 09:30 is too short, so it waits for the meeting to end
    'later:0': '2026-11-09 11:00-12:00',
    'nodate:0': '2026-11-09 12:00-12:30',
    'home:0': '2026-11-09 18:30-19:15',
  });
  assert.deepEqual(r.unplanned, []);
});

test('work is never planned at the weekend, and a long task is split into sittings', () => {
  const r = planner.plan({ now: at('2026-11-13', '15:00'), tasks: [{ id: 'big', space: 'work', minutes: 240, due: null, createdAt: 1 }] });
  // Friday 15:00 leaves an hour, too short for an 80-minute sitting, so all three wait for Monday.
  assert.deepEqual(r.blocks.map(b => `${clock(b.start)} ${(b.end - b.start) / 60}`), ['2026-11-16 08:00 80', '2026-11-16 09:20 80', '2026-11-16 10:40 80']);
});

test('a task that cannot be done before its due date is flagged, and one with no room at all is reported', () => {
  const day = [{ start: at(MON, '08:00'), end: at(MON, '16:00') }];
  const r = planner.plan({ now: at(MON, '08:00'), tasks: [{ id: 'a', space: 'work', minutes: 30, due: MON, createdAt: 1 }], busy: day });
  assert.equal(clock(r.blocks[0].start), '2026-11-10 08:00');
  assert.equal(r.blocks[0].late, 1);
  const none = planner.plan({ now: at(MON, '08:00'), days: 1, tasks: [{ id: 'a', space: 'work', minutes: 30, due: null, createdAt: 1 }], busy: day });
  assert.deepEqual(none.unplanned, ['a']);
});

test('a flexible appointment stays put until something fixed lands on it', () => {
  const flexible = [{ id: 'gym', start: at(MON, '12:00'), end: at(MON, '13:00') }];
  assert.deepEqual(planner.plan({ now: at(MON, '09:00'), flexible }).moved, []);
  const r = planner.plan({ now: at(MON, '09:00'), flexible, busy: [{ start: at(MON, '12:30'), end: at(MON, '13:30') }],
    tasks: [{ id: 'a', space: 'work', minutes: 30, due: null, createdAt: 1 }] });
  assert.deepEqual(r.moved.map(m => [m.id, clock(m.start), clock(m.end)]), [['gym', '2026-11-09 13:30', '2026-11-09 14:30']]);
  assert.equal(clock(r.blocks[0].start), '2026-11-09 09:00');
});

test('a block under way or placed by Douglas is left alone; one that ran out is planned again', () => {
  const task = { id: 'a', space: 'work', minutes: 30, due: null, createdAt: 1 };
  const underway = planner.plan({ now: at(MON, '10:10'), tasks: [task], existing: [{ id: 'a:0', taskId: 'a', start: at(MON, '10:00'), end: at(MON, '10:30'), pinned: 0 }] });
  assert.equal(clock(underway.blocks[0].start), '2026-11-09 10:00');
  const ranOut = planner.plan({ now: at(MON, '10:32'), tasks: [task], existing: [{ id: 'a:0', taskId: 'a', start: at(MON, '10:00'), end: at(MON, '10:30'), pinned: 0 }] });
  assert.deepEqual(ranOut.blocks.map(b => [b.id, clock(b.start)]), [['a:0', '2026-11-09 10:35']]);
  const pinned = planner.plan({ now: at(MON, '09:00'), tasks: [task, { ...task, id: 'b' }], existing: [{ id: 'a:0', taskId: 'a', start: at(MON, '09:00') + 86400, end: at(MON, '09:30') + 86400, pinned: 1 }] });
  assert.deepEqual(pinned.blocks.map(b => [b.id, clock(b.start), b.pinned]), [['b:0', '2026-11-09 09:00', 0], ['a:0', '2026-11-10 09:00', 1]]);
});

test('a run writes blocks to Google, changes nothing when nothing changed, and moves a block when a meeting lands on it', async () => {
  const t = tasks.create('work', { title: 'Write the audit plan' });
  tasks.setMinutes(t.id, 60);
  api.add({ summary: 'Dentist', start: iso(at(MON, '09:30')), end: iso(at(MON, '10:00')) });
  let d = await calendar.run({ api, at: at(MON, '09:00') });
  assert.deepEqual([d.events, d.blocks, d.created, d.changed, d.removed], [1, 1, 1, 0, 0]);
  const made = api.rows.find(e => e.extendedProperties?.private?.hubBlock);
  assert.equal(made.summary, 'Write the audit plan');
  assert.equal(made.extendedProperties.private.hubTask, t.id);
  assert.equal(clock(Date.parse(made.start.dateTime) / 1000), '2026-11-09 10:00');
  assert.match(made.description, new RegExp(`/crm/work/tasks/${t.id}`));

  api.calls.length = 0;
  d = await calendar.run({ api, at: at(MON, '09:05') });
  assert.deepEqual(api.calls, []);

  api.add({ summary: 'Board call', start: iso(at(MON, '10:30')), end: iso(at(MON, '11:30')), attendees: [{ self: true }, { email: 'a@example.com' }] });
  d = await calendar.run({ api, at: at(MON, '09:10') });
  assert.equal(d.changed, 1);
  assert.equal(clock(Date.parse(made.start.dateTime) / 1000), '2026-11-09 11:30');
  const receipts = db.crm().prepare("SELECT operation, status FROM effects WHERE module = 'crm_calendar' ORDER BY created_at, rowid").all();
  assert.deepEqual(receipts.map(r => `${r.operation}:${r.status}`), ['event.insert:done', 'event.patch:done']);
});

test('a block dragged in Google stays where Douglas put it, until he hands it back', async () => {
  const t = tasks.create('work', { title: 'Call the supplier' });
  await calendar.run({ api, at: at(MON, '09:00') });
  const made = api.rows.find(e => e.extendedProperties?.private?.hubBlock);
  Object.assign(made, { start: iso(at(MON, '14:00')), end: iso(at(MON, '14:30')) });
  api.calls.length = 0;
  const d = await calendar.run({ api, at: at(MON, '09:05') });
  assert.equal(d.pinned, 1);
  assert.deepEqual(api.calls, []);
  assert.deepEqual(calendar.blocksFor(t.id).map(b => [clock(b.start_at), b.pinned]), [['2026-11-09 14:00', 1]]);
  calendar.unpin(t.id);
  assert.equal(calendar.blocksFor(t.id)[0].pinned, 0);
});

test('finishing a task removes its future block; a lost reply is recovered without a second event', async () => {
  const a = tasks.create('work', { title: 'First' });
  await calendar.run({ api, at: at(MON, '07:00') });
  assert.equal(api.rows.length, 1);
  // Google made the event but the Hub never heard back.
  db.crm().prepare('UPDATE plan_blocks SET google_event_id = NULL, pushed_start = NULL, pushed_end = NULL').run();
  api.calls.length = 0;
  await calendar.run({ api, at: at(MON, '07:05') });
  assert.deepEqual(api.calls, []);
  assert.equal(api.rows.length, 1);

  tasks.edit(a.id, { status: 'completed' });
  const d = await calendar.run({ api, at: at(MON, '07:10') });
  assert.equal(d.removed, 1);
  assert.equal(api.rows.length, 0);
  assert.deepEqual(calendar.blocksFor(a.id), []);
});

test('only an appointment Douglas made for himself alone can be flexible, and the Hub moves it in Google', async () => {
  const gym = api.add({ summary: 'Gym', start: iso(at(MON, '12:00')), end: iso(at(MON, '13:00')) });
  const shared = api.add({ summary: 'Lunch with Aoife', start: iso(at(MON, '14:00')), end: iso(at(MON, '15:00')), attendees: [{ self: true }, { email: 'aoife@example.com' }] });
  await calendar.run({ api, at: at(MON, '09:00') });
  assert.equal(calendar.setFlexible(shared.id, true), 0);
  assert.equal(calendar.setFlexible(gym.id, true), 1);
  api.add({ summary: 'Urgent meeting', start: iso(at(MON, '12:30')), end: iso(at(MON, '13:30')), organizer: { email: 'x@example.com' }, attendees: [{ self: true }, { email: 'x@example.com' }] });
  const d = await calendar.run({ api, at: at(MON, '09:05') });
  assert.equal(d.appointmentsMoved, 1);
  // 13:30 would run into lunch at 14:00, so the first hour that is really free is 15:00.
  assert.equal(clock(Date.parse(gym.start.dateTime) / 1000), '2026-11-09 15:00');
  assert.equal(clock(Date.parse(shared.start.dateTime) / 1000), '2026-11-09 14:00');
});

test('a Google failure is recorded and shown; Today hides the other space behind "Busy", the Calendar shows both', async () => {
  tasks.create('work', { title: 'Something' });
  api.add({ summary: 'Private appointment', start: iso(at(MON, '10:00')), end: iso(at(MON, '11:00')) });
  api.events.insert = async () => { throw Object.assign(new Error('Backend Error'), { code: 503 }); };
  await assert.rejects(calendar.run({ api, at: at(MON, '09:00') }), /Google Calendar: Backend Error/);
  assert.match(calendar.health('work').map(h => h.text).join('|'), /Calendar: Google Calendar: Backend Error/);
  assert.equal(db.crm().prepare("SELECT status FROM effects WHERE module = 'crm_calendar'").get().status, 'uncertain');
  const work = calendar.day('work', MON).items.map(i => `${i.type}:${i.title}`);
  assert.deepEqual(work, ['task:Something', 'busy:Busy (Personal)']);
  assert.deepEqual(calendar.day('personal', MON).items.map(i => `${i.type}:${i.title}`), ['event:Private appointment']);
  // The Calendar screen shows both spaces in full, each item carrying its own space.
  const both = s => calendar.week(s, MON, 1)[0].items.map(i => `${i.space}:${i.type}:${i.title}:${i.other}`);
  assert.deepEqual(both('work'), ['work:task:Something:false', 'personal:event:Private appointment:true']);
  assert.deepEqual(both('personal'), ['work:task:Something:true', 'personal:event:Private appointment:false']);
});

test('the model sizes new tasks in one batch; a length Douglas set is never overwritten', () => {
  const a = tasks.create('work', { title: 'Reply to Alec about the figures' });
  const b = tasks.create('work', { title: 'Draft the Q4 audit report' });
  const mine = tasks.create('work', { title: 'Mine' });
  tasks.setMinutes(mine.id, 45);
  const queued = [];
  const jobs = { enqueue: j => { queued.push(j); return { jobId: 'j1' }; }, getJob: () => ({ status: 'completed', result: { output: JSON.stringify({ tasks: [
    { id: a.id, minutes: 15 }, { id: b.id, minutes: 100 }, { id: mine.id, minutes: 240 }, { id: 'made-up', minutes: 30 }] }) } }) };
  assert.equal(taskLength.enqueueNext(jobs), true);
  assert.equal(taskLength.enqueueNext(jobs), false);
  assert.match(queued[0].payload.userPrompt, /Reply to Alec/);
  assert.doesNotMatch(queued[0].payload.userPrompt, /Mine/);
  assert.deepEqual(taskLength.collect(jobs, JSON.parse), { saved: 1 });
  assert.deepEqual([a, b, mine].map(t => { const r = tasks.get(t.id); return [r.minutes, r.minutes_by]; }), [[15, 'guess'], [null, ''], [45, 'you']]);
  // 100 isn't a length on offer, so that task is asked again; after two bad replies it rests on the default and says so.
  taskLength.enqueueNext(jobs);
  taskLength.collect({ ...jobs, getJob: () => ({ status: 'completed', result: { output: 'not json' } }) }, JSON.parse);
  assert.equal(taskLength.nextBatch().length, 0);
  assert.equal(taskLength.failedCount('work'), 1);
  assert.deepEqual(calendar.blocksFor(a.id).map(x => (x.end_at - x.start_at) / 60), [15]);
});

test('the Calendar pop-out lists the people, the transcript recorded in that meeting, and tasks that came from it', () => {
  const sources = require('../lib/crm/sources'), atoms = require('../lib/crm/atoms'), identity = require('../lib/crm/identity');
  const person = (id, name) => db.crm().prepare("INSERT INTO people (id, space, name) VALUES (?, 'work', ?)").run(id, name);
  person('mary', 'Mary Byrne'); person('ken', 'Ken Doyle');
  identity.linkIdentifier('mary', 'email', 'mary@example.org');
  calendar.storeEvents({ id: 'primary', space: 'work' }, [
    { id: 'm1', status: 'confirmed', summary: 'Bluecat and Beacon - DHCP', htmlLink: 'https://calendar.google.com/event?eid=m1', start: iso(at(MON, '14:00')), end: iso(at(MON, '15:00')),
      attendees: [{ self: true, email: 'douglas@mclellan.scot' }, { email: 'mary@example.org', displayName: 'Mary' }, { email: 'stranger@example.com', displayName: 'Sam Stranger' }] },
    { id: 'm2', status: 'confirmed', summary: 'MS Governance', start: iso(at(MON, '14:30')), end: iso(at(MON, '15:30')) },
  ], at(MON, '08:00'));
  const transcript = (ext, hhmm, text) => sources.admitSource({ space: 'work', kind: 'meeting', origin: 'krisp', externalId: ext, title: `Mobile recording ${hhmm}`, occurredAt: at(MON, hhmm), text }).source;
  const ours = transcript('k1', '14:05', 'Ken Doyle will send the IPAM licence quote by Friday.');
  transcript('k2', '14:45', 'Governance board notes.');
  transcript('k3', '16:10', 'Unrelated call.');
  atoms.applyAtoms(ours.id, [{ statement: 'Ken Doyle will send the IPAM licence quote by Friday', kind: 'fact', quote: 'Ken Doyle will send the IPAM licence quote by Friday', people: ['Ken Doyle'], topics: [], confidence: 'high' }]);
  const t = tasks.create('work', { title: 'Chase Ken for the IPAM quote', context: { sourceId: ours.id } });
  tasks.create('work', { title: 'Unrelated task' });

  const items = calendar.week('work', MON, 1)[0].items.filter(i => i.type === 'event');
  const pop = id => items.find(i => i.id === id).detail;
  const d = pop('m1');
  assert.deepEqual(d.people.map(p => `${p.name}:${p.via}`), ['Ken Doyle:Mentioned', 'Mary Byrne:Invited']);
  assert.deepEqual(d.guests, [{ name: 'Sam Stranger', email: 'stranger@example.com' }]);
  assert.deepEqual(d.transcripts.map(s => s.id), [ours.id], 'the 14:45 recording is closer to the 14:30 meeting');
  assert.deepEqual(d.tasks.map(x => x.id), [t.id]);
  assert.deepEqual(pop('m2').transcripts.map(s => s.title), ['Mobile recording 14:45']);
  assert.deepEqual(pop('m2').tasks, []);
  assert.equal(calendar.day('work', MON).items.find(i => i.id === 'm1').detail, null, 'Today does not need the pop-out');
  // Two meetings starting at the same time: a recording between them belongs to neither.
  calendar.storeEvents({ id: 'primary', space: 'work' }, [
    { id: 'a', status: 'confirmed', summary: 'A', start: iso(at(MON, '17:00')), end: iso(at(MON, '18:00')) },
    { id: 'b', status: 'confirmed', summary: 'B', start: iso(at(MON, '17:00')), end: iso(at(MON, '17:30')) },
  ], at(MON, '08:05'));
  transcript('k4', '17:05', 'Who was this for?');
  const later = calendar.week('work', MON, 1)[0].items.filter(i => i.type === 'event');
  assert.deepEqual(later.map(i => `${i.title}:${i.detail.transcripts.length}`).sort(), ['A:0', 'B:0']);
});

test('past-month meetings retain source-backed outcomes and completed tasks without historical task blocks', async () => {
  const sources = require('../lib/crm/sources'), atoms = require('../lib/crm/atoms');
  const date = '2026-10-20';
  const old = api.add({ summary: 'Historical review', start: iso(at(date, '10:00')), end: iso(at(date, '11:00')) });
  api.add({ summary: 'Outside import window', start: iso(at('2026-09-01', '10:00')), end: iso(at('2026-09-01', '11:00')) });
  await calendar.run({ api, at: at(MON, '09:00') });
  const e = db.crm().prepare('SELECT * FROM calendar_events WHERE id=?').get(old.id);
  assert.ok(e);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM calendar_events').get().n, 1);
  const s = sources.admitSource({ space: e.space, kind: 'meeting', origin: 'test', externalId: 'historical', title: 'Review transcript', occurredAt: at(date, '10:05'), text: 'The board approved the budget.' }).source;
  atoms.applyAtoms(s.id, [{ statement: 'The board approved the budget.', kind: 'decision', quote: 'The board approved the budget.', people: [], topics: [], confidence: 'high' }]);
  const task = tasks.create(e.space, { title: 'Send budget', context: { sourceId: s.id } });
  tasks.edit(task.id, { status: 'completed' });
  const detail = calendar.week('work', date, 1)[0].items[0].detail;
  assert.equal(detail.transcripts[0].id, s.id);
  assert.equal(detail.happened[0].source_id, s.id);
  assert.equal(detail.tasks[0].status, 'completed');
  api.rows.splice(api.rows.indexOf(old), 1);
  await calendar.run({ api, at: at(MON, '09:05') });
  assert.ok(db.crm().prepare('SELECT id FROM calendar_events WHERE id=?').get(old.id));
  assert.deepEqual(calendar.blocksFor(task.id), []);
  assert.deepEqual(api.calls, []);
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM sources WHERE kind='calendar' AND is_history=0").get().n, 0);
});

test('historical calendar renders click targets, source links and valid pop-out JavaScript', () => {
  const ejs = require('ejs'), vm = require('node:vm');
  calendar.storeEvents({ id: 'primary', space: 'work' }, [{ id: 'history', summary: '<Review>', start: iso(at('2026-10-20', '10:00')), end: iso(at('2026-10-20', '11:00')) }], at(MON, '09:00'));
  const template = fs.readFileSync(path.join(__dirname, '../views/crm/calendar.ejs'), 'utf8').replace(/<%- include\('_top'\) %>|<%- include\('_bottom'\) %>/g, '');
  const html = ejs.render(template, { space: 'work', today: MON, from: '2026-10-20', earlier: '2026-10-13', later: '2026-10-27', days: calendar.week('work', '2026-10-20'), state: calendar.state('work'), hours: calendar.hours(), ago: () => 'just now', fmt: ts => String(ts) });
  assert.match(html, /Earlier/);
  assert.match(html, /What happened/);
  assert.match(html, /data-pop="cal-pop-0"/);
  assert.match(html, /&lt;Review&gt;/);
  assert.doesNotMatch(html, /data-pop="cal-pop--1"/);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('cancelled ongoing events release future time while ended meetings remain', () => {
  const cal = { id: 'primary', space: 'work' };
  calendar.storeEvents(cal, [
    { id: 'ongoing', summary: 'Ongoing', start: iso(at(MON, '08:00')), end: iso(at(MON, '17:00')) },
    { id: 'day', summary: 'Offsite', start: { date: MON }, end: { date: '2026-11-10' }, attendees: [{ email: 'guest@example.com' }] },
    { id: 'ended', summary: 'Finished', start: iso(at(MON, '07:00')), end: iso(at(MON, '08:00')) }
  ], at(MON, '07:30'));
  const banner = calendar.week('work', MON, 1)[0].banners[0];
  assert.equal(banner.detail.guests[0].email, 'guest@example.com');
  calendar.storeEvents(cal, [], at(MON, '10:00'));
  assert.deepEqual(db.crm().prepare('SELECT id FROM calendar_events').all().map(e => e.id), ['ended']);
});
