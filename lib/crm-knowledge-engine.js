'use strict';

/**
 * CRM knowledge engine.
 *
 * Raw source evidence is resolved before any model call.  Model outputs are
 * then compiled into versioned action outcomes whose identity is an exact
 * evidence span, not a mutable task title.  That gives replays a durable place
 * to recover from an interrupted side effect without making the model's latest
 * paraphrase an external idempotency key.
 */

const db = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');
const { getCrmKnowledgeHealth } = require('./crm-knowledge-health');
const {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  SOURCE_EVIDENCE_KINDS,
  listSourceEvidence,
  resolveSourceEvidence,
  locateEvidenceSpan,
  stableActionKey,
  isCanonicalEvidenceExcluded,
  hash,
} = require('./source-evidence');
const {
  loadEntities,
  buildEntityFacts,
  sourceContext,
  synthesiseSource,
} = require('./synthesis');
const { createTask } = require('./google-tasks');
const { createCalendarEvent } = require('./google-calendar');
const { routingMetadata } = require('./messaging-capture');
const { mergeRefs } = require('./atoms');
const {
  sourceReceipt,
  writeReceipt,
  receiptForCurrentSource,
  currentSourceReceipt,
} = require('./crm-receipts');
const {
  SOURCE_PROCESSING_LEASE_SECONDS,
  claimSourceProcessingLease,
  finishSourceProcessingLease,
  refreshSourceProcessingLease,
  sourceProcessingLeaseLostError,
  sourceProcessingLeaseHeldError,
  isSourceProcessingLeaseLostError,
  startSourceProcessingLeaseHeartbeat,
} = require('./crm-source-lease');

const TRIAGE_FALLBACK = 'anthropic/claude-haiku-4-5';
const DUPLICATE_FALLBACK = 'anthropic/claude-haiku-4-5';
const ACTION_FALLBACK = 'anthropic/claude-haiku-4-5';
const ENGINE_SOURCE_KINDS = SOURCE_EVIDENCE_KINDS;
const ACTION_CONFIDENCE_THRESHOLD = 0.6;
const ACTION_REVIEW_FLOOR = 0.35;
const SIDE_EFFECT_PENDING_LEASE_SECONDS = 5 * 60;
const DUPLICATE_REVIEW_CONFIDENCE = 0.85;
// Automatic retries must not consume every scheduler pass when a source has a
// durable provider/model failure.  These delays are derived from immutable
// current-revision receipts/outcomes, rather than a second mutable scheduler
// state table.  A human-requested retry deliberately bypasses this cadence.
const AUTO_ERROR_RETRY_BASE_SECONDS = 5 * 60;
const AUTO_ERROR_RETRY_MAX_SECONDS = 24 * 60 * 60;
const OUTCOME_TERMINAL = new Set([
  'task_created',
  'event_created',
  'task_and_event_created',
  'existing_open_task',
  'fyi',
  'dismissed',
]);

const ACTION_STATE_GUARD = `Runtime task-state rule:
- The supplied task list contains only currently OPEN tasks. Do not duplicate one of them: if an open task already covers this ask, set duplicate_of to its title instead of emitting a new action.
- You are NOT shown completed, deleted, or wrong tasks. Do not try to guess at them or withhold a genuine ask on the assumption it was already handled — a separate deterministic check suppresses anything that matches a closed task after you respond.
- A completed task source is a terminal state event, not a request for a replacement follow-up task.`;
const ACTION_EVENT_GUARD = `Runtime event-field rule:
- Every action object in "actions" must include an "event" field, even if the response schema you were given doesn't show one.
- "event": { "start": "YYYY-MM-DDTHH:MM or null", "end": "YYYY-MM-DDTHH:MM or null", "location": "string or null" }.
- Set start/end only when the source states BOTH a specific date and a specific time Douglas must personally attend (interview, appointment, meeting). Leave them null for a plain due-by deadline with no attendance component.`;
const ACTION_EVIDENCE_GUARD = `Runtime evidence identity rule:
- The output JSON schema is amended: every object in "actions" MUST include "candidate_key": "<the exact supplied candidate_key>". Copy the exact supplied candidate_key for the one candidate this action projects; never omit, rename, or invent it.
- evidence must be an exact, short quotation from this source chunk. Never paraphrase it.
- Do not use title wording to decide whether an action is a duplicate; duplicate_of is allowed only for an actually open task supplied in the task history.`;

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function entityList(entities) {
  return entities
    .map(e => `- ${e.kind}:${e.id} ${e.label}${e.aliases?.length ? ` (aka ${e.aliases.join(', ')})` : ''}`)
    .join('\n') || '(none)';
}

function reusableTriageDecision(user, evidence) {
  const row = currentSourceReceipt(user, evidence, 'crm_source_triage');
  if (!row || row.status !== 'done') return null;
  const decision = parseJson(row.payload, null);
  // An old or malformed receipt must not masquerade as a complete triage
  // decision.  Re-run only in that case; valid decisions are replayed exactly
  // as written so their candidate identities cannot drift after a crash.
  if (!decision || typeof decision.should_synthesise !== 'boolean'
    || !Array.isArray(decision.candidate_actions)) return null;
  return { row, decision };
}

function reusableDuplicateDecision(user, evidence) {
  const row = currentSourceReceipt(user, evidence, 'crm_duplicate_reviewed');
  if (!row || ['error', 'fail'].includes(String(row.status || '').toLowerCase())) return null;
  const decision = parseJson(row.payload, null);
  if (!decision || !String(decision.decision || '').trim()) return null;
  return { row, decision };
}

function actionProjectionCovered(user, evidence, decision) {
  const receipt = currentSourceReceipt(user, evidence, 'crm_action_projected');
  if (!receipt || !['done', 'review'].includes(String(receipt.status || '').toLowerCase())) return false;
  const candidates = Array.isArray(decision?.candidate_actions) ? decision.candidate_actions : [];
  if (!candidates.length) return receipt.status === 'done';
  const expected = new Set(candidates.map(candidate => candidate?.candidate_key).filter(Boolean));
  if (expected.size !== candidates.length) return false;
  const terminal = new Set(db.hub().prepare(`
    SELECT action_key FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
      AND pipeline_version = ? AND disposition IN ('task_created','event_created','task_and_event_created','existing_open_task','fyi','dismissed')
  `).all(
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION,
  ).map(row => row.action_key));
  return [...expected].every(key => terminal.has(key));
}

function sourceRows(user, sourceKind) {
  return listSourceEvidence(user, sourceKind).map(evidence => ({
    ...evidence.row,
    text: evidence.text,
    evidence,
  }));
}

function autoErrorRetryDelaySeconds(attempts) {
  const count = Math.max(1, Number(attempts) || 1);
  const exponent = Math.min(16, count - 1);
  return Math.min(AUTO_ERROR_RETRY_MAX_SECONDS, AUTO_ERROR_RETRY_BASE_SECONDS * (2 ** exponent));
}

function sourceErrorRetryState(user, evidence, referenceNow = now()) {
  const hub = db.hub();
  const receiptRows = hub.prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, evidence.source_kind, evidence.source_id)
    .filter(row => receiptForCurrentSource(row, evidence))
    .filter(row => ['error', 'fail'].includes(String(row.status || '').toLowerCase()));
  const outcomeRows = hub.prepare(`
    SELECT updated_at FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ?
      AND source_revision = ? AND pipeline_version = ? AND disposition = 'error'
  `).all(
    user, evidence.source_kind, evidence.source_id,
    evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION,
  );
  const attemptsByStage = new Map();
  for (const row of receiptRows) {
    attemptsByStage.set(row.stage, (attemptsByStage.get(row.stage) || 0) + 1);
  }
  // One failed action projection can produce several action-outcome rows in a
  // single pass.  Count that pass once; the stage receipt records subsequent
  // attempts durably when the scheduler retries it.
  const attempts = Math.max(
    1,
    ...attemptsByStage.values(),
    outcomeRows.length ? 1 : 0,
  );
  const lastErrorAt = Math.max(
    0,
    ...receiptRows.map(row => Number(row.created_at || 0)),
    ...outcomeRows.map(row => Number(row.updated_at || 0)),
  );
  const retryDelaySeconds = autoErrorRetryDelaySeconds(attempts);
  const nextRetryAt = lastErrorAt + retryDelaySeconds;
  return {
    attempts,
    last_error_at: lastErrorAt || null,
    next_retry_at: nextRetryAt,
    retry_delay_seconds: retryDelaySeconds,
    due: Number(referenceNow) >= nextRetryAt,
  };
}

