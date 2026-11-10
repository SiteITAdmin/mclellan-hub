'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-filing-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const review = require('../lib/crm/review');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const identity = require('../lib/crm/identity');
const facts = require('../lib/crm/facts');
const check = require('../lib/crm/project-check');
const views = require('../lib/crm/views');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function person(space, name) { const id = `p${++n}`; db.crm().prepare('INSERT INTO people (id, space, name) VALUES (?, ?, ?)').run(id, space, name); return id; }
function fact(space, statement, people = []) {
  const s = sources.admitSource({ space, kind: 'note', origin: 'note', externalId: `n${++n}`, title: 'Note', occurredAt: db.now() - n, text: statement }).source;
  atoms.applyAtoms(s.id, [{ statement, kind: 'fact', quote: statement, people, topics: [], confidence: 'high' }]);
  return db.crm().prepare('SELECT atom_id FROM atom_sources WHERE source_id = ?').get(s.id).atom_id;
}

test('facts in no project are listed, and filing one takes it off the list and onto the project', () => {
  const dad = review.createProject('personal', 'Dad');
  const a = fact('personal', 'Dad has a GP appointment on Friday 13 November');
  const b = fact('personal', 'The car insurance renews on 14 November');
  fact('work', 'A work fact that belongs to the other space');
  assert.deepEqual(facts.unfiled('personal').rows.map(r => r.id).sort(), [a, b].sort());
  facts.addProject(a, dad.id, 'personal');
  assert.deepEqual(facts.unfiled('personal').rows.map(r => r.id), [b]);
  assert.equal(facts.unfiled('personal').total, 1);
  assert.deepEqual(views.project(dad.id).atoms.map(x => x.id), [a]);
  assert.equal(check.waiting(dad.id), 0, 'filed by Douglas, so never re-checked');
  assert.throws(() => facts.addProject(b, review.createProject('work', 'M365').id, 'personal'), /same space/);
});

test('a fact moves between projects, and one taken off by the check can be filed back', () => {
  const dad = review.createProject('personal', 'Dad'), house = review.createProject('personal', 'House');
  const a = fact('personal', 'The roof repair quote came to 4,000 euro');
  db.crm().prepare('INSERT INTO atom_projects (atom_id, project_id) VALUES (?, ?)').run(a, dad.id);
  check.remove(a, dad.id, 'check', 'About the house, not Dad');
  assert.equal(facts.detail(a, 'personal').removedFrom[0].reason, 'About the house, not Dad');
  facts.addProject(a, house.id, 'personal');
  assert.deepEqual(facts.detail(a, 'personal').projects.map(p => p.name), ['House']);
  facts.addProject(a, dad.id, 'personal');
  assert.deepEqual(facts.detail(a, 'personal').removedFrom, [], 'filing it again clears the removal');
  facts.removeProject(a, house.id, 'personal');
  assert.deepEqual(facts.detail(a, 'personal').projects.map(p => p.name), ['Dad']);
  assert.equal(check.removed(house.id)[0].by, 'you');
});

test('people on a fact can be added and removed, and the name matcher never puts a removed person back', () => {
  const alec = person('work', 'Alec Smith'), jane = person('work', 'Jane Whelan');
  const a = fact('work', 'Alec Smith will send the licence figures', ['Alec Smith']);
  assert.deepEqual(facts.detail(a, 'work').people.map(p => p.name), ['Alec Smith']);
  facts.addPerson(a, jane, 'work');
  facts.addPerson(a, jane, 'work');
  assert.deepEqual(facts.detail(a, 'work').people.map(p => [p.name, p.how]), [['Alec Smith', 'name'], ['Jane Whelan', 'you']]);
  facts.removePerson(a, alec, 'work');
  atoms.reresolveMentions('work');
  assert.deepEqual(facts.detail(a, 'work').people.map(p => p.name), ['Jane Whelan']);
  assert.equal(views.person(alec).atoms.length, 0);
  assert.equal(views.person(jane).atoms.length, 1);
  assert.throws(() => facts.addPerson(a, person('personal', 'Dad'), 'work'), /same space/);
});

test('people are added to and taken off projects from either side, without filing their facts there', () => {
  const m365 = review.createProject('work', 'M365 Rollout');
  const ken = person('work', 'Ken Murray'), glenn = person('work', 'Glenn Kavanagh');
  const printer = fact('work', 'Ken Murray reported the printer on floor 2 is offline', ['Ken Murray']);
  const filed = fact('work', 'Glenn Kavanagh moved 40 mailboxes to Exchange Online', ['Glenn Kavanagh']);
  facts.addProject(filed, m365.id, 'work');
  facts.addMember(m365.id, ken, 'work');
  facts.addMember(m365.id, ken, 'work');
  const people = views.project(m365.id).people;
  assert.deepEqual(people.added.map(p => [p.name, p.n]), [['Ken Murray', 0]]);
  assert.deepEqual(people.fromFacts.map(p => [p.name, p.n]), [['Glenn Kavanagh', 1]]);
  assert.equal(db.crm().prepare('SELECT 1 FROM atom_projects WHERE atom_id = ?').get(printer), undefined, "Ken's printer fact is not filed under the project");
  const kenProjects = views.person(ken).projects;
  assert.deepEqual([kenProjects.added.map(p => p.name), kenProjects.fromFacts], [['M365 Rollout'], []]);
  assert.deepEqual(views.person(glenn).projects.fromFacts.map(p => p.name), ['M365 Rollout']);
  facts.removeMember(m365.id, ken, 'work');
  assert.deepEqual(views.project(m365.id).people.added, []);
  assert.throws(() => facts.addMember(m365.id, person('personal', 'Dad'), 'work'), /same space/);
});

