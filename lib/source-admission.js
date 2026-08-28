'use strict';

/**
 * The ingest door.
 *
 * `source-evidence.js` already knows how to judge whether a raw row is faithful
 * enough to reason over. Until now it only answered that question on the way
 * OUT — the CRM engine asked it, hours later, about rows an ingester had long
 * since marked processed. So when AgentMail stored a forwarded email without
 * its body on 2 August, nothing failed at the AgentMail boundary: the ingester
 * reported success, and the loss only became visible when Douglas noticed a
 * task that never appeared.
 *
 * This module moves that judgement to the moment of capture. An ingester calls
 * `admitSource` immediately after writing its raw row and gets back a verdict
 * plus a durable receipt. A source that cannot be read is now a visible failure
 * belonging to the ingester that captured it, which is the whole point: being
 * told "AgentMail isn't reading emails" should be a fact the system reports,
 * not a conclusion Douglas has to reach on his own.
 *
 * Deliberately NOT here: any decision about meaning. Admission says only
 * "this is what was captured, and here is whether it is whole". Triage,
 * duplicate review, synthesis, and projection remain the engine's.
 */

const db = require('./db');
const { uuid } = require('./id');
const {
  CRM_KNOWLEDGE_PIPELINE_VERSION,
  SOURCE_EVIDENCE_KINDS,
  resolveSourceEvidence,
  canonicalEvidenceExclusionReason,
} = require('./source-evidence');

const ADMISSION_STAGE = 'source_admitted';

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

// An admission is current only for the exact revision it judged. A later body
// or attachment backfill produces a new revision and must be admitted again,
// which is what makes a repaired source eligible instead of permanently marked.
function currentAdmission(user, sourceKind, sourceId, revisionHash, database = null) {
  const hub = database || db.hub();
  const rows = hub.prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, sourceKind, sourceId, ADMISSION_STAGE);
  return rows.find(row => parseJson(row.payload).source_revision === revisionHash) || null;
}

function writeAdmissionReceipt(user, sourceKind, sourceId, {
  status, summary, payload, database = null,
}) {
  const hub = database || db.hub();
  const id = uuid();
  hub.prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(id, user, sourceKind, sourceId, ADMISSION_STAGE, status, summary || null, JSON.stringify(payload), now());
  return id;
}

/**
 * Admit one freshly-captured raw row.
 *
 * Returns { admitted, complete, completeness, revision_hash, receipt_id,
 * evidence, reason }. `admitted` is false only when nothing readable was
 * captured at all; an incomplete-but-readable source is admitted with a review
 * receipt, because a partial body is still worth reasoning over and must stay
 * eligible for a later backfill rather than being thrown away at the door.
 */
function admitSource(user, sourceKind, sourceIdOrRow, {
  ingester = 'unknown',
  database = null,
} = {}) {
  const normalisedUser = String(user || '').trim();
  const kind = String(sourceKind || '').trim();
  if (!normalisedUser) return { admitted: false, reason: 'user_required' };
  if (!SOURCE_EVIDENCE_KINDS.includes(kind)) {
    return { admitted: false, reason: 'unsupported_source_kind', source_kind: kind };
  }

  let evidence = null;
  let resolveError = null;
  try {
    evidence = resolveSourceEvidence(normalisedUser, kind, sourceIdOrRow);
  } catch (error) {
    resolveError = error;
  }
  if (!evidence) {
    const sourceId = sourceIdOrRow && typeof sourceIdOrRow === 'object'
      ? String(sourceIdOrRow.id || '')
      : String(sourceIdOrRow || '');
    const reason = resolveError
      ? `evidence_error: ${String(resolveError.message || resolveError).slice(0, 200)}`
      : 'raw_source_not_readable';
    if (sourceId) {
      writeAdmissionReceipt(normalisedUser, kind, sourceId, {
        status: 'error',
        summary: `${ingester} captured a row that produced no readable evidence.`,
        payload: {
          pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
          source_revision: null,
          ingester,
          reason,
        },
        database,
      });
    }
    return { admitted: false, reason, source_kind: kind, source_id: sourceId || null };
  }

  // An excluded source is a deliberate boundary, not a capture failure. The
  // Hub's own report mail is captured faithfully and simply isn't CRM evidence.
  const exclusionReason = canonicalEvidenceExclusionReason(evidence);
  const excluded = Boolean(exclusionReason);
  const existing = currentAdmission(normalisedUser, kind, evidence.source_id, evidence.revision_hash, database);
  if (existing) {
    return {
      admitted: true,
      repeat: true,
      complete: Boolean(evidence.complete),
      completeness: evidence.completeness,
      excluded,
      exclusion_reason: exclusionReason,
      revision_hash: evidence.revision_hash,
      receipt_id: existing.id,
      evidence,
    };
  }

  const { UNINTELLIGIBLE_COMPLETENESS } = require('./transcript-quality');
  const unintelligible = evidence.completeness === UNINTELLIGIBLE_COMPLETENESS;
  const status = excluded ? 'skipped'
    : unintelligible ? 'error'
      : evidence.complete ? 'done'
        : 'review';
  const summary = excluded
    ? `${ingester} captured an excluded source: ${exclusionReason} (${evidence.completeness}).`
    : unintelligible
      ? `${ingester} captured an unintelligible transcript — not treated as a meeting.`
      : evidence.complete
        ? `${ingester} captured complete evidence (${evidence.chunks.length} chunk(s)).`
        : `${ingester} captured incomplete evidence: ${evidence.completeness}.`;

  const receiptId = writeAdmissionReceipt(normalisedUser, kind, evidence.source_id, {
    status,
    summary,
    payload: {
      pipeline_version: CRM_KNOWLEDGE_PIPELINE_VERSION,
      source_revision: evidence.revision_hash,
      ingester,
      complete: Boolean(evidence.complete),
      completeness: evidence.completeness,
      reason: unintelligible ? UNINTELLIGIBLE_COMPLETENESS : undefined,
      body_source: evidence.body_source,
      chunks: evidence.chunks.length,
      text_chars: String(evidence.text || '').length,
      excluded,
      exclusion_reason: exclusionReason,
    },
    database,
  });

  return {
    admitted: true,
    repeat: false,
    complete: Boolean(evidence.complete),
    completeness: evidence.completeness,
    excluded,
    exclusion_reason: exclusionReason,
    revision_hash: evidence.revision_hash,
    receipt_id: receiptId,
    evidence,
  };
}

