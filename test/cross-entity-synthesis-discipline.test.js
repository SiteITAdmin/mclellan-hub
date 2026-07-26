'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  CROSS_ENTITY_MAX_TOKENS,
  normaliseCrossEntityInsights,
  replaceCrossEntityInsights,
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

  const result = replaceCrossEntityInsights(USER, insights);
  assert.equal(result.written, 1);

  const row = db.hub().prepare(`
    SELECT subject_kind, subject_label, predicate, source_refs
      FROM knowledge_atoms
     WHERE user = ?
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
