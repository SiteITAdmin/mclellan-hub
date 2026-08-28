'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-atom-dedup-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const db = require('../lib/db');
const { upsertAtom } = require('../lib/atoms');
const { dedupProposedAtoms, preferCanonical } = require('../lib/atom-dedup');

let seq = 0;
function insertAtom({ user, label = 'H3O', predicate = 'fact', value, status = 'active', confidence = 0.9, subjectId = null, refKind = 'email', refId = null }) {
  const id = `atom-${++seq}`;
  const ref = refId ? JSON.stringify([{ kind: refKind, id: refId }]) : '[]';
  db.hub().prepare(`
    INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value,
      source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?, ?, 'company', ?, ?, ?, ?, ?, ?, ?, 'synthesis', unixepoch(), unixepoch(), unixepoch())
  `).run(id, user, subjectId, label, predicate, value, ref, confidence, status);
  return id;
}
const statusOf = (id) => db.hub().prepare('SELECT status FROM knowledge_atoms WHERE id = ?').get(id)?.status;
const refsOf = (id) => JSON.parse(db.hub().prepare('SELECT source_refs FROM knowledge_atoms WHERE id = ?').get(id)?.source_refs || '[]');

// Deterministic stand-ins for Ollama + the adjudicator. Facts sharing an
// identifying token embed to the same axis and are judged the same.
const factKey = (v) => {
  const s = String(v).toLowerCase();
  if (s.includes('gb279886811')) return 'vat';
  if (s.includes('charlotte')) return 'office';
  if (s.includes('10986998')) return 'company-no';
  return 'other-' + s.slice(0, 8);
};
const AXES = { vat: [1, 0, 0], office: [0, 1, 0], 'company-no': [0, 0, 1] };
const embedFn = async (text) => AXES[factKey(text)] || [0.2, 0.2, 0.2];
const cosineFn = (a, b) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const na = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  const nb = Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  return na && nb ? dot / (na * nb) : 0;
};
const adjudicateFn = async (_user, a, b) => factKey(a.value) === factKey(b.value);

test('upsertAtom: an exact/substring re-extraction of a REJECTED fact stays rejected (sticky)', () => {
  const user = 'sticky-reject';
  const id = insertAtom({ user, value: 'H3O Digital Limited VAT No. is GB279886811.', status: 'retired' });
  // Re-extraction of the same fact (substring) from a new email footer.
  const returnedId = upsertAtom(user, {
    subjectKind: 'company', subjectLabel: 'H3O', predicate: 'fact',
    value: 'VAT No. is GB279886811.', status: 'proposed', derivedBy: 'synthesis',
    sourceRef: { kind: 'email', id: 'new-email-1' },
  });
  assert.equal(returnedId, id, 'merged into the retired atom, no new row');
  assert.equal(statusOf(id), 'retired', 'rejection is sticky');
  const rows = db.hub().prepare("SELECT COUNT(*) n FROM knowledge_atoms WHERE user = ? AND status = 'proposed'").get(user);
  assert.equal(rows.n, 0, 'no fresh proposal created');
});

test('upsertAtom: re-confirming an APPROVED fact never demotes it to proposed', () => {
  const user = 'sticky-approve';
  const id = insertAtom({ user, value: 'H3O Digital Limited registered office is 54 Charlotte Street, London.', status: 'active' });
  upsertAtom(user, {
    subjectKind: 'company', subjectLabel: 'H3O', predicate: 'fact',
    value: 'H3O Digital Limited registered office is 54 Charlotte Street, London.', // exact
    status: 'proposed', derivedBy: 'synthesis', sourceRef: { kind: 'email', id: 'again-1' },
  });
  assert.equal(statusOf(id), 'active', 'approved atom stays active');
});

test('dedupProposedAtoms collapses a paraphrase into an already-APPROVED fact and auto-resolves it', async () => {
  const user = 'para-active';
  const active = insertAtom({ user, value: 'H3O Digital Limited VAT number is GB279886811.', status: 'active', refId: 'e1' });
  const prop = insertAtom({ user, value: 'The VAT No. of H3O Digital Limited is GB279886811.', status: 'proposed', refId: 'e2' });

  const res = await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn });
  assert.equal(statusOf(prop), 'retired', 'proposed paraphrase auto-resolved');
  assert.equal(statusOf(active), 'active', 'approved canonical unchanged');
  assert.equal(res.resolvedAgainstActive, 1);
  const refs = refsOf(active).map(r => r.id).sort();
  assert.deepEqual(refs, ['e1', 'e2'], 'provenance from the duplicate merged into the survivor');
});

