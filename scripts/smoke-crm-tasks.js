'use strict';

// Run on the VPS with CRM_DB_PATH pointing to a disposable database outside
// /app/data. The temporary Google lists keep test evidence out of the live CRM.
require('dotenv').config();
const path = require('path');
const assert = require('node:assert/strict');
const fs = require('fs');
if (!process.env.CRM_DB_PATH || path.resolve(process.env.CRM_DB_PATH).startsWith(path.resolve(__dirname, '../data') + path.sep)) {
  throw new Error('Set CRM_DB_PATH to a new disposable database outside app/data');
}
if (fs.existsSync(process.env.CRM_DB_PATH)) throw new Error('Smoke database must be new');
process.env.HUB_DISABLE_JOBS = '1';
const { crm, now } = require('../lib/crm/db');
const { uuid } = require('../lib/id');
const tasks = require('../lib/crm/tasks');
const sync = require('../lib/crm/tasks-sync');
const real = require('../lib/crm/google').tasks();
const opt = { timeout: 30000, retry: false };
const lists = [];

async function effect(operation, request, fn) {
  const id = uuid();
  crm().prepare("INSERT INTO effects (id, module, entity_id, operation, request, status) VALUES (?, 'crm_tasks_smoke', 'smoke', ?, ?, 'started')").run(id, operation, JSON.stringify(request));
  let r;
  try { r = await fn(); }
  catch (err) {
    crm().prepare("UPDATE effects SET status = 'failed', result = ?, finished_at = ? WHERE id = ?").run(String(err.message), now(), id);
    throw err;
  }
  crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(r.data || {}), now(), id);
  return r.data;
}

(async () => {
  try {
    for (const space of ['Work', 'Personal']) {
      const body = { title: `Hub sync test ${space} ${uuid().slice(0, 8)}` };
      const list = await effect('list.insert', body, () => real.tasklists.insert({ requestBody: body }, opt));
      lists.push({ id: list.id, title: space });
    }
    const api = { tasks: real.tasks, tasklists: { list: async () => ({ data: { items: lists } }), insert: () => { throw new Error('Unexpected list create'); } } };
    const run = () => sync.run({ api });
    const t = tasks.create('work', { title: 'Hub sync verification', notes: 'Temporary synthetic task', due: '2026-11-02' });
    const personal = tasks.create('personal', { title: 'Personal sync verification' });
    await run();
    let local = tasks.get(t.id);
    const params = { tasklist: lists[0].id, task: local.google_id };
    let remote = (await real.tasks.get(params, opt)).data;
    assert.equal(remote.title, t.title); assert.equal(remote.due.slice(0, 10), '2026-11-02');
    assert.match(remote.notes, new RegExp(t.id));
    assert.equal(tasks.get(personal.id).google_list_id, lists[1].id);
    tasks.edit(t.id, { title: 'Edited in the Hub', due: '' }); await run();
    remote = (await real.tasks.get(params, opt)).data; assert.equal(remote.title, 'Edited in the Hub'); assert.ok(!remote.due);
    await effect('task.patch', params, () => real.tasks.patch({ ...params, requestBody: { title: 'Edited in Google', status: 'completed' } }, opt));
    await assert.rejects(() => effect('task.patch.stale-check', params, () => real.tasks.patch({ ...params,
      requestBody: { title: 'This stale write must be rejected' } }, { ...opt, headers: { 'If-Match': remote.etag } })),
      err => Number(err.response?.status || err.code) === 412);
    await run(); assert.equal(tasks.get(t.id).title, 'Edited in Google'); assert.equal(tasks.get(t.id).status, 'completed');
    tasks.edit(t.id, { status: 'needsAction' }); await run();
    assert.equal((await real.tasks.get(params, opt)).data.status, 'needsAction');
    const imported = await effect('task.insert', { tasklist: lists[1].id }, () => real.tasks.insert({ tasklist: lists[1].id, requestBody: { title: 'Created in Google' } }, opt));
    await run(); assert.ok(tasks.list('personal').some(x => x.google_id === imported.id));
    tasks.edit(t.id, { status: 'deleted' }); await run();
    assert.equal((await real.tasks.get(params, opt)).data.deleted, true);
    await effect('task.delete', { tasklist: lists[1].id, task: imported.id }, () => real.tasks.delete({ tasklist: lists[1].id, task: imported.id }, opt));
    await run(); assert.equal(crm().prepare('SELECT status FROM tasks WHERE google_id = ?').get(imported.id).status, 'deleted');
    console.log('PASS: real Google create, import, edit, due-date clear, complete, reopen and delete round trips; stale ETag rejected; Work/Personal isolated.');
  } finally {
    for (const list of lists) {
      await effect('list.delete', { tasklist: list.id }, () => real.tasklists.delete({ tasklist: list.id }, opt));
    }
    console.log(`Removed ${lists.length} temporary Google lists. Receipts: ${process.env.CRM_DB_PATH}`);
  }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