function takeFairCandidates(limit, newestIncomplete, oldestIncomplete, dueErrors) {
  const cap = Math.max(1, Number(limit) || 8);
  const selected = [];
  const seen = new Set();
  const lanes = [
    { items: newestIncomplete, index: 0 },
    { items: oldestIncomplete, index: 0 },
    { items: dueErrors, index: 0 },
  ];
  // A deterministic round-robin gives every normal pass a recent-source
  // slot, an oldest-incomplete recovery slot, and a separately budgeted due
  // error slot.  A short pass prefers recent evidence first; when only one
  // non-error source exists, de-duplication releases the next slot to errors.
  while (selected.length < cap) {
    let progressed = false;
    for (const lane of lanes) {
      while (lane.index < lane.items.length && seen.has(`${lane.items[lane.index].source_kind}\u0000${lane.items[lane.index].source_id}`)) {
        lane.index += 1;
      }
      if (lane.index >= lane.items.length || selected.length >= cap) continue;
      const evidence = lane.items[lane.index++];
      const key = `${evidence.source_kind}\u0000${evidence.source_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(evidence);
      progressed = true;
    }
    if (!progressed) break;
  }
  return selected;
}

// Health owns the current-revision lifecycle decision: any incomplete/error
// source is recoverable, including a process that died after triage but before
// projection or synthesis.  Selection deliberately does not use one global
// oldest-first slice: a persistent old error or untouched backlog must not
// starve newly arrived evidence.  Error retries are separately receipt-backed
// and only enter this automatic pass once due; manual retry remains immediate.
function candidateSources(user, limit, { referenceNow = now() } = {}) {
  const health = getCrmKnowledgeHealth(user);
  const recoverable = new Map((health.coverage?.sources || [])
    .filter(source => source.state === 'incomplete' || source.state === 'error')
    .map(source => [`${source.source_kind}\u0000${source.source_id}`, source.state]));
  const evidence = listSourceEvidence(user)
    .filter(evidence => !isCanonicalEvidenceExcluded(evidence))
    .filter(evidence => recoverable.has(`${evidence.source_kind}\u0000${evidence.source_id}`));
  const stableOrder = (a, b) => a.source_kind.localeCompare(b.source_kind)
    || String(a.source_id).localeCompare(String(b.source_id));
  const incomplete = evidence
    .filter(item => recoverable.get(`${item.source_kind}\u0000${item.source_id}`) === 'incomplete');
  const newestIncomplete = [...incomplete]
    .sort((a, b) => Number(b.ts) - Number(a.ts) || stableOrder(a, b));
  const oldestIncomplete = [...incomplete]
    .sort((a, b) => Number(a.ts) - Number(b.ts) || stableOrder(a, b));
  const dueErrors = evidence
    .filter(item => recoverable.get(`${item.source_kind}\u0000${item.source_id}`) === 'error')
    .map(item => ({ item, retry: sourceErrorRetryState(user, item, referenceNow) }))
    .filter(({ retry }) => retry.due)
    .sort((a, b) => Number(a.retry.next_retry_at) - Number(b.retry.next_retry_at)
      || Number(a.retry.last_error_at || 0) - Number(b.retry.last_error_at || 0)
      || stableOrder(a.item, b.item))
    .map(({ item }) => item);
  return takeFairCandidates(limit, newestIncomplete, oldestIncomplete, dueErrors);
}

function candidateSpan(evidence, chunk, candidate) {
  const quote = String(candidate?.evidence || candidate?.action || '').trim();
  return locateEvidenceSpan(evidence, quote, chunk)
    || (chunk ? {
      start: chunk.start,
      end: chunk.end,
      chunk_index: chunk.index,
      chunk_id: chunk.chunk_id,
      text: chunk.text,
      exact: false,
    } : null);
}

function stageActionKey(evidence, chunk, stage) {
  const span = candidateSpan(evidence, chunk, {});
  const base = stableActionKey(evidence, span) || hash(`${evidence.revision_hash}:${chunk?.chunk_id || 'source'}`);
  return hash(`${base}:${stage}`);
}

function malformedCandidateKey(evidence, chunk, candidate, ordinal = 0) {
  // This key is deliberately per candidate, not per fallback chunk.  It keeps
  // all malformed/unmatched model rows visible for review without granting any
  // of them the ordinary exact-span identity used for side effects.
  return hash(JSON.stringify({
    type: 'malformed_candidate',
    source_kind: evidence.source_kind,
    source_id: evidence.source_id,
    source_revision: evidence.revision_hash,
    chunk_id: chunk?.chunk_id || null,
    ordinal: Number(ordinal) || 0,
    action: String(candidate?.action || ''),
    title: String(candidate?.title || ''),
    evidence: String(candidate?.evidence || ''),
    actionability: String(candidate?.actionability || ''),
    confidence: Number(candidate?.confidence) || 0,
  }));
}

function decorateCandidate(evidence, chunk, candidate, ordinal) {
  const span = candidateSpan(evidence, chunk, candidate);
  const key = stableCandidateActionKey(evidence, span, candidate)
    || malformedCandidateKey(evidence, chunk, candidate, ordinal);
  return {
    ...(candidate && typeof candidate === 'object' ? candidate : {}),
    candidate_key: key,
    source_span: span ? {
      start: span.start,
      end: span.end,
      chunk_index: span.chunk_index,
      chunk_id: span.chunk_id,
      text: span.text,
      exact: Boolean(span.exact),
    } : null,
    source_revision: evidence.revision_hash,
  };
}

function mergeTriageResults(evidence, parts) {
  const actions = new Map();
  const entityRows = [];
  const relationshipRows = [];
  const summaries = [];
  const routing = [];
  let shouldSynthesise = false;
  let confidence = 0;
  for (const { parsed, chunk } of parts) {
    shouldSynthesise = shouldSynthesise || Boolean(parsed.should_synthesise);
    confidence = Math.max(confidence, Number(parsed.confidence) || 0);
    if (parsed.source_summary) summaries.push(String(parsed.source_summary));
    if (parsed.routing_notes) routing.push(String(parsed.routing_notes));
    entityRows.push(...(Array.isArray(parsed.candidate_entities) ? parsed.candidate_entities : []));
    relationshipRows.push(...(Array.isArray(parsed.candidate_relationships) ? parsed.candidate_relationships : []));
    for (const [ordinal, action] of (Array.isArray(parsed.candidate_actions) ? parsed.candidate_actions : []).entries()) {
      const candidate = decorateCandidate(evidence, chunk, action, ordinal);
      // A source sentence can carry more than one ask.  Exact span alone is
      // therefore insufficient; stable normalised candidate semantics keep
      // each ask visible while a wording-only replay retains its own row.
      if (!actions.has(candidate.candidate_key)) actions.set(candidate.candidate_key, candidate);
    }
  }
  return {
    should_synthesise: shouldSynthesise,
    source_summary: summaries.slice(0, 6).join(' ') || '',
    knowledge_value: shouldSynthesise ? 'durable_claims' : actions.size ? 'actions' : 'none',
    candidate_entities: entityRows,
    candidate_relationships: relationshipRows,
    candidate_actions: [...actions.values()],
    routing_notes: routing.slice(0, 8).join(' '),
    confidence,
    chunks_processed: parts.length,
  };
}

async function triageSource(user, evidence, entities) {
  const modelId = getSystemModelId('crm_source_triage', 'system', TRIAGE_FALLBACK);
  const parts = [];
  for (const chunk of evidence.chunks) {
    const prompt = getSystemPrompt('crm_source_triage', 'system', PROMPTS.crm_source_triage)
      .replaceAll('[SOURCE_KIND]', evidence.source_kind)
      .replaceAll('[ENTITIES]', entityList(entities))
      .replaceAll('[SOURCE_TEXT]', chunk.text);
    const parsed = await requestModelObject({
      modelId,
      messages: [{ role: 'user', content: prompt }],
      user,
      feature: 'crm-source-triage',
      modelKey: 'crm_source_triage',
      taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
      defaults: {
        should_synthesise: false,
        source_summary: '',
        knowledge_value: 'none',
        candidate_entities: [],
        candidate_relationships: [],
        candidate_actions: [],
        routing_notes: '',
        confidence: 0,
      },
      label: `CRM source triage response (${evidence.source_kind} chunk ${chunk.index})`,
    });
    parsed.candidate_entities = Array.isArray(parsed.candidate_entities) ? parsed.candidate_entities : [];
    parsed.candidate_relationships = Array.isArray(parsed.candidate_relationships) ? parsed.candidate_relationships : [];
    parsed.candidate_actions = Array.isArray(parsed.candidate_actions) ? parsed.candidate_actions : [];
    parts.push({ parsed, chunk });
  }
  return { parsed: mergeTriageResults(evidence, parts), modelId };
}

function existingKnowledgeForReview(user, decision, evidence) {
  const hub = db.hub();
  const names = [
    ...(decision.candidate_entities || []).map(e => e.name),
    ...(decision.candidate_relationships || []).flatMap(r => [r.subject, r.object]),
    ...(decision.candidate_actions || []).flatMap(a => [a.owner, a.action]),
  ].map(v => String(v || '').trim().toLowerCase()).filter(v => v.length >= 3);
  const atoms = hub.prepare(`
    SELECT id, subject_kind, subject_label, predicate, value, confidence, status
    FROM knowledge_atoms
    WHERE user = ? AND status IN ('active','proposed')
    ORDER BY updated_at DESC
    LIMIT 400
  `).all(user).filter(atom => {
    if (!names.length) return true;
    const haystack = `${atom.subject_label} ${atom.predicate} ${atom.value}`.toLowerCase();
    return names.some(name => haystack.includes(name) || name.includes(String(atom.subject_label || '').toLowerCase()));
  }).slice(0, 40);
  const openTasks = hub.prepare(`
    SELECT id, title, notes, project_slug, due
    FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 80
  `).all(user);
  return [
    `SOURCE EXCERPT: ${String(evidence.text || '').slice(0, 1200)}`,
    'EXISTING ATOMS',
    ...(atoms.length ? atoms.map(a => `ATOM ${a.id}: [${a.subject_kind}:${a.subject_label}] ${a.predicate} = ${a.value} (status ${a.status}, confidence ${a.confidence})`) : ['(none)']),
    'OPEN TASKS',
    ...(openTasks.length ? openTasks.map(t => `TASK ${t.id}: ${t.title}${t.project_slug ? ` /${t.project_slug}` : ''}${t.due ? ` due ${t.due}` : ''}${t.notes ? ` — ${String(t.notes).slice(0, 120)}` : ''}`) : ['(none)']),
  ].join('\n');
}

async function reviewDuplicate(user, evidence, decision) {
  const modelId = getSystemModelId('crm_duplicate_review', 'system', DUPLICATE_FALLBACK);
  const prompt = getSystemPrompt('crm_duplicate_review', 'system', PROMPTS.crm_duplicate_review)
    .replaceAll('[CANDIDATE]', JSON.stringify({
      source_kind: evidence.source_kind,
      source_summary: decision.source_summary,
      knowledge_value: decision.knowledge_value,
      candidate_entities: decision.candidate_entities,
      candidate_relationships: decision.candidate_relationships,
      candidate_actions: decision.candidate_actions,
      routing_notes: decision.routing_notes,
    }, null, 2).slice(0, 12000))
    .replaceAll('[EXISTING]', existingKnowledgeForReview(user, decision, evidence).slice(0, 14000));
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    user,
    feature: 'crm-duplicate-review',
    modelKey: 'crm_duplicate_review',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: { decision: 'uncertain', target_id: null, reason: '', confidence: 0 },
    label: 'CRM duplicate review response',
  });
  return { parsed, modelId };
}

function sourceRefForEvidence(evidence) {
  return {
    kind: evidence.source_kind,
    id: evidence.source_id,
    revision: evidence.revision_hash,
    // Duplicate review applies to the whole raw source, not a model-invented
    // quote.  Preserve the revision and full range without pretending that it
    // was one particular extraction chunk.
    start: 0,
    end: String(evidence.text || '').length,
  };
}

function mergeSourceRefIntoAtom(user, atomId, sourceRef, confidence = 0.7) {
  const hub = db.hub();
  const atom = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
  if (!atom) return false;
  const refs = mergeRefs(atom.source_refs, sourceRef);
  const nextConfidence = Math.min(0.99, Math.max(Number(atom.confidence) || 0.6, Number(confidence) || 0.7) + 0.02);
  hub.prepare(`
    UPDATE knowledge_atoms
       SET source_refs = ?, confidence = ?, last_confirmed = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND user = ?
  `).run(JSON.stringify(refs), nextConfidence, atomId, user);
  return true;
}

function confirmationTargetEvidence(user, evidence, targetId, result = null) {
  const atom = db.hub().prepare('SELECT id, source_refs FROM knowledge_atoms WHERE id = ? AND user = ?').get(targetId, user);
  const refs = parseJson(atom?.source_refs, []);
  const perClaimProvenance = Array.isArray(refs) && refs.some(ref =>
    ref?.kind === evidence.source_kind
      && String(ref?.id) === String(evidence.source_id)
      && ref?.revision === evidence.revision_hash
      // A full-source duplicate-review decision is deliberately insufficient:
      // the extractor must contribute a deterministic chunk/span reference.
      && Boolean(ref?.chunk_id)
      && Number.isInteger(ref?.start)
      && Number.isInteger(ref?.end)
      && ref.end > ref.start
  );
  const emittedTarget = Array.isArray(result?.atom_ids) && result.atom_ids.includes(targetId);
  return {
    target_id: targetId,
    per_claim_proven: Boolean(perClaimProvenance),
    emitted_target: emittedTarget,
  };
}

function mutableAtomForSupersession(user, atomId) {
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
  if (!atom) return { atom: null, reason: 'duplicate_target_not_found' };
  const derivedBy = String(atom.derived_by || '').toLowerCase();
  if (derivedBy === 'manual' || derivedBy.startsWith('backfill:crm_fact')) {
    return { atom, reason: 'duplicate_target_is_human_curated' };
  }
  return { atom, reason: null };
}

function retireAtomForSupersession(user, atomId, sourceRef, confidence = 0.7) {
  const resolved = mutableAtomForSupersession(user, atomId);
  if (!resolved.atom || resolved.reason) return { retired: false, ...resolved };
  const atom = resolved.atom;
  const refs = mergeRefs(atom.source_refs, sourceRef);
  const nextConfidence = Math.min(0.99, Math.max(Number(atom.confidence) || 0.6, Number(confidence) || 0.7) + 0.02);
  db.hub().prepare(`
    UPDATE knowledge_atoms
       SET source_refs = ?, confidence = ?, status = 'retired',
           last_confirmed = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND user = ? AND status != 'retired'
  `).run(JSON.stringify(refs), nextConfidence, atomId, user);
  return { retired: true, atom, reason: null };
}

function duplicateSynthesisPlan(user, evidence, duplicateDecision) {
  const decision = String(duplicateDecision?.decision || '').trim().toLowerCase();
  const confidence = Number(duplicateDecision?.confidence) || 0;
  const targetId = String(duplicateDecision?.target_id || '').trim();
  if (!['new', 'duplicate', 'confirms_existing', 'corrects_existing', 'supersedes_existing'].includes(decision)) {
    return { mode: 'review', reason: 'duplicate_review_uncertain', decision, confidence, target_id: targetId || null };
  }
  if (confidence < DUPLICATE_REVIEW_CONFIDENCE) {
    return { mode: 'review', reason: 'duplicate_review_below_confidence_threshold', decision, confidence, target_id: targetId || null };
  }
  if (decision === 'new') return { mode: 'synthesise', decision, confidence, target_id: null };
  if (!targetId) {
    // Model said duplicate/confirms/corrects without naming an atom. Do not
    // strand the source in permanent review — run per-claim synthesis so novel
    // claims still compile; true duplicates merge via upsertAtom provenance.
    // Corrections/supersessions still need a real target to retire anything.
    if (['duplicate', 'confirms_existing'].includes(decision)) {
      return {
        mode: 'synthesise',
        reason: 'duplicate_without_target_synthesise',
        decision,
        confidence,
        target_id: null,
      };
    }
    return { mode: 'review', reason: 'duplicate_review_missing_target', decision, confidence, target_id: null };
  }
  const sourceRef = sourceRefForEvidence(evidence);
  if (['duplicate', 'confirms_existing'].includes(decision)) {
    const target = db.hub().prepare('SELECT id FROM knowledge_atoms WHERE id = ? AND user = ?').get(targetId, user);
    if (!target) {
      return { mode: 'review', reason: 'duplicate_review_target_not_found', decision, confidence, target_id: targetId };
    }
    // A duplicate-review response is scoped to the raw source, not to every
    // claim the source contains.  It can identify a likely existing atom, but
    // cannot prove that there is no second, novel claim elsewhere in the same
    // message/document.  Continue through normal per-claim synthesis: an
    // extracted matching claim will merge through upsertAtom with its exact
    // chunk provenance, while a novel claim remains eligible for a new atom.
    // In particular, do not attach a full-source ref or skip synthesis here.
    return {
      mode: 'synthesise_with_confirmation',
      reason: 'duplicate_or_confirmation_requires_per_claim_synthesis',
      decision,
      confidence,
      target_id: targetId,
    };
  }
  const target = mutableAtomForSupersession(user, targetId);
  if (!target.atom || target.reason) {
    return { mode: 'review', reason: target.reason || 'duplicate_review_target_not_found', decision, confidence, target_id: targetId };
  }
  // Correction/supersession may create a replacement claim, but the old
  // mutable claim is retired only after the new evidence has actually been
  // synthesised.  A model/synthesis failure therefore leaves the old claim
  // intact rather than losing knowledge mid-recovery.
  return {
    mode: 'synthesise_then_retire',
    decision,
    confidence,
    target_id: targetId,
    source_ref: sourceRef,
    // Retiring a claim requires a replacement in this same claim slot, not
    // merely any atom extracted from the new source revision.
    target_claim_slot: {
      subject_kind: target.atom.subject_kind || null,
      subject_id: target.atom.subject_id || null,
      subject_label: target.atom.subject_label || null,
      predicate: target.atom.predicate || null,
    },
  };
}

function normalisedAtomLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sameAtomClaimSlot(target, candidate) {
  if (!target || !candidate || String(target.predicate || '') !== String(candidate.predicate || '')) return false;
  const targetKind = String(target.subject_kind || '');
  const candidateKind = String(candidate.subject_kind || '');
  if (targetKind && candidateKind && targetKind !== candidateKind) return false;
  const targetId = String(target.subject_id || '').trim();
  const candidateId = String(candidate.subject_id || '').trim();
  const sameIdentity = Boolean(targetId && candidateId && targetId === candidateId);
  const targetLabel = normalisedAtomLabel(target.subject_label);
  const candidateLabel = normalisedAtomLabel(candidate.subject_label);
  const sameLabel = Boolean(targetLabel && candidateLabel && targetLabel === candidateLabel);
  // A resolved entity identity is strongest; unresolved/partially resolved
  // synthesis may still prove the slot with an exact subject label.
  return sameIdentity || sameLabel;
}

function replacementAtomsForEvidence(user, evidence, targetAtomOrId = null) {
  const target = typeof targetAtomOrId === 'string'
    ? db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(targetAtomOrId, user)
    : targetAtomOrId;
  if (!target) return [];
  const rows = db.hub().prepare(`
    SELECT id, subject_kind, subject_id, subject_label, predicate, source_refs FROM knowledge_atoms
    WHERE user = ? AND status IN ('active', 'proposed', 'stale')
  `).all(user);
  return rows.filter(row => row.id !== target.id).filter(row => {
    if (!sameAtomClaimSlot(target, row)) return false;
    const refs = parseJson(row.source_refs, []);
    return Array.isArray(refs) && refs.some(ref =>
      ref?.kind === evidence.source_kind
        && String(ref?.id) === String(evidence.source_id)
        && ref?.revision === evidence.revision_hash
    );
  });
}

function taskState(task) {
  if (task.deleted_at) return task.status === 'wrong' ? 'wrong' : 'deleted';
  return task.status === 'completed' ? 'completed' : 'open';
}

// Only OPEN tasks travel in the prompt now: they are the live state the model
// must not duplicate, and there are few of them. Closed tasks (completed /
// deleted / wrong) used to dominate this block — ~240 rows, most of them
// negative "do not recreate" history — but a probabilistic model scanning a
// long list is the wrong tool for an exact-duplicate check. That guarantee is
// enforced deterministically after the model responds by closedTaskDuplicateMatch,
// which checks the whole closed corpus rather than the most recent slice.
function taskHistoryForActionProjection(user) {
  const rows = db.hub().prepare(`
    SELECT id, google_task_id, title, notes, due, project_slug, status, deleted_at, completed_at, created_at
    FROM google_tasks
    WHERE user = ? AND deleted_at IS NULL AND status NOT IN ('completed', 'wrong')
    ORDER BY COALESCE(created_at, synced_at) DESC
    LIMIT 120
  `).all(user);
  if (!rows.length) return '(none)';
  return rows.map(task => {
    const bits = [`[open] TASK_ID:${task.id} ${task.title}`];
    if (task.project_slug) bits.push(`project:${task.project_slug}`);
    if (task.due) bits.push(`due:${task.due}`);
    if (task.notes) bits.push(String(task.notes).slice(0, 100));
    return `- ${bits.join(' | ')}`;
  }).join('\n');
}

// Deterministic anti-recreation guard for CLOSED tasks (completed / deleted /
// wrong), replacing the closed-task history that used to be stuffed into the
// projection prompt. Two layers, cheapest first:
//   1. Normalised-title exact match against the ENTIRE closed corpus — catches
//      the common case (the model reproducing a near-identical title) and is
//      the only layer that covers deleted/wrong tasks, which are not embedded.
//   2. Semantic match against completed-task embeddings (already indexed on the
//      local Ollama, zero cost) — catches paraphrased duplicates of completed
//      work. Deliberately conservative: a high threshold so a genuinely new
//      task is never suppressed, because a wrongly-dropped task costs Douglas
//      the thing he needed (see effect-gate philosophy in CLAUDE.md).
// Fail-open: any embedding outage silently falls back to the title layer; the
// check never throws and never blocks task creation on infrastructure state.
const CLOSED_TASK_SEMANTIC_THRESHOLD = 0.90;

function normaliseTaskTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function closedTaskDuplicateMatch(user, action) {
  const title = String(action?.title || '').trim();
  if (!title) return null;

  const closed = db.hub().prepare(`
    SELECT id, title, status, deleted_at FROM google_tasks
    WHERE user = ? AND COALESCE(title, '') != ''
      AND (status IN ('completed', 'wrong') OR deleted_at IS NOT NULL)
  `).all(user);
  if (!closed.length) return null;

  const wantedTitle = normaliseTaskTitle(title);
  if (wantedTitle) {
    const hit = closed.find(task => normaliseTaskTitle(task.title) === wantedTitle);
    if (hit) return { taskId: hit.id, matchedTitle: hit.title, state: taskState(hit), method: 'title', score: 1 };
  }

  try {
    const { semanticSearch } = require('./retrieval');
    const hits = await semanticSearch(user, `${title}\n${action.evidence || ''}`, 1, {
      sourceKinds: ['completed_task'],
      minScore: CLOSED_TASK_SEMANTIC_THRESHOLD,
    });
    const top = hits[0];
    if (top) {
      const task = closed.find(t => t.id === top.source_id)
        || db.hub().prepare('SELECT id, title, status, deleted_at FROM google_tasks WHERE user = ? AND id = ?').get(user, top.source_id);
      if (task) return { taskId: task.id, matchedTitle: task.title, state: taskState(task), method: 'semantic', score: top.score };
    }
  } catch (err) {
    console.warn('[crm-engine] closed-task semantic dedup skipped:', err.message);
  }
  return null;
}

async function projectActions(user, chunk, candidates) {
  if (!candidates?.length) return { parsed: { actions: [] }, modelId: null };
  const modelId = getSystemModelId('crm_action_projection', 'system', ACTION_FALLBACK);
  const basePrompt = getSystemPrompt('crm_action_projection', 'system', PROMPTS.crm_action_projection)
    .replaceAll('[SOURCE_TEXT]', chunk.text)
    .replaceAll('[CANDIDATES]', JSON.stringify(candidates, null, 2))
    .replaceAll('[TASKS]', taskHistoryForActionProjection(user));
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: `${basePrompt}\n\n${ACTION_STATE_GUARD}\n\n${ACTION_EVENT_GUARD}\n\n${ACTION_EVIDENCE_GUARD}` }],
    user,
    feature: 'crm-action-projection',
    modelKey: 'crm_action_projection',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: { actions: [] },
    label: `CRM action projection response (chunk ${chunk.index})`,
  });
  parsed.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return { parsed, modelId };
}

// Preserve every candidate rather than truncating a dense source chunk to fit
// a single prompt.  Oversized individual candidates still travel intact in a
// one-item batch, which makes the exceptional case observable to the model.
function candidateBatches(candidates, { maxChars = 10000 } = {}) {
  const batches = [];
  let batch = [];
  let characters = 2; // JSON array brackets
  for (const candidate of candidates || []) {
    const serialized = JSON.stringify(candidate);
    const addition = serialized.length + (batch.length ? 1 : 0);
    if (batch.length && characters + addition > maxChars) {
      batches.push(batch);
      batch = [];
      characters = 2;
    }
    batch.push(candidate);
    characters += serialized.length + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function findEntityByName(entities, kind, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return entities.find(entity => {
    if (kind && entity.kind !== kind) return false;
    const names = [entity.label, ...(entity.aliases || [])].map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
    return names.some(candidate => candidate === wanted || (wanted.length >= 4 && (candidate.includes(wanted) || wanted.includes(candidate))));
  }) || null;
}

function actionProjectionBlockReason(sourceKind, _duplicateDecision, row = null) {
  // Duplicate review is intentionally absent: it governs atom synthesis only.
  if (sourceKind === 'completed_task') return 'completed_task_is_terminal';
  if (sourceKind === 'messaging_message' && routingMetadata(row).historical_backfill) return 'historical_backfill_requires_current_evidence';
  return null;
}

function eventFromAction(action) {
  const event = action?.event;
  if (!event || !event.start || !event.end) return null;
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start: event.start, end: event.end, location: event.location || null };
}

function actionDisposition(action) {
  const confidence = Number(action?.confidence) || 0;
  const actionability = String(action?.actionability || '').toLowerCase();
  if (!String(action?.title || '').trim()) return { disposition: 'review', reason: 'malformed_missing_title', confidence };
  if (actionability === 'fyi') return { disposition: 'fyi', reason: 'fyi_not_actionable', confidence };
  if (!['explicit_ask', 'commitment', 'implied'].includes(actionability)) {
    return { disposition: 'review', reason: 'malformed_actionability', confidence };
  }
  if (actionability === 'explicit_ask' || actionability === 'commitment' || confidence >= ACTION_CONFIDENCE_THRESHOLD) {
    return { disposition: 'create', reason: actionability === 'implied' ? 'confident_implied' : 'ask_or_commitment', confidence };
  }
  // Low-confidence is a visible review outcome, never a silently skipped ask.
  return { disposition: 'review', reason: confidence >= ACTION_REVIEW_FLOOR ? 'implied_needs_review' : 'below_review_floor', confidence };
}

function validActionTitle(action) {
  const title = String(action?.title || '').trim();
  return Boolean(title)
    && title.length <= 240
    && !/[\u0000-\u001f\u007f]/.test(title);
}

function exactEvidenceSpan(span) {
  return Boolean(span?.exact === true)
    && Boolean(span?.chunk_id)
    && Number.isInteger(span?.start)
    && Number.isInteger(span?.end)
    && span.end > span.start;
}

function actionCreationBlockReason(action, identity) {
  if (identity?.source_level) return 'source_level_review_not_creatable';
  // Every provider side effect must descend from a triage candidate.  Exact
  // text alone is not authority: an older/hand-written review row can have a
  // real span but no candidate provenance.
  if (!identity?.candidate) return 'action_not_tied_to_triage_candidate';
  if (identity?.side_effect_ambiguity?.requires_reconciliation) {
    return 'side_effect_ambiguity_requires_reconciliation';
  }
  if (identity?.non_creatable) return 'review_not_creatable';
  if (!String(action?.title || '').trim()) return 'malformed_missing_title';
  if (!validActionTitle(action)) return 'malformed_invalid_title';
  return null;
}

function isNonCreatablePayload(payload) {
  return Boolean(payload?.non_creatable)
    || Boolean(payload?.side_effect_ambiguity?.requires_reconciliation);
}

function sideEffectAmbiguityFromReason(reason) {
  const match = String(reason || '').match(/^(task|event)_side_effect_ambiguous_requires_human_review$/);
  return match ? {
    type: 'unreconciled_provider_side_effect',
    phase: match[1],
    requires_reconciliation: true,
  } : null;
}

function outcomeRequiresReconciliation(outcome) {
  const payload = parseJson(outcome?.payload);
  return Boolean(payload?.side_effect_ambiguity?.requires_reconciliation)
    || Boolean(sideEffectAmbiguityFromReason(outcome?.reason));
}

function ambiguousSideEffectIdentity(identity, phase) {
  return {
    ...identity,
    non_creatable: true,
    side_effect_ambiguity: {
      type: 'unreconciled_provider_side_effect',
      phase,
      requires_reconciliation: true,
    },
  };
}

function normaliseText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Candidate semantics distinguish two asks which happen to quote the same
// source sentence.  Keep this deliberately narrow and presentation-insensitive
// so capitalisation, punctuation, and articles on replay do not manufacture a
// second provider action for the same underlying candidate.
function normaliseActionSemantics(value) {
  return normaliseText(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:a|an|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateSemantics(candidate) {
  const action = normaliseActionSemantics(candidate?.action || candidate?.title);
  if (!action) return null;
  return {
    action,
    owner: normaliseActionSemantics(candidate?.owner),
  };
}

function stableCandidateActionKey(evidence, span, candidate) {
  const spanKey = stableActionKey(evidence, span);
  const semantics = candidateSemantics(candidate);
  if (!spanKey || !semantics) return null;
  return hash(JSON.stringify({ type: 'exact_candidate_action', span_key: spanKey, semantics }));
}

const PROJECTION_NON_CREATABLE_REASONS = new Set([
  'projection_action_not_tied_to_triage_candidate',
  'projection_omitted_triage_candidate',
]);

function projectionReviewIsNonCreatable(reason) {
  return PROJECTION_NON_CREATABLE_REASONS.has(String(reason || ''));
}

function projectedCandidateKey(action) {
  return String(action?.candidate_key || action?._candidate_key || '').trim();
}

function candidateForProjectedAction(action, candidates) {
  const explicit = projectedCandidateKey(action);
  const explicitCandidate = explicit
    ? candidates.find(candidate => candidate.candidate_key === explicit)
    : null;
  // Candidate keys are the desired contract, but an action model can emit a
  // stale key or accidentally reuse another candidate's key. A unique
  // semantic/evidence match is stronger proof and must correct that mistake.
  // Prefer the normalised ask over its quotation: one sentence may contain
  // several different asks, all with the same exact evidence span.
  const projectedSemantics = candidateSemantics(action);
  const semanticMatches = projectedSemantics
    ? candidates.filter(candidate => {
      const candidateMeaning = candidateSemantics(candidate);
      return candidateMeaning?.action === projectedSemantics.action;
    })
    : [];
  const evidence = normaliseText(action?.evidence);
  const evidenceMatches = evidence
    ? candidates.filter(candidate => {
      const candidateEvidence = normaliseText(candidate.evidence || candidate.action);
      return candidateEvidence && (candidateEvidence === evidence || candidateEvidence.includes(evidence) || evidence.includes(candidateEvidence));
    })
    : [];
  const uniqueSemantic = semanticMatches.length === 1 ? semanticMatches[0] : null;
  const uniqueEvidence = evidenceMatches.length === 1 ? evidenceMatches[0] : null;

  // Either independent proof may repair a stale/reused key, but two proofs
  // that point at different candidates are a contradiction, not a reason to
  // privilege a model-supplied key. Likewise, a shared semantic or quotation
  // is deliberately not broken with a known key: a reused key plus a shared
  // span is exactly the failure mode that must remain non-creatable.
  if (uniqueSemantic && uniqueEvidence && uniqueSemantic !== uniqueEvidence) return null;
  const independentlyProven = uniqueSemantic || uniqueEvidence;
  if (independentlyProven) return independentlyProven;
  if (semanticMatches.length > 1 || evidenceMatches.length > 1) return null;
  // No independent proof contradicts the supplied, current candidate key.
  // It is therefore the explicit projection link rather than a title-only
  // duplicate signal; absent a known key we fail closed.
  return explicitCandidate || null;
}

// A candidate key is a compiled identity, not a suggestion from the action
// model.  Keep a bad model value for auditability, but every downstream
// identity and provider idempotency key must use the candidate key once the
// conservative linker has proved the relationship.
function canonicaliseProjectedAction(action, candidate) {
  if (!candidate?.candidate_key) return action;
  const supplied = projectedCandidateKey(action);
  return {
    ...(action && typeof action === 'object' ? action : {}),
    candidate_key: candidate.candidate_key,
    ...(supplied && supplied !== candidate.candidate_key
      ? { projected_candidate_key: supplied }
      : {}),
  };
}

function projectedEvidenceSpan(evidence, action, chunk) {
  return locateEvidenceSpan(evidence, action?.evidence || action?.action, chunk);
}

function actionIdentity(evidence, action, candidates, chunk) {
  const candidate = candidateForProjectedAction(action, candidates);
  const candidateEvidenceSpan = candidate?.source_span;
  const actionEvidenceSpan = projectedEvidenceSpan(evidence, action, chunk);
  // Triage may correctly identify an ask while quoting a paraphrase. Once a
  // projection is safely tied to that authoritative candidate, an exact
  // projection quote is stronger provenance than the candidate's approximate
  // fallback span. Do not replace an already exact triage span, and keep the
  // normal non-exact review path when neither stage supplies exact evidence.
  const span = exactEvidenceSpan(candidateEvidenceSpan)
    ? candidateEvidenceSpan
    : exactEvidenceSpan(actionEvidenceSpan)
      ? actionEvidenceSpan
      : candidateEvidenceSpan || actionEvidenceSpan
    || candidateSpan(evidence, chunk, action);
  return {
    candidate,
    span,
    action_key: candidate?.candidate_key || stableActionKey(evidence, span)
      || malformedCandidateKey(evidence, chunk, action, `projection:${projectedCandidateKey(action)}`),
  };
}

function getActionOutcome(user, evidence, actionKey) {
  return db.hub().prepare(`
    SELECT * FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
      AND pipeline_version = ? AND action_key = ?
  `).get(user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey);
}

function outcomePayload(evidence, action, identity, extra = {}) {
  return {
    pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
    source_revision: evidence.revision_hash,
    source_provenance: evidence.provenance,
    action,
    candidate: identity?.candidate || null,
    evidence_span: identity?.span || null,
    source_level: Boolean(identity?.source_level),
    non_creatable: Boolean(identity?.source_level || identity?.non_creatable),
    side_effect_ambiguity: identity?.side_effect_ambiguity || null,
    ...extra,
  };
}

function upsertActionOutcome(user, evidence, actionKey, {
  action = {},
  identity = null,
  disposition,
  reason = '',
  taskId = null,
  eventId = null,
  payload = {},
} = {}) {
  const span = identity?.span || action?.source_span || null;
  const ts = now();
  const terminal = OUTCOME_TERMINAL.has(disposition) || disposition === 'dismissed';
  const title = String(action?.title || identity?.candidate?.action || '').trim() || null;
  const evidenceText = String(span?.text || action?.evidence || identity?.candidate?.evidence || '').trim();
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO crm_action_outcomes
      (id, user, source_kind, source_id, source_revision, pipeline_version, action_key,
       candidate_title, evidence_text, evidence_start, evidence_end, chunk_index, chunk_id,
       actionability, confidence, disposition, reason, task_id, event_id, payload,
       created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user, source_kind, source_id, source_revision, pipeline_version, action_key)
    DO UPDATE SET
      candidate_title = excluded.candidate_title,
      evidence_text = excluded.evidence_text,
      evidence_start = excluded.evidence_start,
      evidence_end = excluded.evidence_end,
      chunk_index = excluded.chunk_index,
      chunk_id = excluded.chunk_id,
      actionability = excluded.actionability,
      confidence = excluded.confidence,
      disposition = excluded.disposition,
      reason = excluded.reason,
      task_id = COALESCE(excluded.task_id, crm_action_outcomes.task_id),
      event_id = COALESCE(excluded.event_id, crm_action_outcomes.event_id),
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      resolved_at = CASE WHEN excluded.resolved_at IS NOT NULL THEN excluded.resolved_at ELSE NULL END
  `).run(
    id, user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey,
    title, evidenceText, span?.start ?? null, span?.end ?? null, span?.chunk_index ?? null, span?.chunk_id ?? null,
    action?.actionability || identity?.candidate?.actionability || null, Number(action?.confidence ?? identity?.candidate?.confidence) || 0,
    disposition, reason || null, taskId, eventId, JSON.stringify(payload || {}), ts, ts, terminal ? ts : null,
  );
  return getActionOutcome(user, evidence, actionKey);
}

// Outcome creation is deliberately not an upsert. Two workers may both reach
// a new source at once; only the one whose INSERT wins may make the
// irreversible provider call or record a new projection failure. Every other
// worker must retain the durable row it observes.
function insertActionOutcomeIfAbsent(user, evidence, actionKey, {
  action = {},
  identity = null,
  disposition,
  reason,
  taskId = null,
  payload = {},
} = {}) {
  const span = identity?.span || action?.source_span || null;
  const ts = now();
  const terminal = OUTCOME_TERMINAL.has(disposition) || disposition === 'dismissed';
  const title = String(action?.title || identity?.candidate?.action || '').trim() || null;
  const evidenceText = String(span?.text || action?.evidence || identity?.candidate?.evidence || '').trim();
  const result = db.hub().prepare(`
    INSERT INTO crm_action_outcomes
      (id, user, source_kind, source_id, source_revision, pipeline_version, action_key,
       candidate_title, evidence_text, evidence_start, evidence_end, chunk_index, chunk_id,
       actionability, confidence, disposition, reason, task_id, event_id, payload,
       created_at, updated_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    ON CONFLICT(user, source_kind, source_id, source_revision, pipeline_version, action_key) DO NOTHING
  `).run(
    uuid(), user, evidence.source_kind, evidence.source_id, evidence.revision_hash, CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey,
    title, evidenceText, span?.start ?? null, span?.end ?? null, span?.chunk_index ?? null, span?.chunk_id ?? null,
    action?.actionability || identity?.candidate?.actionability || null, Number(action?.confidence ?? identity?.candidate?.confidence) || 0,
    disposition, reason || null, taskId, JSON.stringify(payload || {}), ts, ts, terminal ? ts : null,
  );
  return result.changes === 1;
}

function isRetryableProjectionFailure(outcome) {
  return outcome?.disposition === 'error'
    && String(outcome.reason || '').startsWith('action_projection_failed:')
    && !isNonCreatablePayload(parseJson(outcome.payload));
}

function payloadHasHumanReviewState(payload) {
  return Boolean(
    payload?.dismissed_from
    || payload?.dismissal_reason
    || payload?.human_dismissal
    || payload?.human_resolution
    || payload?.human_action
    || payload?.human_review
    || payload?.manual_resolution
    || payload?.manual_review
    || payload?.review_resolution
    || payload?.reviewed_by
    || payload?.resolved_by,
  );
}

function currentCandidateReviewProof(user, outcome, payload, evidence, identity, actionKey) {
  const payloadCandidateKey = String(payload?.candidate?.candidate_key || '').trim();
  const payloadActionCandidateKey = String(payload?.action?.candidate_key || '').trim();
  return Boolean(evidence && identity?.candidate)
    && outcome?.user === user
    && outcome?.source_kind === evidence.source_kind
    && outcome?.source_id === evidence.source_id
    && outcome?.source_revision === evidence.revision_hash
    && outcome?.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
    && outcome?.action_key === actionKey
    && identity.candidate.candidate_key === actionKey
    && payload?.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
    && payload?.source_revision === evidence.revision_hash
    && payloadCandidateKey === actionKey
    // Old rows did not always retain the projected candidate key in the
    // action object. When they did, it is another assertion, not permission
    // to reclaim a key that conflicts with the canonical candidate.
    && (!payloadActionCandidateKey || payloadActionCandidateKey === actionKey)
    && (!payload?.candidate?.source_revision
      || payload.candidate.source_revision === evidence.revision_hash);
}

function automaticProjectionLinkageGate(reason, payload) {
  if (payload?.creation_block) return false;
  return (reason === 'projection_action_not_tied_to_triage_candidate'
      && payload?.projection_gate === 'unmatched_projection_action')
    || (reason === 'projection_omitted_triage_candidate'
      && payload?.projection_gate === 'omitted_triage_candidate');
}

function projectionReviewRecoveryMetadata(previous) {
  const priorPayload = parseJson(previous?.payload);
  return {
    prior_outcome_id: previous?.id || null,
    prior_reason: previous?.reason || null,
    prior_gate_or_block: priorPayload?.projection_gate || priorPayload?.creation_block || null,
    recovered_at: now(),
  };
}

function isAutomaticProjectionRecoveryReview(outcome) {
  return projectionReviewIsNonCreatable(outcome?.reason)
    || outcome?.reason === 'non_exact_evidence_requires_review';
}

function isRetryableProjectionLinkageReview(outcome, user, evidence, identity, actionKey) {
  const payload = parseJson(outcome?.payload);
  return outcome?.disposition === 'review'
    && automaticProjectionLinkageGate(outcome.reason, payload)
    && isNonCreatablePayload(payload)
    && !outcome.task_id
    && !outcome.event_id
    && !outcome.resolved_at
    && !payloadHasHumanReviewState(payload)
    && !outcomeRequiresReconciliation(outcome)
    && currentCandidateReviewProof(user, outcome, payload, evidence, identity, actionKey);
}

// Older pipeline runs incorrectly blocked source-backed candidates whenever
// the model paraphrased their evidence. Candidate identity plus the preserved
// raw source is authoritative; a later canonical projection may reclaim that
// automatic review without requiring the model to reproduce a byte-exact
// quotation.
function isRetryableProjectionEvidenceReview(outcome, user, evidence, identity, actionKey) {
  const payload = parseJson(outcome?.payload);
  return outcome?.disposition === 'review'
    && outcome.reason === 'non_exact_evidence_requires_review'
    && payload?.creation_block === 'non_exact_evidence_requires_review'
    && !payload?.projection_gate
    && !exactEvidenceSpan(payload?.evidence_span)
    && isNonCreatablePayload(payload)
    && !outcome.task_id
    && !outcome.event_id
    && !outcome.resolved_at
    && !payloadHasHumanReviewState(payload)
    && !outcomeRequiresReconciliation(outcome)
    && currentCandidateReviewProof(user, outcome, payload, evidence, identity, actionKey);
}

function reclaimProjectionFailureForTask(user, evidence, actionKey, { payload, taskId = null } = {}) {
  return db.hub().prepare(`
    UPDATE crm_action_outcomes
       SET disposition = 'pending_task', reason = 'task_side_effect_pending',
           task_id = COALESCE(?, task_id), payload = ?, updated_at = ?, resolved_at = NULL
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND action_key = ? AND disposition = 'error'
       AND reason LIKE 'action_projection_failed:%'
  `).run(
    taskId, JSON.stringify(payload), now(),
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey,
  ).changes === 1;
}

// Linkage reviews are created before any provider request. A later replay may
// replace only that exact automatic review with the ordinary task outbox
// claim, after it has safely recovered the authoritative candidate identity.
// Matching the old payload as well as its review reason makes this a CAS: a
// concurrent human dismissal or any other state transition cannot be stolen.
function reclaimProjectionLinkageReviewForTask(user, evidence, actionKey, {
  previous,
  identity,
  payload,
  taskId = null,
} = {}) {
  if (!isRetryableProjectionLinkageReview(previous, user, evidence, identity, actionKey)) return null;
  const recovery = projectionReviewRecoveryMetadata(previous);
  const recoveryPayload = {
    ...payload,
    recovered_from_projection_linkage_review: recovery,
  };
  const changed = db.hub().prepare(`
    UPDATE crm_action_outcomes
       SET disposition = 'pending_task', reason = 'task_side_effect_pending',
           task_id = COALESCE(?, task_id), payload = ?, updated_at = ?, resolved_at = NULL
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND action_key = ? AND disposition = 'review'
       AND reason = ? AND task_id IS NULL AND event_id IS NULL AND resolved_at IS NULL
       AND payload = ?
  `).run(
    taskId, JSON.stringify(recoveryPayload), now(),
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey, previous.reason, previous.payload,
  ).changes;
  return changed ? { recovered_from_projection_linkage_review: recovery } : null;
}

function reclaimProjectionEvidenceReviewForTask(user, evidence, actionKey, {
  previous,
  identity,
  payload,
  taskId = null,
} = {}) {
  if (!isRetryableProjectionEvidenceReview(previous, user, evidence, identity, actionKey)) return null;
  const recovery = {
    ...projectionReviewRecoveryMetadata(previous),
    prior_creation_block: parseJson(previous.payload)?.creation_block || null,
  };
  const recoveryPayload = {
    ...payload,
    recovered_from_non_exact_evidence_review: recovery,
  };
  const changed = db.hub().prepare(`
    UPDATE crm_action_outcomes
       SET disposition = 'pending_task', reason = 'task_side_effect_pending',
           task_id = COALESCE(?, task_id), payload = ?, updated_at = ?, resolved_at = NULL
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND action_key = ? AND disposition = 'review'
       AND reason = 'non_exact_evidence_requires_review'
       AND task_id IS NULL AND event_id IS NULL AND resolved_at IS NULL AND payload = ?
  `).run(
    taskId, JSON.stringify(recoveryPayload), now(),
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey, previous.payload,
  ).changes;
  return changed ? { recovered_from_non_exact_evidence_review: recovery } : null;
}

function claimPendingSideEffect(user, evidence, actionKey, {
  action,
  identity,
  phase,
  taskId = null,
  approved = false,
  recovery = null,
} = {}) {
  const disposition = phase === 'event' ? 'pending_event' : 'pending_task';
  const reason = phase === 'event' ? 'calendar_side_effect_pending' : 'task_side_effect_pending';
  const payload = outcomePayload(evidence, action, identity, {
    ...(taskId ? { task_id: taskId } : {}),
    ...(recovery || {}),
  });
  if (insertActionOutcomeIfAbsent(user, evidence, actionKey, {
    action, identity, disposition, reason, taskId, payload,
  })) {
    return { claimed: true, outcome: getActionOutcome(user, evidence, actionKey) };
  }

  let outcome = getActionOutcome(user, evidence, actionKey);
  // A projection-model failure happened before any provider request. Once a
  // later projection supplies a valid candidate, it is safe to atomically turn
  // that particular error into the normal task outbox claim. Do not do this
  // for provider failures: those remain reconciliation reviews forever.
  if (phase === 'task' && isRetryableProjectionFailure(outcome)
    && reclaimProjectionFailureForTask(user, evidence, actionKey, { payload, taskId })) {
    return { claimed: true, outcome: getActionOutcome(user, evidence, actionKey) };
  }
  const linkageRecovery = phase === 'task' && identity?.candidate?.candidate_key === actionKey
    ? reclaimProjectionLinkageReviewForTask(user, evidence, actionKey, {
      previous: outcome, identity, payload, taskId,
    })
    : null;
  if (linkageRecovery) {
    return {
      claimed: true,
      outcome: getActionOutcome(user, evidence, actionKey),
      recovery: linkageRecovery,
    };
  }
  const evidenceRecovery = phase === 'task' && identity?.candidate?.candidate_key === actionKey
    ? reclaimProjectionEvidenceReviewForTask(user, evidence, actionKey, {
      previous: outcome, identity, payload, taskId,
    })
    : null;
  if (evidenceRecovery) {
    return {
      claimed: true,
      outcome: getActionOutcome(user, evidence, actionKey),
      recovery: evidenceRecovery,
    };
  }
  outcome = getActionOutcome(user, evidence, actionKey);
  // The worker that has just reconciled/created the task may atomically move
  // its own task claim into the event claim.  Other workers reach this helper
  // without a task id and cannot advance or steal that pending transition.
  if (phase === 'event' && taskId && outcome?.disposition === 'pending_task') {
    const changed = db.hub().prepare(`
      UPDATE crm_action_outcomes
         SET disposition = ?, reason = ?, task_id = ?, payload = ?, updated_at = ?, resolved_at = NULL
       WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
         AND pipeline_version = ? AND action_key = ? AND disposition = 'pending_task'
    `).run(
      disposition, reason, taskId, JSON.stringify(payload), now(),
      user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
      CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey,
    ).changes;
    if (changed) return { claimed: true, outcome: getActionOutcome(user, evidence, actionKey) };
    outcome = getActionOutcome(user, evidence, actionKey);
  }
  // Human approval is an explicit new decision.  The conditional update is a
  // compare-and-set, so it cannot steal a pending claim held by another worker.
  if (approved && outcome?.disposition === 'review') {
    if (isNonCreatablePayload(parseJson(outcome.payload)) || outcomeRequiresReconciliation(outcome)) {
      return { claimed: false, outcome };
    }
    const changed = db.hub().prepare(`
      UPDATE crm_action_outcomes
         SET disposition = ?, reason = ?, task_id = COALESCE(?, task_id),
             payload = ?, updated_at = ?, resolved_at = NULL
       WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
         AND pipeline_version = ? AND action_key = ? AND disposition = 'review'
    `).run(
      disposition, reason, taskId, JSON.stringify(payload), now(),
      user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
      CRM_KNOWLEDGE_PIPELINE_VERSION, actionKey,
    ).changes;
    if (changed) return { claimed: true, outcome: getActionOutcome(user, evidence, actionKey) };
    outcome = getActionOutcome(user, evidence, actionKey);
  }
  return { claimed: false, outcome };
}

function preservedProjectionRecovery(existing) {
  const payload = parseJson(existing?.payload);
  const preserved = {};
  for (const key of [
    'recovered_from_projection_linkage_review',
    'recovered_from_non_exact_evidence_review',
  ]) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) preserved[key] = payload[key];
  }
  return preserved;
}

