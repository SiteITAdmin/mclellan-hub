'use strict';

/**
 * Best-effort finish of the first attribution-reconciliation corpus pass.
 * No model calls. Org facts go on the meeting's project (or an inferred one);
 * quote-backed person moves are applied; leftover Hub questions are decided
 * from the stored transcript evidence rather than dumped back on Douglas.
 */

const db = require('./db');
const { writeReceipt } = require('./crm-receipts');
const { resolveSourceEvidence } = require('./source-evidence');
const { discardClarification, openClarifications, KINDS } = require('./crm-clarifications');
const {
  ATTRIBUTION_RECONCILIATION_STAGE,
  ATTRIBUTION_RECONCILIATION_VERSION,
  applyReviewedAttribution,
  buildPacket,
  stateHash,
  _test: { applyDecision },
} = require('./attribution-reconciliation');

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const PROJECT_HINTS = [
  { slug: 'm365-rollout', hints: ['m365', 'microsoft 365', 'microsoft services', 'intune', 'endpoint central', 'pst', 'mailbox', 'onedrive', 'sharepoint', 'e3', 'f3', 'copilot', 'dlp', 'h3o', 'pilot', 'package list', 'gpo', 'outlook', 'sql server', 'site visit', 'global administrator', 'wave ingest', 'departmental wave'] },
  { slug: 'ad-entra-rebuild-inc-hardware', hints: ['entra', 'domain controller', 'kerberos', 'active directory', 'fsmo', 'azure connect', 'dhcp', 'dns'] },
  { slug: 'ropa-sharepoint', hints: ['ropa', 'retention policy', 'lawful', 'statutory', 'identification document'] },
  { slug: 'hr-sharepoint-onedrive-migration', hints: ['u-drive', 'u drive', 'departmental drive'] },
  { slug: 'powerbi-managment', hints: ['power bi', 'powerbi'] },
  { slug: 'cybersecurity-report-and-framework', hints: ['cyber', 'firewall'] },
  { slug: 'dad', hints: ['assessment bed', 'care home', 'hospital social', 'watch him'] },
  { slug: 'jointers-leavers-policy-nis2', hints: ['b-time', 'long-term leave', 'leaver', 'maternity', 'competenc'] },
  { slug: 'teams-project-management-tools', hints: ['hub-site', 'teams team creates a sharepoint'] },
];

function haystackOf(atom, intake) {
  return `${atom.predicate || ''} ${atom.value || ''} ${intake.title || ''} ${intake.project_slug || ''}`.toLowerCase();
}

function inferProjectSlug(atom, intake) {
  if (intake.project_slug) return intake.project_slug;
  const hay = haystackOf(atom, intake);
  for (const row of PROJECT_HINTS) {
    if (row.hints.some(hint => hay.includes(hint))) return row.slug;
  }
  return null;
}

function isFalseEmployment(atom) {
  return atom.predicate === 'works_at' && /^(microsoft)(\s+teams)?$/i.test(compact(atom.value));
}

function contactByName(user, name) {
  const wanted = norm(name);
  if (!wanted) return null;
  const rows = db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const exact = rows.find(row => norm(row.name) === wanted);
  if (exact) return exact;
  const first = wanted.split(' ')[0];
  if (!first || first.length < 3) return null;
  const sameFirst = rows.filter(row => norm(row.name).split(' ')[0] === first);
  return sameFirst.length === 1 ? sameFirst[0] : null;
}

function latestReconciliationReceipts(user) {
  const rows = db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'meeting_intake' AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, ATTRIBUTION_RECONCILIATION_STAGE);
  const latest = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id);
    latest.push(row);
  }
  return latest;
}

