'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-boox-app-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const Database = require('better-sqlite3');
const db = require('../lib/crm/db'), boox = require('../lib/crm/boox'), app = require('../lib/crm/boox-app'), atoms = require('../lib/crm/atoms');
const identity = require('../lib/crm/identity'), sources = require('../lib/crm/sources'), tasks = require('../lib/crm/tasks'), planner = require('../lib/crm/planner');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const T = Math.floor(Date.now() / 1000), DAY = 86400;
const TODAY = planner.local(T).date;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); delete process.env.HUB_BOOX_TOKEN; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function pdf(lines) {
  const d = await PDFDocument.create({ updateMetadata: false });
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const s of lines) d.addPage([400, 200]).drawText(s, { x: 10, y: 100, size: 12, font });
  return Buffer.from(await d.save());
}
const file = (id, name, modified = T, created = T) => ({ id, name, mimeType: 'application/pdf', createdTime: new Date(created * 1000).toISOString(), modifiedTime: new Date(modified * 1000).toISOString() });
const drive = files => ({ files: { list: async () => ({ data: { files } }) } });
const notebook = id => db.crm().prepare('SELECT * FROM notebooks WHERE id=?').get(id);
// Stands in for the Mac worker: hands back whatever the reader is said to have read.
function read(text, { uncertain = false } = {}) {
  const queued = [];
  const jobs = { enqueue: x => { queued.push(x); return { jobId: 'j' }; }, getJob: () => ({ status: 'completed', result: { output: JSON.stringify({ text, uncertain, reason: uncertain ? 'A name is unclear' : '' }) } }) };
  assert.equal(boox.enqueueNext(jobs), true);
  boox.collect(jobs);
  return queued[0].payload;
}

test('a note the app named for a day is placed by its name; other notebooks still wait to be classified', async () => {
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Work.pdf`), file('other', 'Notebook-6.pdf'), file('planner', `Planner ${TODAY}.pdf`), file('bad', '2026-13-45 Work.pdf'), file('dup', `${TODAY} personal (1).pdf`)]), T);
  assert.deepEqual([notebook('day').space, notebook('day').kind, notebook('day').day], ['work', 'day', TODAY]);
  assert.deepEqual([notebook('dup').space, notebook('dup').kind], ['personal', 'day']);
  for (const id of ['other', 'planner', 'bad']) assert.equal(notebook(id).space, null);
  assert.throws(() => boox.configure('day', 'personal', 'journal'), /day note/);
  assert.equal(boox.dayNoteTitle('2026-11-12', 'work'), '2026-11-12 Work');
  assert.throws(() => boox.dayNoteTitle('2026-02-30', 'work'), /date/);
  assert.throws(() => boox.dayNoteTitle('2026-11-12', 'both'), /space/);
});

test('a notebook a person already classified keeps its space and kind even if renamed like a day note', async () => {
  await boox.discover(drive([file('n', 'Meetings.pdf')]), T);
  boox.configure('n', 'personal', 'meetings');
  await boox.discover(drive([file('n', `${TODAY} Work.pdf`)]), T);
  assert.deepEqual([notebook('n').space, notebook('n').kind, notebook('n').day], ['personal', 'meetings', null]);
});

test('writing added to a day-note page later the same day is read as new, can create actions, and is not repeated', async () => {
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Work.pdf`)]), T);
  assert.equal(await boox.capture(notebook('day'), await pdf(['morning']), T), 1);
  assert.equal(read('Call Jane about the audit plan').userPrompt.includes('read before'), false);
  const first = db.crm().prepare('SELECT * FROM sources').get();
  assert.deepEqual([first.kind, first.origin, first.space, first.is_history, first.text_fresh], ['note', 'boox', 'work', 0, 'Call Jane about the audit plan']);
  assert.match(first.title, /Boox day note · page 1$/);
  assert.equal(planner.local(first.occurred_at).date, TODAY);

  db.crm().prepare('UPDATE notebooks SET modified_at=? WHERE id=?').run(T + 3600, 'day');
  assert.equal(await boox.capture(notebook('day'), await pdf(['morning and afternoon']), T + 3600), 1);
  const second = read('Call Jane about the audit plan\nI will send Tom the risk register by Friday');
  assert.match(second.userPrompt, /read before[\s\S]*Call Jane about the audit plan/);
  const added = db.crm().prepare('SELECT * FROM sources ORDER BY rowid DESC').get();
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM sources').get().n, 2);
  assert.equal(added.text_fresh, 'I will send Tom the risk register by Friday');
  assert.ok(added.text.startsWith(added.text_fresh) && added.text.includes('Already read from this page:\nCall Jane about the audit plan'));
  assert.equal(added.is_history, 0);
  atoms.applyAtoms(added.id, [{ statement: 'Douglas will send Tom the risk register by Friday', quote: 'I will send Tom the risk register by Friday', kind: 'promise', confidence: 'high',
    promise: { direction: 'mine', certainty: 'clear', action: 'send Tom the risk register', who: 'Tom' } }]);
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM promises').get().n, 1);

  // The same page exported again with nothing new written leads to no further source.
  db.crm().prepare('UPDATE notebooks SET modified_at=? WHERE id=?').run(T + 7200, 'day');
  assert.equal(await boox.capture(notebook('day'), await pdf(['same words, new export']), T + 7200), 1);
  read('call Jane about the audit plan.\nI will send Tom the risk register by Friday');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM sources').get().n, 2);
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM notebook_pages WHERE status='done'").get().n, 3);
});

