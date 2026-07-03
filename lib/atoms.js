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

// Strip punctuation and collapse whitespace — used for fuzzy dedup comparisons only
const stripNorm = s => norm(s).replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

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

  let existing = hub.prepare(`
    SELECT * FROM knowledge_atoms
     WHERE user = ? AND lower(subject_label) = ? AND predicate = ? AND lower(value) = ?
     LIMIT 1
  `).get(user, norm(subjectLabel), predicate, norm(value));

  if (existing && existing.subject_id && subjectId && existing.subject_id !== subjectId) {
    existing = null;
  }
  if (existing && existing.subject_kind && subjectKind && existing.subject_kind !== subjectKind) {
    existing = null;
  }

  const now = Math.floor(Date.now() / 1000);

  // Fuzzy dedup: if no exact match, check if new value is contained in an existing atom
  // (or vice-versa) within the same (subject_label, predicate) group. Catches the
  // pattern where resetSynthesis causes the LLM to re-extract the same fact with slightly
  // different wording — one version is typically a substring of the more verbose version.
  if (!existing) {
    const MIN_FUZZY = 20;
    const newStripped = stripNorm(value);
    if (newStripped.length >= MIN_FUZZY) {
      const group = hub.prepare(`
        SELECT * FROM knowledge_atoms
         WHERE user = ? AND lower(subject_label) = ? AND predicate = ? AND status != 'retired'
         LIMIT 100
      `).all(user, norm(subjectLabel), predicate);
      for (const candidate of group) {
        const candStripped = stripNorm(candidate.value);
        if (candStripped.length < MIN_FUZZY) continue;
        if (candStripped.includes(newStripped)) {
          // Candidate already contains this fact — treat new as duplicate
          existing = candidate;
          break;
        }
        if (newStripped.includes(candStripped)) {
          // New value is more informative — update candidate's stored value, then merge
          existing = candidate;
          hub.prepare('UPDATE knowledge_atoms SET value = ?, updated_at = ? WHERE id = ?')
            .run(value, now, candidate.id);
          break;
        }
      }
    }
  }
  if (existing) {
    const refs = mergeRefs(existing.source_refs, sourceRef);
    const newConf = Math.min(0.99, Math.max(existing.confidence, confidence) + 0.03);
    hub.prepare(`
      UPDATE knowledge_atoms
         SET source_refs = ?, confidence = ?, last_confirmed = ?, updated_at = ?,
             subject_id = COALESCE(subject_id, ?),
             subject_kind = COALESCE(subject_kind, ?),
             status = CASE WHEN status = 'retired' THEN status ELSE ? END
       WHERE id = ?
    `).run(JSON.stringify(refs), newConf, now, now, subjectId, subjectKind, status, existing.id);
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

function atomsForEntity(user, subjectKind, subjectId, { includeProposed = false, includeStale = false } = {}) {
  const list = ['active'];
  if (includeProposed) list.push('proposed');
  if (includeStale) list.push('stale');
  const statuses = `('${list.join("','")}')`;
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
    if (a && (a.status === 'active' || a.status === 'stale')) out.push({ ...a, score: h.score });
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

// One-shot retroactive dedup: within each (subject_label, predicate) group, retire any
// atom whose stripped value is fully contained in a longer atom in the same group.
// Source refs and confidence are merged into the surviving atom before retirement.
// Returns { scanned, merged }.
function dedupAtoms(user) {
  const hub = db.hub();
  const MIN_LEN = 20;

  const atoms = hub.prepare(`
    SELECT id, subject_label, predicate, value, source_refs, confidence
      FROM knowledge_atoms
     WHERE user = ? AND status IN ('active', 'proposed') AND subject_kind != 'insight'
     ORDER BY subject_label, predicate, length(value) DESC
  `).all(user);

  const groups = new Map();
  for (const a of atoms) {
    const key = `${norm(a.subject_label)}|||${a.predicate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  let merged = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const retired = new Set();

    for (let i = 0; i < group.length; i++) {
      if (retired.has(group[i].id)) continue;
      const longerS = stripNorm(group[i].value);
      if (longerS.length < MIN_LEN) continue;

      for (let j = i + 1; j < group.length; j++) {
        if (retired.has(group[j].id)) continue;
        const shorterS = stripNorm(group[j].value);
        if (shorterS.length < MIN_LEN) continue;

        if (longerS.includes(shorterS)) {
          // group[j] is redundant — merge its refs into group[i] and retire it
          let existRefs = [];
          let jRefs = [];
          try { existRefs = JSON.parse(group[i].source_refs || '[]'); } catch { existRefs = []; }
          try { jRefs = JSON.parse(group[j].source_refs || '[]'); } catch { jRefs = []; }
          for (const r of jRefs) {
            if (r?.kind && r?.id && !existRefs.some(x => x.kind === r.kind && x.id === r.id)) {
              existRefs.push(r);
            }
          }
          const newConf = Math.min(0.99, Math.max(group[i].confidence, group[j].confidence));
          hub.prepare(`UPDATE knowledge_atoms SET source_refs = ?, confidence = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(existRefs), newConf, now, group[i].id);
          hub.prepare(`UPDATE knowledge_atoms SET status = 'retired', updated_at = ? WHERE id = ?`)
            .run(now, group[j].id);
          retired.add(group[j].id);
          merged++;
        }
      }
    }
  }

  return { scanned: atoms.length, merged };
}

module.exports = {
  upsertAtom, atomsForEntity, atomsForQuery,
  setStatus, listByStatus, backfillFromCrmFacts, dedupAtoms, norm,
};
