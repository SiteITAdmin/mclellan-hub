'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-correction-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';

const db = require('../lib/crm/db');
const sources = require('../lib/crm/sources');
const identity = require('../lib/crm/identity');
const correction = require('../lib/crm/speaker-correction');
const { uuid } = require('../lib/id');
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const INTAKE = 'a'.repeat(64);
const RAW = JSON.stringify({ data: { content: [{ speaker: 'Speaker 1', text: 'The quote as spoken.' }] } });

function seed() {
  const crm = db.crm();
  for (const table of ['promises', 'tasks', 'atom_mentions', 'atom_sources', 'atom_projects', 'atom_topics', 'atoms', 'sources_fts', 'sources',
    'settings', 'krisp_intake', 'identity_imports', 'connections', 'project_people', 'identifiers', 'people', 'review_items']) crm.prepare(`DELETE FROM ${table}`).run();
  crm.prepare(`INSERT INTO krisp_intake (id, raw_json, title, transcript, occurred_at, readable, status, space, source_ids)
    VALUES (?, ?, ?, ?, ?, 1, 'classified', 'work', '[]')`)
    .run(INTAKE, RAW, 'Mobile recording', 'Speaker 1: The quote as spoken.\n\nDouglas McLellan: Yes.\n\nSpeaker 10: Other.', 1762787482);
  const text = ['Speaker 1: The quote as spoken.', 'Speaker 1: I will send the quote.', '    Speaker 1: quoted speech stays',
    'Douglas McLellan: Yes.', 'Speaker 10: Other.', 'Karen: Fine.'].join('\n\n');
  const source = sources.admitSource({ space: 'work', kind: 'meeting', origin: 'krisp', externalId: `${INTAKE}:1`,
    title: 'Mobile recording', occurredAt: 1762787482, text, fresh: text, rawRef: `krisp-intake:${INTAKE}` }).source;
  crm.prepare('UPDATE krisp_intake SET source_ids = ? WHERE id = ?').run(JSON.stringify([source.id]), INTAKE);

  const atomId = uuid();
  crm.prepare(`INSERT INTO atoms (id, space, statement, kind, confidence, said_at) VALUES (?, 'work', ?, 'promise', 'high', ?)`)
    .run(atomId, 'Speaker 1 will send the quote. Speaker 10 will not.', 1762787482);
  crm.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, 1)')
    .run(atomId, source.id, 'I will send the quote.');
  crm.prepare("INSERT INTO atom_mentions (id, atom_id, name, name_norm, status) VALUES (?, ?, 'Speaker 1', 'speaker 1', 'unresolved')")
    .run(uuid(), atomId);
  crm.prepare(`INSERT INTO promises (atom_id, space, direction, who, action, certainty, state, said_at)
    VALUES (?, 'work', 'owed_to_me', 'Speaker 1', 'send the quote', 'clear', 'open', ?)`).run(atomId, 1762787482);
  const taskId = uuid();
  crm.prepare(`INSERT INTO tasks (id, space, title, notes, status, context, source_id, origin)
    VALUES (?, 'work', ?, ?, 'needsAction', '{}', ?, 'promise')`)
    .run(taskId, 'Chase Speaker 1 for the quote', 'Speaker 1 will send the quote. Speaker 10 will not.\n\n“I will send the quote.”', source.id);
  crm.prepare('UPDATE promises SET task_id = ? WHERE atom_id = ?').run(taskId, atomId);
  return { source, atomId, taskId };
}

