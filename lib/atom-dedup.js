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
 * is decision-sticky — a proposed atom that the model judges the same fact as an
 * already-active atom is auto-resolved (merged + retired, no re-ask), and one
 * judged the same as an already-retired atom stays retired. Fail-closed on the
 * semantic layer: if embeddings are unavailable it skips rather than guessing
 * (no OpenRouter fallback), and any model outage leaves the atom in the queue.
 */

const db = require('./db');
const { mergeRefs, norm } = require('./atoms');
const { TASK_CODES } = require('./openrouter-attribution');

const DUPLICATE_FALLBACK = 'anthropic/claude-haiku-4-5';

// Facts are short; paraphrases of the same fact score high. This is a recall
// floor only — the model makes the actual same/different call, so it can sit
// low enough to catch reworded footers without deciding anything by score.
const SHORTLIST_FLOOR = 0.60;
const SHORTLIST_K = 6;          // candidates embedded-ranked per proposed atom
const ADJUDICATE_MAX_PER_ATOM = 3;
const ADJUDICATE_MAX_TOTAL = 60; // whole-run ceiling on model calls

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
      modelKey: 'crm_duplicate_review',
      taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
      defaults: { same_fact: false },
      label: 'atom duplicate adjudication',
    });
    return parsed?.same_fact === true;
  } catch (err) {
    console.warn('[atom-dedup] adjudication failed (atom left in queue):', err.message);
    return false;
  }
}

// Collapse one duplicate into the surviving canonical: merge provenance, keep the
// canonical's human decision, and never resurrect a retired atom or demote an
// active one. Returns the id that was retired (the loser), or null if the pair
// cannot be collapsed without changing a decision.
function collapseInto(hub, canonical, dup, now) {
  if (dup.status === 'active' && canonical.status !== 'active') return null; // never demote an approved fact
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
    if (result.adjudications >= limit) break;

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
      if (result.adjudications >= limit) break;
      if (adjudicatedForP >= ADJUDICATE_MAX_PER_ATOM) break;
      adjudicatedForP += 1;
      result.adjudications += 1;
      const same = await adjudicate(user, p, c);
      if (!same) continue;

      const canonical = preferCanonical(p, c);
      const dup = canonical.id === p.id ? c : p;
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