test('the reader is told who is on each project, and members tell two people with the same name apart', () => {
  const m365 = review.createProject('work', 'M365 Rollout');
  const alecA = person('work', 'Alec'), alecB = person('work', 'Alec');
  facts.addMember(m365.id, alecB, 'work');
  assert.match(check.describe('work').join('\n'), /- M365 Rollout: .*\. People on it: Alec$/m);
  const r = identity.resolveName('work', 'Alec', { projectIds: [m365.id] });
  assert.deepEqual([r.status, r.personId, r.how], ['resolved', alecB, 'project']);
  assert.equal(identity.resolveName('work', 'Alec').status, 'ambiguous', 'outside the project it is still asked');
  assert.ok(alecA);
});

test('deleting a fact removes it everywhere, keeps the email, tidies what pointed at it, and re-reading cannot bring it back', () => {
  const ken = person('work', 'Karol Podziewski');
  const m365 = review.createProject('work', 'M365 Rollout');
  const s = sources.admitSource({ space: 'work', kind: 'email', origin: 'outlook', externalId: 'ooo', title: 'Automatic reply: Infra group', occurredAt: db.now(),
    text: 'I am out of the office and return on Monday 9 November 2026.', participants: [] }).source;
  const raw = { statement: 'Karol Podziewski is out of the office and returns on Monday, 9 November 2026.', kind: 'date', quote: 'I am out of the office and return on Monday 9 November 2026', people: ['Karol Podziewski'], projects: ['M365 Rollout'], topics: ['leave'], valid_from: '2026-11-09', confidence: 'high' };
  atoms.applyAtoms(s.id, [raw]);
  const a = db.crm().prepare('SELECT id FROM atoms').get().id;
  const older = fact('work', 'The licence count was 400');
  db.crm().prepare("UPDATE atoms SET status = 'superseded', superseded_by = ? WHERE id = ?").run(a, older);
  db.crm().prepare("INSERT INTO standings (entity_type, entity_id, space, tried_at) VALUES ('person', ?, 'work', ?)").run(ken, db.now());

  facts.deleteFact(a, 'work');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atoms WHERE id = ?').get(a).n, 0);
  for (const t of ['atom_sources', 'atom_mentions', 'atom_projects', 'atom_topics', 'atoms_fts']) assert.equal(db.crm().prepare(`SELECT COUNT(*) n FROM ${t} WHERE atom_id = ?`).get(a).n, 0, t);
  assert.ok(db.crm().prepare('SELECT 1 FROM sources WHERE id = ?').get(s.id), 'the email is kept');
  assert.equal(db.crm().prepare('SELECT status FROM atoms WHERE id = ?').get(older).status, 'active', 'what it replaced is current again');
  assert.equal(db.crm().prepare("SELECT tried_at FROM standings WHERE entity_id = ?").get(ken).tried_at, 0, "Karol's summary is rewritten");
  assert.equal(views.person(ken).atoms.length, 0);

  atoms.applyAtoms(s.id, [raw, { ...raw, statement: 'Karol is away until 9 November', quote: 'I am out of the office and return on Monday 9 November 2026' }]);
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM atoms WHERE statement LIKE 'Karol%'").get().n, 0, 'reading the same email again brings neither wording back');
  const other = sources.admitSource({ space: 'work', kind: 'email', origin: 'outlook', externalId: 'other', title: 'Leave', occurredAt: db.now(), text: raw.statement, participants: [] }).source;
  atoms.applyAtoms(other.id, [raw]);
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM atoms WHERE statement LIKE 'Karol%'").get().n, 1, 'a different email saying it is a new fact');
  assert.throws(() => facts.deleteFact(a, 'work'), /not found/);
  assert.throws(() => facts.deleteFact(older, 'personal'), /not found/);
});

test('several facts are filed or moved at once; a bad id or wrong space changes nothing', () => {
  const dad = review.createProject('personal', 'Dad'), house = review.createProject('personal', 'House');
  const a = fact('personal', 'The roof repair quote came to 4,000 euro');
  const b = fact('personal', 'The boiler service is due in December');
  const c = fact('personal', 'Dad has a GP appointment on Friday');
  let r = facts.moveMany([a, b, a], house.id, 'personal');
  assert.equal(r.count, 2);
  assert.deepEqual(facts.unfiled('personal').rows.map(x => x.id), [c]);
  facts.addProject(c, house.id, 'personal');
  r = facts.moveMany([c], dad.id, 'personal', { from: house.id });
  assert.deepEqual(facts.detail(c, 'personal').projects.map(p => p.name), ['Dad']);
  assert.equal(check.removed(house.id)[0].reason, 'You moved it to Dad');
  facts.moveMany([b], 'none', 'personal', { from: house.id });
  assert.deepEqual(facts.detail(b, 'personal').projects, []);
  const before = db.crm().prepare('SELECT COUNT(*) n FROM atom_projects').get().n;
  assert.throws(() => facts.moveMany([a, 'not-a-fact'], dad.id, 'personal'), /not found/);
  assert.throws(() => facts.moveMany([a], review.createProject('work', 'M365').id, 'personal'), /same space/);
  assert.throws(() => facts.moveMany([], dad.id, 'personal'), /Tick at least one/);
  assert.throws(() => facts.moveMany([a], house.id, 'personal', { from: house.id }), /already in that project/);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atom_projects').get().n, before, 'all or nothing');
});