function promoteStalePendingOutcome(user, evidence, action, identity, phase, existing) {
  const pending = phase === 'event' ? 'pending_event' : 'pending_task';
  const cutoff = now() - SIDE_EFFECT_PENDING_LEASE_SECONDS;
  if (!existing || existing.disposition !== pending || Number(existing.updated_at || 0) > cutoff) return null;
  const ambiguousIdentity = ambiguousSideEffectIdentity(identity, phase);
  const changed = db.hub().prepare(`
    UPDATE crm_action_outcomes
       SET disposition = 'review', reason = ?, payload = ?, updated_at = ?, resolved_at = NULL
     WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
       AND pipeline_version = ? AND action_key = ? AND disposition = ? AND updated_at <= ?
  `).run(
    `${phase}_side_effect_ambiguous_requires_human_review`,
    JSON.stringify(outcomePayload(evidence, action, ambiguousIdentity, {
      non_creatable: true,
      side_effect_ambiguity: ambiguousIdentity.side_effect_ambiguity,
      prior_pending_outcome_id: existing.id,
      pending_since: existing.updated_at,
      pending_lease_seconds: SIDE_EFFECT_PENDING_LEASE_SECONDS,
      ...preservedProjectionRecovery(existing),
    })),
    now(), user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION, identity.action_key, pending, cutoff,
  ).changes;
  if (!changed) return null;
  return getActionOutcome(user, evidence, identity.action_key);
}

