'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-remember-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const identity = require('../lib/crm/identity');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const kit = require('../lib/crm/keepintouch');
const dates = require('../lib/crm/dates');
const digest = require('../lib/crm/digest');
const planner = require('../lib/crm/planner');

const DAY = 86400;
const NOW = planner.epoch('2026-11-10', 7 * 60 + 30);
let n = 0;

function person(space, name, email) {
  const id = `p${++n}`;
  db.crm().prepare('INSERT INTO people (id, space, name) VALUES (?, ?, ?)').run(id, space, name);
  identity.linkIdentifier(id, 'email', email);
  return db.crm().prepare('SELECT * FROM people_v WHERE id = ?').get(id);
}
function mail(space, email, daysAgo, text = 'Hello there, a short note about nothing in particular.') {
  return sources.admitSource({ space, kind: 'email', origin: 'gmail', externalId: `m${++n}`, title: 'Mail', occurredAt: NOW - daysAgo * DAY, direction: 'in',
    text, participants: [{ email, role: 'from', name: '' }, { email: 'douglas@mclellan.scot', role: 'to', name: '' }] }).source;
}

beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a cadence is suggested from how often two people are really in touch, never for daily contacts', () => {
  const dad = person('personal', 'Dad', 'dad@example.com');
  for (const d of [200, 165, 130, 100, 62, 30]) mail('personal', 'dad@example.com', d);
  const s = kit.suggestion(dad, NOW);
  assert.equal(s.usual, 35);
  assert.equal(s.days, 56);
  const colleague = person('work', 'Alec', 'alec@example.com');
  for (let d = 20; d > 0; d -= 1) mail('work', 'alec@example.com', d);
  assert.equal(kit.suggestion(colleague, NOW), null);
  const rare = person('personal', 'Seen twice', 'twice@example.com');
  mail('personal', 'twice@example.com', 90); mail('personal', 'twice@example.com', 10);
  assert.equal(kit.suggestion(rare, NOW), null);
  assert.deepEqual(kit.suggestions('personal', 3, NOW).map(x => x.person.name), ['Dad']);
});

test('drifting lists only people past the cadence Douglas confirmed; "none" stops the suggestion', () => {
  const dad = person('personal', 'Dad', 'dad@example.com');
  for (const d of [200, 165, 130, 100, 62]) mail('personal', 'dad@example.com', d);
  assert.deepEqual(kit.drifting('personal', NOW), []);
  kit.setCadence(dad.id, 42);
  const drift = kit.drifting('personal', NOW);
  assert.deepEqual(drift.map(x => [x.person.name, x.every, x.overDays]), [['Dad', 42, 20]]);
  mail('personal', 'dad@example.com', 1);
  assert.deepEqual(kit.drifting('personal', NOW), []);
  kit.setCadence(dad.id, 0);
  assert.equal(kit.suggestion(db.crm().prepare('SELECT * FROM people_v WHERE id = ?').get(dad.id), NOW), null);
  assert.throws(() => kit.setCadence(dad.id, -3), /Choose a cadence/);
});

test('key dates come from date atoms: a deadline this week, a birthday every year, nothing outside the week', () => {
  person('personal', 'Jane Whelan', 'jane@example.com');
  const s = mail('personal', 'jane@example.com', 1, 'The car insurance renews on 14 November 2026. My birthday is 12 November. The lease ends on 20 December 2026.');
  atoms.applyAtoms(s.id, [
    { statement: 'The car insurance renews on 14 November 2026', kind: 'date', quote: 'The car insurance renews on 14 November 2026', people: [], topics: ['insurance'], valid_from: '2026-11-14', confidence: 'high' },
    { statement: "Jane Whelan's birthday is 12 November", kind: 'date', quote: 'My birthday is 12 November', people: ['Jane Whelan'], topics: ['birthdays'], valid_from: '2019-11-12', yearly: true, confidence: 'high' },
    { statement: 'The lease ends on 20 December 2026', kind: 'date', quote: 'The lease ends on 20 December 2026', people: [], topics: ['lease'], valid_from: '2026-12-20', confidence: 'high' },
    { statement: 'A fact that is not a date but is yearly', kind: 'fact', quote: 'The lease ends', people: [], topics: [], valid_from: '2026-11-11', yearly: true, confidence: 'high' },
  ]);
  const soon = dates.upcoming('personal', 7, NOW);
  assert.deepEqual(soon.map(d => [d.on, d.inDays, d.yearly, d.people.map(p => p.name).join()]), [['2026-11-12', 2, true, 'Jane Whelan'], ['2026-11-14', 4, false, '']]);
  assert.deepEqual(dates.upcoming('work', 7, NOW), []);
  // A birthday in January is found from late December, in the new year.
  assert.equal(dates.upcoming('personal', 7, planner.epoch('2027-11-09', 600))[0].on, '2027-11-12');
});

