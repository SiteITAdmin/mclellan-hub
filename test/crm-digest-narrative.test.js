'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-digest-narrative-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';

const db = require('../lib/crm/db');
const identity = require('../lib/crm/identity');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const planner = require('../lib/crm/planner');
const narrative = require('../lib/crm/digest-narrative');
const brief = require('../lib/crm/current-brief');

const DAY = 86400;
const at = (date, h, m = 0) => planner.epoch(date, h * 60 + m);
const THU = '2026-11-19', FRI = '2026-11-20', SAT = '2026-11-21', MON = '2026-11-23';

let seq = 0;

function fakeJobs() {
  const map = new Map(), list = [];
  return {
    list,
    enqueue(spec) { const id = `job-${++seq}`; const job = { id, status: 'pending', ...spec, result: null }; map.set(id, job); list.push(job); return { jobId: id }; },
    getJob(id) { return map.get(id) || null; },
    complete(id, output, meta = { runner: 'claude', model: 'opus' }) { Object.assign(map.get(id), { status: 'completed', result: { output: typeof output === 'string' ? output : JSON.stringify(output), meta } }); },
    fail(id, error) { Object.assign(map.get(id), { status: 'failed', error }); },
    last() { return list[list.length - 1] || null; },
  };
}

function fakeMailer() {
  const sent = [];
  return { sent, mail: { user: 'douglas@mclellan.scot', mailer: { sendMail: async m => { sent.push(m); return { messageId: `msg-${sent.length}` }; } } } };
}

function seedActivity(space, t) {
  const d = db.crm();
  const work = space === 'work';
  d.prepare('INSERT OR IGNORE INTO projects (id, space, name, name_norm, about) VALUES (?, ?, ?, ?, ?)')
    .run(`proj-${space}`, space, work ? 'M365 Rollout' : 'House Hunt', work ? 'm365 rollout' : 'house hunt', work ? 'Rollout of M365' : 'Finding a house');
  const email = work ? 'ken@beaconhospital.ie' : 'agent@daft.ie';
  if (!identity.personForAddress('email', email)) {
    const personId = `per-${space}`;
    d.prepare('INSERT INTO people (id, space, name) VALUES (?, ?, ?)').run(personId, space, work ? 'Ken Murray' : 'Alex Agent');
    identity.linkIdentifier(personId, 'email', email);
  }
  const src = sources.admitSource({
    space, kind: 'email', origin: work ? 'outlook' : 'gmail', externalId: `ext-${++seq}`, title: work ? 'Re: M365 Governance' : 'Viewing Saturday',
    occurredAt: t - 12 * 3600, direction: 'out',
    text: work ? 'F3 licences cannot do 24-hour Teams chat deletion; minimum is 30 days.' : 'Confirmed viewing at 11am Saturday.',
    participants: [
      { role: 'from', email: work ? 'douglas.mclellan@beaconhospital.ie' : 'douglas@mclellan.scot', name: 'Douglas McLellan' },
      { role: 'to', email, name: work ? 'Ken Murray' : 'Alex Agent' },
    ],
  }).source;
  d.prepare("UPDATE sources SET atomise_status = 'done' WHERE id = ?").run(src.id);
  atoms.applyAtoms(src.id, [{
    statement: work ? 'F3 licences cannot delete Teams chat after 24 hours; the minimum is 30 days.' : 'House viewing confirmed for 11am on Saturday.',
    kind: 'decision', quote: work ? 'F3 licences cannot do 24-hour Teams chat deletion' : 'Confirmed viewing at 11am Saturday',
    people: [], projects: [work ? 'M365 Rollout' : 'House Hunt'], topics: [work ? 'm365 governance' : 'house viewing'], confidence: 'high',
  }]);
  // The fact was learned before this morning.
  d.prepare('UPDATE atoms SET created_at = ? WHERE space = ?').run(t - 6 * 3600, space);
  d.prepare("INSERT INTO tasks (id, space, title, origin, status, due, completed_at, created_at) VALUES (?, ?, ?, 'manual', 'completed', NULL, ?, ?)")
    .run(`done-${space}-${++seq}`, space, work ? 'Close legal tickets 137462 and 137654' : 'Send payslips to broker', t - 3600, t - DAY);
  d.prepare("INSERT INTO tasks (id, space, title, origin, status, due, created_at) VALUES (?, ?, ?, 'manual', 'needsAction', ?, ?)")
    .run(`open-${space}`, space, work ? 'Check remaining internal Aptvision addresses' : 'Confirm viewing directions', planner.local(t).date, t - 2 * DAY);
  d.prepare(`INSERT INTO calendar_events (id, calendar_id, space, title, start_at, end_at, all_day, busy, solo, link, seen_at)
    VALUES (?, 'cal-1', ?, ?, ?, ?, 0, 1, 0, '', ?)`).run(`ev-${space}-${++seq}`, space, work ? 'Team Call' : 'Mortgage Call', t + 3 * 3600, t + 4 * 3600, t);
}