function preservedExistingOutcomeResult(existing) {
  // A fresh projection branch (FYI, low confidence, duplicate, source gate,
  // and so on) is not a resolution of a durable action outcome. In particular
  // it must not erase human review metadata, provider ambiguity, a pending
  // outbox claim, or recovery audit evidence. The side-effect path below may
  // still use its narrowly-scoped CAS/reconciliation transitions.
  return {
    outcome: existing,
    disposition: existing?.disposition === 'error' ? 'error' : 'review',
    replayed: true,
  };
}

function insertInitialActionOutcomeResult(user, evidence, actionKey, options) {
  // Early projection branches can describe a brand-new outcome, but cannot
  // resolve one. The insert-only write protects a row that appears after the
  // caller's initial read just as the explicit existing-row guard does.
  const inserted = insertActionOutcomeIfAbsent(user, evidence, actionKey, options);
  const outcome = getActionOutcome(user, evidence, actionKey);
  return inserted
    ? { outcome, disposition: options.disposition }
    : preservedExistingOutcomeResult(outcome);
}

function blockedSideEffectResult(user, evidence, action, identity, phase, existing) {
  if (!existing) return null;
  if (OUTCOME_TERMINAL.has(existing.disposition)) {
    return { outcome: existing, disposition: existing.disposition, replayed: true };
  }
  const pending = phase === 'event' ? 'pending_event' : 'pending_task';
  if (existing.disposition === pending) {
    const reviewed = promoteStalePendingOutcome(user, evidence, action, identity, phase, existing);
    if (reviewed) return { outcome: reviewed, disposition: 'review', replayed: true };
    // A pending claim may belong to a concurrent worker or a process which
    // died after the remote call.  In either case auto-replay must not call the
    // provider again. Fresh claims remain pending for their short lease; a
    // stale replay atomically turns them into an actionable review outcome.
    return { outcome: existing, disposition: 'review', replayed: true };
  }
  if (existing.disposition === 'error') {
    const expectedPrefix = phase === 'event' ? 'calendar_side_effect_failed:' : 'task_side_effect_failed:';
    if (String(existing.reason || '').startsWith(expectedPrefix)) {
      const ambiguousIdentity = ambiguousSideEffectIdentity(identity, phase);
      const outcome = upsertActionOutcome(user, evidence, identity.action_key, {
        action, identity: ambiguousIdentity, disposition: 'review', reason: `${phase}_side_effect_ambiguous_requires_human_review`,
        taskId: existing.task_id || null,
        eventId: existing.event_id || null,
        payload: outcomePayload(evidence, action, ambiguousIdentity, {
          non_creatable: true,
          side_effect_ambiguity: ambiguousIdentity.side_effect_ambiguity,
          prior_side_effect_error: existing.reason,
          prior_outcome_id: existing.id,
          ...preservedProjectionRecovery(existing),
        }),
      });
      return { outcome, disposition: 'review', replayed: true };
    }
  }
  return { outcome: existing, disposition: existing.disposition === 'error' ? 'error' : 'review', replayed: true };
}

function sideEffectPhaseForExistingOutcome(outcome) {
  if (outcome?.disposition === 'pending_event'
    || String(outcome?.reason || '').startsWith('calendar_side_effect_')) return 'event';
  return 'task';
}

