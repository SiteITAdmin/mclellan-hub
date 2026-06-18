'use strict';

/**
 * Knowledge layer — L2 substrate (atoms).
 *
 * An atom is a derived claim: (subject, predicate, value) plus provenance and
 * confidence. Atoms are not authored by hand — they are produced from raw and
 * curated sources (crm_facts here in Stage 1; raw documents/emails by the
 * synthesis linker in Stage 2) and re-derivable from those sources. The CRM,
 * wiki and project views read from atoms rather than holding the knowledge
 * themselves.
 */

const db = require('./db');
const { uuid } = require('./id');

const norm = s => String(s || '').trim().toLowerCase();

function mergeRefs(existingJson, ref) {
  let arr = [];
  try { arr = JSON.parse(existingJson || '[]'); } catch { arr = []; }
  if (ref && ref.kind && ref.id && !arr.some(r => r.kind === ref.kind && r.id === ref.id)) {
    arr.push({ kind: ref.kind, id: ref.id });
  }
  return arr;
}

// Insert or re-confirm an atom. Dedup is by (user, subject_label, predicate,
// value) so the same claim from a new source merges provenance and nudges
// confidence up rather than duplicating. Resolving subject_id later is fine —
// COALESCE fills it without disturbing the existing row.
function upsertAtom(user, atom) {
  const hub = db.hub();
  const {
    subjectKind = 'contact', subjectId = null, subjectLabel,
    predicate, value, sourceRef = null,
    confidence = 0.6, status = 'active', derivedBy = null,
  } = atom || {};
  if (!subjectLabel || !predicate || value == null || value === '') return null;

  const existing = hub.prepare(`
    SELECT * FROM knowledge_atoms
     WHERE user = ? AND lower(subject_label) = ? AND predicate = ? AND lower(value) = ?
     LIMIT 1
  `).get(user, norm(subjectLabel), predicate, norm(value));

  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    const refs = mergeRefs(existing.source_refs, sourceRef);
    const newConf = Math.min(0.99, Math.max(existing.confidence, confidence) + 0.03);
    hub.prepare(`
      UPDATE knowledge_atoms
         SET source_refs = ?, confidence = ?, last_confirmed = ?, updated_at = ?,
             subject_id = COALESCE(subject_id, ?),
             status = CASE WHEN status = 'retired' THEN status ELSE ? END
       WHERE id = ?
    `).run(JSON.stringify(refs), newConf, now, now, subjectId, status, existing.id);
    return existing.id;
  }

  const id = uuid();
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, user, subjectKind, subjectId, subjectLabel, predicate, value,
         JSON.stringify(mergeRefs('[]', sourceRef)), confidence, status, derivedBy, now, now, now);
  return id;
}

function atomsForEntity(user, subjectKind, subjectId, { includeProposed = false } = {}) {
  const statuses = includeProposed ? "('active','proposed')" : "('active')";
  return db.hub().prepare(`
    SELECT * FROM knowledge_atoms
     WHERE user = ? AND subject_kind = ? AND subject_id = ? AND status IN ${statuses}
     ORDER BY confidence DESC, predicate
  `).all(user, subjectKind, subjectId);
}

// Semantic lookup over atoms (used by the linker and by views).
async function atomsForQuery(user, query, k = 8) {
  const { semanticSearch } = require('./retrieval');
  const hits = await semanticSearch(user, query, k, { sourceKinds: ['atom'] });
  const hub = db.hub();
  const out = [];
  for (const h of hits) {
    const a = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(h.source_id);
    if (a && a.status === 'active') out.push({ ...a, score: h.score });
  }
  return out;
}

function setStatus(id, status) {
  db.hub().prepare('UPDATE knowledge_atoms SET status = ?, updated_at = unixepoch() WHERE id = ?')
    .run(status, id);
}

function listByStatus(user, status) {
  return db.hub().prepare(
    'SELECT * FROM knowledge_atoms WHERE user = ? AND status = ? ORDER BY updated_at DESC'
  ).all(user, status);
}

// Stage 1 backfill: every curated crm_fact becomes an atom on its contact,
// carrying provenance back to the fact row. Human-curated, so high confidence.
// Idempotent — upsert dedups on content and merges the source ref.
function backfillFromCrmFacts(user) {
  const facts = db.hub().prepare(`
    SELECT f.id, f.fact, f.fact_type, f.contact_id, c.name AS contact_name
      FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
     WHERE f.user = ? AND COALESCE(f.fact, '') != ''
  `).all(user);
  let created = 0;
  for (const f of facts) {
    const predicate = (f.fact_type && f.fact_type !== 'fact') ? f.fact_type : 'fact';
    if (upsertAtom(user, {
      subjectKind: 'contact', subjectId: f.contact_id, subjectLabel: f.contact_name,
      predicate, value: f.fact, sourceRef: { kind: 'crm_fact', id: f.id },
      confidence: 0.85, derivedBy: 'backfill:crm_fact',
    })) created++;
  }
  return { facts: facts.length, created };
}

module.exports = {
  upsertAtom, atomsForEntity, atomsForQuery,
  setStatus, listByStatus, backfillFromCrmFacts, norm,
};