function news(day, items, themes = [{ norm: 'teams retention', name: 'Microsoft Teams retention', why: 'Your 24-hour Teams chat retention question for the governance meeting.', weight: 3, searched: true }]) {
  db.crm().prepare("INSERT INTO briefings (id, day, trigger, status, themes, items, created_at, finished_at) VALUES (?, ?, 'auto', 'done', ?, ?, ?, ?)")
    .run(`b-${day}`, day, JSON.stringify(themes), JSON.stringify(items), at(day, 6), at(day, 6, 30));
}
const newsItem = o => ({ theme: 'teams retention', headline: 'Copilot leaves legacy Teams retention policies', summary: 'From January Copilot interactions get their own retention location.',
  action: 'Review retention policies.', published: '2026-11-12', source: 'Microsoft 365 Message Center', url: 'https://learn.microsoft.com/mc1481313', quote: 'Copilot interactions move.',
  kind: 'change', confidence: 'high', ...o });

const workPart = (o = {}) => ({
  subject_hook: 'F3 Teams limit flagged before governance',
  needs_you: [{ what: 'Check the Aptvision addresses', recommendation: 'Do it before the Team Call so the list is current.', deadline: THU, deadline_confirmed: true, evidence: 'T1' }],
  last_two_days: ['You flagged the **F3** 30-day minimum to Ken.'],
  coming_up: ['**Team Call** this morning.'],
  m365: [{ item: 'N1', text: 'Copilot interactions leave legacy Teams retention in January, which bears on your 24-hour retention question.' }],
  week_in_view: '',
  ...o,
});
const personalPart = (o = {}) => ({
  subject_hook: 'Saturday viewing confirmed',
  needs_you: [{ what: 'Confirm viewing directions', recommendation: 'Text Alex today.', deadline: THU, deadline_confirmed: true, evidence: 'T1' }],
  last_two_days: ['Viewing confirmed with **Alex Agent**.'],
  coming_up: ['**Mortgage Call** later today.'],
  m365: [], week_in_view: '',
  ...o,
});

beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); seq = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('windows: new means since the last email sent for that space, so Monday Work reaches back to Friday morning', () => {
  // No email yet: two days back, Monday Work from Friday.
  assert.equal(narrative.windows('personal', at(THU, 7, 30)).backFrom, '2026-11-17');
  assert.equal(narrative.windows('work', at(MON, 7, 30)).backFrom, FRI);
  // Work last went out on Friday at 07:31; the weekend emails were Personal only.
  db.crm().prepare("INSERT INTO digest_drafts (id, space, day, kind, trigger, status, created_at, sent_at) VALUES ('w', 'work', ?, 'daily', 'auto', 'done', ?, ?)").run(FRI, at(FRI, 7), at(FRI, 7, 31));
  const mon = narrative.windows('work', at(MON, 7, 30));
  assert.equal(mon.backStart, at(FRI, 7, 31));
  assert.equal(mon.lastSentAt, at(FRI, 7, 31));
  // Friday Work looks ahead through Monday.
  assert.equal(narrative.windows('work', at(FRI, 7, 30)).forwardUntil, MON);
  assert.equal(narrative.windows('personal', at(FRI, 7, 30)).forwardUntil, '2026-11-22');
});