test('a confirmed name replaces the placeholder everywhere it was attribution', () => {
  const { source, atomId, taskId } = seed();
  const person = identity.createPerson({ space: 'work', name: 'Margaret Callanan' });
  const before = db.crm().prepare('SELECT raw_json, transcript FROM krisp_intake WHERE id = ?').get(INTAKE);

  const found = correction.review(source.id);
  assert.deepEqual(found.labels.map(x => x.label).sort(), ['Douglas McLellan', 'Karen', 'Speaker 1', 'Speaker 10']);
  assert.equal(found.labels.find(x => x.label === 'Speaker 1').placeholder, true);

  const done = correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  assert.deepEqual(done.mapping, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  assert.deepEqual(done.tasks, [taskId]);

  const crm = db.crm();
  const s = crm.prepare('SELECT text, text_fresh FROM sources WHERE id = ?').get(source.id);
  assert.match(s.text, /^Margaret Callanan: The quote as spoken\./);
  assert.ok(s.text.includes('Margaret Callanan: I will send the quote.'));
  assert.ok(s.text.includes('    Speaker 1: quoted speech stays'), 'indented speech is not attribution');
  assert.ok(!s.text.includes('\nSpeaker 1: '), 'no column-zero placeholder is left');
  assert.ok(s.text.includes('Speaker 10: Other.'), 'Speaker 10 is untouched');
  assert.equal(s.text_fresh, s.text);

  const atom = crm.prepare('SELECT statement FROM atoms WHERE id = ?').get(atomId);
  assert.equal(atom.statement, 'Margaret Callanan will send the quote. Speaker 10 will not.');
  const quote = crm.prepare('SELECT quote FROM atom_sources WHERE atom_id = ?').get(atomId);
  assert.equal(quote.quote, 'I will send the quote.', 'the exact words are not rewritten');
  const mention = crm.prepare('SELECT * FROM atom_mentions WHERE atom_id = ?').get(atomId);
  assert.equal(mention.name, 'Margaret Callanan');
  assert.equal(mention.name_norm, 'margaret callanan');
  assert.equal(mention.status, 'resolved');
  assert.equal(mention.person_id, person.id);
  assert.equal(crm.prepare('SELECT who FROM promises WHERE atom_id = ?').get(atomId).who, 'Margaret Callanan');
  const task = crm.prepare('SELECT title, notes, revision, synced_revision FROM tasks WHERE id = ?').get(taskId);
  assert.equal(task.title, 'Chase Margaret Callanan for the quote');
  assert.equal(task.notes, 'Margaret Callanan will send the quote. Speaker 10 will not.\n\n“I will send the quote.”');
  assert.equal(task.revision, 2);
  assert.equal(task.synced_revision, 0, 'the next Google sync pushes the corrected task');

  assert.deepEqual(crm.prepare('SELECT raw_json, transcript FROM krisp_intake WHERE id = ?').get(INTAKE), before);
  assert.equal(crm.prepare("SELECT count(*) n FROM atoms_fts WHERE atoms_fts MATCH 'Margaret'").get().n, 1);
  assert.equal(crm.prepare("SELECT count(*) n FROM atoms_fts WHERE atoms_fts MATCH '\"Speaker 1\"'").get().n, 0);
  assert.equal(crm.prepare("SELECT count(*) n FROM sources_fts WHERE sources_fts MATCH 'Margaret'").get().n, 1);
  const receipt = crm.prepare("SELECT value FROM settings WHERE key LIKE 'speaker-correction:%'").get();
  assert.ok(JSON.parse(receipt.value).mapping[0].name === 'Margaret Callanan');
  const saved = JSON.parse(crm.prepare('SELECT speaker_review FROM krisp_intake WHERE id = ?').get(INTAKE).speaker_review);
  assert.equal(saved.corrections.length, 1);
});

test('names are validated and an already-corrected label cannot be replayed', () => {
  const { source } = seed();
  assert.throws(() => correction.correct(source.id, [{ label: 'Speaker 1', name: 'Speaker 2' }]), /real name/);
  assert.throws(() => correction.correct(source.id, [{ label: 'Speaker 1', name: '' }]), /real name/);
  assert.throws(() => correction.correct(source.id, [{ label: 'Nobody', name: 'Alex' }]), /no speaker called/);
  assert.throws(() => correction.correct(source.id, [{ label: 'Speaker 1', name: 'Alex: Admin' }]), /real name/);
  correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  assert.throws(() => correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]), /no speaker called/);
  assert.equal(correction.review(source.id).labels.find(x => x.label === 'Speaker 1'), undefined);
});

test('an atom shared with another delivery is reported, never rewritten', () => {
  const { source } = seed();
  const crm = db.crm();
  const other = sources.admitSource({ space: 'work', kind: 'meeting', origin: 'krisp', externalId: `${INTAKE}:2`,
    title: 'Other meeting', occurredAt: 1762787482, text: 'Speaker 1: Something else.', fresh: 'Speaker 1: Something else.',
    rawRef: `krisp-intake:${'b'.repeat(64)}` }).source;
  const shared = uuid();
  crm.prepare(`INSERT INTO atoms (id, space, statement, kind, confidence, said_at) VALUES (?, 'work', ?, 'fact', 'high', ?)`)
    .run(shared, 'Speaker 1 will send the quote.', 1762787482);
  crm.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, 1)').run(shared, source.id, 'quote');
  crm.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, 1)').run(shared, other.id, 'quote');
  const done = correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  assert.deepEqual(done.skippedAtoms, [shared]);
  assert.equal(crm.prepare('SELECT statement FROM atoms WHERE id = ?').get(shared).statement, 'Speaker 1 will send the quote.');
  assert.match(crm.prepare('SELECT text FROM sources WHERE id = ?').get(source.id).text, /^Margaret Callanan: /);
});

