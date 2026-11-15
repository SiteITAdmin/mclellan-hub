'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-transcript-merge-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1'; process.env.KRISP_WEBHOOK_SECRET = 'x';
const db = require('../lib/crm/db'), krisp = require('../lib/crm/krisp'), atoms = require('../lib/crm/atoms'), merge = require('../lib/crm/transcript-merge'),
  meetings = require('../lib/crm/meetings'), tasks = require('../lib/crm/tasks'), spaces = require('../lib/crm/spaces');
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const START = Math.floor(Date.parse('2026-11-10T15:11:00Z') / 1000);
const filler = n => `Turn ${n}: ` + 'we went through the shared drive folder by folder and agreed what moves first. '.repeat(40);
// Three sittings' worth of talk, with one line worth remembering in each.
function release(id = 'k1') {
  const turns = [];
  for (let i = 0; i < 16; i += 1) {
    turns.push({ speakerIndex: i % 2, text: filler(i) });
    if (i === 1) turns.push({ speakerIndex: 1, text: 'The patient services drive is about forty gigabytes in total.' });
    if (i === 7) turns.push({ speakerIndex: 0, text: 'I will send the complete folder list to Margaret by Friday.' });
    if (i === 14) turns.push({ speakerIndex: 1, text: 'The managers presentation is planned for early in the New Year.' });
  }
  const got = krisp.receive({ event: 'transcript_created', meeting: { id, title: 'Mobile recording - November 10, 2026 3:11 p.m.', started_at: START }, data: { content: turns } });
  const held = krisp.list().find(d => d.id === got.id);
  const ids = krisp.classify(got.id, 'work', { revision: held.review.revision, names: ['Douglas McLellan', 'Margaret Callanan'] });
  return { key: got.id, ids };
}
const src = id => db.crm().prepare('SELECT * FROM sources WHERE id = ?').get(id);
const intake = key => db.crm().prepare('SELECT * FROM krisp_intake WHERE id = ?').get(key);
const fact = (statement, quote) => ({ statement, kind: 'fact', quote, people: [], topics: [], confidence: 'high' });
function read(ids) {
  const said = [['The patient services drive is about 40 GB.', 'The patient services drive is about forty gigabytes in total.'],
    ['Douglas will send the complete folder list to Margaret by Friday.', 'I will send the complete folder list to Margaret by Friday.'],
    ['The managers presentation is planned for early in the New Year.', 'The managers presentation is planned for early in the New Year.']];
  for (const id of ids) {
    const text = src(id).text;
    const mine = said.filter(([, quote]) => text.includes(quote)).map(([statement, quote]) => fact(statement, quote));
    // The same thing heard in every part is one fact with a quote from each.
    atoms.applyAtoms(id, [...mine, fact('Margaret Callanan and Douglas went through the shared drive folder by folder.', 'we went through the shared drive folder by folder')]);
  }
}

