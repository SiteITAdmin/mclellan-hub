'use strict';

// Synthetic proof for openTaskDuplicateMatch — the source-agnostic open-corpus
// duplicate guard. Hermetic: the semantic-search and adjudicator are injected,
// so the test is deterministic and needs no Ollama or model plane.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-open-dedup-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { _test } = require('../lib/crm-knowledge-engine');
const { openTaskDuplicateMatch } = _test;

const USER = 'open-dedup-test';

test.before(() => {
  const hub = db.hub();
  const ins = hub.prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, task_list_id, title, status, source, deleted_at)
    VALUES (?, ?, ?, '@default', ?, ?, 'crm-engine', ?)
  `);
  // Genuine open task originally extracted from a MEETING transcript.
  ins.run('t-meeting-hld', USER, 'g-hld', 'Return the tidy HLD document and progress approval and sign-off', 'needsAction', null);
  // A distinct open task naming Alec — must never merge with an Alan action.
  ins.run('t-alec', USER, 'g-alec', 'Chase Alec for firm pilot-PC delivery dates', 'needsAction', null);
  // A task that has since been COMPLETED: its open_task vector may still be in
  // the index (stale), but it must not be treated as a live-open duplicate.
  ins.run('t-ghost', USER, 'g-ghost', 'Draft the leaver lifecycle policy', 'completed', null);
});

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a forwarded-briefing action links to the existing meeting task instead of creating a duplicate', async () => {
  // The M365 brief was forwarded; its paraphrased action re-enters projection.
  const action = { title: 'Return the HLD', evidence: 'Forwarded M365 Operations & Security Brief line' };
  const semanticSearchFn = async () => [{ source_id: 't-meeting-hld', score: 0.86 }]; // mid band
  const adjudicateFn = async () => true; // model confirms: same concrete action
  const match = await openTaskDuplicateMatch(USER, action, { semanticSearchFn, adjudicateFn });
  assert.ok(match, 'expected a duplicate match');
  assert.equal(match.taskId, 't-meeting-hld');
  assert.equal(match.method, 'semantic_adjudicated');
});

test('an exact restatement dedups on the title layer with no embeddings available', async () => {
  const action = { title: '  return the TIDY   HLD document and progress approval and sign-off ' };
  const semanticSearchFn = async () => { throw new Error('embeddings down'); }; // must not be needed
  const match = await openTaskDuplicateMatch(USER, action, { semanticSearchFn, adjudicateFn: async () => false });
  assert.ok(match, 'title layer should match before any embedding call');
  assert.equal(match.taskId, 't-meeting-hld');
  assert.equal(match.method, 'title');
});

test('distinct people are never merged — an Alan action does not collapse into the Alec task', async () => {
  const action = { title: 'Chase Alan for firm pilot-PC delivery dates' };
  const semanticSearchFn = async () => [{ source_id: 't-alec', score: 0.88 }]; // mid band, high wording overlap
  const adjudicateFn = async () => false; // model: different person -> not the same action
  const match = await openTaskDuplicateMatch(USER, action, { semanticSearchFn, adjudicateFn });
  assert.equal(match, null, 'Alan action must survive as its own task');
});

test('a stale vector for a since-completed task cannot cause a false open-dedup', async () => {
  const action = { title: 'Draft the leaver lifecycle policy' };
  // Even a near-perfect semantic hit is ignored when the id is not live-open.
  const semanticSearchFn = async () => [{ source_id: 't-ghost', score: 0.99 }];
  const adjudicateFn = async () => { throw new Error('adjudicator should not run for a non-open hit'); };
  const match = await openTaskDuplicateMatch(USER, action, { semanticSearchFn, adjudicateFn });
  assert.equal(match, null, 'a completed task is not an open duplicate');
});

test('an unambiguous paraphrase auto-dedups above the safe floor without adjudication', async () => {
  const action = { title: 'Return tidy HLD doc and progress the approval + sign-off' };
  const semanticSearchFn = async () => [{ source_id: 't-meeting-hld', score: 0.95 }]; // >= auto floor
  let adjudicated = false;
  const adjudicateFn = async () => { adjudicated = true; return false; };
  const match = await openTaskDuplicateMatch(USER, action, { semanticSearchFn, adjudicateFn });
  assert.ok(match);
  assert.equal(match.method, 'semantic');
  assert.equal(adjudicated, false, 'auto floor must not spend a model call');
});

test('projectOneAction is wired to the open-corpus guard and treats a hit as an existing task, not a new one', () => {
  // Static wiring proof: the guard runs inside projectOneAction and its hit maps
  // to the terminal existing_open_task disposition (not task_created).
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'crm-knowledge-engine.js'), 'utf8');
  assert.match(src, /openTaskDuplicateMatchFn\s*=\s*openTaskDuplicateMatch/, 'default dependency wired');
  assert.match(src, /const openDuplicate = await openTaskDuplicateMatchFn\(user, action\)/, 'guard invoked in projectOneAction');
  assert.match(src, /disposition:\s*'existing_open_task',\s*reason:\s*'duplicate_of_open_task'/, 'hit links to existing task');
});