function listActionOutcomeQueue(user, { limit = 80 } = {}) {
  const rows = db.hub().prepare(`
    SELECT * FROM crm_action_outcomes
    WHERE user = ? AND disposition IN ('review', 'error', 'pending_task', 'pending_event')
    ORDER BY CASE disposition WHEN 'error' THEN 0 WHEN 'pending_task' THEN 1 WHEN 'pending_event' THEN 1 ELSE 2 END,
             updated_at ASC, id ASC
  `).all(user);
  const revisions = new Map(listSourceEvidence(user).filter(evidence => !isCanonicalEvidenceExcluded(evidence)).map(evidence => [
    `${evidence.source_kind}\u0000${evidence.source_id}`,
    evidence.revision_hash,
  ]));
  return rows
    .filter(row => row.pipeline_version === CRM_KNOWLEDGE_PIPELINE_VERSION
      && revisions.get(`${row.source_kind}\u0000${row.source_id}`) === row.source_revision)
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 80)))
    .map(row => {
      const payload = parseJson(row.payload);
      const inferredAmbiguity = payload.side_effect_ambiguity || sideEffectAmbiguityFromReason(row.reason);
      const inferredNonCreatable = isNonCreatablePayload(payload)
        || Boolean(inferredAmbiguity?.requires_reconciliation)
        || projectionReviewIsNonCreatable(row.reason);
      return {
        ...row,
        payload: inferredNonCreatable
          ? {
            ...payload,
            non_creatable: true,
            ...(inferredAmbiguity ? { side_effect_ambiguity: inferredAmbiguity } : {}),
          }
          : payload,
      };
    });
}

function findStableTask(user, actionKey) {
  return db.hub().prepare(`
    SELECT * FROM google_tasks
    WHERE user = ? AND source = 'crm-engine' AND source_id = ?
    LIMIT 1
  `).get(user, `crm-action:${actionKey}`);
}

function findStableEvent(user, actionKey) {
  return db.hub().prepare(`
    SELECT * FROM meetings
    WHERE user = ? AND source = 'crm-engine' AND source_id = ?
    LIMIT 1
  `).get(user, `crm-action-event:${actionKey}`);
}

function verifiedOpenTask(user, duplicateOf) {
  const reference = String(duplicateOf || '').trim();
  if (!reference) return null;
  const hub = db.hub();
  const direct = hub.prepare(`
    SELECT * FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
      AND (id = ? OR google_task_id = ?)
    LIMIT 1
  `).get(user, reference, reference);
  if (direct) return direct;
  // The model's semantic comparison chooses the task; exact title here merely
  // verifies that the named task is currently open.  It is not a title-only
  // duplicate detector and is never consulted absent duplicate_of.
  return hub.prepare(`
    SELECT * FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
      AND lower(title) = lower(?)
    ORDER BY created_at DESC LIMIT 1
  `).get(user, reference);
}

function sourceTaskIsOpen(user, sourceKind, sourceId) {
  if (sourceKind !== 'open_task') return null;
  return db.hub().prepare(`
    SELECT * FROM google_tasks WHERE user = ? AND id = ?
      AND status = 'needsAction' AND deleted_at IS NULL LIMIT 1
  `).get(user, sourceId);
}

function actionNotes(evidence, action) {
  return [
    `Evidence: ${action.evidence || 'CRM knowledge engine projection'}`,
    `Source: ${evidence.source_kind}/${evidence.source_id}`,
    `Source revision: ${evidence.revision_hash}`,
  ].join('\n');
}

async function projectOneAction(user, evidence, action, identity, entities, {
  createTaskFn = createTask,
  createCalendarEventFn = createCalendarEvent,
  assertSourceLeaseFn = null,
  approved = false,
} = {}) {
  const actionKey = identity.action_key;
  const existing = getActionOutcome(user, evidence, actionKey);
  if (existing && OUTCOME_TERMINAL.has(existing.disposition)) return { outcome: existing, disposition: existing.disposition, replayed: true };

  // Only a concrete action tied to a canonical triage candidate can reach an
  // irreversible provider call. The preserved raw source remains the evidence
  // even when a model describes that evidence with a paraphrase.
  const creationBlock = actionCreationBlockReason(action, identity);
  if (creationBlock) {
    if (existing) return preservedExistingOutcomeResult(existing);
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'review', reason: creationBlock,
      payload: outcomePayload(evidence, action, identity, { non_creatable: true, creation_block: creationBlock }),
    });
  }

  const sourceBlock = actionProjectionBlockReason(evidence.source_kind, null, evidence.row);
  if (sourceBlock) {
    if (existing) return preservedExistingOutcomeResult(existing);
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'review', reason: sourceBlock,
      payload: outcomePayload(evidence, action, identity, { source_block: sourceBlock }),
    });
  }

  const sourceTask = sourceTaskIsOpen(user, evidence.source_kind, evidence.source_id);
  if (sourceTask) {
    if (existing) return preservedExistingOutcomeResult(existing);
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'existing_open_task', reason: 'source_is_current_open_task', taskId: sourceTask.id,
      payload: outcomePayload(evidence, action, identity, { verified_task_id: sourceTask.id }),
    });
  }

  const decision = approved ? { disposition: 'create', reason: 'user_accepted_review', confidence: Number(action.confidence) || 0 } : actionDisposition(action);
  if (decision.disposition === 'fyi') {
    if (existing) return preservedExistingOutcomeResult(existing);
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'fyi', reason: decision.reason,
      payload: outcomePayload(evidence, action, identity),
    });
  }
  if (decision.disposition === 'review') {
    if (existing) return preservedExistingOutcomeResult(existing);
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'review', reason: decision.reason,
      payload: outcomePayload(evidence, action, identity),
    });
  }

  const duplicate = String(action.duplicate_of || '').trim();
  if (duplicate) {
    if (existing) return preservedExistingOutcomeResult(existing);
    const openTask = verifiedOpenTask(user, duplicate);
    if (openTask) {
      return insertInitialActionOutcomeResult(user, evidence, actionKey, {
        action, identity, disposition: 'existing_open_task', reason: 'verified_model_duplicate_of_open_task', taskId: openTask.id,
        payload: outcomePayload(evidence, action, identity, { verified_task_id: openTask.id }),
      });
    }
    return insertInitialActionOutcomeResult(user, evidence, actionKey, {
      action, identity, disposition: 'review', reason: 'unverified_duplicate_reference',
      payload: outcomePayload(evidence, action, identity, { duplicate_of: duplicate }),
    });
  }

  // Closed tasks no longer travel in the projection prompt; this is where the
  // "do not recreate a completed/deleted/wrong task" guarantee is enforced,
  // deterministically and over the whole closed corpus. An explicit human
  // approval is a decision to create despite history, so it bypasses this.
  if (!approved) {
    const closedDuplicate = await closedTaskDuplicateMatch(user, action);
    if (closedDuplicate) {
      if (existing) return preservedExistingOutcomeResult(existing);
      return insertInitialActionOutcomeResult(user, evidence, actionKey, {
        action, identity, disposition: 'dismissed', reason: `duplicate_of_${closedDuplicate.state}_task`,
        taskId: closedDuplicate.taskId,
        payload: outcomePayload(evidence, action, identity, {
          duplicate_of_closed_task: {
            task_id: closedDuplicate.taskId,
            matched_title: closedDuplicate.matchedTitle,
            state: closedDuplicate.state,
            method: closedDuplicate.method,
            score: closedDuplicate.score,
          },
        }),
      });
    }
  }

  const contact = findEntityByName(entities, 'contact', action.person);
  const company = findEntityByName(entities, 'company', action.company);
  const project = findEntityByName(entities, 'project', action.project_slug) || findEntityByName(entities, 'project', action.project);
  const projectSlug = action.project_slug || project?.aliases?.[0] || null;
  const stableTask = findStableTask(user, actionKey);
  let taskId = stableTask?.id || null;
  let projectionRecovery = null;
  if (stableTask) {
    if (taskState(stableTask) !== 'open') {
      if (existing) return preservedExistingOutcomeResult(existing);
      return insertInitialActionOutcomeResult(user, evidence, actionKey, {
        action, identity, disposition: 'review', reason: `stable_task_${taskState(stableTask)}`, taskId,
        payload: outcomePayload(evidence, action, identity, {
          stable_task_id: taskId,
          ...(projectionRecovery || {}),
        }),
      });
    }
    // A reconciled provider task cannot bypass the ordinary outbox state
    // machine. In particular, every review remains a review unless the exact
    // automatic linkage/non-exact evidence CAS succeeds; a provider finding
    // the same idempotency key is not permission to overwrite a human or
    // ambiguity gate. Pending/error rows likewise go through their normal
    // blocked/reconciliation result rather than becoming task_created here.
    // An explicit human approval is a different, already-vetted decision:
    // approveReviewedAction has already rejected non-creatable/ambiguous rows
    // before calling here, so it may still reach the CAS below even when this
    // review is not one of the automatic-recovery reasons.
    if (existing && !OUTCOME_TERMINAL.has(existing.disposition)) {
      const phase = sideEffectPhaseForExistingOutcome(existing);
      if (!approved && (existing.disposition !== 'review' || !isAutomaticProjectionRecoveryReview(existing))) {
        return blockedSideEffectResult(user, evidence, action, identity, phase, existing)
          || { outcome: existing, disposition: 'review', replayed: true };
      }
      const claim = claimPendingSideEffect(user, evidence, actionKey, {
        action, identity, phase: 'task', taskId, approved,
      });
      if (!claim.claimed) {
        return blockedSideEffectResult(user, evidence, action, identity, 'task', claim.outcome)
          || { outcome: claim.outcome, disposition: 'review', replayed: true };
      }
      projectionRecovery = claim.recovery || null;
    }
  } else {
    // Atomically claim the irreversible API call.  A second worker or a
    // crash-window replay never overwrites this pending row and calls Google.
    if (assertSourceLeaseFn) assertSourceLeaseFn();
    const claim = claimPendingSideEffect(user, evidence, actionKey, {
      action, identity, phase: 'task', approved,
    });
    if (!claim.claimed) {
      return blockedSideEffectResult(user, evidence, action, identity, 'task', claim.outcome)
        || { outcome: claim.outcome, disposition: 'review', replayed: true };
    }
    projectionRecovery = claim.recovery || null;
    try {
      const task = await createTaskFn(user, {
        title: String(action.title).trim().slice(0, 240),
        notes: actionNotes(evidence, action),
        due: /^\d{4}-\d{2}-\d{2}$/.test(action.due_date || '') ? action.due_date : undefined,
        source: 'crm-engine',
        origin: 'crm-knowledge-engine:action-projection',
        sourceId: `crm-action:${actionKey}`,
        contactId: contact?.id || null,
        companyId: company?.id || null,
        projectSlug,
      });
      // The provider may have completed while this worker lost the enclosing
      // source lease.  Do not publish a terminal local outcome from a stale
      // worker: leave its pending claim for deterministic reconciliation.
      if (assertSourceLeaseFn) assertSourceLeaseFn();
      taskId = task?.localId || findStableTask(user, actionKey)?.id || null;
      if (!taskId) throw new Error('Task API returned without a reconcilable local task');
    } catch (err) {
      if (isSourceProcessingLeaseLostError(err)) throw err;
      // A provider-side failure is also not ours to publish if ownership was
      // lost during the await. The existing pending row then remains the
      // durable reconciliation record instead of being overwritten as error.
      if (assertSourceLeaseFn) assertSourceLeaseFn();
      const outcome = upsertActionOutcome(user, evidence, actionKey, {
        action, identity, disposition: 'error', reason: `task_side_effect_failed: ${err.message}`,
        payload: outcomePayload(evidence, action, identity, {
          error: err.message,
          ...(projectionRecovery || {}),
        }),
      });
      return { outcome, disposition: 'error' };
    }
  }

  const event = eventFromAction(action);
  if (!event) {
    if (assertSourceLeaseFn) assertSourceLeaseFn();
    const outcome = upsertActionOutcome(user, evidence, actionKey, {
      action, identity, disposition: 'task_created', reason: stableTask ? 'reconciled_stable_task' : 'task_created', taskId,
      payload: outcomePayload(evidence, action, identity, {
        task_id: taskId,
        ...(projectionRecovery || {}),
      }),
    });
    return { outcome, disposition: 'task_created' };
  }

  const stableEvent = findStableEvent(user, actionKey);
  let eventId = stableEvent?.id || null;
  if (!stableEvent) {
    if (assertSourceLeaseFn) assertSourceLeaseFn();
    const claim = claimPendingSideEffect(user, evidence, actionKey, {
      action, identity, phase: 'event', taskId, approved, recovery: projectionRecovery,
    });
    if (!claim.claimed) {
      return blockedSideEffectResult(user, evidence, action, identity, 'event', claim.outcome)
        || { outcome: claim.outcome, disposition: 'review', replayed: true };
    }
    try {
      const created = await createCalendarEventFn(user, {
        title: String(action.title).trim().slice(0, 240),
        description: actionNotes(evidence, action),
        location: event.location,
        startAt: event.start,
        endAt: event.end,
        source: 'crm-engine',
        sourceId: `crm-action-event:${actionKey}`,
        contactId: contact?.id || null,
        companyId: company?.id || null,
      });
      // See the task equivalent above: a late worker must leave the pending
      // event claim untouched so a later owner can reconcile it safely.
      if (assertSourceLeaseFn) assertSourceLeaseFn();
      eventId = created?.localId || findStableEvent(user, actionKey)?.id || null;
      if (!eventId) throw new Error('Calendar API returned without a reconcilable local event');
    } catch (err) {
      if (isSourceProcessingLeaseLostError(err)) throw err;
      if (assertSourceLeaseFn) assertSourceLeaseFn();
      const outcome = upsertActionOutcome(user, evidence, actionKey, {
        action, identity, disposition: 'error', reason: `calendar_side_effect_failed: ${err.message}`, taskId,
        payload: outcomePayload(evidence, action, identity, {
          task_id: taskId,
          error: err.message,
          ...(projectionRecovery || {}),
        }),
      });
      return { outcome, disposition: 'error' };
    }
  }
  if (assertSourceLeaseFn) assertSourceLeaseFn();
  const outcome = upsertActionOutcome(user, evidence, actionKey, {
    action, identity, disposition: 'task_and_event_created',
    reason: stableEvent || stableTask ? 'reconciled_stable_side_effects' : 'task_and_event_created',
    taskId, eventId,
    payload: outcomePayload(evidence, action, identity, {
      task_id: taskId,
      event_id: eventId,
      ...(projectionRecovery || {}),
    }),
  });
  return { outcome, disposition: 'task_and_event_created' };
}

function emptyProjectionTotals() {
  return { created: 0, skipped: 0, errors: 0, review: 0, fyi: 0, existing: 0, details: [], events: { created: 0, skipped: 0, errors: 0, details: [] } };
}

function tallyProjection(totals, result, action) {
  const disposition = result.disposition;
  if (['task_created', 'task_and_event_created'].includes(disposition)) totals.created += 1;
  if (disposition === 'task_and_event_created') totals.events.created += 1;
  if (disposition === 'existing_open_task') { totals.skipped += 1; totals.existing += 1; }
  if (disposition === 'fyi' || disposition === 'dismissed') { totals.skipped += 1; totals.fyi += 1; }
  if (disposition === 'review') totals.review += 1;
  if (disposition === 'error') totals.errors += 1;
  totals.details.push({ title: action.title || result.outcome?.candidate_title || '', disposition, reason: result.outcome?.reason || '' });
}

async function createProjectedTasks(user, sourceKind, sourceId, actions, entities, {
  evidence = resolveSourceEvidence(user, sourceKind, sourceId),
  candidates = [],
  chunkById = new Map(),
  dependencies = {},
  approved = false,
} = {}) {
  const totals = emptyProjectionTotals();
  if (!evidence) return { ...totals, errors: 1, details: [{ error: 'Raw source no longer exists' }] };
  for (const action of actions || []) {
    const candidate = candidateForProjectedAction(action, candidates);
    const chunk = candidate?.source_span?.chunk_id ? chunkById.get(candidate.source_span.chunk_id) : evidence.chunks[0];
    const canonicalAction = canonicaliseProjectedAction(action, candidate);
    const identity = actionIdentity(evidence, canonicalAction, candidates, chunk);
    const result = await projectOneAction(user, evidence, canonicalAction, identity, entities, {
      ...dependencies,
      approved,
    });
    tallyProjection(totals, result, canonicalAction);
  }
  return totals;
}

