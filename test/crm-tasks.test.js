'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-tasks-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const tasks = require('../lib/crm/tasks');
const sync = require('../lib/crm/tasks-sync');
const copy = x => JSON.parse(JSON.stringify(x));
let api;

function fakeGoogle() {
  let n = 0;
  const lists = [{ id: 'old', title: 'My Tasks' }, { id: 'work', title: 'Work' }, { id: 'personal', title: 'Personal' }];
  const rows = { old: [], work: [], personal: [] }, calls = [];
  const version = t => ({ ...t, etag: `v${++n}`, updated: new Date().toISOString() });
  const add = (list, fields) => { const t = version({ id: `g${++n}`, title: 'Google task', notes: '', status: 'needsAction', ...fields }); rows[list].push(t); return t; };
  const find = p => rows[p.tasklist].find(t => t.id === p.task);
  const check = (p, o) => { if (o?.headers?.['If-Match'] !== find(p).etag) throw Object.assign(new Error('Precondition Failed'), { code: 412 }); };
  return { rows, lists, calls, add, version,
    tasklists: {
      list: async p => { const start = Number(p.pageToken || 0); return { data: { items: copy(lists.slice(start, start + 2)), nextPageToken: start + 2 < lists.length ? String(start + 2) : undefined } }; },
      insert: async p => { calls.push(['list.insert', p]); const t = { id: `list${++n}`, ...p.requestBody }; lists.push(t); rows[t.id] = []; return { data: t }; },
    },
    tasks: {
      list: async p => { assert.equal(p.showCompleted, true); assert.equal(p.showHidden, true); assert.equal(p.showDeleted, true); const start = Number(p.pageToken || 0), all = rows[p.tasklist]; return { data: { items: copy(all.slice(start, start + 2)), nextPageToken: start + 2 < all.length ? String(start + 2) : undefined } }; },
      get: async p => { const t = find(p); if (!t) throw Object.assign(new Error('Not found'), { code: 404 }); return { data: copy(t) }; },
      insert: async p => { calls.push(['insert', copy(p)]); return { data: copy(add(p.tasklist, p.requestBody)) }; },
      patch: async (p, o) => { calls.push(['patch', copy(p)]); check(p, o); Object.assign(find(p), version(p.requestBody)); return { data: copy(find(p)) }; },
      delete: async (p, o) => { calls.push(['delete', copy(p)]); check(p, o); Object.assign(find(p), version({ deleted: true })); return { data: {} }; },
    },
  };
}
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); api = fakeGoogle(); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });
const run = () => sync.run({ api });

test('two-way create, edit, date clear, complete, reopen, delete; effects attributed and repeat passes idle', async () => {
  const t = tasks.create('work', { title: 'Send figures', due: '2026-11-02' });
  await run();
  let local = tasks.get(t.id), remote = api.rows.work[0];
  assert.ok(local.google_id);
  assert.match(remote.notes, new RegExp(`/crm/work/tasks/${t.id}`));
  assert.equal(remote.due, '2026-11-02T00:00:00.000Z');
  await run(); assert.equal(api.calls.length, 1);
  tasks.edit(t.id, { notes: 'Bring licence numbers', due: null });
  await run(); assert.equal(remote.due, null); assert.match(remote.notes, /Bring licence numbers/);
  Object.assign(remote, api.version({ title: 'Google title', status: 'completed', hidden: true }));
  await run(); assert.equal(tasks.get(t.id).title, 'Google title'); assert.equal(tasks.get(t.id).status, 'completed');
  tasks.edit(t.id, { status: 'needsAction' }); await run(); assert.equal(remote.status, 'needsAction');
  tasks.edit(t.id, { status: 'completed' }); await run(); assert.equal(remote.status, 'completed');
  tasks.edit(t.id, { status: 'deleted' }); await run(); assert.equal(remote.deleted, true);
  await run(); assert.equal(tasks.list('work').length, 0);
  assert.ok(db.crm().prepare('SELECT * FROM effects').all().every(e => e.module === 'crm_tasks_sync' && e.status === 'done'));
});

test('Google imports all pages, including cleared completed tasks, without writes; old lists untouched', async () => {
  for (let i = 0; i < 5; i++) api.add('work', { title: `Remote ${i}`, ...(i === 4 ? { status: 'completed', hidden: true } : {}) });
  api.add('old', { title: 'Do not import' });
  api.add('personal', { title: 'Personal task' });
  await run();
  assert.equal(tasks.list('work').length, 4); assert.equal(tasks.list('work', { status: 'completed' }).length, 1);
  assert.equal(tasks.list('personal').length, 1); assert.equal(api.calls.length, 0);
  const imported = tasks.list('personal')[0]; tasks.edit(imported.id, { title: 'Changed here' }); await run();
  assert.equal(api.rows.personal[0].title, 'Changed here');
});