test('the morning email goes once, only in the morning, and never for Work at the weekend', async () => {
  const dad = person('personal', 'Dad', 'dad@example.com');
  for (const d of [200, 165, 130, 100, 62]) mail('personal', 'dad@example.com', d);
  kit.setCadence(dad.id, 42);
  const sent = [];
  const mailer = { user: 'me@example.com', mailer: { sendMail: async m => { sent.push(m); return { messageId: 'x1' }; } } };
  const first = await digest.send('personal', { t: NOW, mail: mailer });
  assert.match(first.sent, /^Personal, Tue 10 Nov: 1 drifting$/);
  assert.equal(sent[0].to, 'me@example.com');
  assert.match(sent[0].text, /Drifting\n- Dad: last in touch 9 weeks ago/);
  assert.match(sent[0].text, /Today: https:\/\/douglas\.mclellan\.scot\/crm\/personal$/);
  assert.deepEqual(await digest.send('personal', { t: NOW + 60, mail: mailer }), { skipped: 'already sent' });
  assert.deepEqual(await digest.send('work', { t: NOW + 4 * 3600, mail: mailer }), { skipped: 'too late in the day' });
  assert.deepEqual(await digest.send('work', { t: planner.epoch('2026-11-14', 450), mail: mailer }), { skipped: 'weekend' });
  assert.equal(sent.length, 1);
  assert.deepEqual(db.crm().prepare("SELECT operation, status FROM effects WHERE module = 'crm_morning_digest'").all(), [{ operation: 'email.send', status: 'done' }]);
  const raw = digest.mime({ from: '"Hub" <me@example.com>', to: 'me@example.com', subject: 'Personal: café', text: 'Plain é', html: '<p>Rich</p>' });
  assert.match(raw, /^From: "Hub" <me@example\.com>\r\nTo: me@example\.com\r\nSubject: =\?UTF-8\?B\?UGVyc29uYWw6IGNhZsOp\?=\r\nMIME-Version: 1\.0\r\nContent-Type: multipart\/alternative/);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[2].split('\r\n--')[0], 'base64').toString(), 'Plain é');
  // A failed send is recorded and not repeated the same day.
  const broken = { user: 'me@example.com', mailer: { sendMail: async () => { throw new Error('Invalid login'); } } };
  await assert.rejects(digest.send('work', { t: NOW, mail: broken }), /Work morning email: Invalid login/);
  assert.deepEqual(await digest.send('work', { t: NOW + 60, mail: broken }), { skipped: 'already sent' });
});

