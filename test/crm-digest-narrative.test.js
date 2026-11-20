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
const digest = require('../lib/crm/digest');
const narrative = require('../lib/crm/digest-narrative');

const DAY = 86400;
const THU = planner.epoch('2026-11-19', 7 * 60 + 30); // Thursday
const FRI = planner.epoch('2026-11-20', 7 * 60 + 30); // Friday
const SAT = planner.epoch('2026-11-21', 7 * 60 + 30); // Saturday
const MON = planner.epoch('2026-11-23', 7 * 60 + 30); // Monday

let seq = 0;

function fakeJobs() {
  const map = new Map(), list = [];
  return {
    list,
    enqueue(spec) {
      const id = `job-${++seq}`;
      const job = { id, status: 'pending', ...spec, result: null, error: null };
      map.set(id, job);
      list.push(job);
      return { jobId: id };
    },
    getJob(id) { return map.get(id) || null; },
    complete(id, output, meta = { runner: 'claude', model: 'opus' }) {
      const j = map.get(id);
      j.status = 'completed';
      j.result = { output, meta };
    },
    fail(id, error) {
      const j = map.get(id);
      j.status = 'failed';
      j.error = error;
    },
    last() { return list[list.length - 1] || null; },
  };
}

function fakeMailer() {
  const sent = [];
  return {
    sent,
    mail: {
      user: 'douglas@mclellan.scot',
      mailer: {
        sendMail: async m => { sent.push(m); return { messageId: `msg-${sent.length}` }; },
      },
    },
  };
}

function seedActivity(space, at = THU) {
  const d = db.crm();
  const pid = `proj-${space}-${++seq}`;
  d.prepare('INSERT OR IGNORE INTO projects (id, space, name, name_norm, about) VALUES (?, ?, ?, ?, ?)')
    .run(pid, space, space === 'work' ? 'M365 Rollout' : 'House Hunt', space === 'work' ? 'm365 rollout' : 'house hunt',
      space === 'work' ? 'Rollout of M365' : 'Finding a house');
  const email = space === 'work' ? 'ken@beaconhospital.ie' : 'agent@daft.ie';
  if (!identity.personForAddress('email', email)) {
    const personId = `per-${space}-${++seq}`;
    d.prepare('INSERT INTO people (id, space, name) VALUES (?, ?, ?)').run(personId, space, space === 'work' ? 'Ken Murray' : 'Alex Agent');
    identity.linkIdentifier(personId, 'email', email);
  }

  const src = sources.admitSource({
    space, kind: 'email', origin: space === 'work' ? 'outlook' : 'gmail',
    externalId: `ext-${++seq}`, title: space === 'work' ? 'Re: M365 Governance' : 'Viewing Saturday',
    occurredAt: at - 12 * 3600, direction: 'out',
    text: space === 'work' ? 'F3 licences cannot do 24-hour Teams chat deletion; minimum is 30 days.' : 'Confirmed viewing at 11am Saturday.',
    participants: [
      { role: 'from', email: space === 'work' ? 'douglas.mclellan@beaconhospital.ie' : 'douglas@mclellan.scot', name: 'Douglas McLellan' },
      { role: 'to', email, name: space === 'work' ? 'Ken Murray' : 'Alex Agent' },
    ],
  }).source;
  d.prepare("UPDATE sources SET atomise_status = 'done' WHERE id = ?").run(src.id);

  atoms.applyAtoms(src.id, [{
    statement: space === 'work'
      ? 'F3 licences cannot delete Teams chat after 24 hours; the minimum is 30 days.'
      : 'House viewing confirmed for 11am on Saturday.',
    kind: 'decision',
    quote: space === 'work' ? 'F3 licences cannot do 24-hour Teams chat deletion' : 'Confirmed viewing at 11am Saturday',
    people: [],
    projects: [space === 'work' ? 'M365 Rollout' : 'House Hunt'],
    topics: [space === 'work' ? 'm365 governance' : 'house viewing'],
    confidence: 'high',
  }]);

  // One completed task and one open task in this space.
  d.prepare(`INSERT INTO tasks (id, space, title, origin, status, due, completed_at, created_at) VALUES (?, ?, ?, 'manual', 'completed', ?, ?, ?)`)
    .run(`done-${space}-${++seq}`, space, space === 'work' ? 'Close legal tickets 137462 and 137654' : 'Send payslips to broker', null, at - 3600, at - DAY);
  d.prepare(`INSERT INTO tasks (id, space, title, origin, status, due, created_at) VALUES (?, ?, ?, 'manual', 'needsAction', ?, ?)`)
    .run(`open-${space}-${++seq}`, space, space === 'work' ? 'Check remaining internal Aptvision addresses' : 'Confirm viewing directions', planner.local(at).date, at - 2 * DAY);

  // One upcoming calendar event in this space.
  d.prepare(`INSERT INTO calendar_events (id, calendar_id, space, title, start_at, end_at, all_day, busy, solo, link, seen_at)
    VALUES (?, 'cal-1', ?, ?, ?, ?, 0, 1, 0, '', ?)`)
    .run(`ev-${space}-${++seq}`, space, space === 'work' ? 'Team Call' : 'Mortgage Call', at + 3 * 3600, at + 4 * 3600, at);
}

