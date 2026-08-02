'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { deferDebriefActions, runDebriefExtraction } = require('../routes/hub-debrief');
const { writeMeetingNote } = require('../lib/meeting');

const USER = '__test_debrief_knowledge_boundary';

function cleanup() {
  const h = db.hub();
  h.prepare('DELETE FROM meeting_intakes WHERE user = ?').run(USER);
  const meetingIds = h.prepare('SELECT id FROM meetings WHERE user = ?').all(USER).map(row => row.id);
  for (const meetingId of meetingIds) h.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meetingId);
  h.prepare('DELETE FROM meetings WHERE user = ?').run(USER);
  h.prepare('DELETE FROM documents WHERE user = ?').run(USER);
  h.prepare('DELETE FROM google_tasks WHERE user = ?').run(USER);
  h.prepare('DELETE FROM crm_facts WHERE user = ?').run(USER);
  // runDebriefExtraction records model usage in the shared request log. Keep
  // this fixture's policy-only request out of subsequent system-report tests.
  h.prepare("DELETE FROM request_logs WHERE user = ? AND model_key = 'debrief_extractor'").run(USER);
  h.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
  h.prepare('DELETE FROM projects WHERE user = ?').run(USER);
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(cleanup);

test('debrief actions are deferred to CRM knowledge without task projection', () => {
  const result = deferDebriefActions(['First action', 'Already done', 'Will fail'], '2026-08-02', 'session-1');

  assert.equal(result.requested, 3);
  assert.equal(result.created, 0);
  assert.equal(result.existing, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.deferred, 3);
  assert.equal(result.status, 'deferred_to_crm_knowledge');
  assert.equal(result.outcomes.every(outcome => outcome.status === 'deferred_to_crm_knowledge'), true);
});

test('daily debrief extraction persists evidence and does not create facts, tasks, or project notes', async () => {
  const h = db.hub();
  const contactId = uuid();
  const projectId = uuid();
  const sessionId = uuid();
  h.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)').run(contactId, USER, 'Known Person', '[]');
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)').run(projectId, USER, 'Known Project', 'known-project');
  h.prepare('INSERT INTO debrief_sessions (id, user, transcript, started_at) VALUES (?, ?, ?, unixepoch())')
    .run(sessionId, USER, '**You:** We should follow this up.');
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-boundary-'));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = tempVault;
  try {
    const result = await runDebriefExtraction(USER, '**You:** We should follow this up.', '2026-08-02', 'Debrief/source.md', sessionId, {
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          people: ['Known Person'],
          projects: ['Known Project'],
          actions: ['Follow up on the decision'],
        }) } }] }),
      }),
    });
    assert.equal(result.outcome, 'deferred_to_crm_knowledge');
    assert.equal(result.task_outcomes.status, 'deferred_to_crm_knowledge');
    assert.equal(result.task_outcomes.created, 0);
    assert.equal(result.task_outcomes.deferred, 1);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM crm_facts WHERE user = ?').get(USER).n, 0);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM google_tasks WHERE user = ?').get(USER).n, 0);
    assert.equal(fs.existsSync(path.join(tempVault, 'Projects', 'known-project.md')), false);
    assert.equal(fs.existsSync(path.join(tempVault, 'Debrief', 'Actions-2026-08-02.md')), false);
    const stored = JSON.parse(h.prepare('SELECT extraction FROM debrief_sessions WHERE id = ?').get(sessionId).extraction);
    assert.equal(stored.outcome, 'deferred_to_crm_knowledge');
    assert.equal(stored.actions[0], 'Follow up on the decision');
  } finally {
    if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previousVault;
    fs.rmSync(tempVault, { recursive: true, force: true });
  }
});

test('writeMeetingNote keeps explicit meeting metadata without redundant meeting-debrief facts', async () => {
  const h = db.hub();
  const contactId = uuid();
  h.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)').run(contactId, USER, 'Known Person', '[]');
  const before = h.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'meeting-debrief'").get(USER).n;
  const tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-boundary-'));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = tempVault;
  try {
    const result = await writeMeetingNote(USER, {
      title: 'Boundary meeting',
      attendees: ['Known Person'],
      myThoughts: 'A raw meeting note.',
      date: new Date('2026-08-02T12:00:00Z'),
    });
    assert.ok(result.meetingId);
    assert.equal(h.prepare('SELECT COUNT(*) AS n FROM meeting_attendees WHERE meeting_id = ? AND contact_id = ?').get(result.meetingId, contactId).n, 1);
    assert.equal(h.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'meeting-debrief'").get(USER).n, before);
  } finally {
    if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = previousVault;
    fs.rmSync(tempVault, { recursive: true, force: true });
  }
});
