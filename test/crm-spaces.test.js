'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-spaces-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const spaces = require('../lib/crm/spaces');
const meetings = require('../lib/crm/meetings');
const atoms = require('../lib/crm/atoms');
const identity = require('../lib/crm/identity');
const facts = require('../lib/crm/facts');
const orgs = require('../lib/crm/orgs');
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const T = 1794643200; // 10 Nov 2026
function people() {
  identity.createPerson({ space: 'work', name: 'Serhiy Pylypaka' });
  identity.createPerson({ space: 'work', name: 'Anthony' });
  identity.createPerson({ space: 'personal', name: 'Catriona McLellan' });
  identity.createPerson({ space: 'personal', name: 'Kai McLellan' });
  identity.createPerson({ space: 'work', name: 'Pat Byrne' });
  identity.createPerson({ space: 'personal', name: 'Pat Byrne' });
  orgs.createOrg('work', 'Beacon Hospital');
}
function event(id, title, description = '', attendees = []) {
  db.crm().prepare(`INSERT OR REPLACE INTO calendar_events (id, calendar_id, space, title, start_at, end_at, description, attendees) VALUES (?, 'primary', 'personal', ?, ?, ?, ?, ?)`)
    .run(id, title, T + 3600, T + 7200, description, JSON.stringify(attendees));
  return db.crm().prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
}
const src = id => db.crm().prepare('SELECT * FROM sources WHERE id = ?').get(id);
const reply = (o) => ({ getJob: () => ({ status: 'completed', result: { output: JSON.stringify(o) } }) });
function readWith(sourceId, o) {
  db.crm().prepare("UPDATE sources SET atomise_status = 'queued', atomise_job_id = 'j' WHERE id = ?").run(sourceId);
  atoms.collectFinished(reply(o));
}
const fact = (statement, quote) => ({ statement, kind: 'fact', quote, people: [], projects: [], topics: [], confidence: 'high' });

test('Work people, Work organisations and the work address point to Work; loose or shared names say nothing', () => {
  people();
  const c = spaces.clues({ text: 'Serhiy Pylypaka told Anthony and Douglas about the Beacon Hospital DHCP meeting' });
  assert.deepEqual(c.personal, []);
  assert.equal(c.work.length, 2, 'full name and organisation; "Anthony" alone is too loose');
  assert.equal(spaces.decide(c).space, 'work');
  assert.equal(spaces.decide(spaces.clues({ text: 'Dinner with Catriona McLellan' })).space, 'personal');
  assert.equal(spaces.decide(spaces.clues({ text: 'Coffee with Pat Byrne' })), null, 'a name filed in both spaces');
  assert.equal(spaces.decide(spaces.clues({ text: 'Kai London' })), null);
  assert.equal(spaces.decide(spaces.clues({ text: 'Catriona McLellan and Serhiy Pylypaka' })), null, 'clues that disagree');
  assert.equal(spaces.decide(spaces.clues({ text: 'Invite', emails: ['douglas.mclellan@beaconhospital.ie'] })).space, 'work');
  assert.equal(spaces.decide(spaces.clues({ text: 'From: someone@beaconhospital.ie' })).space, 'work');
});

test('a calendar entry naming a Work contact is filed in Work, though the calendar is Personal', () => {
  people();
  const r = meetings.captureEvent(event('e1', 'Bluecat and Beacon Hospital - DHCP/IPAM', '<p>Serhiy Pylypaka moved this to 14:00</p>'), T);
  assert.equal(r.source.space, 'work');
  assert.equal(r.source.space_by, 'clues');
  assert.match(r.source.space_why, /Serhiy Pylypaka is a Work person/);
  assert.equal(db.crm().prepare("SELECT space FROM calendar_events WHERE id = 'e1'").get().space, 'work');
  assert.doesNotMatch(atoms.buildPacket(src(r.source.id)).userPrompt, /Space check/);
});

test('with no clues the reader decides, and a source it calls Work is moved and read again there', () => {
  people();
  const r = meetings.captureEvent(event('e2', 'Infrastructure Projects meeting'), T);
  assert.equal(r.source.space, 'personal');
  assert.equal(r.source.space_by, 'ask');
  const packet = atoms.buildPacket(src(r.source.id)).userPrompt;
  assert.match(packet, /Space check/);
  assert.match(packet, /Work organisations: Beacon Hospital/);
  assert.match(packet, /his work email is at beaconhospital\.ie/);
  readWith(r.source.id, { atoms: [fact('An Infrastructure Projects meeting is on 10 November 2026', 'Infrastructure Projects meeting')], space: 'work' });
  let s = src(r.source.id);
  assert.equal(s.space, 'work');
  assert.equal(s.space_by, 'reader');
  assert.equal(s.atomise_status, 'pending', 'read again in Work');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atoms').get().n, 0, 'nothing written in the wrong space');
  assert.equal(db.crm().prepare("SELECT space FROM calendar_events WHERE id = 'e2'").get().space, 'work');
  assert.doesNotMatch(atoms.buildPacket(s).userPrompt, /Space check/);
  readWith(r.source.id, { atoms: [fact('An Infrastructure Projects meeting is on 10 November 2026', 'Infrastructure Projects meeting')], space: null });
  assert.equal(db.crm().prepare('SELECT space FROM atoms').get().space, 'work');

  const k = meetings.captureEvent(event('e3', 'Kai London'), T);
  readWith(k.source.id, { atoms: [fact('Kai is in London from 10 to 15 November 2026', 'Kai London')], space: 'personal' });
  s = src(k.source.id);
  assert.equal(s.space, 'personal');
  assert.equal(s.space_by, 'reader');
  assert.equal(s.atomise_status, 'done');
  assert.equal(db.crm().prepare("SELECT space FROM atoms WHERE statement LIKE 'Kai%'").get().space, 'personal');
});

