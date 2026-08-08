'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  CROSS_ENTITY_MAX_TOKENS,
  CROSS_ENTITY_MAX_INSIGHTS,
  normaliseCrossEntityInsights,
  mergeCrossEntityInsights,
  gatherCrossEntityEvidence,
} = require('../lib/knowledge-synthesis');

const USER = '__test_cross_entity_synthesis_discipline';

const atoms = [
  { id: 'atom-a', subject_kind: 'project', subject_label: 'Dad care', predicate: 'needs', value: 'weekly medication collection' },
  { id: 'atom-b', subject_kind: 'contact', subject_label: 'Catriona', predicate: 'coordinates', value: 'weekly medication collection' },
  { id: 'atom-c', subject_kind: 'task', subject_label: 'Medication task', predicate: 'recurs', value: 'weekly medication collection' },
];

function cleanup() {
  db.hub().prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
}

// mergeCrossEntityInsights retires a prior insight when its evidence atoms are
// no longer active. These tests seed the cited atoms as real active rows so a
// kept insight is not spuriously retired.
function seedAtoms(ids) {
  const hub = db.hub();
  const ins = hub.prepare(`
    INSERT OR IGNORE INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?,?,?,NULL,?,?,?,?,?, 'active', 'test', ?, ?, ?)
  `);
  const ts = Math.floor(Date.now() / 1000);
  for (const id of ids) ins.run(id, USER, 'contact', id, 'x', id, '[]', 0.9, ts, ts, ts);
}

function insightRows() {
  return db.hub().prepare(
    `SELECT subject_label, predicate, source_refs, confidence FROM knowledge_atoms WHERE user = ? AND subject_kind = 'insight' ORDER BY subject_label`
  ).all(USER);
}

function makeInsight(title, evidenceAtomIds, confidence = 0.8, type = 'connection') {
  return normaliseCrossEntityInsights([{
    type, title,
    detail: `${title}: an independently useful cross-entity connection with sufficient cited evidence to change what should be done.`,
    evidence_atom_ids: evidenceAtomIds,
    confidence,
  }], atoms);
}

test.beforeEach(cleanup);
test.after(cleanup);

test('cross-entity synthesis has a bounded completion budget', () => {
  assert.equal(CROSS_ENTITY_MAX_TOKENS, 8000);
});

test('only source-backed cross-entity insights are accepted', () => {
  const insights = normaliseCrossEntityInsights([
    {
      type: 'connection',
      title: 'Medication coordination loop',
      detail: 'Catriona and the Dad-care project describe the same recurring medication collection. It should be viewed as one supported care workflow.',
      entities: ['Dad care', 'Catriona'],
      evidence_atom_ids: ['atom-a', 'atom-b'],
      confidence: 0.91,
    },
    {
      type: 'pattern',
      title: 'Unsupported pattern',
      detail: 'This must not be written because one cited atom was invented.',
      evidence_atom_ids: ['atom-a', 'atom-b', 'not-an-atom'],
      confidence: 0.8,
    },
  ], atoms);

  assert.equal(insights.length, 1);
  assert.deepEqual(insights[0].evidenceAtomIds, ['atom-a', 'atom-b']);
});

test('source-backed insight candidates are not truncated to a fixed quota', () => {
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    type: 'connection',
    title: `Distinct connection ${index + 1}`,
    detail: `This independently useful connection has sufficient evidence for item ${index + 1}. It changes how the related work should be understood.`,
    evidence_atom_ids: ['atom-a', 'atom-b'],
    confidence: 0.8,
  }));

  assert.equal(normaliseCrossEntityInsights(candidates, atoms).length, 16);
});

test('replacing insights preserves exact atom provenance', () => {
  const insights = normaliseCrossEntityInsights([{
    type: 'workflow',
    title: 'Medication collection workflow',
    detail: 'The same medication collection appears in project, contact, and task evidence. It should be managed as one visible recurring workflow.',
    entities: ['Dad care', 'Catriona', 'Medication task'],
    evidence_atom_ids: ['atom-a', 'atom-b', 'atom-c'],
    confidence: 0.88,
  }], atoms);

  const result = mergeCrossEntityInsights(USER, insights);
  assert.equal(result.written, 1);

  const row = db.hub().prepare(`
    SELECT subject_kind, subject_label, predicate, source_refs
      FROM knowledge_atoms
     WHERE user = ? AND subject_kind = 'insight'
  `).get(USER);
  assert.equal(row.subject_kind, 'insight');
  assert.equal(row.subject_label, 'Medication collection workflow');
  assert.equal(row.predicate, 'workflow');
  assert.deepEqual(JSON.parse(row.source_refs), [
    { kind: 'knowledge_atom', id: 'atom-a' },
    { kind: 'knowledge_atom', id: 'atom-b' },
    { kind: 'knowledge_atom', id: 'atom-c' },
  ]);
});