function sourceLevelOutcome(user, evidence, stage, disposition, reason, extra = {}) {
  const chunk = evidence.chunks[0] || null;
  const span = candidateSpan(evidence, chunk, {});
  const identity = { span, candidate: null, source_level: true, action_key: stageActionKey(evidence, chunk, stage) };
  const action = { title: `${evidence.source_kind.replace(/_/g, ' ')} source`, actionability: 'implied', confidence: 0, evidence: span?.text || '' };
  return upsertActionOutcome(user, evidence, identity.action_key, {
    action, identity, disposition, reason,
    payload: outcomePayload(evidence, action, identity, {
      non_creatable: true,
      source_level: true,
      source_stage: stage,
      ...extra,
    }),
  });
}

/** Mark source-level stage outages as dismissed once a later successful stage supersedes them. */
function dismissSupersededSourceLevelErrors(user, evidence, {
  stages = [],
  reasonPattern = null,
  resolution = 'stage_succeeded',
} = {}) {
  const stageSet = new Set(stages.map(String));
  const rows = db.hub().prepare(`
    SELECT * FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
      AND pipeline_version = ? AND disposition = 'error'
  `).all(
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION,
  );
  let n = 0;
  for (const row of rows) {
    const payload = parseJson(row.payload);
    if (!payload.source_level) continue;
    const stage = String(payload.source_stage || '');
    const reason = String(row.reason || '');
    const stageMatch = stageSet.size ? stageSet.has(stage) : false;
    const reasonMatch = reasonPattern ? reasonPattern.test(reason) : false;
    if (!stageMatch && !reasonMatch) continue;
    const { action, identity } = actionAndIdentityForSourceOutcome(row, payload);
    upsertActionOutcome(user, evidence, row.action_key, {
      action,
      identity,
      disposition: 'dismissed',
      reason: `source_level_${resolution}`,
      taskId: row.task_id,
      eventId: row.event_id,
      payload: outcomePayload(evidence, action, identity, {
        non_creatable: true,
        source_level: true,
        source_stage: stage || 'source_level_resolution',
        source_level_resolution: {
          action: resolution,
          prior_disposition: row.disposition,
          prior_reason: row.reason || null,
          resolved_at: now(),
        },
      }),
    });
    n += 1;
  }
  return n;
}

const DUPLICATE_REVIEW_SOURCE_STAGES = new Set([
  'duplicate_review_error',
  'duplicate_review_gate',
  'duplicate_review_retry_error',
  'duplicate_confirmation_unproven',
  'duplicate_supersession_replacement',
  'duplicate_supersession_retirement',
]);

function isDuplicateReviewSourceOutcome(row) {
  const payload = parseJson(row?.payload);
  if (!payload.source_level) return false;
  const stage = String(payload.source_stage || '');
  if (DUPLICATE_REVIEW_SOURCE_STAGES.has(stage)) return true;
  // Rows written before source_stage was added remain safely resolvable when
  // their payload proves that the review, not an action candidate, blocked
  // synthesis.
  return /^duplicate_review_/.test(String(row?.reason || ''))
    || /^supersession_/.test(String(row?.reason || ''));
}

function duplicateReviewOutcomeContext(user, outcomeId) {
  const row = db.hub().prepare('SELECT * FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) throw new Error('Duplicate-review outcome not found');
  if (!['review', 'error'].includes(row.disposition) || !isDuplicateReviewSourceOutcome(row)) {
    throw new Error('This outcome is not an unresolved duplicate/supersession review');
  }
  const evidence = resolveSourceEvidence(user, row.source_kind, row.source_id);
  if (!evidence || evidence.revision_hash !== row.source_revision || row.pipeline_version !== CRM_KNOWLEDGE_PIPELINE_VERSION) {
    throw new Error('This duplicate/supersession review is stale; reprocess the current source first');
  }
  const triage = reusableTriageDecision(user, evidence);
  if (!triage?.decision?.should_synthesise) {
    throw new Error('This source no longer requires duplicate/supersession synthesis review');
  }
  return { row, payload: parseJson(row.payload), evidence, triage };
}

function actionAndIdentityForSourceOutcome(row, payload) {
  const action = payload.action || {
    title: row.candidate_title,
    evidence: row.evidence_text,
    actionability: row.actionability || 'implied',
    confidence: row.confidence,
  };
  return {
    action,
    identity: {
      candidate: null,
      span: payload.evidence_span || {
        start: row.evidence_start,
        end: row.evidence_end,
        chunk_index: row.chunk_index,
        chunk_id: row.chunk_id,
        text: row.evidence_text,
        exact: Boolean(row.evidence_text),
      },
      source_level: true,
      non_creatable: true,
      action_key: row.action_key,
    },
  };
}

function terminalizeDuplicateReviewOutcomes(user, evidence, resolution, { reason = '' } = {}) {
  const rows = db.hub().prepare(`
    SELECT * FROM crm_action_outcomes
    WHERE user = ? AND source_kind = ? AND source_id = ? AND source_revision = ?
      AND pipeline_version = ? AND disposition IN ('review', 'error')
  `).all(
    user, evidence.source_kind, evidence.source_id, evidence.revision_hash,
    CRM_KNOWLEDGE_PIPELINE_VERSION,
  ).filter(isDuplicateReviewSourceOutcome);
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const { action, identity } = actionAndIdentityForSourceOutcome(row, payload);
    upsertActionOutcome(user, evidence, row.action_key, {
      action,
      identity,
      disposition: 'dismissed',
      reason: `duplicate_review_${resolution}`,
      taskId: row.task_id,
      eventId: row.event_id,
      payload: outcomePayload(evidence, action, identity, {
        non_creatable: true,
        source_level: true,
        source_stage: payload.source_stage || 'duplicate_review_resolution',
        duplicate_review_resolution: {
          action: resolution,
          reason: String(reason || '').slice(0, 1000) || null,
          resolved_at: now(),
          prior_disposition: row.disposition,
          prior_reason: row.reason || null,
        },
      }),
    });
  }
  return rows.length;
}

function skipDuplicateReviewSynthesis(user, outcomeId, { reason = '' } = {}) {
  const context = duplicateReviewOutcomeContext(user, outcomeId);
  const receiptOptions = { sourceRevision: context.evidence.revision_hash };
  const resolvedAt = now();
  const resolution = {
    action: 'skip',
    outcome_id: context.row.id,
    reason: String(reason || '').slice(0, 1000) || null,
    resolved_at: resolvedAt,
  };
  const resolve = db.hub().transaction(() => {
    // This is a human terminal decision about compiled knowledge, not a
    // deletion of source evidence. Both receipts are current-version audit
    // evidence, allowing health to distinguish a deliberate skip from a
    // duplicate-review failure.
    writeReceipt(user, context.evidence.source_kind, context.evidence.source_id, 'crm_duplicate_reviewed', {
      status: 'skipped',
      summary: 'Human chose to skip atom synthesis after duplicate/supersession review.',
      payload: { duplicate_review_resolution: resolution, triage: context.triage.decision },
      modelKey: 'crm_duplicate_review',
      ...receiptOptions,
    });
    writeReceipt(user, context.evidence.source_kind, context.evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'skipped',
      summary: 'Human chose to skip atom synthesis after duplicate/supersession review.',
      payload: {
        triage: context.triage.decision,
        duplicate_review_resolution: resolution,
        synthesis_gate: 'human_duplicate_review_skip',
      },
      modelKey: 'atom_extractor/entity_linker',
      ...receiptOptions,
    });
    return terminalizeDuplicateReviewOutcomes(user, context.evidence, 'synthesis_skipped_by_user', { reason });
  });
  const resolved = resolve.immediate();
  return { outcomeId: context.row.id, resolved, resolution };
}

function queueDuplicateReviewRetry(user, outcomeId, { reason = '' } = {}) {
  const context = duplicateReviewOutcomeContext(user, outcomeId);
  const previous = currentSourceReceipt(user, context.evidence, 'crm_duplicate_reviewed');
  const previousPayload = parseJson(previous?.payload);
  if (previous?.status === 'pending' && previousPayload?.duplicate_review_resolution?.action === 'retry') {
    return { queued: true, existing: true, outcomeId: context.row.id };
  }
  const resolution = {
    action: 'retry',
    outcome_id: context.row.id,
    reason: String(reason || '').slice(0, 1000) || null,
    queued_at: now(),
  };
  writeReceipt(user, context.evidence.source_kind, context.evidence.source_id, 'crm_duplicate_reviewed', {
    status: 'pending',
    summary: 'Human requested a targeted duplicate/supersession re-review.',
    payload: { duplicate_review_resolution: resolution, triage: context.triage.decision },
    modelKey: 'crm_duplicate_review',
    sourceRevision: context.evidence.revision_hash,
  });
  return { queued: true, existing: false, outcomeId: context.row.id, evidence: context.evidence };
}

function markDuplicateReviewRetryError(user, context, error) {
  const { action, identity } = actionAndIdentityForSourceOutcome(context.row, context.payload);
  return upsertActionOutcome(user, context.evidence, context.row.action_key, {
    action,
    identity,
    disposition: 'error',
    reason: `duplicate_review_retry_failed: ${error.message || error}`,
    taskId: context.row.task_id,
    eventId: context.row.event_id,
    payload: outcomePayload(context.evidence, action, identity, {
      non_creatable: true,
      source_level: true,
      source_stage: context.payload.source_stage || 'duplicate_review_retry_error',
      duplicate_review_retry_error: String(error.message || error),
    }),
  });
}

// This is deliberately source-specific. It reuses the saved triage decision,
// re-runs only duplicate review for this raw revision, then resumes only this
// source's gated synthesis path. It never broadens a human review click into a
// scan of unrelated review sources.
async function retryDuplicateReview(user, outcomeId, { dependencies = {}, lease: leaseOptions = {} } = {}) {
  const context = duplicateReviewOutcomeContext(user, outcomeId);
  const lease = claimSourceProcessingLease(user, context.evidence, leaseOptions);
  if (!lease.claimed) return { queued: true, lease_held: true, lease_expires_at: lease.expires_at };
  const heartbeat = startSourceProcessingLeaseHeartbeat(user, context.evidence, lease.token, leaseOptions);
  const suppliedLeaseGuard = dependencies.assertSourceLeaseFn;
  const assertSourceLeaseFn = () => {
    heartbeat.assertOwned();
    if (suppliedLeaseGuard) suppliedLeaseGuard();
  };
  const receiptOptions = { sourceRevision: context.evidence.revision_hash };
  try {
    assertSourceLeaseFn();
    const reviewDuplicateFn = dependencies.reviewDuplicateFn || reviewDuplicate;
    const duplicate = await reviewDuplicateFn(user, context.evidence, context.triage.decision);
    assertSourceLeaseFn();
    const duplicateDecision = duplicate?.parsed || {};
    writeReceipt(user, context.evidence.source_kind, context.evidence.source_id, 'crm_duplicate_reviewed', {
      status: duplicateDecision.decision || 'uncertain',
      summary: duplicateDecision.reason || `Duplicate review retry: ${duplicateDecision.decision || 'uncertain'}`,
      payload: {
        ...duplicateDecision,
        duplicate_review_resolution: { action: 'retry', outcome_id: context.row.id, completed_at: now() },
      },
      modelKey: 'crm_duplicate_review',
      modelId: duplicate?.modelId || null,
      ...receiptOptions,
    });
    const sourceContextState = {
      entities: loadEntities(user),
      entityFacts: buildEntityFacts(user),
      budget: { n: Number(dependencies.linkBudget) || 12 },
    };
    const result = await processSourceClaimed(user, context.evidence, sourceContextState, {
      retry: true,
      dependencies: { ...dependencies, assertSourceLeaseFn },
    });
    // Keep the prior human-review gate live until this retry has actually
    // reached a terminal synthesis receipt.  If the fresh answer remains
    // unsafe, processSourceClaimed replaces/creates a current review gate; if
    // its lease/model call fails, the old gate is still in the queue with its
    // dedicated Skip/Re-run controls.  Dismissing first would create a window
    // where lease loss hid an unresolved source-level synthesis decision.
    assertSourceLeaseFn();
    const synthesis = currentSourceReceipt(user, context.evidence, 'crm_knowledge_synthesised');
    if (synthesis && ['done', 'skipped'].includes(String(synthesis.status || '').toLowerCase())) {
      terminalizeDuplicateReviewOutcomes(user, context.evidence, 'replaced_by_retry');
    }
    finishSourceProcessingLease(user, context.evidence, lease.token, {
      status: result.errors ? 'error' : result.reviews ? 'review' : 'done',
    });
    return { ...result, retry_duplicate_reviewed: true };
  } catch (err) {
    if (isSourceProcessingLeaseLostError(err)) {
      finishSourceProcessingLease(user, context.evidence, lease.token, { status: 'error', error: err.message || err });
      throw err;
    }
    assertSourceLeaseFn();
    markDuplicateReviewRetryError(user, context, err);
    writeReceipt(user, context.evidence.source_kind, context.evidence.source_id, 'crm_duplicate_reviewed', {
      status: 'error',
      summary: `Duplicate review retry failed: ${err.message || err}`,
      payload: { error: String(err.message || err), duplicate_review_resolution: { action: 'retry', outcome_id: context.row.id } },
      modelKey: 'crm_duplicate_review',
      ...receiptOptions,
    });
    finishSourceProcessingLease(user, context.evidence, lease.token, { status: 'error', error: err.message || err });
    return { triaged: 0, synthesised: 0, skipped: 0, errors: 1, reviews: 0, retry_duplicate_reviewed: true };
  } finally {
    heartbeat.stop();
  }
}