test('parts stay apart until every one is read, then become one transcript with everything still attached', () => {
  const c = db.crm();
  const { key, ids } = release();
  assert.equal(ids.length, 3, 'the synthetic recording is long enough for three sittings');
  const whole = ids.map(id => src(id).text).join('\n\n');
  assert.deepEqual(merge.run(), { joined: 0 }, 'nothing is joined while parts are unread');
  read(ids.slice(0, 2));
  assert.deepEqual(merge.run(), { joined: 0 }, 'one unread part keeps them apart');
  read(ids.slice(2));
  c.prepare("UPDATE sources SET atomise_status = 'failed' WHERE id = ?").run(ids[1]);
  assert.deepEqual(merge.run(), { joined: 0 }, 'a part that could not be read keeps them apart');
  c.prepare("UPDATE sources SET atomise_status = 'done' WHERE id = ?").run(ids[1]);

  // Things that point at the later parts.
  const partOf = quote => ids.find(id => src(id).text.includes(quote));
  const listPart = partOf('complete folder list'), talkPart = partOf('managers presentation');
  assert.notEqual(listPart, ids[0]); assert.notEqual(talkPart, ids[0]); assert.notEqual(talkPart, listPart);
  const t1 = tasks.create('work', { title: 'Send the complete folder list', context: { sourceId: listPart } });
  const t2 = tasks.create('work', { title: 'Prepare the managers presentation', context: { sourceId: talkPart } });
  c.prepare('UPDATE tasks SET source_id = ? WHERE id = ?').run(talkPart, t2.id);
  c.prepare("INSERT INTO task_help (task_id, space, task_print, evidence_print, status, refs, help, tried_at) VALUES (?, 'work', 'p', 'e', 'done', ?, ?, ?)")
    .run(t1.id, JSON.stringify({ sources: { S1: listPart } }), JSON.stringify({ have: [{ text: 'x', refs: [{ source: talkPart }] }] }), START);
  c.prepare("INSERT INTO deleted_facts (atom_id, space, statement, source_ids, quotes, at) VALUES ('gone', 'work', 'A fact Douglas deleted.', ?, '[]', ?)").run(JSON.stringify([talkPart]), START);
  const promise = c.prepare("SELECT a.id FROM atoms a WHERE a.statement LIKE 'Douglas will send%'").get().id;
  c.prepare("INSERT OR REPLACE INTO promises (atom_id, space, direction, who, action, certainty, state, said_at, looks_done_source_id, not_done_sources, closed_by) VALUES (?, 'work', 'mine', 'Margaret Callanan', 'send the folder list', 'clear', 'open', ?, ?, ?, ?)")
    .run(promise, START, talkPart, JSON.stringify([listPart]), `source:${talkPart}`);
  const factsBefore = c.prepare('SELECT COUNT(DISTINCT atom_id) n FROM atom_sources').get().n;
  assert.equal(factsBefore, 4);
  assert.equal(c.prepare("SELECT COUNT(*) n FROM atom_sources x JOIN atoms a ON a.id = x.atom_id WHERE a.statement LIKE 'Margaret Callanan and Douglas%'").get().n, 3, 'the repeated fact cites all three parts');

  assert.deepEqual(merge.run(START + 60), { joined: 1 });
  const all = c.prepare("SELECT * FROM sources WHERE kind = 'meeting'").all();
  assert.equal(all.length, 1); const one = all[0];
  assert.equal(one.id, ids[0], 'the first part’s id lives on, so links to it still work');
  assert.equal(one.text, whole); assert.equal(one.text_fresh, whole);
  assert.equal(one.title, 'Mobile recording - November 10, 2026 3:11 p.m.', 'no "(part 1 of 3)" left in the title');
  assert.equal(one.atomise_status, 'done'); assert.equal(one.atom_count, 4);
  assert.deepEqual(JSON.parse(intake(key).source_ids), [one.id]);
  const cites = c.prepare('SELECT * FROM atom_sources').all();
  assert.equal(cites.length, 4); assert.ok(cites.every(x => x.source_id === one.id));
  assert.ok(cites.every(x => x.quote_verified === 1 && atoms.quoteVerified(x.quote, one.text)), 'every quote is still found in the joined text');
  for (const t of [t1, t2]) assert.equal(JSON.parse(c.prepare('SELECT context FROM tasks WHERE id = ?').get(t.id).context).sourceId, one.id);
  assert.equal(c.prepare('SELECT source_id FROM tasks WHERE id = ?').get(t2.id).source_id, one.id);
  assert.equal(tasks.detail(tasks.get(t1.id)).evidence.id, one.id, 'the task page still finds where it came from');
  const help = c.prepare('SELECT refs, help FROM task_help').get();
  assert.equal(JSON.parse(help.refs).sources.S1, one.id); assert.equal(JSON.parse(help.help).have[0].refs[0].source, one.id);
  assert.deepEqual(JSON.parse(c.prepare('SELECT source_ids FROM deleted_facts').get().source_ids), [one.id]);
  assert.ok(require('../lib/crm/facts').wasDeleted('work', one.id, 'A fact Douglas deleted.', ''), 'a deleted fact stays deleted');
  const p = c.prepare('SELECT * FROM promises WHERE atom_id = ?').get(promise);
  assert.equal(p.looks_done_source_id, one.id); assert.deepEqual(JSON.parse(p.not_done_sources), [one.id]); assert.equal(p.closed_by, `source:${one.id}`);
  assert.deepEqual(c.prepare('SELECT source_id FROM sources_fts WHERE sources_fts MATCH ?').all('"planned for early in the New Year"').map(r => r.source_id), [one.id], 'Search finds the end of the transcript in the one source');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM sources_fts WHERE source_id IN (?, ?)').get(ids[1], ids[2]).n, 0);
  assert.deepEqual(c.prepare('SELECT old_id, into_id FROM source_merges ORDER BY old_id').all(), ids.slice(1).sort().map(old_id => ({ old_id, into_id: one.id })));
  assert.deepEqual(merge.joinedInto(ids[2]), { id: one.id, space: 'work' }); assert.equal(merge.joinedInto(one.id), null);
  const [rec] = meetings.recordings('work');
  assert.equal(rec.sources.length, 1); assert.equal(rec.facts, 4); assert.equal(rec.tasks.length, 2); assert.equal(rec.title, 'Meeting with Margaret Callanan');
  assert.equal(require('../lib/crm/speaker-correction').review(one.id).labels.length, 2, 'speaker names can still be corrected');
  assert.deepEqual(merge.run(), { joined: 0 }); assert.equal(merge.waiting().length, 0);
});

test('parts filed in different spaces are never joined', () => {
  const { ids } = release();
  read(ids);
  spaces.moveSource(ids[2], 'personal', 'you', '');
  atoms.applyAtoms(ids[2], []);
  assert.deepEqual(merge.run(), { joined: 0 });
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM sources WHERE kind = 'meeting'").get().n, 3);
});