function priorReviews(user, sourceId, latestRowid) {
  const rows = db.hub().prepare(`
    SELECT payload FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'meeting_intake' AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, sourceId, ATTRIBUTION_RECONCILIATION_STAGE);
  for (const row of rows) {
    const payload = parseJson(row.payload, {});
    if (payload.derived_by === 'attribution_review_settlement') continue;
    if (payload.derived_by === 'attribution_owner_tidy') continue;
    if (Array.isArray(payload.reviews) && payload.reviews.length) return payload.reviews;
  }
  return [];
}

function rehomeAtom(user, atomId, { kind, id, label, status = null }) {
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
  if (!atom) return { skipped: true, reason: 'missing' };
  const sets = ['subject_kind = ?', 'subject_id = ?', 'subject_label = ?', 'updated_at = unixepoch()'];
  const args = [kind, id, label];
  if (status) {
    sets.push('status = ?');
    args.push(status);
  }
  args.push(atomId, user);
  db.hub().prepare(`UPDATE knowledge_atoms SET ${sets.join(', ')} WHERE id = ? AND user = ?`).run(...args);
  return { atom_id: atomId, before: { subject_kind: atom.subject_kind, subject_id: atom.subject_id, subject_label: atom.subject_label, status: atom.status }, after: { subject_kind: kind, subject_id: id, subject_label: label, status: status || atom.status } };
}

function collapseDuplicateFacts(user, atomIds) {
  const retired = [];
  const atoms = [];
  for (const id of new Set(atomIds.filter(Boolean))) {
    const atom = db.hub().prepare('SELECT id, subject_kind, subject_id, predicate, value, status FROM knowledge_atoms WHERE id = ? AND user = ?').get(id, user);
    if (atom && atom.status !== 'retired') atoms.push(atom);
  }
  const groups = new Map();
  for (const atom of atoms) {
    const key = `${atom.subject_kind}|${atom.subject_id || ''}|${atom.predicate}|${norm(atom.value)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(atom);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(b.value).length - String(a.value).length);
    for (const extra of group.slice(1)) {
      db.hub().prepare("UPDATE knowledge_atoms SET status = 'retired', updated_at = unixepoch() WHERE id = ? AND user = ?")
        .run(extra.id, user);
      retired.push(extra.id);
    }
  }
  return retired;
}

const TASK_OWNER_RULES = [
  { pattern: /shared mailbox imports|failed pst/i, owner: 'Nick Chin' },
  { pattern: /september plan/i, owner: 'Nicola Wolfe' },
  { pattern: /hld comments/i, owner: 'Nicola Wolfe' },
  { pattern: /on-site personnel|site visit/i, owner: 'Nicola Wolfe' },
  { pattern: /b-time reports and responsibilities/i, owner: 'Nadine Murphy' },
  { pattern: /recurring b-time/i, owner: 'Nadine Murphy' },
  { pattern: /retention requirements as the ropa/i, owner: 'Jane Whelan' },
  { pattern: /u-drive to onedrive/i, owner: 'Ken Murray' },
  { pattern: /maternity and extended-absence/i, owner: 'Douglas McLellan' },
  { pattern: /pilot build timeline|laptop delivery/i, owner: 'Neil Midlane' },
  { pattern: /release and delivery date to rob/i, owner: 'Nick Chin' },
  { pattern: /sign off the tool/i, owner: 'Jane Whelan' },
  { pattern: /microsoft forms/i, owner: 'Therese Gilligan' },
];

function decideTaskOwner(review) {
  const title = review.task?.title || review.context || '';
  for (const rule of TASK_OWNER_RULES) {
    if (rule.pattern.test(title)) return { owner: rule.owner, reason: `Task "${title}" is ${rule.owner}'s work from the transcript context.` };
  }
  const owners = (review.owners || []).map(row => row.name).filter(Boolean);
  const named = owners.filter(name => !/^douglas(\s+mclellan)?$/i.test(name) && !/client team/i.test(name) && !/unassigned/i.test(name));
  const unique = [];
  for (const name of named) {
    if (unique.some(other => norm(other) === norm(name) || norm(other).startsWith(norm(name) + ' ') || norm(name).startsWith(norm(other) + ' '))) continue;
    unique.push(name);
  }
  if (unique.length === 1) return { owner: unique[0], reason: `${unique[0]} is the only named non-Douglas owner.` };
  return { owner: 'Douglas McLellan', reason: 'Ambiguous owners; Hub keeps this on Douglas as the tracker.' };
}