test('packet: one space only, things already told are marked, evidence is keyed, and only Work sees Microsoft 365 items', () => {
  const t = at(THU, 7, 30);
  seedActivity('work', t);
  seedActivity('personal', t);
  news(THU, [newsItem()]);
  db.crm().prepare("INSERT INTO digest_drafts (id, space, day, kind, trigger, status, created_at, sent_at, body_json) VALUES ('w0', 'work', '2026-11-18', 'daily', 'auto', 'done', ?, ?, ?)")
    .run(t - DAY, t - DAY, JSON.stringify({ last_two_days: ['Yesterday you met Ken.'], coming_up: [], needs_you: [], m365: [] }));

  const w = narrative.packet('work', t), p = narrative.packet('personal', t);
  const wj = JSON.stringify(w.payload), pj = JSON.stringify(p.payload);
  assert.ok(wj.includes('F3 licences cannot delete Teams chat'));
  assert.ok(!wj.includes('House viewing') && !wj.includes('Mortgage Call'));
  assert.ok(pj.includes('House viewing confirmed') && !pj.includes('M365 Rollout'));
  assert.equal(w.payload.last_email.text, 'Yesterday you met Ken.');
  assert.equal(w.payload.recent_facts[0].told, undefined, 'learned after the last email, so new');
  assert.equal(w.payload.open_tasks[0].key, 'T1');
  assert.equal(w.refs.T1.path, '/crm/work/tasks/open-work');
  assert.equal(w.refs.T1.due, THU);
  assert.equal(w.payload.m365_candidates[0].key, 'N1');
  assert.match(w.payload.m365_candidates[0].why_it_matters_to_him, /24-hour Teams chat retention/);
  assert.ok(!wj.includes('https://learn.microsoft.com/mc1481313'), 'the model never sees a link to copy');
  assert.equal(p.payload.m365_candidates, undefined);
  assert.equal(w.quiet, false);

  // A fact learned before the last email is marked as told.
  db.crm().prepare('UPDATE digest_drafts SET sent_at = ? WHERE id = ?').run(t - 60, 'w0');
  assert.equal(narrative.packet('work', t).payload.recent_facts[0].told, true);
});

test('where he is crosses over: his own away entries and flights reach the other part, nothing else does', () => {
  const t = at(THU, 7, 30);
  seedActivity('work', t);
  const add = (id, space, title, from, toExclusive) => db.crm().prepare(`INSERT INTO calendar_events (id, calendar_id, space, title, start_at, end_at, all_day, busy, solo, link, seen_at)
    VALUES (?, 'primary', ?, ?, ?, ?, 1, 0, 0, '', ?)`).run(id, space, title, planner.epoch(from), planner.epoch(toExclusive), t);
  add('away', 'personal', 'Douglas In Scotland', FRI, '2026-11-23');
  add('kai', 'personal', 'Kai Barcelona', FRI, '2026-11-22');
  add('bday', 'personal', "Mum's birthday", FRI, SAT);
  require('../lib/db').hub().prepare(`INSERT INTO flights (id, user, flight_number, airline, direction, flight_date, scheduled_dep, scheduled_arr, status)
    VALUES ('f1', 'douglas', 'FR812', 'Ryanair', 'DUB-EDI', ?, '07:05', '08:10', 'scheduled'), ('f2', 'someone', 'FR1', 'Ryanair', 'DUB-STN', ?, '09:00', '10:00', 'scheduled')`).run(FRI, FRI);

  const where = narrative.packet('work', t).payload.whereabouts;
  assert.deepEqual(where.away, [{ away: 'Douglas In Scotland', from: 'Fri 20 Nov', to: 'Sun 22 Nov' }], 'last day, not the exclusive end');
  assert.deepEqual(where.flights, [{ day: 'Fri 20 Nov', route: 'DUB-EDI', flight: 'FR812', departs: '07:05', arrives: '08:10' }]);
  const wj = JSON.stringify(narrative.packet('work', t).payload);
  assert.ok(!wj.includes('Kai Barcelona') && !wj.includes('birthday'), 'other people and other personal entries stay in Personal');
  // Personal already has its own calendar, so it gets only the flights.
  seedActivity('personal', t);
  const p = narrative.packet('personal', t).payload;
  assert.equal(p.whereabouts.away, undefined);
  assert.equal(p.whereabouts.flights.length, 1);
  assert.match(p.upcoming_calendar.find(e => e.title === 'Douglas In Scotland').end, /last day Sun 22 Nov/);
  assert.match(narrative.SYSTEM_PROMPT, /whereabouts/);
});