test('a task derived from a shared atom is left alone', () => {
  const { source } = seed();
  const crm = db.crm();
  const other = sources.admitSource({ space: 'work', kind: 'meeting', origin: 'krisp', externalId: `${INTAKE}:3`,
    title: 'Other meeting', occurredAt: 1762787482, text: 'Speaker 1: Something else.', fresh: 'Speaker 1: Something else.',
    rawRef: `krisp-intake:${'c'.repeat(64)}` }).source;
  const shared = uuid();
  crm.prepare(`INSERT INTO atoms (id, space, statement, kind, confidence, said_at) VALUES (?, 'work', ?, 'promise', 'high', ?)`)
    .run(shared, 'Speaker 1 will send the quote.', 1762787482);
  crm.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, 1)').run(shared, source.id, 'quote');
  crm.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, 1)').run(shared, other.id, 'quote');
  crm.prepare(`INSERT INTO promises (atom_id, space, direction, who, action, certainty, state, said_at)
    VALUES (?, 'work', 'owed_to_me', 'Speaker 1', 'send the quote', 'clear', 'open', ?)`).run(shared, 1762787482);
  const taskId = uuid();
  crm.prepare(`INSERT INTO tasks (id, space, title, notes, status, context, source_id, origin)
    VALUES (?, 'work', 'Chase Speaker 1 for the quote', ?, 'needsAction', ?, ?, 'promise')`)
    .run(taskId, 'Speaker 1 will send the quote.\n\n“I will send the quote.”', JSON.stringify({ sourceId: source.id }), other.id);
  crm.prepare('UPDATE promises SET task_id = ? WHERE atom_id = ?').run(taskId, shared);

  const done = correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  assert.deepEqual(done.skippedAtoms, [shared]);
  assert.ok(!done.tasks.includes(taskId), 'another delivery\'s task is not touched');
  const t = crm.prepare('SELECT title, notes, revision FROM tasks WHERE id = ?').get(taskId);
  assert.equal(t.title, 'Chase Speaker 1 for the quote');
  assert.match(t.notes, /^Speaker 1 will send the quote\./);
  assert.equal(t.revision, 1);
  assert.equal(crm.prepare('SELECT who FROM promises WHERE atom_id = ?').get(shared).who, 'Speaker 1');
});

test('a real name label is corrected in the transcript only, never inside prose', () => {
  const { source, atomId } = seed();
  const crm = db.crm();
  crm.prepare("INSERT INTO atom_mentions (id, atom_id, name, name_norm, status) VALUES (?, ?, 'Karen', 'karen', 'unresolved')").run(uuid(), atomId);
  crm.prepare("UPDATE atoms SET statement = 'Karen asked Douglas to call Karen Smith.' WHERE id = ?").run(atomId);
  const done = correction.correct(source.id, [{ label: 'Karen', name: 'Margaret Callanan' }]);
  assert.deepEqual(done.atoms, []);
  assert.equal(crm.prepare('SELECT statement FROM atoms WHERE id = ?').get(atomId).statement, 'Karen asked Douglas to call Karen Smith.');
  assert.match(crm.prepare('SELECT text FROM sources WHERE id = ?').get(source.id).text, /Margaret Callanan: Fine\./);
});

test('a mention Douglas decided himself keeps its decision', () => {
  const { source, atomId } = seed();
  const crm = db.crm();
  const mentionId = crm.prepare('SELECT id FROM atom_mentions WHERE atom_id = ?').get(atomId).id;
  crm.prepare("UPDATE atom_mentions SET status = 'none', how = 'you' WHERE id = ?").run(mentionId);
  correction.correct(source.id, [{ label: 'Speaker 1', name: 'Margaret Callanan' }]);
  const mention = crm.prepare('SELECT * FROM atom_mentions WHERE id = ?').get(mentionId);
  assert.equal(mention.status, 'none');
  assert.equal(mention.how, 'you');
});

test('the signed-in source page offers the correction and saves it', async () => {
  const { source } = seed();
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: 'douglas' }; next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/crm/work/sources/${source.id}`)).text();
    assert.ok(html.includes('Speaker names'));
    assert.ok(html.includes('name="label" value="Speaker 1"'));
    const body = new URLSearchParams({ label: 'Speaker 1', name: 'Margaret Callanan' });
    const res = await fetch(`${base}/crm/work/sources/${source.id}/speaker-names`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base }, body,
    });
    assert.equal(res.status, 302);
    assert.match(db.crm().prepare('SELECT text FROM sources WHERE id = ?').get(source.id).text, /^Margaret Callanan: /);
  } finally { server.close(); }
});