test('independent changes merge; same-field conflict preserves the Hub value for review', async () => {
  const t = tasks.create('work', { title: 'Baseline', notes: 'Original' }); await run();
  const r = api.rows.work[0];
  tasks.edit(t.id, { title: 'Hub title' }); Object.assign(r, api.version({ notes: 'Google notes' }));
  await run(); assert.equal(r.title, 'Hub title'); assert.match(r.notes, /Google notes/);
  tasks.edit(t.id, { title: 'Hub conflicting title' }); Object.assign(r, api.version({ title: 'Google conflicting title' }));
  await run(); assert.equal(tasks.get(t.id).title, 'Google conflicting title');
  assert.equal(JSON.parse(tasks.get(t.id).conflict).title.hub, 'Hub conflicting title');
  tasks.edit(t.id, { title: 'Chosen final title' }); await run(); assert.equal(tasks.get(t.id).conflict, '');
});

test('remote deletion wins over queued local edits and stays terminal; missing tombstone confirmed with GET', async () => {
  const t = tasks.create('work', { title: 'Terminal' }); await run();
  tasks.edit(t.id, { title: 'Stale edit' }); api.rows.work.splice(0, 1);
  await run(); assert.equal(tasks.get(t.id).status, 'deleted');
  await run(); assert.equal(api.calls.filter(c => c[0] === 'insert').length, 1);
  assert.throws(() => tasks.edit(t.id, { status: 'needsAction' }), /deleted/);
});

test('a failed page cannot trigger missing-task deletes or writes; Personal still syncs', async () => {
  const t = tasks.create('work', { title: 'Keep me' }); await run(); tasks.edit(t.id, { title: 'Queued' });
  const original = api.tasks.list;
  api.tasks.list = async p => { if (p.tasklist === 'work') throw new Error('network down'); return original(p); };
  tasks.create('personal', { title: 'Personal still runs' });
  await assert.rejects(run(), /network down/);
  assert.equal(tasks.get(t.id).status, 'needsAction'); assert.equal(api.rows.work[0].title, 'Keep me');
  assert.equal(api.rows.personal.length, 1); assert.match(require('../lib/crm/runs').all().tasks_sync.last_error, /network down/);
});

test('lost create response recovers by marker; local edit while request was in flight survives', async () => {
  const t = tasks.create('work', { title: 'Original request' });
  const insert = api.tasks.insert;
  api.tasks.insert = async p => { await insert(p); tasks.edit(t.id, { title: 'Edited during request' }); throw new Error('socket hang up'); };
  await assert.rejects(run(), /socket hang up/); assert.equal(tasks.get(t.id).google_id, null);
  api.tasks.insert = insert;
  await run(); assert.equal(api.rows.work.length, 1); assert.equal(api.rows.work[0].title, 'Edited during request');
  assert.equal(tasks.get(t.id).revision, tasks.get(t.id).synced_revision);
});

test('uncertain create with no remote match pauses, never blindly inserts again', async () => {
  const t = tasks.create('work', { title: 'Uncertain' }); let attempts = 0;
  api.tasks.insert = async () => { attempts++; throw new Error('timeout'); };
  await assert.rejects(run(), /timeout/); await assert.rejects(run(), /Automatic recreation is paused/);
  assert.equal(attempts, 1); assert.match(tasks.get(t.id).sync_error, /duplicate/);
});

test('ETag blocks mid-sync remote edits; a later pass merges the newer copy', async () => {
  const t = tasks.create('work', { title: 'First' }); await run(); tasks.edit(t.id, { title: 'Hub new' });
  const patch = api.tasks.patch;
  api.tasks.patch = async (p, o) => { Object.assign(api.rows.work[0], api.version({ title: 'Google race' })); return patch(p, o); };
  await assert.rejects(run(), /Google changed/); assert.equal(api.rows.work[0].title, 'Google race');
  api.tasks.patch = patch; await run(); assert.equal(tasks.get(t.id).title, 'Google race');
  assert.match(tasks.get(t.id).conflict, /Hub new/);
});

test('successful write acknowledgements preserve edits made while awaiting Google', async () => {
  const t = tasks.create('work', { title: 'Original' });
  const insert = api.tasks.insert;
  api.tasks.insert = async p => { const r = await insert(p); tasks.edit(t.id, { title: 'Later edit' }); return r; };
  await run(); assert.equal(tasks.get(t.id).title, 'Later edit'); assert.equal(tasks.detail(tasks.get(t.id)).pending, true);
  await run(); assert.equal(api.rows.work[0].title, 'Later edit'); assert.equal(tasks.detail(tasks.get(t.id)).pending, false);
});