test('current brief: priorities and decisions pass through; a deferral hides until its date and then lapses', () => {
  const t = at(THU, 7, 30);
  assert.equal(brief.forDraft('personal', t), null, 'optional: nothing when empty');
  assert.throws(() => brief.save('personal', { defer_what: ['Conveyancing replies'], defer_until: [''] }, t), /Give a date/);
  brief.save('personal', { priorities: 'Dad first', mine: 'Christmas plans', defer_what: ['Conveyancing replies', 'Old thing', ''], defer_until: ['2026-12-01', '2026-11-10', ''] }, t);
  const b = brief.forDraft('personal', t);
  assert.equal(b.priorities, 'Dad first');
  assert.deepEqual(b.deferred, [{ what: 'Conveyancing replies', until: '2026-12-01' }], 'a deferral already past is dropped on save');
  assert.equal(brief.forDraft('personal', at('2026-12-01', 7)).deferred, undefined, 'it lapses on its date');
  assert.equal(brief.forDraft('work', t), null, 'each space keeps its own');
  seedActivity('personal', t);
  assert.equal(narrative.packet('personal', t).payload.current_brief.priorities, 'Dad first');
});

test('drifting people (once a WhatsApp nudge) are named only when newly drifting, or on Friday', () => {
  const t = at(THU, 7, 30);
  seedActivity('personal', t);
  db.crm().prepare("INSERT INTO people (id, space, name, cadence_days, created_at) VALUES ('d1', 'personal', 'Old Friend', 14, ?)").run(t - 60 * DAY);
  assert.deepEqual(narrative.packet('personal', t).payload.drifting_contacts.map(d => d.name), ['Old Friend']);
  db.crm().prepare("INSERT INTO digest_drafts (id, space, day, kind, trigger, status, created_at, sent_at, body_json) VALUES ('p0', 'personal', '2026-11-18', 'daily', 'auto', 'done', ?, ?, ?)")
    .run(t - DAY, t - DAY, JSON.stringify({ drift: ['Old Friend'] }));
  assert.equal(narrative.packet('personal', t).payload.drifting_contacts, undefined, 'already named in the last email');
  assert.deepEqual(narrative.packet('personal', at(FRI, 7, 30)).payload.drifting_contacts.map(d => d.name), ['Old Friend']);
});