test('a blank day-note page makes no source, and an older unread copy of a page gives way to the newer one', async () => {
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Personal.pdf`)]), T);
  await boox.capture(notebook('day'), await pdf(['blank']), T);
  read('');
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM sources').get().n, 0);
  assert.equal(boox.dayNotes(TODAY, TODAY)[TODAY].personal.pages[0].blank, true);

  db.crm().prepare('UPDATE notebooks SET modified_at=? WHERE id=?').run(T + 60, 'day');
  await boox.capture(notebook('day'), await pdf(['first words']), T + 60);
  read('Ring [unclear] on Monday', { uncertain: true });
  assert.equal(boox.dayNotes(TODAY, TODAY)[TODAY].personal.checking, 1);
  db.crm().prepare('UPDATE notebooks SET modified_at=? WHERE id=?').run(T + 120, 'day');
  await boox.capture(notebook('day'), await pdf(['first words, then more']), T + 120);
  assert.deepEqual(db.crm().prepare('SELECT status FROM notebook_pages ORDER BY rowid').all().map(p => p.status), ['done', 'replaced', 'pending']);
  read('Ring Maeve on Monday');
  const note = boox.dayNotes(TODAY, TODAY)[TODAY].personal;
  assert.deepEqual([note.checking, note.waiting, note.sources.length, note.sources[0].page], [0, 0, 1, 1]);
  assert.equal(db.crm().prepare('SELECT space FROM sources').get().space, 'personal');
});

test('a day note written the next morning still belongs to its day', async () => {
  const yesterday = planner.addDays(TODAY, -1);
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${yesterday} Work.pdf`, T, T - DAY)]), T);
  await boox.capture(notebook('day'), await pdf(['late']), T);
  read('Agreed the budget with Finance');
  const s = db.crm().prepare('SELECT * FROM sources').get();
  assert.equal(planner.local(s.occurred_at).date, yesterday);
  assert.equal(s.is_history, 0);
});