test('a prior insight is kept when a later run does not resurface it', () => {
  seedAtoms(['atom-a', 'atom-b', 'atom-c']);
  // Night 1: an old-meets-new connection is discovered.
  const first = mergeCrossEntityInsights(USER, makeInsight('June-August link', ['atom-a', 'atom-b']));
  assert.equal(first.written, 1);
  // Night 2: the seed has moved on; a different connection is found, and the
  // first must NOT be wiped just because it was not rediscovered.
  const second = mergeCrossEntityInsights(USER, makeInsight('Different link', ['atom-b', 'atom-c']));
  assert.equal(second.written, 1);
  assert.equal(second.kept, 1, 'the earlier insight survives the second run');
  const titles = insightRows().map(r => r.subject_label);
  assert.deepEqual(titles, ['Different link', 'June-August link']);
});

test('rediscovering the same connection refreshes rather than duplicates', () => {
  seedAtoms(['atom-a', 'atom-b']);
  mergeCrossEntityInsights(USER, makeInsight('Same connection', ['atom-a', 'atom-b'], 0.7));
  const again = mergeCrossEntityInsights(USER, makeInsight('Same connection', ['atom-a', 'atom-b'], 0.95));
  assert.equal(again.retired, 1, 'the prior identical-evidence insight is superseded');
  assert.equal(again.written, 1);
  const rows = insightRows();
  assert.equal(rows.length, 1, 'no duplicate row for the same connection');
  assert.equal(rows[0].confidence, 0.95, 'the refreshed confidence wins');
});

test('an insight is retired once its cited atoms are no longer active', () => {
  seedAtoms(['atom-a', 'atom-b']);
  mergeCrossEntityInsights(USER, makeInsight('Fragile link', ['atom-a', 'atom-b']));
  assert.equal(insightRows().length, 1);
  // The evidence atoms are removed (retired/superseded elsewhere); the standing
  // insight must not linger citing atoms that no longer stand.
  db.hub().prepare('DELETE FROM knowledge_atoms WHERE user = ? AND id IN (?, ?)').run(USER, 'atom-a', 'atom-b');
  const result = mergeCrossEntityInsights(USER, makeInsight('Unrelated new link', ['atom-c'], 0.8));
  seedAtoms(['atom-c']); // ensure the new one's evidence stands for the assertion
  assert.equal(result.retired, 1, 'the insight whose atoms vanished is retired');
  const titles = insightRows().map(r => r.subject_label);
  assert.ok(!titles.includes('Fragile link'), 'the stale insight is gone');
});

test('standing insights are bounded and evict lowest-confidence first', () => {
  // A single merge inserts every incoming insight (the active-atom check only
  // retires PRIOR rows), so eviction-by-count is exercised without seeding any
  // atoms. Build already-normalised objects directly with distinct evidence
  // pairs so each is a separate identity, not a supersession.
  const insights = [];
  for (let i = 0; i <= CROSS_ENTITY_MAX_INSIGHTS; i += 1) {
    insights.push({
      type: 'connection',
      title: `cap insight ${String(i).padStart(4, '0')}`,
      detail: 'bounded-set eviction fixture',
      entities: [],
      evidenceAtomIds: [`cap-${2 * i}`, `cap-${2 * i + 1}`],
      confidence: i === 0 ? 0.31 : 0.9, // item 0 is the weakest, must be evicted
    });
  }
  mergeCrossEntityInsights(USER, insights);
  const rows = insightRows();
  assert.equal(rows.length, CROSS_ENTITY_MAX_INSIGHTS, 'total is capped');
  assert.ok(!rows.some(r => r.confidence < 0.32), 'the weakest insight was evicted');
});