test('list reuse, missing-list refusal, duplicate names, and lost list-create recovery', async () => {
  await run(); api.lists.splice(api.lists.findIndex(l => l.id === 'work'), 1);
  await assert.rejects(run(), /list is missing/); assert.equal(api.calls.length, 0);
  db.crm().prepare('DELETE FROM settings').run(); api.lists.push({ id: 'p2', title: 'Personal' });
  await assert.rejects(run(), /More than one/);
  api.lists.splice(api.lists.findIndex(l => l.id === 'p2'), 1);
  db.crm().prepare('DELETE FROM settings').run(); api.lists.splice(api.lists.findIndex(l => l.title === 'Work'), 1);
  db.crm().prepare('DELETE FROM effects').run();
  const insert = api.tasklists.insert;
  api.tasklists.insert = async p => { await insert(p); throw new Error('lost list reply'); };
  await assert.rejects(run(), /lost list reply/); api.tasklists.insert = insert;
  await run(); assert.equal(api.lists.filter(l => l.title === 'Work').length, 1);
});

test('one sync lease across processes and stale leases expire', async () => {
  db.setSetting('tasks_sync_lock', JSON.stringify({ token: 'other', until: db.now() + 60 }));
  assert.deepEqual(await run(), { busy: true });
  db.setSetting('tasks_sync_lock', JSON.stringify({ token: 'dead', until: db.now() - 1 }));
  await run(); assert.equal(db.setting('tasks_sync_lock'), null);
});

test('task context derives from current task evidence, belongs to one space, and reaches organisation and department', () => {
  const identity = require('../lib/crm/identity'), orgs = require('../lib/crm/orgs'), review = require('../lib/crm/review');
  const org = orgs.createOrg('work', 'Example Hospital');
  const p = identity.createPerson({ space: 'work', name: 'Alice Sample', orgId: org.id });
  const dept = orgs.addUnit(org.id, { name: 'IT' }); orgs.setPersonUnit(p.id, dept.id);
  const project = review.createProject('work', 'Migration');
  const other = review.createProject('personal', 'Home');
  assert.throws(() => tasks.create('work', { title: 'Bad link', projectId: other.id }), /same space/);
  assert.throws(() => tasks.create('work', { title: 'Bad date', due: '2026-02-30' }), /valid due date/);
  const t = tasks.create('work', { title: 'Ask Alice Sample about Migration', personId: p.id, projectId: project.id });
  assert.equal(tasks.list('work', { orgId: org.id }).length, 1);
  assert.equal(tasks.list('work', { unitId: dept.id }).length, 1);
  const auto = tasks.create('work', { title: 'Alice Sample will send the Migration figures' });
  require('../lib/crm/atoms').applyAtoms(auto.source_id, [{ statement: 'Alice Sample will send the Migration figures', quote: 'Alice Sample will send the Migration figures', kind: 'promise', confidence: 'high', people: ['Alice Sample'], projects: ['Migration'] }]);
  assert.equal(tasks.list('work', { personId: p.id }).length, 2);
  assert.equal(tasks.list('work', { projectId: project.id }).length, 2);
  tasks.edit(auto.id, { title: 'Book a taxi' }); assert.equal(tasks.list('work', { personId: p.id }).length, 1);
  assert.throws(() => tasks.edit(t.id, { title: 'Stale browser', revision: 0 }), /Reload/);
});

test('task screens and forms render, enforce space/auth/origin, escape text and preserve rejected input', async () => {
  const express = require('express'); const app = express();
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs'); app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: req.headers['x-no-auth'] ? null : 'douglas' }; next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = tasks.create('work', { title: '<script>alert(1)</script>' });
    for (const route of ['/crm/work/tasks', '/crm/personal/tasks', '/crm/work/tasks?status=completed', '/crm/work/tasks/new', `/crm/work/tasks/${t.id}`]) {
      const r = await fetch(base + route); assert.equal(r.status, 200, route); assert.match(await r.text(), /<h1/);
    }
    const html = await (await fetch(base + `/crm/work/tasks/${t.id}`)).text(); assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.equal((await fetch(base + `/crm/personal/tasks/${t.id}`)).status, 404);
    assert.equal((await fetch(base + '/crm/work/tasks', { headers: { 'x-no-auth': '1' }, redirect: 'manual' })).status, 302);
    const post = (route, data, origin = base) => fetch(base + route, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data), redirect: 'manual' });
    assert.equal((await post(`/crm/work/tasks/${t.id}/complete`, {}, 'https://evil.invalid')).status, 403);
    assert.equal((await post(`/crm/personal/tasks/${t.id}/complete`, {})).status, 404);
    const bad = await post('/crm/work/tasks', { title: 'Keep my draft', due: 'invalid' }); assert.equal(bad.status, 400); assert.match(await bad.text(), /Keep my draft/);
    assert.equal((await post(`/crm/work/tasks/${t.id}/complete`, { revision: t.revision })).status, 302); assert.equal(tasks.get(t.id).status, 'completed');
  } finally { await new Promise(r => server.close(r)); }
});


test('full-size imported Google notes survive completion without truncation', async () => {
  api.add('work', { notes: 'a'.repeat(8192) }); await run();
  const t = tasks.list('work')[0]; tasks.edit(t.id, { status: 'completed' }); await run();
  assert.equal(api.rows.work[0].notes.length, 8192); assert.equal(api.rows.work[0].status, 'completed');
});