test('validate: evidence must be real, a deadline is confirmed only when the data says so, and an over-long part is sent back', () => {
  const refs = { T1: { path: '/crm/work/tasks/a', label: 'Task A', due: THU }, N1: { news: { url: 'https://learn.microsoft.com/x', url_key: 'learn.microsoft.com/x', source: 'MS', kind: 'change' } } };
  const body = narrative.validate({
    subject_hook: 'Hook here',
    needs_you: [
      { what: 'Real one', recommendation: 'Do it.', deadline: THU, deadline_confirmed: true, evidence: 'T1' },
      { what: 'Claims confirmed', recommendation: 'Hmm.', deadline: '2026-11-25', deadline_confirmed: true, evidence: 'T1' },
      { what: 'No evidence', recommendation: 'x', deadline: '', evidence: 'T9' },
    ],
    last_two_days: ['A day.'], coming_up: ['Next.'],
    m365: [{ item: 'N1', text: 'Tied to your work.' }, { item: 'N7', text: 'Invented.' }],
  }, refs, 'work');
  assert.deepEqual(body.needs_you.map(n => [n.what, n.confirmed]), [['Real one', true], ['Claims confirmed', false]]);
  assert.equal(body.needs_you[0].evidence.path, '/crm/work/tasks/a');
  assert.deepEqual(body.m365.map(m => m.url), ['https://learn.microsoft.com/x']);
  assert.throws(() => narrative.validate({ subject_hook: 'x', needs_you: [], last_two_days: [], coming_up: [] }, refs, 'work'), /empty/);
  const long = Array(260).fill('word').join(' ');
  assert.throws(() => narrative.validate({ subject_hook: 'x', last_two_days: [long], coming_up: [] }, refs, 'personal'), /over its 140/);
});