/**
 * What did each ingester capture, and how much of it was whole?
 *
 * This is the number that answers "is AgentMail reading emails?" without
 * anyone having to infer it from a downstream task count. Counting only the
 * latest admission per source keeps a repaired source from being reported
 * broken forever.
 */
function admissionHealth(user, { sinceSeconds = 86400, database = null } = {}) {
  const hub = database || db.hub();
  const since = now() - Math.max(60, Number(sinceSeconds) || 86400);
  const rows = hub.prepare(`
    SELECT r.* FROM knowledge_receipts r
    JOIN (
      SELECT source_kind, source_id, MAX(created_at) AS latest
      FROM knowledge_receipts
      WHERE user = ? AND stage = ? AND created_at >= ?
      GROUP BY source_kind, source_id
    ) latest_rows
      ON latest_rows.source_kind = r.source_kind
     AND latest_rows.source_id = r.source_id
     AND latest_rows.latest = r.created_at
    WHERE r.user = ? AND r.stage = ? AND r.created_at >= ?
  `).all(user, ADMISSION_STAGE, since, user, ADMISSION_STAGE, since);

  const byIngester = new Map();
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const key = String(payload.ingester || 'unknown');
    const entry = byIngester.get(key) || {
      ingester: key, captured: 0, complete: 0, incomplete: 0, unreadable: 0, excluded: 0,
      unintelligible: 0, unintelligibleIds: [], reasons: {},
    };
    entry.captured += 1;
    if (row.status === 'error') {
      entry.unreadable += 1;
      const reason = String(payload.reason || payload.completeness || 'unknown');
      entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
      if (reason === 'unintelligible_transcript' || payload.completeness === 'unintelligible_transcript') {
        entry.unintelligible += 1;
        if (row.source_id) entry.unintelligibleIds.push(row.source_id);
      }
    } else if (payload.excluded) {
      entry.excluded += 1;
    } else if (payload.complete) {
      entry.complete += 1;
    } else {
      entry.incomplete += 1;
      const reason = String(payload.completeness || 'unknown');
      entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
    }
    byIngester.set(key, entry);
  }

  const ingesters = [...byIngester.values()].sort((a, b) => b.captured - a.captured);
  const totals = ingesters.reduce((acc, entry) => ({
    captured: acc.captured + entry.captured,
    complete: acc.complete + entry.complete,
    incomplete: acc.incomplete + entry.incomplete,
    unreadable: acc.unreadable + entry.unreadable,
    excluded: acc.excluded + entry.excluded,
    unintelligible: acc.unintelligible + (entry.unintelligible || 0),
  }), { captured: 0, complete: 0, incomplete: 0, unreadable: 0, excluded: 0, unintelligible: 0 });

  // An ingester that captured only unreadable rows is the exact 2 August
  // shape: it ran, it reported success, and nothing usable arrived.
  const silentlyFailing = ingesters.filter(entry => entry.captured >= 3
    && entry.complete === 0
    && (entry.unreadable + entry.incomplete) === entry.captured - entry.excluded
    && entry.captured > entry.excluded);

  return { since, totals, ingesters, silentlyFailing };
}

module.exports = { ADMISSION_STAGE, admitSource, admissionHealth, currentAdmission };