test('the app is given both diaries, task blocks, people, promises and each day\'s note, and nothing without the token', async () => {
  const jane = identity.createPerson({ space: 'work', name: 'Jane Whelan', role: 'Head of Audit' });
  identity.linkIdentifier(jane.id, 'email', 'jane@example.com');
  const start = planner.epoch(TODAY, 23 * 60 + 30);
  db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,attendees,description) VALUES('e','primary','work','Audit plan review',?,?,?,'')`)
    .run(start, start + 900, JSON.stringify([{ email: 'jane@example.com', name: 'Jane' }, { email: 'stranger@example.com', name: 'Sam Stranger' }]));
  db.crm().prepare(`INSERT INTO calendar_events(id,calendar_id,space,title,start_at,end_at,all_day) VALUES('h','primary','personal','Half term',?,?,1)`)
    .run(planner.epoch(TODAY), planner.epoch(planner.addDays(TODAY, 1)));
  const task = tasks.create('personal', { title: 'Renew passport', due: planner.addDays(TODAY, -1) });
  db.crm().prepare("INSERT INTO plan_blocks(id,task_id,space,start_at,end_at) VALUES('b',?,'personal',?,?)").run(task.id, planner.epoch(TODAY, 19 * 60), planner.epoch(TODAY, 19 * 60 + 30));
  const s = sources.admitSource({ space: 'work', kind: 'note', origin: 'test', externalId: 's', title: 'Note', text: 'I will send Jane Whelan the audit scope', occurredAt: T }).source;
  atoms.applyAtoms(s.id, [{ statement: 'Douglas will send Jane Whelan the audit scope', quote: 'I will send Jane Whelan the audit scope', kind: 'promise', confidence: 'high', people: ['Jane Whelan'],
    promise: { direction: 'mine', certainty: 'clear', action: 'send the audit scope', who: 'Jane Whelan' } }]);
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Work.pdf`)]), T);
  await boox.capture(notebook('day'), await pdf(['x']), T);
  read('Jane wants the scope by Friday');

  const out = app.sync({ t: T, app: '2.0.0' });
  assert.equal(out.today, TODAY);
  assert.equal(out.days.length, app.BACK_DAYS + app.AHEAD_DAYS);
  assert.equal(out.days[app.BACK_DAYS].date, TODAY);
  const day = out.days[app.BACK_DAYS];
  const event = day.items.find(i => i.type === 'event');
  assert.deepEqual([event.title, event.space, event.from, event.until], ['Audit plan review', 'work', '23:30', '23:45']);
  assert.deepEqual([event.people, event.guests], [[jane.id], ['Sam Stranger']]);
  const block = day.items.find(i => i.type === 'task');
  assert.deepEqual([block.title, block.space, block.from], ['Renew passport', 'personal', '19:00']);
  assert.deepEqual(day.allDay.map(b => [b.title, b.space]), [['Half term', 'personal']]);
  assert.deepEqual(day.notes.work, { title: `${TODAY} Work`, opened: null, pages: 1, state: 'read' });
  assert.deepEqual(day.notes.personal, { title: `${TODAY} Personal`, opened: null, pages: 0, state: 'none' });
  assert.equal(out.spaces.personal.tasks[0].title, 'Renew passport');
  assert.equal(out.spaces.personal.tasks[0].overdue, true);
  assert.match(out.spaces.personal.tasks[0].planned, /19:00$/);
  assert.deepEqual([out.spaces.work.owe[0].text, out.spaces.work.owe[0].to], ['Send the audit scope', 'Jane Whelan']);
  assert.deepEqual([out.people[jane.id].name, out.people[jane.id].role, out.people[jane.id].owe.length], ['Jane Whelan', 'Head of Audit', 1]);
  assert.equal(app.lastSeen().at, T);

  assert.equal(app.secretOk('Bearer anything'), false);
  process.env.HUB_BOOX_TOKEN = 'a-long-device-token';
  assert.equal(app.secretOk('Bearer a-long-device-token'), true);
  assert.equal(app.secretOk('Bearer a-long-device-tokeX'), false);
  assert.equal(app.secretOk(''), false);
});