test('compose: one email, Needs you ranked across both spaces, Microsoft 365 linked, whole units dropped over the cap', () => {
  const t = at(THU, 7, 30);
  const need = (space, what, deadline, confirmed) => ({ space, what, recommendation: 'Do it.', deadline, confirmed, evidence: { path: `/crm/${space}/tasks/x` } });
  const work = { subject_hook: 'Work hook', needs_you: [need('work', 'Suggested work thing', THU, false), need('work', 'No date work thing', '', false)],
    last_two_days: ['Work story with <b>tags</b>.'], coming_up: ['Work ahead.'],
    m365: [1, 2, 3].map(i => ({ text: `M365 item ${i}`, url: `https://learn.microsoft.com/${i}`, url_key: `k${i}`, source: 'MS', published: '2026-11-12' })), week_in_view: '' };
  const personal = { subject_hook: 'Personal hook', needs_you: [need('personal', 'Confirmed personal thing', '2026-11-20', true)], last_two_days: ['Personal story.'], coming_up: ['Personal ahead.'] };
  const out = narrative.compose({ work, personal }, t, { house: ['1 item waiting'] });
  assert.equal(out.subject, 'Thu 19 Nov — Confirmed personal thing', 'a confirmed deadline within 48 hours leads, whichever space');
  assert.ok(out.text.indexOf('Personal: **') < 0 && out.text.indexOf('Personal: Confirmed personal thing') < out.text.indexOf('Work: Suggested work thing'));
  assert.match(out.text, /Due Fri 20 Nov/);
  assert.match(out.text, /Suggested by Thu 19 Nov/);
  assert.ok(out.text.indexOf('Work: the last two days') < out.text.indexOf('Microsoft 365 for your work'));
  assert.ok(out.text.indexOf('Microsoft 365 for your work') < out.text.indexOf('\nPersonal\n'));
  assert.match(out.text, /MS, Thu 12 Nov: https:\/\/learn\.microsoft\.com\/1/);
  assert.match(out.text, /Work Today: .*\/crm\/work · Personal Today: .*\/crm\/personal/);
  assert.match(out.text, /Worth a look in the Hub: 1 item waiting/);
  assert.ok(out.html.includes('&lt;b&gt;tags&lt;/b&gt;'));
  assert.equal(out.m365.length, 3);
  assert.ok(!/What's biting/.test(out.text));

  const padded = { ...work, last_two_days: [Array(590).fill('w').join(' ')] };
  const trimmed = narrative.compose({ work: padded, personal }, t);
  assert.equal(trimmed.m365.length, 2, 'the third M365 item goes first');
  assert.ok(!trimmed.text.includes('Personal ahead.'), 'then the Personal look-ahead');
  assert.ok(trimmed.text.includes('Personal story.'));
});

test('a weekday morning: Personal drafts first, Work waits for the news search, one email goes at 07:30 and M365 items count as delivered', async () => {
  const t0 = at(THU, 7, 30);
  seedActivity('work', t0);
  seedActivity('personal', t0);
  db.crm().prepare("INSERT INTO briefings (id, day, trigger, status, created_at) VALUES ('b-run', ?, 'auto', 'search', ?)").run(THU, at(THU, 6));
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();

  assert.deepEqual((await narrative.tick({ jobs, t: at(THU, 6, 30), mail })).started, [], 'nothing before 06:45');
  assert.deepEqual((await narrative.tick({ jobs, t: at(THU, 6, 46), mail })).started, ['personal']);
  assert.match(jobs.last().payload.systemPrompt, /ONE PART of Douglas McLellan's morning email/);
  jobs.complete(jobs.last().id, personalPart());
  const r2 = await narrative.tick({ jobs, t: at(THU, 6, 50), mail });
  assert.equal(r2.collected.done, true);
  assert.deepEqual(r2.started, [], 'Work waits while the news search is still running');

  // The briefing finishes with one item; Work starts and sees it.
  db.crm().prepare('DELETE FROM briefings').run();
  news(THU, [newsItem()]);
  assert.deepEqual((await narrative.tick({ jobs, t: at(THU, 7, 0), mail })).started, ['work']);
  assert.equal(JSON.parse(jobs.last().payload.userPrompt).m365_candidates.length, 1);
  jobs.complete(jobs.last().id, workPart());
  await narrative.tick({ jobs, t: at(THU, 7, 10), mail });
  assert.equal(sent.length, 0, 'not before 07:30');

  const r = await narrative.tick({ jobs, t: t0, mail });
  assert.equal(r.sent.kind, 'email');
  assert.equal(sent.length, 1, 'one email for both spaces');
  const m = sent[0];
  assert.match(m.subject, /^Thu 19 Nov — Check the Aptvision addresses/);
  assert.match(m.text, /Needs you\n- Work: Check the Aptvision addresses.*Due Thu 19 Nov\. Evidence: .*\/crm\/work\/tasks\/open-work/);
  assert.match(m.text, /- Personal: Confirm viewing directions/);
  assert.match(m.text, /Microsoft 365 for your work\n- Copilot interactions leave legacy Teams retention/);
  assert.match(m.text, /https:\/\/learn\.microsoft\.com\/mc1481313/);
  assert.match(m.text, /\nPersonal\nViewing confirmed with Alex Agent\./);
  assert.ok(narrative.get('work', THU).sent_at && narrative.get('personal', THU).sent_at);
  assert.deepEqual(require('../lib/crm/briefing').forEmail(t0 + 60), [], 'a sent M365 item is not offered again');

  assert.equal((await narrative.tick({ jobs, t: t0 + 120, mail })).sent, null);
  assert.equal(sent.length, 1, 'never twice');
});

test('Work starts at 07:15 without the news search; one part failing still sends the other with a one-line note', async () => {
  const t0 = at(THU, 7, 30);
  seedActivity('work', t0);
  seedActivity('personal', t0);
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();
  await narrative.tick({ jobs, t: at(THU, 6, 46), mail });
  for (let i = 0; i < 3; i++) { jobs.fail(jobs.last().id, 'Claude CLI busy'); await narrative.tick({ jobs, t: at(THU, 6, 50 + i), mail }); }
  assert.equal(narrative.get('personal', THU).status, 'failed');
  assert.deepEqual((await narrative.tick({ jobs, t: at(THU, 7, 0), mail })).started, [], 'no briefing yet, so Work waits');
  assert.deepEqual((await narrative.tick({ jobs, t: at(THU, 7, 16), mail })).started, ['work']);
  jobs.complete(jobs.last().id, workPart({ m365: [] }));
  await narrative.tick({ jobs, t: at(THU, 7, 20), mail });
  await narrative.tick({ jobs, t: t0, mail });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^The Personal part couldn't be written this morning \(Claude CLI busy/);
  assert.match(sent[0].text, /Work: the last two days/);
  assert.match(narrative.health('personal', t0).map(h => h.text).join(' '), /Personal part of the morning email.*couldn't be written/);
});

test('at 09:30 a part still writing is given up and the ready part goes; with nothing ready, a three-line note', async () => {
  const t0 = at(THU, 7, 30);
  seedActivity('work', t0);
  seedActivity('personal', t0);
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();
  await narrative.tick({ jobs, t: at(THU, 6, 46), mail });
  jobs.complete(jobs.last().id, personalPart());
  await narrative.tick({ jobs, t: at(THU, 7, 16), mail });
  assert.equal(narrative.get('work', THU).status, 'writing');
  await narrative.tick({ jobs, t: at(THU, 7, 40), mail });
  assert.equal(sent.length, 0, 'waits for Work while there is time');
  // The Mac is slow but still inside its 20 minutes at 09:30.
  db.crm().prepare("UPDATE digest_drafts SET queued_at = ? WHERE space = 'work'").run(at(THU, 9, 20));
  await narrative.tick({ jobs, t: at(THU, 9, 30), mail });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /The Work part couldn't be written this morning \(Not ready by 09:30\)/);
  assert.equal(narrative.get('work', THU).status, 'failed');

  // Another morning where nothing is ready at all.
  db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  seedActivity('personal', at(SAT, 7, 30));
  const j2 = fakeJobs(), m2 = fakeMailer();
  await narrative.tick({ jobs: j2, t: at(SAT, 6, 46), mail: m2.mail });
  for (let i = 0; i < 3; i++) { j2.fail(j2.last().id, 'Mac offline'); await narrative.tick({ jobs: j2, t: at(SAT, 6, 50 + i), mail: m2.mail }); }
  await narrative.tick({ jobs: j2, t: at(SAT, 7, 30), mail: m2.mail });
  assert.equal(m2.sent.length, 1);
  assert.match(m2.sent[0].subject, /^Sat 21 Nov — morning email couldn't be written \(Personal\)/);
  assert.equal(m2.sent[0].text.split('\n').length, 3);
});

test('a quiet morning sends nothing unless something is broken; weekends are Personal only', async () => {
  // In a fresh database the iMessage reader has never checked in, which counts as broken.
  const broken = fakeMailer();
  await narrative.tick({ jobs: fakeJobs(), t: at('2026-11-18', 6, 46), mail: broken.mail });
  await narrative.tick({ jobs: fakeJobs(), t: at('2026-11-18', 7, 30), mail: broken.mail });
  assert.equal(broken.sent.length, 1);
  assert.match(broken.sent[0].subject, /something in the Hub needs a look/);
  assert.match(broken.sent[0].text, /iMessage reader has not checked in/);

  db.crm().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('imessage_paused', '1')").run();
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();
  await narrative.tick({ jobs, t: at(THU, 6, 46), mail });
  await narrative.tick({ jobs, t: at(THU, 6, 48), mail });
  assert.equal(jobs.list.length, 0, 'nothing to write, so no model job');
  assert.equal(narrative.get('personal', THU).error, narrative.QUIET);
  const r = await narrative.tick({ jobs, t: at(THU, 7, 30), mail });
  assert.equal(r.sent.silent, true);
  assert.equal(sent.length, 0);
  assert.equal(narrative.outcome().status, 'silent');
  assert.deepEqual(narrative.health('work', at(THU, 11)).map(h => h.text), [], 'silence is not a failure');

  seedActivity('personal', at(SAT, 7, 30));
  seedActivity('work', at(SAT, 7, 30));
  const s = await narrative.tick({ jobs, t: at(SAT, 6, 46), mail });
  assert.deepEqual(s.started, ['personal']);
  jobs.complete(jobs.last().id, personalPart());
  await narrative.tick({ jobs, t: at(SAT, 7, 0), mail });
  assert.equal(narrative.get('work', SAT), null, 'no Work part at the weekend');
  await narrative.tick({ jobs, t: at(SAT, 7, 30), mail });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes('Work Today'));
});