async function projectCandidates(user, evidence, candidates, entities, dependencies = {}) {
  const totals = emptyProjectionTotals();
  const byChunk = new Map();
  const chunkById = new Map(evidence.chunks.map(chunk => [chunk.chunk_id, chunk]));
  for (const candidate of candidates) {
    const id = candidate.source_span?.chunk_id || evidence.chunks[0]?.chunk_id || 'source';
    if (!byChunk.has(id)) byChunk.set(id, []);
    byChunk.get(id).push(candidate);
  }
  const projectedCandidateKeys = new Set();
  const projectActionsFn = dependencies.projectActionsFn || projectActions;
  const assertSourceLease = () => {
    if (dependencies.assertSourceLeaseFn) dependencies.assertSourceLeaseFn();
  };
  for (const [chunkId, group] of byChunk) {
    const chunk = chunkById.get(chunkId) || evidence.chunks[0];
    for (const batch of candidateBatches(group)) {
      try {
        assertSourceLease();
        const projected = await projectActionsFn(user, chunk, batch);
        assertSourceLease();
        const matchedActions = new Map();
        for (const action of projected.parsed.actions) {
          const candidate = candidateForProjectedAction(action, batch);
          if (candidate) {
            projectedCandidateKeys.add(candidate.candidate_key);
            const canonicalAction = canonicaliseProjectedAction(action, candidate);
            const current = matchedActions.get(candidate.candidate_key);
            // A noisy projection may repeat one candidate. Keep one action per
            // authoritative identity, preferring a later exact quote over an
            // earlier paraphrase so a valid side effect is never hidden by a
            // duplicate non-exact row.
            if (!current
              || (!exactEvidenceSpan(projectedEvidenceSpan(evidence, current, chunk))
                && exactEvidenceSpan(projectedEvidenceSpan(evidence, canonicalAction, chunk)))) {
              matchedActions.set(candidate.candidate_key, canonicalAction);
            }
            continue;
          }
          // The action model may refine a triage candidate, but it is not
          // allowed to invent a new side effect outside that candidate set.
          // Keep the unexpected output visible and source-backed for review.
          const identity = {
            ...actionIdentity(evidence, action, [], chunk),
            non_creatable: true,
          };
          const outcome = upsertActionOutcome(user, evidence, identity.action_key, {
            action, identity, disposition: 'review', reason: 'projection_action_not_tied_to_triage_candidate',
            payload: outcomePayload(evidence, action, identity, {
              non_creatable: true,
              projection_gate: 'unmatched_projection_action',
            }),
          });
          totals.review += 1;
          totals.details.push({
            title: action.title || outcome?.candidate_title || '',
            disposition: 'review',
            reason: 'projection_action_not_tied_to_triage_candidate',
          });
        }
        const result = await createProjectedTasks(user, evidence.source_kind, evidence.source_id, [...matchedActions.values()], entities, {
          evidence,
          candidates: batch,
          chunkById,
          dependencies,
        });
        for (const key of ['created', 'skipped', 'errors', 'review', 'fyi', 'existing']) totals[key] += result[key] || 0;
        totals.details.push(...result.details);
        totals.events.created += result.events?.created || 0;
        totals.events.skipped += result.events?.skipped || 0;
        totals.events.errors += result.events?.errors || 0;
        totals.events.details.push(...(result.events?.details || []));
      } catch (err) {
        if (isSourceProcessingLeaseLostError(err)) throw err;
        for (const candidate of batch) {
          const identity = { candidate, span: candidate.source_span, action_key: candidate.candidate_key };
          // A projection outage is new evidence only when this candidate has
          // no durable outcome. INSERT ... DO NOTHING also closes the race
          // where another worker or a human resolved it after our read.
          if (getActionOutcome(user, evidence, identity.action_key)) continue;
          const inserted = insertActionOutcomeIfAbsent(user, evidence, identity.action_key, {
            action: { title: candidate.action || '', actionability: 'implied', confidence: candidate.confidence, evidence: candidate.evidence || '' },
            identity, disposition: 'error', reason: `action_projection_failed: ${err.message}`,
            payload: outcomePayload(evidence, candidate, identity, { error: err.message }),
          });
          if (inserted) totals.errors += 1;
        }
      }
    }
  }
  // A triage candidate that the second model omitted is not permission to drop
  // it.  Surface it for a human rather than claiming the source is complete.
  // Exception: a prior OpenRouter/model outage left action_projection_failed
  // without ever reaching Google. The triage candidate is still authoritative —
  // project it directly so recovery does not depend on the second model
  // restating the same ask.
  const reclaimFromTriage = [];
  for (const candidate of candidates) {
    if (projectedCandidateKeys.has(candidate.candidate_key)) continue;
    const existing = getActionOutcome(user, evidence, candidate.candidate_key);
    if (existing && isRetryableProjectionFailure(existing)) {
      reclaimFromTriage.push({
        title: String(candidate.action || '').trim().slice(0, 240),
        actionability: 'explicit_ask',
        confidence: Number(candidate.confidence) || 0.8,
        evidence: candidate.evidence || candidate.action || '',
        candidate_key: candidate.candidate_key,
        person: candidate.owner || null,
      });
      continue;
    }
    // Preserve a projection error (or an already-visible review/pending row)
    // rather than replacing it with a generic omission review.  A retry must
    // be able to find the actual failure that needs reprocessing.
    if (existing) continue;
    const identity = {
      candidate,
      span: candidate.source_span,
      action_key: candidate.candidate_key,
      non_creatable: true,
    };
    upsertActionOutcome(user, evidence, identity.action_key, {
      action: { title: candidate.action || '', actionability: 'implied', confidence: candidate.confidence, evidence: candidate.evidence || '' },
      identity, disposition: 'review', reason: 'projection_omitted_triage_candidate',
      payload: outcomePayload(evidence, candidate, identity, {
        non_creatable: true,
        projection_gate: 'omitted_triage_candidate',
      }),
    });
    totals.review += 1;
    totals.details.push({ title: candidate.action || '', disposition: 'review', reason: 'projection_omitted_triage_candidate' });
  }
  if (reclaimFromTriage.length) {
    const chunkById = new Map(evidence.chunks.map(chunk => [chunk.chunk_id, chunk]));
    const recovered = await createProjectedTasks(
      user, evidence.source_kind, evidence.source_id, reclaimFromTriage, entities, {
        evidence,
        candidates,
        chunkById,
        dependencies,
      },
    );
    for (const key of ['created', 'skipped', 'errors', 'review', 'fyi', 'existing']) totals[key] += recovered[key] || 0;
    totals.details.push(...recovered.details);
    totals.events.created += recovered.events?.created || 0;
    totals.events.skipped += recovered.events?.skipped || 0;
    totals.events.errors += recovered.events?.errors || 0;
    totals.events.details.push(...(recovered.events?.details || []));
  }
  return totals;
}

async function processSourceClaimed(user, evidence, context, { retry = false, dependencies = {} } = {}) {
  const { entities, entityFacts, budget } = context;
  const receiptOptions = { sourceRevision: evidence.revision_hash };
  const assertSourceLease = () => {
    if (dependencies.assertSourceLeaseFn) dependencies.assertSourceLeaseFn();
  };
  assertSourceLease();
  if (!evidence.complete) {
    sourceLevelOutcome(user, evidence, 'incomplete_source', 'review', evidence.completeness, { completeness: evidence.completeness });
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
      status: 'review', summary: `Source requires raw evidence backfill: ${evidence.completeness}.`,
      payload: { completeness: evidence.completeness }, ...receiptOptions,
    });
    return { triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 1 };
  }

  const existingTriage = reusableTriageDecision(user, evidence);
  const triageSourceFn = dependencies.triageSourceFn || triageSource;
  let triage = existingTriage
    ? { parsed: existingTriage.decision, modelId: existingTriage.row.model_id || null }
    : null;
  if (!triage) {
    try {
      assertSourceLease();
      triage = await triageSourceFn(user, evidence, entities);
      assertSourceLease();
    } catch (err) {
      if (isSourceProcessingLeaseLostError(err)) throw err;
      sourceLevelOutcome(user, evidence, 'triage_error', 'error', `source_triage_failed: ${err.message}`, { error: err.message });
      writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
        status: 'error', summary: err.message, payload: { error: err.message }, modelKey: 'crm_source_triage', ...receiptOptions,
      });
      return { triaged: 0, synthesised: 0, skipped: 0, errors: 1, reviews: 0 };
    }
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_source_triage', {
      status: 'done',
      summary: triage.parsed.source_summary || triage.parsed.routing_notes || 'CRM source triaged.',
      payload: triage.parsed, modelKey: 'crm_source_triage', modelId: triage.modelId, ...receiptOptions,
    });
    // Supersede source-level triage outage rows so health no longer treats the
    // source as action_outcome_error after a later successful triage.
    dismissSupersededSourceLevelErrors(user, evidence, {
      stages: ['triage_error'],
      reasonPattern: /source_triage_failed/i,
      resolution: 'triage_succeeded',
    });
  }

  const decision = triage.parsed;
  const triageCount = existingTriage ? 0 : 1;
  let duplicateDecision = null;
  let duplicateReviewError = null;
  if (decision.should_synthesise || decision.candidate_actions.length) {
    const existingDuplicate = reusableDuplicateDecision(user, evidence);
    if (existingDuplicate) {
      duplicateDecision = existingDuplicate.decision;
      dismissSupersededSourceLevelErrors(user, evidence, {
        stages: ['duplicate_review_error'],
        reasonPattern: /duplicate_review_failed/i,
        resolution: 'duplicate_review_available',
      });
    } else {
      const reviewDuplicateFn = dependencies.reviewDuplicateFn || reviewDuplicate;
      try {
        assertSourceLease();
        const duplicate = await reviewDuplicateFn(user, evidence, decision);
        assertSourceLease();
        duplicateDecision = duplicate.parsed;
        writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_duplicate_reviewed', {
          status: duplicateDecision.decision || 'uncertain',
          summary: duplicateDecision.reason || `Duplicate review: ${duplicateDecision.decision || 'uncertain'}`,
          payload: duplicateDecision, modelKey: 'crm_duplicate_review', modelId: duplicate.modelId, ...receiptOptions,
        });
        dismissSupersededSourceLevelErrors(user, evidence, {
          stages: ['duplicate_review_error'],
          reasonPattern: /duplicate_review_failed/i,
          resolution: 'duplicate_review_succeeded',
        });
      } catch (err) {
        if (isSourceProcessingLeaseLostError(err)) throw err;
        // Action projection still runs from the saved triage candidates, but
        // atom synthesis must not proceed without a duplicate/supersession
        // decision.  Record the failure now and fail that later stage closed.
        duplicateReviewError = err;
        writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_duplicate_reviewed', {
          status: 'error', summary: err.message, payload: { error: err.message }, modelKey: 'crm_duplicate_review', ...receiptOptions,
        });
      }
    }
  }

  let projection = emptyProjectionTotals();
  if (!actionProjectionCovered(user, evidence, decision)) {
    if (decision.candidate_actions.length) {
      assertSourceLease();
      projection = await projectCandidates(user, evidence, decision.candidate_actions, entities, dependencies);
      assertSourceLease();
      const status = projection.errors ? 'error' : projection.review ? 'review' : 'done';
      writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
        status,
        summary: `${decision.candidate_actions.length} action candidate(s); ${projection.created} task(s) created, ${projection.existing} verified existing, ${projection.review} review, ${projection.errors} error.`,
        payload: { candidates: decision.candidate_actions, task_projection: projection, duplicate_review: duplicateDecision },
        modelKey: 'crm_action_projection', ...receiptOptions,
      });
    } else {
      writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_action_projected', {
        status: 'done', summary: 'No candidate actions in this source.', payload: { candidates: [] }, ...receiptOptions,
      });
    }
  }

  if (!decision.should_synthesise) {
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'skipped', summary: 'Triage found no durable knowledge to synthesise.',
      payload: { triage: decision, duplicate_review: duplicateDecision }, ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 0, skipped: 1, errors: projection.errors, reviews: projection.review };
  }

  if (evidence.source_kind === 'open_task') {
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'skipped', summary: 'Open tasks remain action state until their completion is evidence.',
      payload: { triage: decision, duplicate_review: duplicateDecision }, ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 0, skipped: 1, errors: projection.errors, reviews: projection.review };
  }

  if (duplicateReviewError) {
    const reason = `duplicate_review_failed: ${duplicateReviewError.message || duplicateReviewError}`;
    sourceLevelOutcome(user, evidence, 'duplicate_review_error', 'error', reason, { error: String(duplicateReviewError.message || duplicateReviewError) });
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'error', summary: 'Atom synthesis blocked because duplicate/supersession review failed.',
      payload: { triage: decision, duplicate_review_error: String(duplicateReviewError.message || duplicateReviewError), synthesis_gate: 'duplicate_review_error' },
      modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 0, skipped: 0, errors: projection.errors + 1, reviews: projection.review };
  }

  const duplicatePlan = duplicateSynthesisPlan(user, evidence, duplicateDecision);
  if (duplicatePlan.mode === 'review') {
    sourceLevelOutcome(user, evidence, 'duplicate_review_gate', 'review', duplicatePlan.reason, { duplicate_review: duplicateDecision, synthesis_gate: duplicatePlan });
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'review', summary: `Atom synthesis blocked: ${duplicatePlan.reason}.`,
      payload: { triage: decision, duplicate_review: duplicateDecision, synthesis_gate: duplicatePlan },
      modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 0, skipped: 0, errors: projection.errors, reviews: projection.review + 1 };
  }
  try {
    assertSourceLease();
    const synthesiseSourceFn = dependencies.synthesiseSourceFn || synthesiseSource;
    const confirmationBefore = duplicatePlan.mode === 'synthesise_with_confirmation'
      ? confirmationTargetEvidence(user, evidence, duplicatePlan.target_id)
      : null;
    const synthesisOptions = {
      assertLeaseFn: dependencies.assertSourceLeaseFn,
    };
    if (duplicatePlan.mode === 'synthesise_then_retire') {
      synthesisOptions.excludeAtomIds = [duplicatePlan.target_id];
    }
    const result = await synthesiseSourceFn(
      user,
      evidence.source_kind,
      evidence.source_id,
      evidence,
      entities,
      budget,
      entityFacts,
      sourceContext(user, evidence.source_kind, evidence.row),
      synthesisOptions,
    );
    assertSourceLease();
    let retiredAtom = null;
    const duplicateConfirmation = duplicatePlan.mode === 'synthesise_with_confirmation'
      ? confirmationTargetEvidence(user, evidence, duplicatePlan.target_id, result)
      : null;
    if (duplicateConfirmation) {
      duplicateConfirmation.gained_current_provenance = Boolean(
        duplicateConfirmation.per_claim_proven && !confirmationBefore?.per_claim_proven,
      );
    }
    if (duplicatePlan.mode === 'synthesise_then_retire') {
      const replacements = replacementAtomsForEvidence(user, evidence, duplicatePlan.target_id);
      if (!replacements.length) {
        sourceLevelOutcome(user, evidence, 'duplicate_supersession_replacement', 'review', 'supersession_replacement_not_proven', {
          duplicate_review: duplicateDecision,
          synthesis_gate: duplicatePlan,
        });
        writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
          status: 'review', summary: 'Replacement atom was not proven; the prior claim remains active.',
          payload: { ...result, triage: decision, retry, duplicate_review: duplicateDecision, synthesis_gate: duplicatePlan },
          modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
        });
        return { triaged: triageCount, synthesised: 1, skipped: 0, errors: projection.errors, reviews: projection.review + 1, atomsStored: result.stored, proposed: result.proposed };
      }
      const retired = retireAtomForSupersession(user, duplicatePlan.target_id, duplicatePlan.source_ref, duplicatePlan.confidence);
      if (!retired.retired) {
        sourceLevelOutcome(user, evidence, 'duplicate_supersession_retirement', 'review', retired.reason || 'supersession_target_not_retired', {
          duplicate_review: duplicateDecision,
          synthesis_gate: duplicatePlan,
        });
        writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
          status: 'review', summary: `Replacement atoms were derived, but ${retired.reason || 'the superseded target could not be retired'}.`,
          payload: { ...result, triage: decision, retry, duplicate_review: duplicateDecision, synthesis_gate: duplicatePlan, supersession_retirement: retired.reason || null },
          modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
        });
        return { triaged: triageCount, synthesised: 1, skipped: 0, errors: projection.errors, reviews: projection.review + 1, atomsStored: result.stored, proposed: result.proposed };
      }
      retiredAtom = duplicatePlan.target_id;
    }
    if (duplicateConfirmation && !duplicateConfirmation.per_claim_proven) {
      // Novel atoms from this source have already been compiled, but the
      // source-wide duplicate answer did not prove its nominated target at an
      // exact current chunk/span. Do not infer that confirmation or silently
      // complete the source: preserve a dedicated, resolvable review gate.
      sourceLevelOutcome(user, evidence, 'duplicate_confirmation_unproven', 'review', 'duplicate_confirmation_unproven', {
        duplicate_review: duplicateDecision,
        synthesis_gate: duplicatePlan,
        duplicate_confirmation: duplicateConfirmation,
      });
      writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
        status: 'review',
        summary: `${result.stored} atom(s) stored, but the duplicate confirmation target lacks current per-claim provenance.`,
        payload: {
          ...result,
          triage: decision,
          retry,
          duplicate_review: duplicateDecision,
          synthesis_gate: duplicatePlan,
          duplicate_confirmation: duplicateConfirmation,
          superseded_atom_retired: retiredAtom,
        }, modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
      });
      return {
        triaged: triageCount,
        synthesised: 1,
        skipped: 0,
        errors: projection.errors,
        reviews: projection.review + 1,
        atomsStored: result.stored,
        proposed: result.proposed,
      };
    }
    // Clear source-level synthesis/duplicate gates that a successful compile supersedes.
    terminalizeDuplicateReviewOutcomes(user, evidence, 'synthesis_completed');
    dismissSupersededSourceLevelErrors(user, evidence, {
      stages: ['duplicate_review_error', 'duplicate_review_gate'],
      reasonPattern: /duplicate_review_failed|duplicate_review_missing_target/i,
      resolution: 'synthesis_completed',
    });
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'done', summary: `${result.stored} atom(s) stored; ${result.proposed} proposed.${retiredAtom ? ` Superseded atom ${retiredAtom} retired with source provenance.` : ''}${duplicateConfirmation ? duplicateConfirmation.per_claim_proven ? ` Duplicate target ${duplicateConfirmation.target_id} was confirmed by per-claim source evidence.` : ' Duplicate target was not merged without per-claim source evidence.' : ''}`,
      payload: {
        ...result,
        triage: decision,
        retry,
        duplicate_review: duplicateDecision,
        synthesis_gate: duplicatePlan,
        duplicate_confirmation: duplicateConfirmation,
        superseded_atom_retired: retiredAtom,
      }, modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 1, skipped: 0, errors: projection.errors, reviews: projection.review, atomsStored: result.stored, proposed: result.proposed };
  } catch (err) {
    if (isSourceProcessingLeaseLostError(err)) throw err;
    writeReceipt(user, evidence.source_kind, evidence.source_id, 'crm_knowledge_synthesised', {
      status: 'error', summary: err.message, payload: { error: err.message, triage: decision }, modelKey: 'atom_extractor/entity_linker', ...receiptOptions,
    });
    return { triaged: triageCount, synthesised: 0, skipped: 0, errors: projection.errors + 1, reviews: projection.review };
  }
}