test('dedupProposedAtoms keeps a rejected decision sticky against a reworded twin', async () => {
  const user = 'para-retired';
  const retired = insertAtom({ user, value: 'H3O uses Teams for everything.', predicate: 'fact', status: 'retired' });
  const prop = insertAtom({ user, value: 'H3O uses Teams for everything.', predicate: 'fact', status: 'proposed' });
  // Same fact key via the "other-" branch (identical text).
  const res = await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn });
  assert.equal(statusOf(prop), 'retired', 'reworded twin of a rejected fact stays out of the queue');
  assert.equal(res.resolvedAgainstRetired, 1);
});

test('dedupProposedAtoms leaves genuinely distinct facts alone', async () => {
  const user = 'distinct';
  const vat = insertAtom({ user, value: 'VAT No.: GB279886811', status: 'proposed' });
  const office = insertAtom({ user, value: 'Registered office 54 Charlotte Street, London.', status: 'proposed' });
  const res = await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn });
  assert.equal(statusOf(vat), 'proposed', 'VAT proposal untouched');
  assert.equal(statusOf(office), 'proposed', 'office proposal untouched');
  assert.equal(res.collapsed, 0);
});

test('a different verdict is persisted and never spends another model call for unchanged atoms', async () => {
  const user = 'distinct-sticky';
  insertAtom({ user, value: 'Ken will review the job description.', status: 'proposed' });
  insertAtom({ user, value: 'Discuss the role profile next week.', status: 'proposed' });
  let calls = 0;
  const alwaysNear = async () => [1, 0, 0];
  const alwaysDifferent = async () => { calls += 1; return false; };

  const first = await dedupProposedAtoms(user, {
    embedFn: alwaysNear,
    cosineFn,
    adjudicateFn: alwaysDifferent,
  });
  const second = await dedupProposedAtoms(user, {
    embedFn: alwaysNear,
    cosineFn,
    adjudicateFn: alwaysDifferent,
  });

  assert.equal(calls, 1, 'the pair is adjudicated only once across repeated runs');
  assert.equal(first.adjudications, 1);
  assert.equal(first.decisionsPersisted, 1);
  assert.equal(second.adjudications, 0);
  assert.ok(second.decisionsReused >= 1);
});

test('dedupProposedAtoms collapses two proposals to one survivor (one review, not many)', async () => {
  const user = 'two-proposed';
  const a = insertAtom({ user, value: 'H3O Digital Limited is registered in England and Wales, number 10986998.', status: 'proposed', confidence: 0.99, refId: 'x1' });
  const b = insertAtom({ user, value: 'Registered in England and Wales under company number 10986998.', status: 'proposed', confidence: 0.9, refId: 'x2' });
  const res = await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn });
  const survivors = [a, b].filter(id => statusOf(id) === 'proposed');
  assert.equal(survivors.length, 1, 'exactly one proposal survives for review');
  assert.equal(res.collapsed, 1);
  assert.equal(survivors[0], a, 'the higher-confidence proposal is kept');
});

test('a dedup-retired proposal cannot become canonical and retire the survivor on a later run', async () => {
  const user = 'two-proposed-repeat';
  const a = insertAtom({ user, value: 'VAT No.: GB279886811', status: 'proposed', confidence: 0.99 });
  const b = insertAtom({ user, value: 'The VAT number is GB279886811.', status: 'proposed', confidence: 0.9 });
  let calls = 0;
  const same = async () => { calls += 1; return true; };

  await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn: same });
  await dedupProposedAtoms(user, { embedFn, cosineFn, adjudicateFn: same });

  assert.equal(calls, 1, 'the saved same-fact decision is reused');
  assert.equal(statusOf(a), 'proposed', 'the original canonical remains reviewable');
  assert.equal(statusOf(b), 'retired', 'the duplicate remains retired');
});

test('embeddings unavailable → dedup fails closed, nothing collapsed', async () => {
  const user = 'no-embed';
  const p1 = insertAtom({ user, value: 'The VAT No. of H3O Digital Limited is GB279886811.', status: 'proposed' });
  insertAtom({ user, value: 'VAT No.: GB279886811', status: 'active' });
  const res = await dedupProposedAtoms(user, { embedFn: async () => null, cosineFn, adjudicateFn });
  assert.equal(statusOf(p1), 'proposed', 'nothing collapsed without embeddings');
  assert.equal(res.embeddingsUnavailable, true);
});

test('preferCanonical ranks active over retired over proposed (human decisions win)', () => {
  const active = { id: 'a', status: 'active', confidence: 0.5, value: 'x' };
  const proposed = { id: 'p', status: 'proposed', confidence: 0.99, value: 'xxxxx' };
  const retired = { id: 'r', status: 'retired', confidence: 1, value: 'xxxxxxxxxx' };
  assert.equal(preferCanonical(active, proposed).id, 'a');
  assert.equal(preferCanonical(active, retired).id, 'a');
  assert.equal(preferCanonical(retired, proposed).id, 'r', 'a rejection suppresses a fresh proposal');
});