test('a joined transcript that must be read again is cut into parts first, read in full, and joined again', async () => {
  const c = db.crm();
  const { key, ids } = release();
  read(ids); merge.run();
  const whole = src(ids[0]).text;
  assert.ok(whole.length > atoms.MAX_FRESH, 'longer than the reader takes in one sitting');
  assert.equal(merge.cutForReading(), 0, 'a transcript that has been read is left joined');

  spaces.moveSource(ids[0], 'personal', 'you', 'Douglas moved it');
  assert.equal(src(ids[0]).atomise_status, 'pending'); assert.equal(c.prepare('SELECT COUNT(*) n FROM atom_sources').get().n, 0);
  // The reading tick cuts before it picks anything to read.
  const queue = [];
  const jobs = { enqueue(j) { queue.push({ ...j, id: `j${queue.length}`, status: 'pending' }); return { jobId: `j${queue.length - 1}` }; },
    getJob: id => queue.find(j => j.id === id), queueStats: () => ({ pending: 0 }) };
  await atoms.runAtomiseTick({ jobs });
  const parts = JSON.parse(intake(key).source_ids).map(src);
  assert.equal(parts.length, 3); assert.equal(parts[0].id, ids[0]);
  assert.ok(parts.every(p => p.space === 'personal' && p.kind === 'meeting' && p.text.length <= atoms.MAX_FRESH && p.space_why === 'Douglas moved it'));
  assert.equal(parts.map(p => p.text).join('\n\n'), whole, 'nothing lost or repeated in the cut');
  assert.deepEqual(parts.map(p => p.title), [1, 2, 3].map(n => `Mobile recording - November 10, 2026 3:11 p.m. (part ${n} of 3)`));
  assert.deepEqual(parts.map(p => p.atomise_status).sort(), ['pending', 'pending', 'queued'], 'one part went to the reader, whole');
  const sent = queue.find(j => j.payload?.meta?.sourceId);
  assert.ok(sent.payload.userPrompt.includes(src(sent.payload.meta.sourceId).text.slice(-200)), 'the reader was given all of that part');
  assert.equal(c.prepare('SELECT COUNT(*) n FROM sources_fts WHERE source_id IN (SELECT id FROM sources WHERE kind = ?)').get('meeting').n, 3);

  // Nothing is joined while a job is in flight; once all are read, the next quiet tick joins them.
  assert.deepEqual(merge.run(), { joined: 0 });
  c.prepare("UPDATE sources SET atomise_status = 'pending', atomise_job_id = NULL WHERE atomise_status = 'queued'").run();
  read(parts.map(p => p.id));
  queue.length = 0;
  await atoms.runAtomiseTick({ jobs });
  const one = c.prepare("SELECT * FROM sources WHERE kind = 'meeting'").all();
  assert.equal(one.length, 1); assert.equal(one[0].id, ids[0]); assert.equal(one[0].space, 'personal'); assert.equal(one[0].text, whole);
  assert.equal(one[0].atom_count, 4);
  assert.equal(require('../lib/crm/runs').all().transcript_merge.detail.joined, 1);
  // Every part id there has ever been leads to the one transcript.
  for (const old of [ids[1], ids[2], parts[1].id, parts[2].id]) assert.deepEqual(merge.joinedInto(old), { id: ids[0], space: 'personal' });
});

test('an old link to a part opens the joined transcript, and a failure to join shows on Today', async () => {
  const { ids } = release();
  read(ids); merge.run();
  const app = require('express')(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  const session = { adminUser: 'douglas' }; app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = session; next(); }); app.use(require('../routes/crm'));
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/crm/personal/sources/${ids[2]}`, { redirect: 'manual' });
    assert.equal(res.status, 302); assert.equal(res.headers.get('location'), `/crm/work/sources/${ids[0]}`);
    res = await fetch(`${base}/crm/work/sources/${ids[0]}`); assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('managers presentation is planned') && html.includes('forty gigabytes'), 'the page shows the whole transcript');
    assert.equal((await fetch(`${base}/crm/work/sources/nope`, { redirect: 'manual' })).status, 404);
    const meetingsPage = await (await fetch(`${base}/crm/work/meetings`)).text();
    assert.ok(meetingsPage.includes('Read transcript') && !meetingsPage.includes('Transcript part 2'));
  } finally { server.close(); }
  db.crm().prepare("INSERT INTO job_runs (name, last_started, last_error, last_error_at) VALUES ('transcript_merge', 1, 'boom', 2)").run();
  assert.ok(require('../lib/crm/views').health('work').some(h => /Joining a transcript’s parts into one failed: boom/.test(h.text)));
});

test('cutting never drops text, even from one turn longer than a part', () => {
  const long = 'x'.repeat(merge.PART * 2 + 5);
  const text = ['Ann: hello', long, 'Bob: bye'].join('\n\n');
  const parts = merge.pieces(text);
  assert.ok(parts.every(p => p.length <= merge.PART));
  assert.equal(parts.join('\n\n').replace(/\n\n/g, ''), text.replace(/\n\n/g, ''));
});
