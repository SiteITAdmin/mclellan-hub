'use strict';

/**
 * Paraphrase-aware, decision-sticky dedup for the knowledge review queue.
 *
 * The deterministic guard in lib/atoms.js `upsertAtom` collapses exact and
 * substring re-extractions. It cannot collapse *paraphrases* — "The VAT No. of
 * H3O Digital Limited is GB279886811." and "VAT No.: GB279886811" share no
 * substring, so each footer wording became a fresh 'proposed' atom and the
 * review page kept asking about facts Douglas had already approved or rejected.
 *
 * This pass mirrors the open-task dedup shipped for CRM projection
 * (crm-knowledge-engine `openTaskDuplicateMatch`): embedding recall to shortlist
 * near-duplicates within the same (subject_label, predicate) group, then a
 * bounded `crm_duplicate_review` model call to make the precision decision. It
 * is decision-sticky — both same and different verdicts are receipted against
 * the exact atom-content revision. Same facts merge into the saved canonical;
 * different facts are never re-adjudicated unchanged. Fail-closed on the semantic
 * layer: if embeddings are unavailable it skips rather than guessing (no
 * OpenRouter fallback), and any model outage leaves the atom in the queue.
 */

const db = require('./db');
const { uuid } = require('./id');
const { mergeRefs, norm } = require('./atoms');
const { hash } = require('./source-evidence');
const { TASK_CODES } = require('./openrouter-attribution');

const DUPLICATE_FALLBACK = 'anthropic/claude-haiku-4-5';

// Facts are short; paraphrases of the same fact score high. This is a recall
// floor only — the model makes the actual same/different call, so it can sit
// low enough to catch reworded footers without deciding anything by score.
const SHORTLIST_FLOOR = 0.60;
const SHORTLIST_K = 6;          // candidates embedded-ranked per proposed atom
const ADJUDICATE_MAX_PER_ATOM = 3;
const ADJUDICATE_MAX_TOTAL = 60; // whole-run ceiling on model calls
const PAIR_DECISION_VERSION = 1;
const PAIR_SOURCE_KIND = 'knowledge_atom_pair';
const PAIR_STAGE = 'atom_duplicate_reviewed';

// A human decision outranks an untouched proposal: an approved fact wins over
// everything, and a rejected fact must win over a fresh proposal so a reworded
// twin is suppressed rather than resurrected. Only among equal-status atoms does
// confidence/completeness break the tie.
const STATUS_RANK = { active: 2, retired: 1, proposed: 0 };

// The survivor of a duplicate pair is the one a human already blessed (active),
// then a prior rejection (retired), then the more-confident / more-complete
// proposed one.
function preferCanonical(a, b) {
  const ra = STATUS_RANK[a.status] ?? 1;
  const rb = STATUS_RANK[b.status] ?? 1;
  if (ra !== rb) return ra > rb ? a : b;
  if ((a.confidence || 0) !== (b.confidence || 0)) return (a.confidence || 0) > (b.confidence || 0) ? a : b;
  return String(a.value || '').length >= String(b.value || '').length ? a : b;
}

async function adjudicateSameFact(user, a, b, { requestModelObjectFn, getSystemModelIdFn } = {}) {
  const requestModelObject = requestModelObjectFn || require('./model-request').requestModelObject;
  const getSystemModelId = getSystemModelIdFn || require('./settings').getSystemModelId;
  try {
    const modelId = getSystemModelId('crm_duplicate_review', 'system', DUPLICATE_FALLBACK);
    const parsed = await requestModelObject({
      modelId,
      messages: [{ role: 'user', content: [
        'Two candidate facts describe the same subject and the same attribute.',
        'Decide if they state the SAME fact — i.e. one is just a reworded or more/less complete version of the other, carrying no information the other contradicts.',
        'SAME: identical value expressed differently (e.g. "VAT No.: GB123" vs "The VAT number is GB123").',
        'DIFFERENT: a different value, a different attribute, or an added fact the other does not contain (e.g. a company number vs a VAT number; two different addresses).',
        '',
        `FACT A: ${String(a.value || '').trim()}`,
        `FACT B: ${String(b.value || '').trim()}`,
        '',
        'Return JSON {"same_fact": true|false}.',
      ].join('\n') }],
      user,
      feature: 'crm-duplicate-review',
      modelKey: 'crm_atom_duplicate_review',
      taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
      defaults: { same_fact: false },
      label: 'atom duplicate adjudication',
    });
    return { decided: true, sameFact: parsed?.same_fact === true, modelId };
  } catch (err) {
    console.warn('[atom-dedup] adjudication failed (atom left in queue):', err.message);
    return { decided: false, sameFact: false, modelId: null };
  }
}