test('opening a day note leaves one receipt, and Today says when a started note never reaches Drive', async () => {
  const early = T - 5 * 3600;
  assert.deepEqual(app.opened({ id: 'abcdef123456', date: TODAY, space: 'work', created: true, at: early }, T), { ok: true, title: `${TODAY} Work` });
  app.opened({ id: 'abcdef123456', date: TODAY, space: 'work', created: true, at: early }, T);
  app.opened({ id: 'zzzzzzzz9999', date: TODAY, space: 'personal', created: true, at: T - 600 }, T);
  assert.deepEqual(db.crm().prepare("SELECT module, entity_id, operation, status FROM effects ORDER BY created_at").all(), [
    { module: 'boox_app', entity_id: `${TODAY}:work`, operation: 'day_note.create', status: 'done' },
    { module: 'boox_app', entity_id: `${TODAY}:personal`, operation: 'day_note.create', status: 'done' }]);
  assert.throws(() => app.opened({ date: 'tomorrow', space: 'work' }, T), /date/);
  assert.equal(app.sync({ t: T }).days[app.BACK_DAYS].notes.work.opened, early);

  assert.match(app.health('work', T)[0].text, /hasn't reached Google Drive/);
  assert.deepEqual(app.health('personal', T), []);
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Work.pdf`)]), T);
  assert.deepEqual(app.health('work', T), []);
  assert.deepEqual(app.health('personal', T + 8 * DAY), []);
});

test('a crm.db made before day notes existed is widened once, keeping its notebooks and pages', () => {
  db._reset();
  const old = new Database(process.env.CRM_DB_PATH);
  old.exec(`CREATE TABLE notebooks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
      space TEXT CHECK(space IN ('work','personal')), kind TEXT CHECK(kind IN ('meetings','todos','journal')),
      baseline_at INTEGER NOT NULL, page_count INTEGER NOT NULL DEFAULT 0, captured_version INTEGER,
      error TEXT NOT NULL DEFAULT '', seen_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE notebook_pages (
      id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id), page_no INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, pdf BLOB NOT NULL, occurred_at INTEGER NOT NULL, is_history INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', job_id TEXT, text TEXT NOT NULL DEFAULT '',
      uncertainty TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', source_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(notebook_id, page_no, fingerprint));
    INSERT INTO notebooks (id,name,created_at,modified_at,space,kind,baseline_at,page_count) VALUES ('n','Notebook-6.pdf',1,2,'work','meetings',3,1);
    INSERT INTO notebook_pages (id,notebook_id,page_no,fingerprint,pdf,occurred_at,is_history) VALUES ('p','n',1,'f',x'00',2,1);`);
  old.close();
  const kept = db.crm().prepare('SELECT * FROM notebooks').get();
  assert.deepEqual([kept.id, kept.name, kept.space, kept.kind, kept.page_count, kept.day], ['n', 'Notebook-6.pdf', 'work', 'meetings', 1, null]);
  assert.equal(db.crm().prepare('SELECT notebook_id FROM notebook_pages').get().notebook_id, 'n');
  assert.equal(db.crm().pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.crm().prepare('PRAGMA foreign_key_check').all(), []);
  db.crm().prepare("INSERT INTO notebooks (id,name,created_at,modified_at,space,kind,baseline_at,day) VALUES ('d','x',1,1,'work','day',1,'2026-11-12')").run();
  db.crm().prepare("INSERT INTO notebook_pages (id,notebook_id,page_no,fingerprint,pdf,occurred_at,is_history) VALUES ('q','d',1,'g',x'00',2,0)").run();
  assert.throws(() => db.crm().prepare("INSERT INTO notebook_pages (id,notebook_id,page_no,fingerprint,pdf,occurred_at,is_history) VALUES ('r','missing',1,'g',x'00',2,0)").run(), /FOREIGN KEY/);
  db._reset();
  assert.equal(db.crm().prepare('SELECT COUNT(*) n FROM notebooks').get().n, 2);
});

test('writing into an old day note stays historical even when its PDF was just exported', async () => {
  const old = planner.addDays(TODAY, -10);
  db.setSetting('boox_started', String(T - 20 * DAY));
  await boox.discover(drive([file('old', `${old} Work.pdf`)]), T);
  await boox.capture(notebook('old'), await pdf(['old writing']), T);
  read('I will send the old report');
  assert.equal(db.crm().prepare('SELECT is_history FROM sources').get().is_history, 1);
});

test('device HTTP routes reject missing and wrong tokens and return uncached authenticated data', async () => {
  const express = require('express');
  const serverApp = express(); serverApp.use(express.json()); serverApp.use(require('../routes/boox-app'));
  const server = await new Promise(resolve => { const s = serverApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/crm/boox`;
  try {
    assert.equal((await fetch(`${base}/sync`)).status, 503);
    process.env.HUB_BOOX_TOKEN = 'test-device-token';
    assert.equal((await fetch(`${base}/sync`)).status, 401);
    assert.equal((await fetch(`${base}/sync`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const headers = { authorization: 'Bearer test-device-token', 'content-type': 'application/json' };
    const response = await fetch(`${base}/sync`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).days.length, app.BACK_DAYS + app.AHEAD_DAYS);
    assert.equal((await fetch(`${base}/note`, { method: 'POST', headers, body: JSON.stringify({ date: 'invalid', space: 'work' }) })).status, 400);
    const receipt = { id: 'http-test-receipt', date: TODAY, space: 'personal', created: true };
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${base}/note`, { method: 'POST', headers, body: JSON.stringify(receipt) })).status, 200);
    assert.equal(db.crm().prepare("SELECT count(*) n FROM effects WHERE module='boox_app'").get().n, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test('Claude capacity pauses page reading without exhausting retries, then resumes automatically', async () => {
  db.setSetting('boox_started', String(T - 3 * DAY));
  await boox.discover(drive([file('day', `${TODAY} Work.pdf`)]), T);
  await boox.capture(notebook('day'), await pdf(['Boox connection test. No actions.']), T);
  let job = { status: 'failed', error: 'usage_limit_reached: resets at 10:30pm' };
  const jobs = { enqueue: () => ({ jobId: 'quota-job' }), getJob: () => job };
  assert.equal(boox.enqueueNext(jobs, true, T), true);
  const retry = boox.collect(jobs, T);
  assert.equal(retry.retryAt, T + 900);
  assert.equal(db.crm().prepare('SELECT attempts FROM notebook_pages').get().attempts, 0);
  assert.equal(boox.enqueueNext(jobs, true, T + 899), false);
  assert.match(boox.health('work')[0].text, /provider capacity/);
  assert.equal(boox.enqueueNext(jobs, true, T + 900), true);
  job = { status: 'completed', result: { output: JSON.stringify({ text: 'Boox connection test. No actions.', uncertain: false }) } };
  boox.collect(jobs, T + 901);
  assert.equal(db.crm().prepare('SELECT status FROM notebook_pages').get().status, 'done');
  assert.equal(boox.readerWait(T + 901), null);
});
