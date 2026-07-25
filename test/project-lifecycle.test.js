'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  closedProjectIds, listProjects, isProjectClosed, renameProject,
} = require('../lib/project-lifecycle');

function fixture() {
  const hub = new Database(':memory:');
  hub.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, user TEXT, name TEXT, slug TEXT, context_depth INTEGER, is_cv_context INTEGER);
    CREATE TABLE knowledge_atoms (id TEXT PRIMARY KEY, user TEXT, subject_kind TEXT, subject_id TEXT, subject_label TEXT, predicate TEXT, value TEXT, status TEXT, derived_by TEXT, updated_at INTEGER);
    CREATE TABLE google_tasks (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE email_summaries (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE meeting_intakes (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE crm_facts (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE inbound_email_records (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE request_logs (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE task_extraction_feedback (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
    CREATE TABLE project_report_schedules (id TEXT PRIMARY KEY, user TEXT, project_slug TEXT);
  `);
  hub.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, 20, 0)').run('old', 'douglas', 'Old name', 'old-name');
  hub.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, 20, 0)').run('open', 'douglas', 'Open name', 'open-name');
  return hub;
}

test('closed projects are retained but omitted from active lists', () => {
  const hub = fixture();
  hub.prepare('INSERT INTO knowledge_atoms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())')
    .run('atom', 'douglas', 'project', 'old', 'Old name', 'status', 'closed', 'active', 'manual');
  assert.deepEqual([...closedProjectIds(hub, 'douglas')], ['old']);
  assert.equal(isProjectClosed(hub, 'douglas', 'old'), true);
  assert.deepEqual(listProjects(hub, 'douglas').map(p => p.id), ['open']);
  assert.equal(listProjects(hub, 'douglas', { includeClosed: true }).length, 2);
  hub.close();
});

test('rename updates slug projections and project atom labels atomically', () => {
  const hub = fixture();
  for (const table of ['google_tasks', 'email_summaries', 'meeting_intakes', 'crm_facts', 'inbound_email_records', 'request_logs', 'task_extraction_feedback', 'project_report_schedules']) {
    hub.prepare(`INSERT INTO ${table} VALUES (?, ?, ?)`).run(table, 'douglas', 'old-name');
  }
  hub.prepare('INSERT INTO knowledge_atoms VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())')
    .run('atom', 'douglas', 'project', 'old', 'Old name', 'scope', 'A scope', 'active', 'manual');
  const result = renameProject(hub, { user: 'douglas', projectId: 'old', name: 'New name', slug: 'new-name' });
  assert.equal(result.referencesUpdated, 8);
  assert.deepEqual(hub.prepare('SELECT name, slug FROM projects WHERE id = ?').get('old'), { name: 'New name', slug: 'new-name' });
  assert.equal(hub.prepare('SELECT subject_label FROM knowledge_atoms WHERE id = ?').get('atom').subject_label, 'New name');
  assert.equal(hub.prepare("SELECT count(*) AS n FROM google_tasks WHERE project_slug = 'new-name'").get().n, 1);
  hub.close();
});
