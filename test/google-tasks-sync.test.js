'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tasks-sync-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const { syncTasks, syncTasksIfStale } = require('../lib/google-tasks');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seedProjects(user, lists) {
  const hub = db.hub();
  for (const l of lists) {
    hub.prepare(
      'INSERT INTO projects (id, user, name, slug, google_task_list_id) VALUES (?, ?, ?, ?, ?)'
    ).run(`${user}-${l.slug}`, user, l.name, l.slug, l.id);
  }
}

test('syncTasks pulls every list in parallel and compiles the cache correctly', async () => {
  const user = 'sync-parallel-test';
  const lists = [
    { id: 'listA', name: 'Project A', slug: 'project-a' },
    { id: 'listB', name: 'Project B', slug: 'project-b' },
    { id: 'listC', name: 'Project C', slug: 'project-c' },
  ];
  seedProjects(user, lists);

  // A locally-open task absent from every Google list must be marked completed.
  db.hub().prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, task_list_id, title, status, source, synced_at)
    VALUES (?, ?, ?, ?, ?, 'needsAction', 'google', unixepoch())
  `).run('local-gone', user, 'gone-google-id', 'listA', 'Vanished task');

  const itemsByList = {
    listA: [
      { id: 'a1', title: 'Parent A', position: '1' },
      { id: 'a2', title: 'Child A', parent: 'a1', position: '2' },
    ],
    listB: [{ id: 'b1', title: 'Task B', due: '2026-08-20T00:00:00.000Z', position: '1' }],
    listC: [{ id: 'c1', title: 'Task C', position: '1' }],
  };

  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    tasklists: {
      list: async () => ({ data: { items: lists.map((l) => ({ id: l.id, title: l.name })) } }),
    },
    tasks: {
      list: async ({ tasklist }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(10);
        inFlight -= 1;
        return { data: { items: itemsByList[tasklist] || [] } };
      },
    },
  };

  await syncTasks(user, { tasksClient: client });

  assert.ok(maxInFlight > 1, `lists were pulled serially (max in-flight ${maxInFlight})`);
  assert.ok(maxInFlight <= 5, `pull concurrency ${maxInFlight} exceeded the bound`);

  const hub = db.hub();
  const rows = hub.prepare(
    'SELECT google_task_id, title, project_slug, parent_id, status, due FROM google_tasks WHERE user = ? ORDER BY google_task_id'
  ).all(user);
  const byGoogleId = Object.fromEntries(rows.map((r) => [r.google_task_id, r]));

  assert.equal(byGoogleId.a1.project_slug, 'project-a');
  assert.equal(byGoogleId.b1.project_slug, 'project-b');
  assert.equal(byGoogleId.c1.project_slug, 'project-c');
  assert.equal(byGoogleId.b1.due, '2026-08-20');

  // Parent resolved to the local id of a1 (parent seen in same sync).
  const a1LocalId = hub.prepare('SELECT id FROM google_tasks WHERE user = ? AND google_task_id = ?')
    .get(user, 'a1').id;
  assert.equal(byGoogleId.a2.parent_id, a1LocalId);

  // The task no longer present in any Google list is now completed.
  assert.equal(byGoogleId['gone-google-id'].status, 'completed');
});

test('syncTasksIfStale skips a fresh sync and pulls again once stale', async () => {
  const user = 'sync-throttle-test';
  let tasklistPulls = 0;
  const client = {
    tasklists: {
      list: async () => { tasklistPulls += 1; return { data: { items: [] } }; },
    },
    tasks: { list: async () => ({ data: { items: [] } }) },
  };

  const first = await syncTasksIfStale(user, 60000, { tasksClient: client });
  assert.equal(first, true, 'first call should sync');
  assert.equal(tasklistPulls, 1);

  const second = await syncTasksIfStale(user, 60000, { tasksClient: client });
  assert.equal(second, false, 'second call within the window should skip');
  assert.equal(tasklistPulls, 1, 'no extra Google pull while fresh');

  const forced = await syncTasksIfStale(user, 0, { tasksClient: client });
  assert.equal(forced, true, 'a zero window is always stale');
  assert.equal(tasklistPulls, 2, 'stale window triggers a fresh pull');
});