test('a changed entry replaces its earlier copy and keeps the space the reader chose', () => {
  people();
  const first = meetings.captureEvent(event('e4', 'MS Governance Meeting'), T);
  readWith(first.source.id, { atoms: [], space: 'work' });
  readWith(first.source.id, { atoms: [fact('The MS Governance Meeting is at 14:00 on 11 November 2026', 'MS Governance Meeting')] });
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atoms').get().n, 1);
  const second = meetings.captureEvent(event('e4', 'MS Governance Meeting', 'Moved to 15:00'), T + 60);
  assert.notEqual(second.source.id, first.source.id);
  assert.equal(second.source.space, 'work');
  assert.equal(second.source.space_by, 'reader');
  assert.equal(src(first.source.id).atomise_status, 'ignored');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atoms').get().n, 0, 'the old time is gone');
});

test('Douglas can move a source himself; facts he deleted stay deleted, and later copies follow', () => {
  people();
  const r = meetings.captureEvent(event('e5', 'Team Workload'), T);
  readWith(r.source.id, { atoms: [fact('Each team member fills in the workload sheet', 'Scheduled meeting'), fact('There is no team call in Week 46', 'Team Workload')], space: 'personal' });
  const [keep, gone] = db.crm().prepare('SELECT * FROM atoms ORDER BY statement').all();
  facts.deleteFact(gone.id, 'personal');
  spaces.moveSource(r.source.id, 'work', 'you', 'You moved it');
  const s = src(r.source.id);
  assert.equal(s.space, 'work');
  assert.equal(s.atomise_status, 'pending');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atoms WHERE id = ?').get(keep.id).n, 0);
  assert.equal(db.crm().prepare("SELECT space_by FROM calendar_events WHERE id = 'e5'").get().space_by, 'you');
  readWith(r.source.id, { atoms: [fact(keep.statement, 'Scheduled meeting'), fact(gone.statement, 'Team Workload')] });
  assert.deepEqual(db.crm().prepare('SELECT statement, space FROM atoms').all().map(a => [a.statement, a.space]), [[keep.statement, 'work']]);
  const later = meetings.captureEvent({ ...db.crm().prepare("SELECT * FROM calendar_events WHERE id = 'e5'").get(), description: 'Catriona McLellan joining' }, T + 60);
  assert.equal(later.source.space, 'work', 'his move beats the clues');
  assert.throws(() => spaces.moveSource(r.source.id, 'work', 'you', ''), /already in Work/);
});

test('once: earlier copies are retired, entries with clues are placed, the rest are read again with a space check', () => {
  people();
  const add = (ext, title, text, created) => {
    const id = `s-${ext}-${created}`;
    db.crm().prepare(`INSERT INTO sources (id, space, kind, origin, external_id, title, occurred_at, text, text_fresh, atomise_status, created_at) VALUES (?, 'personal', 'calendar', 'calendar', ?, ?, ?, ?, ?, 'done', ?)`)
      .run(id, `primary:${ext}:${created}`, title, T, text, text, created);
    atoms.applyAtoms(id, [fact(`${title} statement ${created}`, text.slice(0, 30))]);
    return id;
  };
  const oldRota = add('rota', 'Christmas oncall rota', 'Christmas oncall rota UTC times for Beacon Hospital', 1);
  const rota = add('rota', 'Christmas oncall rota', 'Christmas oncall rota Dublin times for Beacon Hospital', 2);
  const kai = add('kai', 'Kai London', 'Kai London trip', 1);
  const scot = add('scot', 'Catriona in Scotland', 'Catriona McLellan in Scotland', 1);
  const done = spaces.recheckCalendar();
  assert.deepEqual(done, { retired: 1, moved: 1, kept: 1, asked: 1 });
  assert.equal(src(oldRota).atomise_status, 'ignored');
  assert.equal(src(rota).space, 'work');
  assert.equal(src(rota).atomise_status, 'pending');
  assert.equal(src(kai).space_by, 'ask');
  assert.equal(src(kai).atomise_status, 'pending');
  assert.equal(src(scot).space_by, 'clues');
  assert.equal(src(scot).atomise_status, 'done');
  assert.deepEqual(db.crm().prepare('SELECT statement FROM atoms').all().map(a => a.statement), ['Catriona in Scotland statement 1']);
  assert.equal(spaces.recheckCalendar(), null, 'runs once');
});