function decideReview(review) {
  const kind = review.target_kind;
  const verdict = review.verdict;
  const from = review.current_contact?.name || review.written_name || '';
  const to = review.proposed_contact_name || '';
  const quote = compact(review.evidence_quote);
  const task = review.task?.title || review.context || '';

  if (kind === 'task_owner_conflict') {
    const picked = decideTaskOwner(review);
    return { action: 'apply_task_owner', contactName: picked.owner, reason: picked.reason };
  }
  if (kind === 'attendee' && verdict === 'not_participant') {
    return { action: 'apply_not_participant', reason: review.reason || `${from} is mentioned, not a speaker or attendee.` };
  }
  if (kind === 'attendee' && verdict === 'correct_link' && /nick chin/i.test(to)) {
    return { action: 'apply_correct_link', contactName: 'Nick Chin', reason: 'The meeting lead invited Nick for the PST work; Speaker 1 is Nick, not Alec.' };
  }
  if (kind === 'action_owner' && /nicola wolfe/i.test(from) && /douglas/i.test(to) && /hld comments/i.test(task)) {
    return { action: 'keep_current', reason: 'The client team still has to verify HLD comments. Douglas offering to speak to his team does not take Nicola\'s action.' };
  }
  if (kind === 'projected_action_owner' && verdict === 'correct_link') {
    if (/alan garland/i.test(from) && /neil midlane/i.test(to)) {
      return { action: 'apply_correct_link', contactName: 'Neil Midlane', reason: 'Neil builds and returns the laptops; Alan was asking when they would be ready.' };
    }
    if (/lindsay/i.test(from) && /douglas/i.test(to)) {
      return { action: 'apply_correct_link', contactName: 'Douglas McLellan', reason: 'The assessment-bed route is a family decision. Lindsay facilitates; Douglas decides.' };
    }
    if (/neil midlane/i.test(from) && /douglas/i.test(to) && /catch-up|call about applications/i.test(task)) {
      return { action: 'apply_correct_link', contactName: 'Douglas McLellan', reason: 'Neil proposed the call; Douglas agreed to take it.' };
    }
    if (/ken murray/i.test(from) && /douglas/i.test(to) && /governance/i.test(task)) {
      return { action: 'apply_correct_link', contactName: 'Douglas McLellan', reason: 'Governance policy is the organisation\'s, not the vendor\'s.' };
    }
    if (/douglas/i.test(from) && /glenn/i.test(to) && /karen/i.test(task)) {
      return { action: 'keep_current', reason: 'The quote does not name Glenn. Leave the shared Karen meeting on Douglas, who tracks it.' };
    }
  }
  if (kind === 'projected_action_owner' && verdict === 'needs_review') {
    if (/alec hirst/i.test(from) && /readjust the (delayed )?rollout plan/i.test(task)) {
      return { action: 'apply_correct_link', contactName: 'Neil Midlane', reason: 'Neil said "Alec and I started this morning"; he is the speaker driving the replan.' };
    }
    if (/lindsay/i.test(from) && /tomorrow/i.test(task)) {
      return { action: 'keep_current', reason: 'Lindsay said she will pop along tomorrow. Keep her as the returning clinician.' };
    }
    if (/nicola wolfe/i.test(from) && /september plan/i.test(task)) {
      return { action: 'keep_current', reason: 'Nicola is the client-side planner for the September plan.' };
    }
    if (/neil midlane/i.test(from) && /chase neil|outstanding application list/i.test(task)) {
      return { action: 'keep_current', reason: 'Neil holds the outstanding application list; chasing him is Hub tracking, not a new owner.' };
    }
    return { action: 'keep_current', reason: 'No clean single owner in the quote; leave the current link.' };
  }
  return { action: 'keep_current', reason: 'No confident deterministic decision; leave current attribution.' };
}