function pairIdentity(a, b) {
  const atoms = [a, b]
    .map(atom => ({
      id: String(atom.id),
      subject_kind: String(atom.subject_kind || ''),
      subject_label: norm(atom.subject_label),
      predicate: String(atom.predicate || ''),
      value: String(atom.value || '').trim(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const pairKey = hash(atoms.map(atom => atom.id).join('\u0000'));
  const pairRevision = hash(JSON.stringify({ version: PAIR_DECISION_VERSION, atoms }));
  return { pairKey, pairRevision, atomIds: atoms.map(atom => atom.id) };
}

function readPairDecision(hub, user, a, b) {
  const identity = pairIdentity(a, b);
  const rows = hub.prepare(`
    SELECT payload FROM knowledge_receipts
     WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ? AND status = 'done'
     ORDER BY created_at DESC, rowid DESC
  `).all(user, PAIR_SOURCE_KIND, identity.pairKey, PAIR_STAGE);
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload || '{}'); } catch { continue; }
    if (payload?.decision_version !== PAIR_DECISION_VERSION
      || payload?.pair_revision !== identity.pairRevision
      || !['same', 'different'].includes(payload?.decision)) continue;
    return { ...payload, identity };
  }
  return null;
}

function writePairDecision(hub, user, a, b, {
  sameFact,
  canonicalId = null,
  duplicateId = null,
  modelId = null,
} = {}) {
  const identity = pairIdentity(a, b);
  const decision = sameFact ? 'same' : 'different';
  hub.prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'done', ?, ?, 'crm_duplicate_review', ?, unixepoch())
  `).run(
    uuid(), user, PAIR_SOURCE_KIND, identity.pairKey, PAIR_STAGE,
    `Atom pair judged ${decision}`,
    JSON.stringify({
      decision_version: PAIR_DECISION_VERSION,
      pair_revision: identity.pairRevision,
      atom_ids: identity.atomIds,
      decision,
      canonical_id: canonicalId,
      duplicate_id: duplicateId,
    }),
    modelId,
  );
  return { decision, canonical_id: canonicalId, duplicate_id: duplicateId, identity };
}

function normaliseAdjudication(value) {
  if (typeof value === 'boolean') return { decided: true, sameFact: value, modelId: null };
  if (!value || value.decided === false) return { decided: false, sameFact: false, modelId: value?.modelId || null };
  if (typeof value.sameFact === 'boolean') {
    return { decided: true, sameFact: value.sameFact, modelId: value.modelId || null };
  }
  if (typeof value.same_fact === 'boolean') {
    return { decided: true, sameFact: value.same_fact, modelId: value.modelId || null };
  }
  return { decided: false, sameFact: false, modelId: value.modelId || null };
}

// Collapse one duplicate into the surviving canonical: merge provenance, keep the
// canonical's human decision, and never resurrect a retired atom or demote an
// active one. Returns the id that was retired (the loser), or null if the pair
// cannot be collapsed without changing a decision.
function collapseInto(hub, canonical, dup, now) {
  if (dup.status === 'active' && canonical.status !== 'active') return null; // never demote an approved fact
  if (dup.status === 'retired') return null;
  const refs = mergeRefs(canonical.source_refs, safeRefs(dup.source_refs));
  const conf = Math.min(0.99, Math.max(canonical.confidence || 0, dup.confidence || 0));
  hub.prepare(`
    UPDATE knowledge_atoms
       SET source_refs = ?, confidence = ?,
           subject_id = COALESCE(subject_id, ?),
           subject_kind = COALESCE(subject_kind, ?),
           updated_at = ?
     WHERE id = ?
  `).run(JSON.stringify(refs), conf, dup.subject_id || null, dup.subject_kind || null, now, canonical.id);
  hub.prepare("UPDATE knowledge_atoms SET status = 'retired', updated_at = ? WHERE id = ?").run(now, dup.id);
  return dup.id;
}

function safeRefs(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

/**
 * Scan the 'proposed' review queue and collapse paraphrase duplicates.
 * Injectable deps keep it unit-testable offline:
 *   embedFn(text) -> vector|null · cosineFn(a,b) -> number · adjudicateFn(user,a,b) -> bool
 */
async function dedupProposedAtoms(user, {
  embedFn = null,
  cosineFn = null,
  adjudicateFn = null,
  limit = ADJUDICATE_MAX_TOTAL,
} = {}) {
  const hub = db.hub();
  const embedOne = embedFn || require('./retrieval').embedOne;
  const cosine = cosineFn || require('./retrieval').cosine;
  const adjudicate = adjudicateFn || ((u, a, b) => adjudicateSameFact(u, a, b));

  const proposed = hub.prepare(`
    SELECT * FROM knowledge_atoms
     WHERE user = ? AND status = 'proposed' AND subject_kind != 'insight'
       AND COALESCE(value, '') != ''
     ORDER BY confidence DESC, length(value) DESC
  `).all(user);

  const result = {
    proposedScanned: proposed.length,
    collapsed: 0,
    resolvedAgainstActive: 0,
    resolvedAgainstRetired: 0,
    adjudications: 0,
    adjudicationFailures: 0,
    decisionsReused: 0,
    decisionsPersisted: 0,
    embeddingsUnavailable: false,
  };
  if (!proposed.length) return result;

  const collapsedIds = new Set();
  const vectorCache = new Map(); // atom id -> vector|null
  const now = Math.floor(Date.now() / 1000);

  const vectorFor = async (atom) => {
    if (vectorCache.has(atom.id)) return vectorCache.get(atom.id);
    const v = await embedOne(String(atom.value || ''));
    vectorCache.set(atom.id, v || null);
    return v || null;
  };

  for (const p of proposed) {
    if (collapsedIds.has(p.id)) continue;

    const candidates = hub.prepare(`
      SELECT * FROM knowledge_atoms
       WHERE user = ? AND lower(subject_label) = ? AND predicate = ?
         AND id != ? AND status IN ('active','proposed','retired')
       LIMIT 200
    `).all(user, norm(p.subject_label), p.predicate, p.id)
      .filter(c => !collapsedIds.has(c.id));
    if (!candidates.length) continue;

    const pv = await vectorFor(p);
    if (!pv) { result.embeddingsUnavailable = true; break; } // fail closed, don't guess

    const scored = [];
    for (const c of candidates) {
      const cv = await vectorFor(c);
      if (!cv) continue;
      scored.push({ atom: c, score: cosine(pv, cv) });
    }
    scored.sort((x, y) => y.score - x.score);
    const shortlist = scored.filter(s => s.score >= SHORTLIST_FLOOR).slice(0, SHORTLIST_K);

    let adjudicatedForP = 0;
    for (const { atom: c } of shortlist) {
      let saved = readPairDecision(hub, user, p, c);
      let same;
      let canonical;
      if (saved) {
        result.decisionsReused += 1;
        same = saved.decision === 'same';
        if (same) canonical = saved.canonical_id === p.id ? p : saved.canonical_id === c.id ? c : null;
      } else {
        if (result.adjudications >= limit || adjudicatedForP >= ADJUDICATE_MAX_PER_ATOM) break;
        adjudicatedForP += 1;
        result.adjudications += 1;
        const decision = normaliseAdjudication(await adjudicate(user, p, c));
        if (!decision.decided) {
          result.adjudicationFailures += 1;
          continue;
        }
        same = decision.sameFact;
        canonical = same ? preferCanonical(p, c) : null;
        const dup = same ? (canonical.id === p.id ? c : p) : null;
        saved = writePairDecision(hub, user, p, c, {
          sameFact: same,
          canonicalId: canonical?.id || null,
          duplicateId: dup?.id || null,
          modelId: decision.modelId,
        });
        result.decisionsPersisted += 1;
      }
      if (!same) continue;

      canonical = canonical || preferCanonical(p, c);
      let dup = canonical.id === p.id ? c : p;
      if (dup.status === 'active' && canonical.status !== 'active') {
        canonical = preferCanonical(p, c);
        dup = canonical.id === p.id ? c : p;
      }
      const retiredId = collapseInto(hub, canonical, dup, now);
      if (!retiredId) continue;
      collapsedIds.add(retiredId);
      result.collapsed += 1;
      if (canonical.status === 'active') result.resolvedAgainstActive += 1;
      else if (canonical.status === 'retired') result.resolvedAgainstRetired += 1;
      if (dup.id === p.id) break; // p itself was collapsed; move on
    }
  }

  return result;
}

module.exports = { dedupProposedAtoms, adjudicateSameFact, preferCanonical, SHORTLIST_FLOOR };