test('previous Dublin day knowledge briefing isolates evidence, distinguishes replacements and renders safe links', () => {
  const start = planner.epoch('2026-11-09');
  const s = mail('personal', 'source@example.com', 100);
  const other = mail('work', 'secret@example.com', 1);
  function fact(id, space, created, source, statement = id) {
    db.crm().prepare(`INSERT INTO atoms (id, space, statement, said_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, space, statement, NOW - 100 * DAY, created, start + 200);
    if (source) db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(id, source.id);
  }
  fact('old', 'personal', start - 1, s);
  fact('new', 'personal', start, s, 'Budget <approved> & ready');
  db.crm().prepare("UPDATE atoms SET status = 'superseded', superseded_by = 'new' WHERE id = 'old'").run();
  fact('addition', 'personal', start + 1, s);
  db.crm().prepare("UPDATE atoms SET is_history = 1 WHERE id = 'addition'").run();
  fact('duplicate-evidence', 'personal', start - 10, s);
  fact('today', 'personal', planner.epoch('2026-11-10'), s);
  fact('secret', 'work', start, other);
  fact('wrong-source', 'personal', start, other);
  fact('no-source', 'personal', start, null);
  const result = digest.build('personal', NOW);
  assert.match(result.text, /CRM briefing — 2026-11-09 \(Dublin\)/);
  assert.match(result.text, /Updated: Budget <approved> & ready \(Previously: old\)/);
  assert.equal(result.empty, false);
  assert.ok(!result.text.includes('historical evidence'));
  assert.match(result.text, /Learned: addition/);
  assert.match(result.text, /Fact: https:.*\/personal\/facts\/new/);
  assert.match(result.html, /Budget &lt;approved&gt; &amp; ready/);
  assert.match(result.html, /<a href="https:.*\/personal\/sources\//);
  for (const excluded of ['duplicate-evidence', 'today', 'secret', 'wrong-source', 'no-source']) {
    assert.ok(!result.text.includes(`: ${excluded}`));
  }
  assert.match(digest.build('work', NOW).text, /Learned: secret/);
});

test('Dublin previous calendar day includes both DST boundaries and bounds the briefing', () => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const start = planner.epoch(date), end = planner.epoch(planner.addDays(date, 1));
    assert.equal(end - start, hours * 3600);
    const s = mail('personal', 'evidence@example.com', 1);
    for (const [id, created] of [[`start-${date}`, start], [`last-${date}`, end - 1], [`end-${date}`, end]]) {
      db.crm().prepare('INSERT INTO atoms (id, space, statement, said_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'personal', id, created, created);
      db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(id, s.id);
    }
    const text = JSON.stringify(digest.previousDay('personal', end + 7 * 3600));
    assert.ok(text.includes(`start-${date}`));
    assert.ok(text.includes(`last-${date}`));
    assert.ok(!text.includes(`end-${date}`));
  }
  const s = mail('work', 'work@example.com', 1);
  for (let i = 0; i < 12; i++) {
    db.crm().prepare('INSERT INTO atoms (id, space, statement, said_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`bounded${i}`, 'work', `bounded${i}`, NOW, planner.epoch('2026-11-09') + i);
    db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(`bounded${i}`, s.id);
  }
  const briefing = digest.previousDay('work', NOW);
  assert.equal(briefing.lines.filter(l => l.text?.startsWith('Learned')).length, 8);
  assert.equal(briefing.lines.at(-1), '4 more facts learned or updated in this period are not shown.');
  assert.match(JSON.stringify(digest.previousDay('personal', planner.epoch('2026-12-01', 450))), /No source-backed/);
});

test('Monday Work covers Friday through Sunday only; Personal and Tuesday retain yesterday', () => {
  const monday = planner.epoch('2026-11-09', 450);
  for (const space of ['work', 'personal']) {
    const source = mail(space, `${space}@example.com`, 1);
    for (const date of ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']) {
      const id = `${space}-${date}`, created = planner.epoch(date);
      db.crm().prepare('INSERT INTO atoms (id, space, statement, said_at, created_at) VALUES (?, ?, ?, ?, ?)').run(id, space, date, created, created);
      db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(id, source.id);
    }
  }
  const work = digest.previousDay('work', monday);
  assert.equal(work.title, 'CRM briefing — 2026-11-06 to 2026-11-08 (Dublin)');
  assert.deepEqual(work.lines.filter(l => l.text).map(l => l.text), ['Learned: 2026-11-08', 'Learned: 2026-11-07', 'Learned: 2026-11-06']);
  assert.deepEqual(digest.previousDay('personal', monday).lines.filter(l => l.text).map(l => l.text), ['Learned: 2026-11-08']);
  assert.deepEqual(digest.previousDay('work', NOW).lines.filter(l => l.text).map(l => l.text), ['Learned: 2026-11-09']);
});

test('non-calendar and mixed evidence outrank calendar copies, with at most eight fact/source pairs', () => {
  const note = mail('work', 'evidence@example.com', 1);
  const calendar = mail('work', 'calendar@example.com', 1);
  db.crm().prepare("UPDATE sources SET kind = 'calendar', origin = 'calendar', is_history = 1 WHERE id = ?").run(calendar.id);
  for (let i = 0; i < 11; i++) {
    const id = `rank-${i}`, created = planner.epoch('2026-11-09') + i;
    db.crm().prepare('INSERT INTO atoms (id, space, statement, said_at, created_at, is_history) VALUES (?, ?, ?, ?, ?, 1)').run(id, 'work', id, created, created);
    db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(id, calendar.id);
    if (i < 2) db.crm().prepare('INSERT INTO atom_sources (atom_id, source_id) VALUES (?, ?)').run(id, note.id);
  }
  const briefing = digest.previousDay('work', NOW);
  const facts = briefing.lines.filter(l => l.links);
  assert.equal(facts.length, 8);
  assert.deepEqual(facts.slice(0, 2).map(l => l.text), ['Learned: rank-1', 'Learned: rank-0']);
  assert.ok(facts.slice(0, 2).every(l => l.links[1].url.endsWith(note.id)));
  assert.ok(facts.every(l => l.links.length === 2));
  assert.equal(briefing.lines.at(-1), '3 more facts learned or updated in this period are not shown.');
  assert.ok(!JSON.stringify(briefing).includes('historical evidence'));
});

test('empty briefing keeps a meaningful empty flag', t => {
  t.mock.method(require('../lib/crm/views'), 'health', () => []);
  assert.equal(digest.previousDay('work', NOW).empty, true);
  assert.equal(digest.build('work', NOW).empty, true);
  assert.match(digest.build('work', NOW).text, /No source-backed knowledge learned or updated/);
});