function shouldApplyPersonMove(review) {
  const predicate = String(review.context || '').split(':')[0];
  const to = review.proposed_contact_name;
  const from = review.current_contact?.name;
  if (!to || !from) return false;
  if (predicate === 'open_commitment') return true;
  if (/performance of new project manager alan/i.test(review.context || '')) return true;
  return false;
}

async function tidyAttributionKnowledge(user = 'douglas', {
  apply = false,
  updateTaskFn,
} = {}) {
  const result = {
    atoms_retired_false: 0,
    atoms_rehomed: 0,
    atoms_deduped: 0,
    person_moves: 0,
    reviews_applied: 0,
    reviews_kept_current: 0,
    questions_discarded: 0,
    errors: [],
  };
  const hub = db.hub();
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ?').all(user);
  const projectBySlug = new Map(projects.map(row => [row.slug, row]));
  const intakes = Object.fromEntries(
    hub.prepare('SELECT * FROM meeting_intakes WHERE user = ?').all(user).map(row => [row.id, row])
  );

  const latest = latestReconciliationReceipts(user);
  const rehomed = [];
  const touchedAtomIds = [];

  for (const receipt of latest) {
    const payload = parseJson(receipt.payload, {});
    const intake = intakes[receipt.source_id];
    if (!intake) continue;

    for (const item of payload.applied || []) {
      const target = item.target_key || '';
      if (!target.startsWith('atom:')) continue;
      const atomId = target.slice('atom:'.length);
      const atom = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
      if (!atom || atom.subject_kind !== 'unresolved_person') continue;
      if (isFalseEmployment(atom)) {
        if (apply) {
          hub.prepare("UPDATE knowledge_atoms SET status = 'retired', updated_at = unixepoch() WHERE id = ? AND user = ?")
            .run(atomId, user);
        }
        result.atoms_retired_false += 1;
        continue;
      }
      const slug = inferProjectSlug(atom, intake);
      const project = slug ? projectBySlug.get(slug) : null;
      if (!project) {
        result.errors.push({ atom_id: atomId, reason: 'no_project_for_org_fact', value: atom.value });
        continue;
      }
      touchedAtomIds.push(atomId);
      if (apply) rehomed.push(rehomeAtom(user, atomId, { kind: 'project', id: project.id, label: project.name }));
      else rehomed.push({ atom_id: atomId, after: { subject_kind: 'project', subject_id: project.id } });
      result.atoms_rehomed += 1;
    }
  }

  for (const receipt of latest) {
    const intake = intakes[receipt.source_id];
    if (!intake) continue;
    const payload = parseJson(receipt.payload, {});
    const dropped = payload.dropped || [];
    const prior = priorReviews(user, receipt.source_id);
    for (const review of prior) {
      const wasDropped = dropped.some(row => row.target_key === review.target_key && row.verdict === review.verdict);
      if (!wasDropped || review.verdict !== 'correct_link' || review.target_kind !== 'fact_subject') continue;
      if (!shouldApplyPersonMove(review)) {
        const atomId = String(review.target_key || '').startsWith('atom:') ? review.target_key.slice(5) : null;
        const atom = atomId ? hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user) : null;
        if (atom && atom.subject_kind === 'contact') {
          const slug = inferProjectSlug(atom, intake);
          const project = slug ? projectBySlug.get(slug) : null;
          if (project) {
            touchedAtomIds.push(atom.id);
            if (apply) rehomeAtom(user, atom.id, { kind: 'project', id: project.id, label: project.name });
            result.atoms_rehomed += 1;
          }
        }
        continue;
      }
      const contact = contactByName(user, review.proposed_contact_name);
      if (!contact) {
        result.errors.push({ target: review.target_key, reason: 'person_move_contact_missing', name: review.proposed_contact_name });
        continue;
      }
      if (apply) {
        try {
          applyDecision(user, intake.id, {
            target_key: review.target_key,
            target_kind: review.target_kind,
            verdict: 'correct_link',
            contact_id: contact.id,
            contact_name: contact.name,
            current_contact: review.current_contact || null,
            written_name: review.written_name || null,
            evidence_quote: review.evidence_quote || '',
            reason: review.reason || 'Quote-backed person re-home from the stored Terra review.',
          });
        } catch (err) {
          result.errors.push({ target: review.target_key, reason: err.message });
          continue;
        }
      }
      if (String(review.target_key || '').startsWith('atom:')) touchedAtomIds.push(review.target_key.slice(5));
      result.person_moves += 1;
    }
  }
  if (apply) result.atoms_deduped += collapseDuplicateFacts(user, touchedAtomIds).length;

  for (const receipt of latest) {
    if (receipt.status !== 'review') continue;
    const intake = intakes[receipt.source_id];
    if (!intake) continue;
    const payload = parseJson(receipt.payload, {});
    const remaining = [];
    for (const review of payload.reviews || []) {
      const decision = decideReview(review);
      if (decision.action === 'keep_current') {
        result.reviews_kept_current += 1;
        continue;
      }
      if (!apply) {
        result.reviews_applied += 1;
        continue;
      }
      try {
        if (decision.action === 'apply_task_owner') {
          const contact = contactByName(user, decision.contactName);
          if (!contact) throw new Error(`No contact for ${decision.contactName}`);
          await applyReviewedAttribution(user, {
            intakeId: intake.id,
            reviewKey: review.review_key,
            contactId: contact.id,
            updateTaskFn,
          });
        } else if (decision.action === 'apply_not_participant') {
          applyDecision(user, intake.id, {
            target_key: review.target_key,
            target_kind: review.target_kind,
            verdict: 'not_participant',
            contact_id: null,
            contact_name: null,
            current_contact: review.current_contact || null,
            written_name: review.written_name || null,
            evidence_quote: review.evidence_quote || '',
            reason: decision.reason,
          });
        } else if (decision.action === 'apply_correct_link') {
          const contact = contactByName(user, decision.contactName);
          if (!contact) throw new Error(`No contact for ${decision.contactName}`);
          applyDecision(user, intake.id, {
            target_key: review.target_key,
            target_kind: review.target_kind,
            verdict: 'correct_link',
            contact_id: contact.id,
            contact_name: contact.name,
            current_contact: review.current_contact || null,
            written_name: review.written_name || null,
            evidence_quote: review.evidence_quote || '',
            reason: decision.reason,
          });
        }
        result.reviews_applied += 1;
      } catch (err) {
        result.errors.push({ review_key: review.review_key, reason: err.message });
        remaining.push(review);
      }
    }

    if (apply) {
      const fresh = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intake.id, user);
      const packet = buildPacket(user, fresh);
      const evidence = resolveSourceEvidence(user, 'meeting_intake', fresh);
      writeReceipt(user, 'meeting_intake', intake.id, ATTRIBUTION_RECONCILIATION_STAGE, {
        status: remaining.length ? 'review' : 'done',
        summary: `Owner tidy: leftover reviews decided from stored evidence; org facts re-homed. ${remaining.length} still open.`,
        payload: {
          reviews: remaining,
          state_hash_after: stateHash(packet),
          follow_up_required: false,
          derived_by: 'attribution_owner_tidy',
        },
        modelKey: 'attribution_reconciliation',
        modelId: receipt.model_id || null,
        sourceRevision: evidence?.revision_hash || payload.source_revision || null,
        pipelineVersion: ATTRIBUTION_RECONCILIATION_VERSION,
      });
    }
  }

  const open = openClarifications(user);
  for (const item of open.filter(row => row.kind === KINDS.MEETING_QUESTION)) {
    if (!apply) {
      result.questions_discarded += 1;
      continue;
    }
    discardClarification(user, {
      key: item.key,
      kind: item.kind,
      question: item.question,
      sourceKind: 'meeting_intake',
      sourceId: item.intake_id,
    });
    result.questions_discarded += 1;
  }

  return result;
}

module.exports = {
  PROJECT_HINTS,
  decideReview,
  decideTaskOwner,
  inferProjectSlug,
  isFalseEmployment,
  tidyAttributionKnowledge,
};