// A source lease encloses the entire model pipeline, rather than just the
// provider outbox.  This prevents two scheduled/manual workers from producing
// two nondeterministic triage decisions for the same raw revision.  Expired
// leases are reclaimable; later side effects still pass through their separate
// pending-action reconciliation gate.
async function processSource(user, evidence, context, options = {}) {
  const leaseOptions = options.lease || {};
  const lease = claimSourceProcessingLease(user, evidence, leaseOptions);
  if (!lease.claimed) {
    return {
      triaged: 0,
      synthesised: 0,
      skipped: 1,
      errors: 0,
      reviews: 0,
      lease_held: true,
      lease_expires_at: lease.expires_at,
    };
  }
  const heartbeat = startSourceProcessingLeaseHeartbeat(user, evidence, lease.token, leaseOptions);
  const suppliedLeaseGuard = options.dependencies?.assertSourceLeaseFn;
  const assertSourceLeaseFn = () => {
    heartbeat.assertOwned();
    if (suppliedLeaseGuard) suppliedLeaseGuard();
    return true;
  };
  try {
    const result = await processSourceClaimed(user, evidence, context, {
      ...options,
      dependencies: { ...(options.dependencies || {}), assertSourceLeaseFn },
    });
    finishSourceProcessingLease(user, evidence, lease.token, {
      status: result.errors ? 'error' : result.reviews ? 'review' : 'done',
    });
    return { ...result, lease_reclaimed: lease.reclaimed_stale || false };
  } catch (err) {
    finishSourceProcessingLease(user, evidence, lease.token, { status: 'error', error: err.message || err });
    throw err;
  } finally {
    heartbeat.stop();
  }
}

async function runCrmKnowledgeEngine(user, { limit = 8, linkBudget = 12, dependencies = {} } = {}) {
  if (!dependencies.requestModelObject && process.env.SUBSCRIPTION_AGENT_DISABLED === '1') {
    return { considered: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 0, reason: 'subscription model plane disabled' };
  }
  const sources = candidateSources(user, limit);
  if (!sources.length) return { considered: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 0 };
  const context = { entities: loadEntities(user), entityFacts: buildEntityFacts(user), budget: { n: linkBudget } };
  const totals = { considered: sources.length, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 0, atomsStored: 0, proposed: 0 };
  for (const evidence of sources) {
    const result = await processSource(user, evidence, context, { dependencies });
    for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
  }
  return totals;
}

// Explicit repair/replay entrypoint. Unlike the recurring scanner, this is
// allowed to enter a current review-state source, but it still resolves the
// raw record through the canonical-evidence boundary and then uses the same
// lease, saved-triage, projection, synthesis, and provider-idempotency path.
// It is deliberately not folded into candidateSources(): ordinary scheduling
// must continue to admit only incomplete/error sources.
async function runCrmKnowledgeSource(user, {
  sourceKind,
  sourceId,
  source_kind: sourceKindPayload = null,
  source_id: sourceIdPayload = null,
  linkBudget = 12,
  dependencies = {},
  lease = {},
} = {}) {
  const kind = String(sourceKind || sourceKindPayload || '').trim();
  const id = String(sourceId || sourceIdPayload || '').trim();
  const empty = {
    considered: 0,
    triaged: 0,
    synthesised: 0,
    skipped: 0,
    errors: 0,
    reviews: 0,
    atomsStored: 0,
    proposed: 0,
    source_kind: kind || null,
    source_id: id || null,
  };
  if (!String(user || '').trim()) return { ...empty, reason: 'user_required' };
  if (!kind || !id) return { ...empty, reason: 'source_kind_and_source_id_required' };
  if (!ENGINE_SOURCE_KINDS.includes(kind)) return { ...empty, reason: 'unsupported_source_kind' };
  const evidence = resolveSourceEvidence(user, kind, id);
  if (!evidence) return { ...empty, reason: 'canonical_source_not_found' };
  if (isCanonicalEvidenceExcluded(evidence)) return { ...empty, reason: 'canonical_source_excluded' };
  if (!dependencies.requestModelObject && process.env.SUBSCRIPTION_AGENT_DISABLED === '1') {
    return { ...empty, reason: 'subscription model plane disabled' };
  }

  const context = {
    entities: loadEntities(user),
    entityFacts: buildEntityFacts(user),
    budget: { n: linkBudget },
  };
  const result = await processSource(user, evidence, context, {
    retry: true,
    dependencies,
    lease,
  });
  return {
    ...empty,
    ...result,
    considered: 1,
    source_kind: evidence.source_kind,
    source_id: evidence.source_id,
  };
}

async function retryCrmKnowledgeErrors(user, { limit = 8, linkBudget = 12, dependencies = {} } = {}) {
  if (!dependencies.requestModelObject && process.env.SUBSCRIPTION_AGENT_DISABLED === '1') {
    return { considered: 0, retried: 0, errors: 0, reason: 'subscription model plane disabled' };
  }
  const health = getCrmKnowledgeHealth(user);
  const groups = new Map();
  for (const receipt of health.currentErrors || []) {
    const key = `${receipt.source_kind}\u0000${receipt.source_id}`;
    const current = groups.get(key) || { sourceKind: receipt.source_kind, sourceId: receipt.source_id, latestAt: Number(receipt.created_at || 0) };
    current.latestAt = Math.min(current.latestAt, Number(receipt.created_at || 0));
    groups.set(key, current);
  }
  const selected = [...groups.values()].sort((a, b) => a.latestAt - b.latestAt)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
  if (!selected.length) return { considered: 0, retried: 0, errors: 0, reviews: 0 };
  const context = { entities: loadEntities(user), entityFacts: buildEntityFacts(user), budget: { n: linkBudget } };
  const totals = { considered: selected.length, retried: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reviews: 0, atomsStored: 0, proposed: 0 };
  for (const item of selected) {
    const evidence = resolveSourceEvidence(user, item.sourceKind, item.sourceId);
    if (!evidence) {
      // Do not erase receipts or effects.  The old error remains audit evidence,
      // and a new source cannot accidentally inherit its completion status.
      writeReceipt(user, item.sourceKind, item.sourceId, 'crm_source_triage', {
        status: 'review', summary: 'Retry could not find the original raw source.',
        payload: { reason: 'raw_source_missing' },
      });
      totals.reviews += 1;
      continue;
    }
    const result = await processSource(user, evidence, context, { retry: true, dependencies });
    totals.retried += 1;
    for (const key of ['triaged', 'synthesised', 'skipped', 'errors', 'reviews', 'atomsStored', 'proposed']) totals[key] += result[key] || 0;
  }
  return totals;
}

function approveReviewedAction(user, outcomeId, { dependencies = {}, lease: suppliedLeaseOptions = {} } = {}) {
  const row = db.hub().prepare('SELECT * FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) throw new Error('Action outcome not found');
  if (row.disposition !== 'review') throw new Error('Only review outcomes can be accepted');
  const payload = parseJson(row.payload);
  const evidence = resolveSourceEvidence(user, row.source_kind, row.source_id);
  if (!evidence || evidence.revision_hash !== row.source_revision || row.pipeline_version !== CRM_KNOWLEDGE_PIPELINE_VERSION) {
    throw new Error('This review item is stale; reprocess the current source before creating a task');
  }
  const action = payload.action || { title: row.candidate_title, evidence: row.evidence_text, actionability: 'implied', confidence: row.confidence };
  const inferredAmbiguity = payload.side_effect_ambiguity || sideEffectAmbiguityFromReason(row.reason);
  const inferredNonCreatable = isNonCreatablePayload(payload)
    || Boolean(inferredAmbiguity?.requires_reconciliation)
    || projectionReviewIsNonCreatable(row.reason);
  const span = payload.evidence_span || {
    start: row.evidence_start,
    end: row.evidence_end,
    chunk_index: row.chunk_index,
    chunk_id: row.chunk_id,
    text: row.evidence_text,
    // Absence of an explicit exact flag is not evidence of exactness.  Old or
    // malformed review rows must be re-triaged rather than accepted blindly.
    exact: false,
  };
  const identity = {
    candidate: payload.candidate || null,
    span,
    source_level: Boolean(payload.source_level),
    non_creatable: inferredNonCreatable,
    side_effect_ambiguity: inferredAmbiguity || null,
    action_key: row.action_key,
  };
  const creationBlock = actionCreationBlockReason(action, identity);
  if (creationBlock || inferredNonCreatable) {
    throw new Error(`This review item cannot create a side effect: ${creationBlock || 'non_creatable_review'}`);
  }
  const entities = loadEntities(user);
  // Approval is not an escape hatch around the source worker. It shares the
  // same full-source token, so an operator cannot publish a task/calendar
  // result while a model/retry worker owns this raw revision.
  const leaseOptions = suppliedLeaseOptions || {};
  const lease = claimSourceProcessingLease(user, evidence, leaseOptions);
  if (!lease.claimed) throw sourceProcessingLeaseHeldError();
  const heartbeat = startSourceProcessingLeaseHeartbeat(user, evidence, lease.token, leaseOptions);
  const suppliedLeaseGuard = dependencies.assertSourceLeaseFn;
  const assertSourceLeaseFn = () => {
    heartbeat.assertOwned();
    if (suppliedLeaseGuard) suppliedLeaseGuard();
    return true;
  };
  return (async () => {
    try {
      assertSourceLeaseFn();
      const result = await projectOneAction(user, evidence, action, identity, entities, {
        ...dependencies,
        approved: true,
        assertSourceLeaseFn,
      });
      // projectOneAction checks before each compiled outcome; this final
      // assertion keeps the approval lease honest before we record its finish.
      assertSourceLeaseFn();
      finishSourceProcessingLease(user, evidence, lease.token, {
        status: result.disposition === 'error' ? 'error' : result.disposition === 'review' ? 'review' : 'done',
      });
      return result;
    } catch (err) {
      // Token-scoped finish is intentionally harmless after ownership loss.
      // The pending outbox claim remains available for reconciliation.
      finishSourceProcessingLease(user, evidence, lease.token, { status: 'error', error: err.message || err });
      throw err;
    } finally {
      heartbeat.stop();
    }
  })();
}

function dismissActionOutcome(user, outcomeId, reason = '') {
  const row = db.hub().prepare('SELECT * FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) throw new Error('Action outcome not found');
  if (!['review', 'error'].includes(row.disposition)) throw new Error('Only review or error outcomes can be dismissed');
  if (isDuplicateReviewSourceOutcome(row)) {
    throw new Error('Duplicate/supersession synthesis review requires Skip atom synthesis or Re-run duplicate review; generic action dismissal cannot resolve it');
  }
  const evidence = resolveSourceEvidence(user, row.source_kind, row.source_id);
  if (!evidence) throw new Error('Original raw source no longer exists');
  const payload = parseJson(row.payload);
  const inferredAmbiguity = payload.side_effect_ambiguity || sideEffectAmbiguityFromReason(row.reason);
  const inferredNonCreatable = isNonCreatablePayload(payload)
    || Boolean(inferredAmbiguity?.requires_reconciliation)
    || projectionReviewIsNonCreatable(row.reason);
  const action = payload.action || { title: row.candidate_title, evidence: row.evidence_text, actionability: row.actionability, confidence: row.confidence };
  const identity = {
    candidate: payload.candidate || null,
    span: payload.evidence_span || {
      start: row.evidence_start, end: row.evidence_end, chunk_index: row.chunk_index,
      chunk_id: row.chunk_id, text: row.evidence_text, exact: true,
    },
    non_creatable: inferredNonCreatable,
    side_effect_ambiguity: inferredAmbiguity || null,
    action_key: row.action_key,
  };
  return upsertActionOutcome(user, evidence, row.action_key, {
    action, identity, disposition: 'dismissed', reason: String(reason || 'dismissed_by_user').slice(0, 1000),
    taskId: row.task_id, eventId: row.event_id,
    payload: outcomePayload(evidence, action, identity, { dismissed_from: row.disposition, dismissal_reason: reason || null }),
  });
}

function shouldSkipByReceipt(user, sourceKind, sourceId) {
  const receipt = sourceReceipt(user, sourceKind, sourceId, 'crm_source_triage');
  if (!receipt || receipt.status !== 'skipped') return false;
  const payload = parseJson(receipt.payload);
  return payload.should_synthesise === false;
}

module.exports = {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  ENGINE_SOURCE_KINDS,
  runCrmKnowledgeEngine,
  runCrmKnowledgeSource,
  retryCrmKnowledgeErrors,
  writeReceipt,
  sourceReceipt,
  shouldSkipByReceipt,
  listActionOutcomeQueue,
  approveReviewedAction,
  dismissActionOutcome,
  skipDuplicateReviewSynthesis,
  queueDuplicateReviewRetry,
  retryDuplicateReview,
  _test: {
    ACTION_STATE_GUARD,
    ACTION_EVENT_GUARD,
    ACTION_EVIDENCE_GUARD,
    ACTION_CONFIDENCE_THRESHOLD,
    ACTION_REVIEW_FLOOR,
    SIDE_EFFECT_PENDING_LEASE_SECONDS,
    AUTO_ERROR_RETRY_BASE_SECONDS,
    AUTO_ERROR_RETRY_MAX_SECONDS,
    actionProjectionBlockReason,
    actionDisposition,
    taskState,
    eventFromAction,
    sourceRows,
    candidateSources,
    runCrmKnowledgeSource,
    autoErrorRetryDelaySeconds,
    sourceErrorRetryState,
    takeFairCandidates,
    currentSourceReceipt,
    claimSourceProcessingLease,
    finishSourceProcessingLease,
    refreshSourceProcessingLease,
    startSourceProcessingLeaseHeartbeat,
    sourceProcessingLeaseLostError,
    isSourceProcessingLeaseLostError,
    reusableTriageDecision,
    reusableDuplicateDecision,
    actionProjectionCovered,
    actionIdentity,
    stableActionKey,
    candidateSpan,
    decorateCandidate,
    mergeTriageResults,
    malformedCandidateKey,
    normaliseActionSemantics,
    candidateSemantics,
    stableCandidateActionKey,
    candidateForProjectedAction,
    canonicaliseProjectedAction,
    projectedEvidenceSpan,
    projectionReviewIsNonCreatable,
    validActionTitle,
    exactEvidenceSpan,
    actionCreationBlockReason,
    sourceLevelOutcome,
    isDuplicateReviewSourceOutcome,
    duplicateReviewOutcomeContext,
    terminalizeDuplicateReviewOutcomes,
    skipDuplicateReviewSynthesis,
    queueDuplicateReviewRetry,
    retryDuplicateReview,
    candidateBatches,
    closedTaskDuplicateMatch,
    taskHistoryForActionProjection,
    createProjectedTasks,
    projectCandidates,
    processSource,
    processSourceClaimed,
    projectOneAction,
    upsertActionOutcome,
    claimPendingSideEffect,
    isRetryableProjectionFailure,
    isRetryableProjectionLinkageReview,
    isRetryableProjectionEvidenceReview,
    reclaimProjectionFailureForTask,
    reclaimProjectionLinkageReviewForTask,
    getActionOutcome,
    stageActionKey,
    sourceRefForEvidence,
    mergeSourceRefIntoAtom,
    retireAtomForSupersession,
    duplicateSynthesisPlan,
    sameAtomClaimSlot,
    replacementAtomsForEvidence,
  },
};