beforeEach(() => {
  db._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  seq = 0;
});

after(() => {
  db._reset();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('kindFor and windows pick daily (48h/48h) Mon-Thu and weekly on Fridays', () => {
  assert.equal(narrative.kindFor('work', THU), 'daily');
  assert.equal(narrative.kindFor('personal', THU), 'daily');
  assert.equal(narrative.kindFor('work', FRI), 'weekly');
  assert.equal(narrative.kindFor('personal', FRI), 'weekly');
  assert.equal(narrative.kindFor('personal', SAT), 'daily');
  assert.equal(narrative.kindFor('work', MON), 'daily');

  // Mon Work daily reaches back 3 days to Friday; Fri Work daily (if run manually) reaches 3 days forward to Monday.
  const monWin = narrative.windows('work', 'daily', MON);
  assert.equal(monWin.backFrom, '2026-11-20');
  assert.equal(monWin.forwardUntil, '2026-11-25');
  const friDaily = narrative.windows('work', 'daily', FRI);
  assert.equal(friDaily.backFrom, '2026-11-18');
  assert.equal(friDaily.forwardUntil, '2026-11-23');
  const friWeekly = narrative.windows('work', 'weekly', FRI);
  assert.equal(friWeekly.backFrom, '2026-11-15');
  assert.equal(friWeekly.forwardUntil, '2026-11-27');
});

test('packet isolates Work from Personal, includes completed tasks and Work news only for Work', () => {
  seedActivity('work', FRI);
  seedActivity('personal', FRI);

  // Add a Work public news item for today.
  db.crm().prepare(`INSERT INTO briefings (id, day, trigger, status, themes, items, created_at, finished_at)
    VALUES ('b1', '2026-11-20', 'auto', 'done', ?, ?, ?, ?)`)
    .run(
      JSON.stringify([{ norm: 'exchange outage', name: 'Exchange Online outage', weight: 3, searched: true, found: 1, refs: [] }]),
      JSON.stringify([{ theme: 'exchange outage', headline: 'EX1550543 service credit deadline Dec 2026', summary: 'Claim before end of December.', action: 'File claim.', source: 'O365 IT Pros', published: '2026-11-16', url: 'https://example.com/1', quote: 'Claim before December', kind: 'change', confidence: 'high' }]),
      FRI - 3600, FRI - 3000,
    );

  // Add an unclassified Personal-sounding recording in krisp_intake to confirm housekeeping never leaks its title into Work.
  db.crm().prepare(`INSERT INTO krisp_intake (id, raw_json, title, transcript, occurred_at, readable, status, space)
    VALUES ('rec-1', '{}', 'Private Mortgage Chat', 'Speaker: hi', ?, 1, 'pending', NULL)`).run(FRI - 12 * 3600);

  const workPkt = narrative.packet('work', 'weekly', FRI);
  const personalPkt = narrative.packet('personal', 'weekly', FRI);

  assert.equal(workPkt.empty, false);
  assert.equal(workPkt.hasNews, true);
  assert.equal(personalPkt.hasNews, false);

  const workJson = JSON.stringify(workPkt.payload);
  const personalJson = JSON.stringify(personalPkt.payload);
  assert.ok(workJson.includes('F3 licences cannot delete Teams chat'));
  assert.ok(workJson.includes('Close legal tickets 137462 and 137654'));
  assert.ok(workJson.includes('EX1550543 service credit deadline'));
  assert.ok(!workJson.includes('Mortgage Call'));
  assert.ok(!workJson.includes('House viewing'));

  assert.ok(personalJson.includes('House viewing confirmed'));
  assert.ok(personalJson.includes('Mortgage Call'));
  assert.ok(!personalJson.includes('M365 Rollout'));
  assert.ok(!personalJson.includes('EX1550543'));

  const hk = narrative.housekeeping('work', FRI).join(' | ');
  assert.match(hk, /1 meeting recording/);
  assert.ok(!hk.includes('Private Mortgage Chat'));
});

test('validate and render safely format bold spans, escape HTML, and reject invalid payloads', () => {
  assert.throws(() => narrative.validate({}), /no sections/);
  assert.throws(() => narrative.validate({ subject_hook: 'Hi', sections: [{ heading: 'Empty', paragraphs: [], bullets: [] }] }), /empty/);

  const valid = narrative.validate({
    subject_hook: 'Aptvision fix & <M365> update',
    sections: [
      { heading: 'Last 48 hours', paragraphs: ['**Ken Murray** booked <governance> review.'], bullets: [] },
      { heading: 'Next 48 hours', paragraphs: ['Light day ahead.'], bullets: ['Check **Duncan** quote'] },
    ],
  });
  const out = narrative.render('work', 'daily', valid, THU, { hasNews: true });
  assert.equal(out.subject, 'Work, Thu 19 Nov — Aptvision fix & <M365> update');
  assert.ok(out.html.includes('<strong>Ken Murray</strong> booked &lt;governance&gt; review.'));
  assert.ok(out.html.includes('Work news briefing'));
  assert.ok(out.text.includes('Ken Murray booked <governance> review.'));
  assert.ok(!out.text.includes('**Ken Murray**'));
});

test('tick drafts sequentially from 06:45, sends narratives at 07:30, and skips Work on weekends', async () => {
  seedActivity('work', THU);
  seedActivity('personal', THU);
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();

  // Before 06:45: nothing starts.
  const tooEarly = await narrative.tick({ jobs, t: planner.epoch('2026-11-19', 6 * 60 + 30), mail });
  assert.deepEqual(tooEarly.started, []);
  assert.equal(jobs.list.length, 0);

  // At 06:46: starts Work daily first (one in flight at a time).
  const t1 = planner.epoch('2026-11-19', 6 * 60 + 46);
  const r1 = await narrative.tick({ jobs, t: t1, mail });
  assert.deepEqual(r1.started, ['work:daily']);
  assert.equal(jobs.last().feature, 'crm_report');
  assert.equal(jobs.last().payload.model, 'opus');
  assert.match(jobs.last().payload.systemPrompt, /LAST 48 HOURS/);

  // Complete Work job -> next tick collects Work and starts Personal daily.
  jobs.complete(jobs.last().id, JSON.stringify({
    subject_hook: 'F3 Teams limit flagged and tickets closed',
    sections: [
      { heading: 'Last 48 hours', paragraphs: ['You flagged the **F3** 30-day minimum.'], bullets: [] },
      { heading: 'Next 48 hours', paragraphs: ['**Team Call** ahead.'], bullets: ['Check internal Aptvision addresses'] },
    ],
  }));
  const t2 = planner.epoch('2026-11-19', 6 * 60 + 50);
  const r2 = await narrative.tick({ jobs, t: t2, mail });
  assert.equal(r2.collected.done, true);
  assert.deepEqual(r2.started, ['personal:daily']);
  assert.equal(sent.length, 0); // Still before 07:30.

  // At 07:30 while Personal is still writing: Work sends its narrative; Personal waits.
  const r3 = await digest.run({ t: THU, mail });
  assert.equal(r3.work.narrative, true);
  assert.match(r3.work.sent, /^Work, Thu 19 Nov — F3 Teams limit flagged/);
  assert.deepEqual(r3.personal, { waiting: 'narrative' });
  assert.equal(sent.length, 1);

  // Personal finishes at 07:34 -> tick collects AND sends Personal narrative immediately.
  jobs.complete(jobs.last().id, JSON.stringify({
    subject_hook: 'Saturday viewing confirmed',
    sections: [
      { heading: 'Last 48 hours', paragraphs: ['Viewing confirmed with **Alex Agent**.'], bullets: [] },
      { heading: 'Next 48 hours', paragraphs: ['**Mortgage Call** today.'], bullets: ['Confirm directions'] },
    ],
  }));
  const r4 = await narrative.tick({ jobs, t: THU + 4 * 60, mail });
  assert.equal(r4.collected.done, true);
  assert.equal(r4.sent.personal.narrative, true);
  assert.match(r4.sent.personal.sent, /^Personal, Thu 19 Nov — Saturday viewing confirmed/);
  assert.equal(sent.length, 2);

  // Subsequent tick does not resend.
  const r5 = await narrative.tick({ jobs, t: THU + 6 * 60, mail });
  assert.deepEqual(r5.sent, {});
  assert.equal(sent.length, 2);

  // Saturday: skips Work completely, starts Personal daily only.
  seedActivity('personal', SAT);
  const satTick = await narrative.tick({ jobs, t: planner.epoch('2026-11-21', 6 * 60 + 50), mail });
  assert.deepEqual(satTick.started, ['personal:daily']);
});

test('Friday drafts weekly briefing, and repeated failure falls back cleanly with visible health warning', async () => {
  seedActivity('work', FRI);
  const jobs = fakeJobs();
  const { sent, mail } = fakeMailer();

  const tStart = planner.epoch('2026-11-20', 6 * 60 + 50);
  const r1 = await narrative.tick({ jobs, t: tStart, mail });
  assert.deepEqual(r1.started, ['work:weekly']);
  assert.match(jobs.last().payload.systemPrompt, /FRIDAY WEEKLY/);

  // Fail 3 times -> status becomes failed, health warns, and 07:30 tick sends short summary fallback with note.
  for (let i = 0; i < 3; i += 1) {
    jobs.fail(jobs.last().id, 'Claude CLI busy');
    await narrative.tick({ jobs, t: tStart + (i + 1) * 60, mail });
  }
  const row = narrative.get('work', '2026-11-20', 'weekly');
  assert.equal(row.status, 'failed');
  assert.ok(narrative.health('work', FRI).some(h => /weekly narrative briefing.*couldn't be written/i.test(h.text)));

  const rSend = await narrative.tick({ jobs, t: FRI, mail });
  assert.equal(rSend.sent.work.narrative, false);
  const workMail = sent.find(m => m.subject.startsWith('Work, Fri 20 Nov'));
  assert.ok(workMail);
  assert.match(workMail.text, /weekly narrative briefing couldn't be written in time/i);
  assert.match(workMail.html, /weekly narrative briefing couldn&#39;t be written|weekly narrative briefing couldn't be written/i);
});
