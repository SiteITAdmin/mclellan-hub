'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { routeTasks, routeTask, MIN_SCORE, MIN_MARGIN } = require('../lib/task-router');

const USER = '__test_task_router_conservative';

function cleanup() {
  const h = db.hub();
  h.prepare('DELETE FROM knowledge_receipts WHERE user = ? AND stage = \'task_router\'').run(USER);
  h.prepare('DELETE FROM google_tasks WHERE user = ?').run(USER);
  h.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
}

test.beforeEach(cleanup);
test.after(cleanup);

function task(title) {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, title, status, source)
    VALUES (?, ?, ?, ?, 'needsAction', 'manual')
  `).run(id, USER, `google-${id}`, title);
  return id;
}

test('strong routing mutates once and records a routed receipt', async () => {
  const contactId = uuid();
  db.hub().prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run(contactId, USER, 'Dad', '[]');
  const taskId = task('Get Dad medicine');
  const queryAtoms = async () => [{
    subject_kind: 'contact', subject_id: contactId, subject_label: 'Dad', score: 0.82,
  }];

  const first = await routeTasks(USER, { queryAtoms });
  assert.equal(first.routed, 1);
  assert.equal(db.hub().prepare('SELECT contact_id FROM google_tasks WHERE id = ?').get(taskId).contact_id, contactId);
  const receipt = db.hub().prepare(`
    SELECT * FROM knowledge_receipts WHERE user = ? AND source_id = ? AND stage = 'task_router'
  `).get(USER, taskId);
  assert.equal(receipt.status, 'routed');
  assert.match(receipt.summary, /Dad/);
  assert.deepEqual(JSON.parse(receipt.payload).mutation, { field: 'contact_id', value: contactId });

  const second = await routeTasks(USER, { queryAtoms });
  assert.equal(second.considered, 0, 'already attached tasks stay idempotent');
});

test('ambiguous evidence produces a review receipt without mutation', async () => {
  const contactA = uuid();
  const contactB = uuid();
  db.hub().prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)').run(contactA, USER, 'A', '[]');
  db.hub().prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)').run(contactB, USER, 'B', '[]');
  const taskId = task('Handle family request');
  const result = await routeTasks(USER, {
    queryAtoms: async () => [
      { subject_kind: 'contact', subject_id: contactA, subject_label: 'A', score: MIN_SCORE + 0.08 },
      { subject_kind: 'contact', subject_id: contactB, subject_label: 'B', score: MIN_SCORE + 0.08 - MIN_MARGIN / 2 },
    ],
  });
  assert.equal(result.routed, 0);
  assert.equal(result.review, 1);
  assert.equal(db.hub().prepare('SELECT contact_id, company_id, project_slug FROM google_tasks WHERE id = ?').get(taskId).contact_id, null);
  const receipt = db.hub().prepare(`
    SELECT status, payload FROM knowledge_receipts WHERE user = ? AND source_id = ? AND stage = 'task_router'
  `).get(USER, taskId);
  assert.equal(receipt.status, 'review');
  assert.match(JSON.parse(receipt.payload).reason, /margin/);
});

test('low-score routing remains observable as review and task failures are errors', async () => {
  const lowTaskId = task('Unrelated vague task');
  const low = await routeTasks(USER, {
    queryAtoms: async () => [{ subject_kind: 'contact', subject_id: uuid(), subject_label: 'Unknown', score: 0.2 }],
  });
  assert.equal(low.routed, 0);
  assert.equal(low.review, 1);
  assert.equal(db.hub().prepare('SELECT status FROM knowledge_receipts WHERE source_id = ? AND stage = \'task_router\'').get(lowTaskId).status, 'review');

  const errorTaskId = task('Will fail to embed');
  const failed = await routeTasks(USER, { queryAtoms: async () => { throw new Error('embedding unavailable'); } });
  assert.equal(failed.errors.some(error => error.taskId === errorTaskId), true);
  assert.equal(db.hub().prepare('SELECT status FROM knowledge_receipts WHERE source_id = ? AND stage = \'task_router\'').get(errorTaskId).status, 'error');
});

test('routeTask preserves the public null-on-uncertain contract', async () => {
  const result = await routeTask(USER, { title: 'No clear owner' }, {
    queryAtoms: async () => [{ subject_kind: 'contact', subject_id: uuid(), score: MIN_SCORE - 0.01 }],
  });
  assert.equal(result, null);
});
