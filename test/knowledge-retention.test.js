'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { upsertAtom, atomsForEntity } = require('../lib/atoms');
const { runLint, isImmutablePredicate, LINT_CONTEXT_KEY } = require('../lib/knowledge-lint');
const { textSearchAtoms } = require('../lib/knowledge-synthesis');

const USER = '__test_retention';
const DAY = 86400;

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM crm_context WHERE user = ?').run(USER);
}

function backdate(id, daysAgo) {
  db.hub().prepare('UPDATE knowledge_atoms SET last_confirmed = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - daysAgo * DAY, id);
}

function getAtom(id) {
  return db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(id);
}

test.after(cleanup);
test.before(cleanup);

test('immutable predicates never decay or go stale', () => {
  const dob = upsertAtom(USER, {
    subjectKind: 'contact', subjectId: 'c-alister', subjectLabel: 'Alister McLellan',
    predicate: 'date_of_birth', value: '14 February 1948', confidence: 0.9,
  });
  const kin = upsertAtom(USER, {
    subjectKind: 'contact', subjectId: 'c-alister', subjectLabel: 'Alister McLellan',
    predicate: 'father_of', value: 'Douglas McLellan', confidence: 0.9,
  });
  backdate(dob, 400);
  backdate(kin, 400);

  runLint(USER);

  for (const id of [dob, kin]) {
    const a = getAtom(id);
    assert.equal(a.status, 'active');
    assert.equal(a.confidence, 0.9);
  }
  assert.ok(isImmutablePredicate('date_of_birth'));
  assert.ok(isImmutablePredicate('Father_Of'));
  assert.ok(!isImmutablePredicate('lives_at'));
});

test('mutable facts decay past 180 days and go stale past 365', () => {
  const decaying = upsertAtom(USER, {
    subjectKind: 'contact', subjectId: 'c-alister', subjectLabel: 'Alister McLellan',
    predicate: 'lives_at', value: '12 Harbour Road', confidence: 0.8,
  });
  const dying = upsertAtom(USER, {
    subjectKind: 'contact', subjectId: 'c-alister', subjectLabel: 'Alister McLellan',
    predicate: 'attends', value: 'Tuesday swimming club', confidence: 0.7,
  });
  backdate(decaying, 200);
  backdate(dying, 400);

  const result = runLint(USER);

  assert.ok(getAtom(decaying).confidence < 0.8);
  assert.equal(getAtom(decaying).status, 'active');
  assert.equal(getAtom(dying).status, 'stale');
  assert.ok(result.decayed >= 2);
  assert.ok(result.staled >= 1);
});

test('lint writes a summary to crm_context for the system report', () => {
  const row = db.hub().prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?')
    .get(USER, LINT_CONTEXT_KEY);
  assert.ok(row, 'lint summary missing from crm_context');
  const summary = JSON.parse(row.value);
  assert.ok(typeof summary.ranAt === 'number');
  assert.ok(Array.isArray(summary.newlyStale));
  assert.ok(summary.newlyStale.some(a => a.value.includes('swimming')));
});

test('stale knowledge never disappears: still found by search and history views', () => {
  const staleAtoms = db.hub().prepare(
    `SELECT * FROM knowledge_atoms WHERE user = ? AND status = 'stale'`
  ).all(USER);
  assert.ok(staleAtoms.length >= 1);

  const hits = textSearchAtoms(USER, 'swimming club');
  assert.ok(hits.some(a => a.status === 'stale' && a.value.includes('swimming')),
    'stale atom not returned by Ask the Hub text search');

  const defaultView = atomsForEntity(USER, 'contact', 'c-alister');
  assert.ok(!defaultView.some(a => a.status === 'stale'), 'stale atom leaked into default view');

  const historyView = atomsForEntity(USER, 'contact', 'c-alister', { includeStale: true });
  assert.ok(historyView.some(a => a.status === 'stale'), 'stale atom missing from history view');
});

test('the daily system report surfaces what went out of view', () => {
  const { knowledgeSection } = require('../lib/system-report');
  const section = knowledgeSection(USER);
  assert.match(section, /^KNOWLEDGE\n/);
  assert.match(section, /stale \(out of view, never deleted/);
  assert.match(section, /Newly out of view/);
  assert.match(section, /swimming/);
});

test('a stale atom is revived when the fact reappears in a new source', () => {
  const revived = upsertAtom(USER, {
    subjectKind: 'contact', subjectId: 'c-alister', subjectLabel: 'Alister McLellan',
    predicate: 'attends', value: 'Tuesday swimming club', confidence: 0.7,
    sourceRef: { kind: 'meeting_intake', id: 'mi-new' },
  });
  const a = getAtom(revived);
  assert.equal(a.status, 'active');
  assert.ok(a.last_confirmed > Math.floor(Date.now() / 1000) - 60);
});
