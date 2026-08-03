'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-atoms-provenance-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { upsertAtom, dedupAtoms, backfillFromCrmFacts } = require('../lib/atoms');

const user = 'atoms-provenance-test';

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('atom merges retain legacy and every revision/chunk/span evidence identity', () => {
  const base = {
    subjectKind: 'contact', subjectLabel: 'Alex', predicate: 'agreement_status', value: 'approved',
    confidence: 0.8, derivedBy: 'synthesis',
  };
  const id = upsertAtom(user, {
    ...base,
    sourceRef: { kind: 'document', id: 'agreement-notes' },
  });
  assert.equal(upsertAtom(user, {
    ...base,
    sourceRef: {
      kind: 'document', id: 'agreement-notes', revision: 'rev-1',
      chunk_id: 'rev-1:0', chunk_index: 0, start: 0, end: 120,
    },
  }), id);
  assert.equal(upsertAtom(user, {
    ...base,
    sourceRef: {
      kind: 'document', id: 'agreement-notes', revision: 'rev-2',
      chunk_id: 'rev-2:1', chunk_index: 1, start: 80, end: 210,
    },
  }), id);

  const refs = JSON.parse(db.hub().prepare('SELECT source_refs FROM knowledge_atoms WHERE id = ?').get(id).source_refs);
  assert.equal(refs.length, 3);
  assert.ok(refs.some(ref => ref.kind === 'document' && ref.id === 'agreement-notes' && !('revision' in ref)));
  assert.ok(refs.some(ref => ref.revision === 'rev-1' && ref.chunk_id === 'rev-1:0' && ref.start === 0 && ref.end === 120));
  assert.ok(refs.some(ref => ref.revision === 'rev-2' && ref.chunk_id === 'rev-2:1' && ref.start === 80 && ref.end === 210));
});

test('atom dedup merges complete provenance rather than collapsing it to kind/id', () => {
  const hub = db.hub();
  const now = Math.floor(Date.now() / 1000);
  const insert = hub.prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_label, predicate, value, source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?, ?, 'contact', 'Alex', 'agreement_detail', ?, ?, 0.8, 'active', 'synthesis', ?, ?, ?)
  `);
  const survivorId = 'atoms-provenance-survivor';
  const retiredId = 'atoms-provenance-redundant';
  insert.run(
    survivorId, user,
    'Alex has approved the final agreement for the summer programme.',
    JSON.stringify([{
      kind: 'email_summary', id: 'agreement-email', revision: 'email-rev-1',
      chunk_id: 'email-rev-1:0', chunk_index: 0, start: 0, end: 90,
    }]),
    now, now, now,
  );
  insert.run(
    retiredId, user,
    'approved the final agreement for the summer programme.',
    JSON.stringify([{
      kind: 'email_summary', id: 'agreement-email', revision: 'email-rev-2',
      chunk_id: 'email-rev-2:1', chunk_index: 1, start: 40, end: 130,
    }]),
    now, now, now,
  );

  const result = dedupAtoms(user);
  assert.equal(result.merged, 1);
  const survivor = hub.prepare('SELECT source_refs FROM knowledge_atoms WHERE id = ?').get(survivorId);
  const retired = hub.prepare('SELECT status FROM knowledge_atoms WHERE id = ?').get(retiredId);
  const refs = JSON.parse(survivor.source_refs);
  assert.equal(retired.status, 'retired');
  assert.ok(refs.some(ref => ref.revision === 'email-rev-1' && ref.chunk_id === 'email-rev-1:0'));
  assert.ok(refs.some(ref => ref.revision === 'email-rev-2' && ref.chunk_id === 'email-rev-2:1' && ref.start === 40));
});

test('scheduled CRM fact backfill defers to the canonical knowledge engine', () => {
  const hub = db.hub();
  const contactId = 'atoms-backfill-contact';
  const factId = 'atoms-backfill-fact';
  hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(contactId, user, 'Backfill Person');
  hub.prepare(`
    INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
    VALUES (?, ?, ?, ?, 'active', 'manual')
  `).run(factId, user, contactId, 'Canonical review is required');

  const previous = process.env.CRM_LEGACY_DIRECT_WRITES;
  delete process.env.CRM_LEGACY_DIRECT_WRITES;
  try {
    const result = backfillFromCrmFacts(user);
    assert.equal(result.created, 0);
    assert.ok(result.deferred >= 1);
    assert.equal(hub.prepare(`
      SELECT count(*) AS n FROM knowledge_atoms
      WHERE user = ? AND derived_by = 'backfill:crm_fact'
    `).get(user).n, 0);
    assert.equal(result.queued.queued, true);
    // A source kind without a source id has never identified a canonical source,
    // so queueCrmKnowledgeEngine deliberately degrades this compatibility caller
    // to the ordinary global pass rather than inventing a scoped target.
    assert.equal(result.queued.payload.source_kind, null);
    assert.equal(result.queued.payload.source_id, null);
    assert.equal(result.queued.payload.requested_by, 'atoms-backfill-compatibility');
    assert.ok(hub.prepare(`
      SELECT 1 FROM system_jobs
      WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
      LIMIT 1
    `).get());
  } finally {
    if (previous === undefined) delete process.env.CRM_LEGACY_DIRECT_WRITES;
    else process.env.CRM_LEGACY_DIRECT_WRITES = previous;
  }
});
