'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-project-check-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const review = require('../lib/crm/review');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const check = require('../lib/crm/project-check');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Facts filed under Dad the old way: the reader only knew the name.
function oldFacts(project, statements, origin = 'gmail') {
  const s = sources.admitSource({ space: 'personal', kind: 'email', origin, externalId: `m${++n}`, title: `Mail ${n}`, occurredAt: db.now(), text: statements.join(' '), participants: [] }).source;
  atoms.applyAtoms(s.id, statements.map(st => ({ statement: st, kind: 'fact', quote: st, people: [], topics: [], confidence: 'high' })));
  const ids = db.crm().prepare('SELECT atom_id FROM atom_sources WHERE source_id = ?').all(s.id).map(r => r.atom_id);
  for (const id of ids) db.crm().prepare('INSERT INTO atom_projects (atom_id, project_id) VALUES (?, ?)').run(id, project.id);
  return ids;
}
const fakeJobs = output => { const q = []; return { q, enqueue: j => { q.push(j); return { jobId: `j${q.length}` }; }, getJob: () => ({ status: 'completed', result: { output } }) }; };

test('the reader is told what each project covers and to leave the project empty when unsure', () => {
  const dad = review.createProject('personal', 'Dad');
  review.createProject('personal', 'House');
  db.crm().prepare("INSERT INTO people (id, space, name) VALUES ('p1', 'personal', 'Ian McLellan')").run();
  check.setAbout(dad.id, { about: "My father's care and health in Scotland.", personId: 'p1' });
  const s = sources.admitSource({ space: 'personal', kind: 'note', origin: 'note', externalId: 'n1', title: 'x', occurredAt: db.now(), text: 'A note about the bank.' }).source;
  const packet = atoms.buildPacket(s).userPrompt;
  assert.match(packet, /- Dad: My father's care and health in Scotland\. \(about Ian McLellan\)/);
  assert.match(packet, /- House: no description yet, so use it only when the source names it directly/);
  assert.match(atoms.SYSTEM_PROMPT, /An empty list is right whenever you are unsure/);
  assert.throws(() => check.setAbout(dad.id, { personId: 'nobody' }), /same space/);
});

test('old guesses are re-checked: removed facts keep a reason, unmentioned ones stay, nothing is deleted', () => {
  const dad = review.createProject('personal', 'Dad');
  check.setAbout(dad.id, { about: "My father's care and health in Scotland." });
  const [bank, care, other] = oldFacts(dad, ['Heritage Credit Union approved the current account', 'Home Instead will cover the care visits over Christmas', 'A third fact the reply does not mention']);
  assert.equal(check.waiting(dad.id), 3);
  const jobs = fakeJobs('{"keep":["F2"],"remove":[{"id":"F1","reason":"This is about your own bank account, not your father."},{"id":"F9","reason":"made up"}]}');
  assert.equal(check.enqueueNext(jobs), true);
  assert.equal(check.enqueueNext(jobs), false, 'one check at a time');
  assert.match(jobs.q[0].payload.userPrompt, /What it covers: My father's care and health in Scotland\./);
  assert.match(jobs.q[0].payload.userPrompt, /\[F1\] Heritage Credit Union approved the current account \(from email "Mail 1"/);
  assert.deepEqual(check.collect(jobs, JSON.parse), { removed: 1, restored: 0, checked: 3 });
  const linked = db.crm().prepare('SELECT atom_id FROM atom_projects WHERE project_id = ?').all(dad.id).map(r => r.atom_id).sort();
  assert.deepEqual(linked, [care, other].sort());
  assert.deepEqual(check.removed(dad.id).map(r => [r.atom_id, r.by, r.reason]), [[bank, 'check', 'This is about your own bank account, not your father']]);
  assert.ok(db.crm().prepare('SELECT 1 FROM atoms WHERE id = ?').get(bank), 'the fact itself is kept');
  assert.equal(check.waiting(dad.id), 0);
  assert.equal(check.enqueueNext(jobs), false, 'checked facts are not checked again');
  check.setAbout(dad.id, { about: "My father's care only." });
  assert.equal(check.waiting(dad.id), 3, 'a new description re-checks what is filed and what an earlier check took off');
  const again = fakeJobs('{"keep":["F1","F2","F3"],"remove":[]}');
  check.enqueueNext(again);
  assert.match(again.q[0].payload.userPrompt, /\(taken off by an earlier check\) Heritage Credit Union/);
  assert.deepEqual(check.collect(again, JSON.parse), { removed: 0, restored: 1, checked: 3 });
  assert.deepEqual(check.removed(dad.id), []);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atom_projects WHERE project_id = ?').get(dad.id).n, 3);
});

test('Douglas can take a fact off and put one back; one he put back is never checked off again', () => {
  const dad = review.createProject('personal', 'Dad');
  const [a, b] = oldFacts(dad, ['Catriona McLellan is in Scotland on 20 November', 'Dad has a GP appointment on Friday']);
  db.crm().prepare("INSERT INTO standings (entity_type, entity_id, space, tried_at) VALUES ('project', ?, 'personal', ?)").run(dad.id, db.now());
  assert.equal(check.remove(a, dad.id, 'you', 'You took it off'), 1);
  assert.equal(db.crm().prepare("SELECT tried_at FROM standings WHERE entity_id = ?").get(dad.id).tried_at, 0, 'the summary is rewritten soon');
  assert.equal(check.remove(a, dad.id, 'you', 'again'), 0);
  assert.equal(check.putBack(a, dad.id), 1);
  assert.deepEqual(check.removed(dad.id), []);
  check.remove(b, dad.id, 'you', 'You took it off');
  check.setAbout(dad.id, { about: 'Something else entirely' });
  assert.deepEqual(check.unchecked(dad.id).map(x => x.id), [], 'neither the fact Douglas put back nor the one he took off is checked again');
});

test('facts from a mailbox Douglas filed under a project are not re-checked; a failed or stale check takes nothing away', () => {
  const wds = review.createProject('personal', 'Wicklow Dementia Support');
  db.crm().prepare('INSERT INTO channel_projects (channel, project_id) VALUES (?, ?)').run('gmail:douglas@wicklowdementiasupport.ie', wds.id);
  oldFacts(wds, ['The board meets on Tuesday'], 'gmail:douglas@wicklowdementiasupport.ie');
  assert.equal(check.waiting(wds.id), 0);
  const dad = review.createProject('personal', 'Dad');
  oldFacts(dad, ['A fact that might not belong']);
  const broken = fakeJobs('not json');
  check.enqueueNext(broken);
  assert.match(check.collect(broken, JSON.parse).error, /JSON/);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atom_projects WHERE project_id = ?').get(dad.id).n, 1);
  const stale = fakeJobs('{"keep":[],"remove":[{"id":"F1","reason":"x"}]}');
  check.enqueueNext(stale);
  check.setAbout(dad.id, { about: 'Changed while the check ran' });
  assert.deepEqual(check.collect(stale, JSON.parse), { stale: true });
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atom_projects WHERE project_id = ?').get(dad.id).n, 1);
});

test('a fact the reader files now is not re-checked, because it already knew the description', () => {
  const dad = review.createProject('personal', 'Dad');
  check.setAbout(dad.id, { about: "My father's care." });
  const s = sources.admitSource({ space: 'personal', kind: 'note', origin: 'note', externalId: 'n2', title: 'GP', occurredAt: db.now(), text: 'Dad has a GP appointment on Friday.' }).source;
  atoms.applyAtoms(s.id, [{ statement: 'Dad has a GP appointment on Friday', kind: 'fact', quote: 'Dad has a GP appointment on Friday', people: [], projects: ['Dad'], topics: [], confidence: 'high' }]);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM atom_projects WHERE project_id = ?').get(dad.id).n, 1);
  assert.equal(check.waiting(dad.id), 0);
});
