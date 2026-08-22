'use strict';

/**
 * Whole-source attribution reconciliation for meeting evidence.
 *
 * Meeting intake and CRM projection deliberately work in bounded stages. This
 * pass comes afterwards and compares the complete transcript with the compiled
 * people/actions/atoms/tasks those stages produced. It is change-driven: the
 * scheduler may scan often, but a model call happens only when the raw revision
 * or its derived attribution state changed.
 */

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');
const { requestModelObject } = require('./model-request');
const { resolveSourceEvidence } = require('./source-evidence');
const { writeReceipt } = require('./crm-receipts');
const { upsertAtom } = require('./atoms');
const { updateTask, parseTaskTags, withTaskTags } = require('./google-tasks');
const { TASK_CODES } = require('./openrouter-attribution');
const { PROMPTS } = require('./prompts');

const ATTRIBUTION_RECONCILIATION_VERSION = 'meeting-attribution-reconciliation-v1';
const ATTRIBUTION_RECONCILIATION_STAGE = 'attribution_reconciliation';
const AUTO_LINK_CONFIDENCE = 0.97;
const AUTO_CORRECT_CONFIDENCE = 0.995;
const VALID_VERDICTS = new Set([
  'link_missing',
  'correct_link',
  'remove_link',
  'not_participant',
  'needs_review',
]);

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function shortHash(parts) {
  return crypto.createHash('sha1').update(parts.map(v => String(v || '')).join('\u0000')).digest('hex').slice(0, 16);
}

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function evidenceIsExact(transcript, quote) {
  const needle = compact(quote);
  return needle.length >= 12 && compact(transcript).includes(needle);
}

function aliasesFor(contact) {
  const parsed = parseJson(contact?.aliases, []);
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

function contactTerms(contact) {
  return [contact?.name, ...aliasesFor(contact)].map(norm).filter(Boolean);
}

function contactForName(contacts, name) {
  const wanted = norm(name);
  if (!wanted) return null;
  const matches = contacts.filter(contact => contactTerms(contact).includes(wanted));
  return matches.length === 1 ? matches[0] : null;
}

function extractionTargetKey(kind, item = {}) {
  // Identity excludes the mutable link/owner field so a confirmed correction
  // keeps the same key and remains authoritative on every later pass.
  if (kind === 'attendee') return `attendee:${shortHash([item.name, item.role_or_context])}`;
  if (kind === 'action') return `action:${shortHash([item.task || item.text, item.project_slug])}`;
  if (kind === 'crm_update') return `crm_update:${shortHash([item.type, item.text, item.project_slug])}`;
  return null;
}

function meetingAtoms(user, intakeId) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ? AND source_refs LIKE ?
    ORDER BY id
  `).all(user, `%${intakeId}%`).filter(atom => {
    const refs = parseJson(atom.source_refs, []);
    return Array.isArray(refs) && refs.some(ref => ref?.kind === 'meeting_intake' && String(ref.id) === String(intakeId));
  });
}

function meetingOutcomes(user, intakeId) {
  return db.hub().prepare(`
    SELECT * FROM crm_action_outcomes
    WHERE user = ? AND source_kind = 'meeting_intake' AND source_id = ?
    ORDER BY created_at, id
  `).all(user, intakeId);
}

function linkedTasks(user, outcomes) {
  const ids = [...new Set(outcomes.map(row => row.task_id).filter(Boolean))];
  if (!ids.length) return [];
  return db.hub().prepare(`
    SELECT * FROM google_tasks WHERE user = ? AND id IN (${ids.map(() => '?').join(',')})
    ORDER BY id
  `).all(user, ...ids);
}

function contactsForUser(user, intake) {
  const scheduled = new Set();
  if (intake.meeting_id) {
    try {
      for (const row of db.hub().prepare('SELECT contact_id FROM meeting_attendees WHERE meeting_id = ?').all(intake.meeting_id)) {
        if (row.contact_id) scheduled.add(row.contact_id);
      }
    } catch (_) { /* legacy databases may not carry meeting_attendees */ }
  }
  const contacts = db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ? ORDER BY name').all(user);
  return contacts.map(contact => ({ ...contact, scheduled_attendee: scheduled.has(contact.id) }));
}

function buildTargets({ extraction, outcomes, atoms, tasks, contacts }) {
  const targets = [];
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const currentContact = name => {
    const contact = contactForName(contacts, name);
    return contact ? { id: contact.id, name: contact.name } : null;
  };

  for (const attendee of extraction.meeting?.attendees || []) {
    targets.push({
      key: extractionTargetKey('attendee', attendee),
      kind: 'attendee',
      written_name: attendee.name || null,
      current_contact: currentContact(attendee.matched_contact),
      context: attendee.role_or_context || null,
    });
  }
  for (const action of extraction.action_register || []) {
    targets.push({
      key: extractionTargetKey('action', action),
      kind: 'action_owner',
      written_name: action.owner || null,
      current_contact: currentContact(action.matched_contact),
      context: [action.task || action.text, action.detail].filter(Boolean).join(' — ').slice(0, 1200),
    });
  }
  for (const update of extraction.crm_updates || []) {
    targets.push({
      key: extractionTargetKey('crm_update', update),
      kind: 'fact_subject',
      written_name: update.subject || null,
      current_contact: currentContact(update.matched_contact),
      context: `${update.type || 'fact'}: ${update.text || ''}`.slice(0, 1200),
    });
  }
  for (const outcome of outcomes) {
    const payload = parseJson(outcome.payload, {});
    const action = payload.action || {};
    const task = taskById.get(outcome.task_id);
    targets.push({
      key: `outcome:${outcome.id}`,
      kind: 'projected_action_owner',
      written_name: action.owner || null,
      current_contact: currentContact(action.person || action.owner),
      context: [action.title || outcome.candidate_title, action.evidence || outcome.evidence_text].filter(Boolean).join(' — ').slice(0, 1400),
      task: task ? {
        id: task.id,
        title: task.title,
        status: task.status,
        current_assignee: parseTaskTags(task.notes).assignee,
      } : null,
    });
  }
  for (const atom of atoms) {
    if (atom.subject_kind !== 'contact') continue;
    targets.push({
      key: `atom:${atom.id}`,
      kind: 'fact_subject',
      written_name: atom.subject_label,
      current_contact: atom.subject_id
        ? contacts.find(contact => contact.id === atom.subject_id)
          ? { id: atom.subject_id, name: contacts.find(contact => contact.id === atom.subject_id).name }
          : null
        : currentContact(atom.subject_label),
      context: `${atom.predicate}: ${atom.value}`.slice(0, 1400),
    });
  }
  return targets.filter(target => target.key);
}

function priorHumanCorrections(user) {
  try {
    return db.hub().prepare(`
      SELECT source_id, question, answer, resolution
      FROM crm_clarification_answers
      WHERE user = ? AND kind = 'attribution_correction'
      ORDER BY created_at DESC LIMIT 20
    `).all(user).map(row => ({
      source_id: row.source_id,
      question: row.question,
      answer: row.answer,
      resolution: parseJson(row.resolution, {}),
    }));
  } catch (_) {
    return [];
  }
}

function humanCorrectionsForSource(user, intakeId) {
  try {
    return db.hub().prepare(`
      SELECT resolution
      FROM crm_clarification_answers
      WHERE user = ? AND kind = 'attribution_correction' AND source_kind = 'meeting_intake' AND source_id = ?
      ORDER BY created_at DESC
    `).all(user, intakeId).map(row => parseJson(row.resolution, {}));
  } catch (_) {
    return [];
  }
}

function buildPacket(user, intake) {
  const extraction = parseJson(intake.extraction, {});
  const outcomes = meetingOutcomes(user, intake.id);
  const atoms = meetingAtoms(user, intake.id);
  const tasks = linkedTasks(user, outcomes);
  const contacts = contactsForUser(user, intake);
  const targets = buildTargets({ extraction, outcomes, atoms, tasks, contacts });
  const humanByTarget = new Map(humanCorrectionsForSource(user, intake.id)
    .filter(resolution => resolution?.target_key)
    .map(resolution => [resolution.target_key, resolution]));
  for (const target of targets) {
    if (humanByTarget.has(target.key)) target.human_resolution = humanByTarget.get(target.key);
  }
  return { intake, extraction, outcomes, atoms, tasks, contacts, targets };
}

function packetState(packet) {
  return {
    extraction: packet.extraction,
    outcomes: packet.outcomes.map(row => ({ id: row.id, disposition: row.disposition, task_id: row.task_id, payload: row.payload })),
    atoms: packet.atoms.map(row => ({ id: row.id, subject_kind: row.subject_kind, subject_id: row.subject_id, subject_label: row.subject_label, value: row.value, status: row.status, source_refs: row.source_refs })),
    tasks: packet.tasks.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status,
      deleted_at: row.deleted_at,
      assignee: parseTaskTags(row.notes).assignee,
    })),
  };
}

function stateHash(packet) {
  return stableHash(packetState(packet));
}

function latestAttributionReceipt(user, intakeId, sourceRevision) {
  const rows = db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'meeting_intake' AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, intakeId, ATTRIBUTION_RECONCILIATION_STAGE);
  return rows.find(row => {
    const payload = parseJson(row.payload, {});
    return payload.pipeline_version === ATTRIBUTION_RECONCILIATION_VERSION
      && payload.source_revision === sourceRevision;
  }) || null;
}

function contactsForPrompt(contacts) {
  return contacts.map(contact => ({
    id: contact.id,
    name: contact.name,
    aliases: aliasesFor(contact),
    scheduled_attendee: Boolean(contact.scheduled_attendee),
  }));
}

function reviewPrompt(user, packet) {
  return PROMPTS.attribution_reconciliation
    .replace('[MEETING_TITLE]', String(packet.intake.title || 'Meeting'))
    .replace('[PROJECT]', String(packet.intake.project_slug || 'unknown'))
    .replace('[CONTACTS]', JSON.stringify(contactsForPrompt(packet.contacts), null, 2))
    .replace('[TARGETS]', JSON.stringify(packet.targets, null, 2))
    .replace('[PRIOR_CORRECTIONS]', JSON.stringify(priorHumanCorrections(user), null, 2))
    .replace('[TRANSCRIPT]', String(packet.intake.transcript || ''));
}

async function requestReview(user, packet) {
  const result = await requestModelObject({
    messages: [{ role: 'user', content: reviewPrompt(user, packet) }],
    user,
    feature: 'attribution_reconciliation',
    modelKey: 'attribution_reconciliation',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: { decisions: [] },
    label: 'meeting attribution reconciliation',
    attempts: 2,
    timeout: 300000,
    meta: true,
  });
  return { parsed: result.object, modelId: result.modelId };
}

function normalizeDecision(raw, packet) {
  const target = packet.targets.find(item => item.key === String(raw?.target_key || '').trim());
  if (!target) return null;
  const verdict = String(raw?.verdict || '').trim().toLowerCase();
  if (!VALID_VERDICTS.has(verdict)) return null;
  const contact = raw?.contact_id ? packet.contacts.find(item => item.id === String(raw.contact_id)) : null;
  if (['link_missing', 'correct_link'].includes(verdict) && !contact) return null;
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
  const evidenceQuote = compact(raw?.evidence_quote);
  return {
    target_key: target.key,
    target_kind: target.kind,
    verdict,
    contact_id: contact?.id || null,
    contact_name: contact?.name || null,
    confidence,
    evidence_quote: evidenceQuote,
    reason: String(raw?.reason || '').trim().slice(0, 1000),
    current_contact: target.current_contact || null,
    written_name: target.written_name || null,
    context: target.context || null,
    task: target.task || null,
  };
}

function transcriptSpeakers(transcript) {
  const names = new Set();
  for (const line of String(transcript || '').split('\n')) {
    const match = line.match(/^\s*([^|:：\n]{1,80}?)\s*(?:\|\s*(?:(?:\d{1,2}:)?\d{1,2}:\d{2})?\s*|[:：-]\s*)/);
    if (match) names.add(norm(match[1]));
  }
  return names;
}

function transcriptTurns(transcript) {
  const turns = [];
  let current = null;
  for (const line of String(transcript || '').split('\n')) {
    const header = line.match(/^\s*(.{1,80}?)\s*\|\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/);
    if (header) {
      if (current) turns.push(current);
      current = { speaker: header[1].trim(), text: '' };
      continue;
    }
    if (current) current.text += `${line} `;
  }
  if (current) turns.push(current);
  return turns.map(turn => ({ ...turn, text: compact(turn.text) }));
}

function speakerForEvidence(transcript, quote) {
  const needle = compact(quote);
  if (!needle) return null;
  const matches = transcriptTurns(transcript).filter(turn => turn.text.includes(needle));
  return matches.length === 1 ? matches[0].speaker : null;
}

function words(value) {
  return ` ${String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function mentionsContact(value, contact, contacts = []) {
  const haystack = words(value);
  const terms = [...contactTerms(contact)];
  const first = words(contact.name).trim().split(' ')[0];
  const sameFirst = contacts.filter(candidate => words(candidate.name).trim().split(' ')[0] === first);
  if (first && sameFirst.length === 1) terms.push(first);
  return terms.some(term => {
    const needle = words(term);
    return needle.trim() && haystack.includes(needle);
  });
}

function speakerMatchesContact(speaker, contact, contacts) {
  if (!speaker || !contact) return false;
  if (contactTerms(contact).includes(norm(speaker))) return true;
  const speakerName = words(speaker).trim();
  if (!speakerName || speakerName.includes(' ')) return false;
  const sameFirst = contacts.filter(candidate => words(candidate.name).trim().split(' ')[0] === speakerName);
  const scheduled = sameFirst.filter(candidate => candidate.scheduled_attendee);
  return contact.scheduled_attendee && scheduled.length === 1 && scheduled[0].id === contact.id;
}

function factSubjectGate(decision, packet) {
  if (decision.target_kind !== 'fact_subject' || decision.verdict !== 'link_missing') return null;
  const proposed = packet.contacts.find(contact => contact.id === decision.contact_id);
  if (!proposed) return 'fact_subject_contact_missing';
  if (mentionsContact(decision.context, proposed, packet.contacts)) return null;
  const namedOthers = packet.contacts.filter(contact => contact.id !== proposed.id && mentionsContact(decision.context, contact, packet.contacts));
  if (namedOthers.length) return 'fact_text_names_a_different_person';
  const firstPerson = /\b(?:i|i'm|i’m|i'll|i’ll|i've|i’ve|my|me)\b/i.test(decision.evidence_quote);
  const speaker = speakerForEvidence(packet.intake.transcript, decision.evidence_quote);
  if (firstPerson && speakerMatchesContact(speaker, proposed, packet.contacts)) return null;
  return 'fact_subject_not_explicit_in_evidence';
}

function automaticDecision(decision, packet) {
  const target = packet.targets.find(item => item.key === decision.target_key);
  if (target?.human_resolution) {
    return { automatic: false, reason: 'human_correction_is_authoritative' };
  }
  if (!evidenceIsExact(packet.intake.transcript, decision.evidence_quote)) {
    return { automatic: false, reason: 'evidence_quote_not_exact' };
  }
  if (decision.verdict === 'link_missing') {
    if (decision.current_contact) return { automatic: false, reason: 'target_already_linked' };
    const factReason = factSubjectGate(decision, packet);
    if (factReason) return { automatic: false, reason: factReason };
    return decision.confidence >= AUTO_LINK_CONFIDENCE
      ? { automatic: true }
      : { automatic: false, reason: 'below_auto_link_confidence' };
  }
  if (decision.verdict === 'correct_link') {
    if (decision.current_contact?.id === decision.contact_id) return { automatic: false, reason: 'already_correct' };
    return decision.confidence >= AUTO_CORRECT_CONFIDENCE
      ? { automatic: true }
      : { automatic: false, reason: 'below_auto_correct_confidence' };
  }
  if (decision.verdict === 'not_participant') {
    const possibleContact = packet.contacts.find(contact => contact.id === decision.current_contact?.id)
      || contactForName(packet.contacts, decision.written_name);
    if (possibleContact?.scheduled_attendee) {
      return { automatic: false, reason: 'scheduled_attendee_requires_review' };
    }
    const neverSpoke = !transcriptSpeakers(packet.intake.transcript).has(norm(decision.written_name));
    return decision.target_kind === 'attendee' && neverSpoke && decision.confidence >= AUTO_CORRECT_CONFIDENCE
      ? { automatic: true }
      : { automatic: false, reason: neverSpoke ? 'below_auto_correct_confidence' : 'named_as_transcript_speaker' };
  }
  return { automatic: false, reason: decision.verdict === 'remove_link' ? 'destructive_unlink_requires_review' : 'model_requested_review' };
}

function locateExtractionTarget(extraction, targetKey) {
  const groups = [
    ['attendee', extraction.meeting?.attendees || []],
    ['action', extraction.action_register || []],
    ['crm_update', extraction.crm_updates || []],
  ];
  for (const [kind, items] of groups) {
    const index = items.findIndex(item => extractionTargetKey(kind, item) === targetKey);
    if (index >= 0) return { kind, items, index, item: items[index] };
  }
  return null;
}

function applyExtractionDecision(user, intakeId, decision) {
  const hub = db.hub();
  const row = hub.prepare('SELECT extraction FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!row) throw new Error('Meeting intake not found');
  const extraction = parseJson(row.extraction, {});
  const located = locateExtractionTarget(extraction, decision.target_key);
  if (!located) throw new Error(`Attribution target no longer exists: ${decision.target_key}`);
  const before = JSON.parse(JSON.stringify(located.item));

  if (decision.verdict === 'not_participant' && located.kind === 'attendee') {
    const [removed] = located.items.splice(located.index, 1);
    if (!extraction.meeting) extraction.meeting = {};
    if (!Array.isArray(extraction.meeting.mentioned_people)) extraction.meeting.mentioned_people = [];
    extraction.meeting.mentioned_people.push({
      name: removed.name,
      matched_contact: removed.matched_contact || null,
      reason: decision.reason || 'Whole-transcript reconciliation found a mention, not a participant.',
    });
  } else if (decision.verdict === 'remove_link') {
    if (located.kind === 'attendee') located.item.matched_contact = null;
    if (located.kind === 'action') {
      located.item.matched_contact = null;
      located.item.owner_type = 'unknown_speaker';
    }
    if (located.kind === 'crm_update') located.item.matched_contact = null;
  } else {
    if (located.kind === 'attendee') located.item.matched_contact = decision.contact_name;
    if (located.kind === 'action') {
      located.item.owner = decision.contact_name;
      located.item.matched_contact = decision.contact_name;
      located.item.owner_type = norm(decision.contact_name) === 'douglas mclellan' ? 'douglas' : 'known_person';
    }
    if (located.kind === 'crm_update') {
      located.item.subject = decision.contact_name;
      located.item.matched_contact = decision.contact_name;
    }
  }
  hub.prepare('UPDATE meeting_intakes SET extraction = ? WHERE id = ? AND user = ?')
    .run(JSON.stringify(extraction), intakeId, user);
  return { target_key: decision.target_key, before, after: decision.verdict === 'not_participant' ? null : located.item };
}

function correctedAtomValue(atom, contactName) {
  if (atom.predicate !== 'open_commitment') return atom.value;
  const prefix = `${atom.subject_label} owns:`;
  return String(atom.value || '').startsWith(prefix)
    ? `${contactName} owns:${String(atom.value).slice(prefix.length)}`
    : atom.value;
}

function applyAtomDecision(user, intakeId, decision) {
  const hub = db.hub();
  const atomId = decision.target_key.slice('atom:'.length);
  const atom = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
  if (!atom) throw new Error('Knowledge atom not found');
  const refs = parseJson(atom.source_refs, []);
  const meetingRefs = Array.isArray(refs)
    ? refs.filter(ref => ref?.kind === 'meeting_intake' && String(ref.id) === String(intakeId))
    : [];
  if (!meetingRefs.length) throw new Error('Knowledge atom no longer cites this meeting');
  const before = { subject_id: atom.subject_id, subject_label: atom.subject_label, source_refs: atom.source_refs };
  const otherRefs = refs.filter(ref => !(ref?.kind === 'meeting_intake' && String(ref.id) === String(intakeId)));

  if (decision.verdict === 'remove_link') {
    if (otherRefs.length) {
      hub.prepare('UPDATE knowledge_atoms SET source_refs = ?, updated_at = unixepoch() WHERE id = ?')
        .run(JSON.stringify(otherRefs), atom.id);
      return { target_key: decision.target_key, before, after: { meeting_provenance_removed: true, subject_id: atom.subject_id } };
    }
    hub.prepare(`
      UPDATE knowledge_atoms
      SET subject_kind = 'unresolved_person', subject_id = NULL, updated_at = unixepoch()
      WHERE id = ?
    `).run(atom.id);
    return { target_key: decision.target_key, before, after: { subject_kind: 'unresolved_person', subject_id: null, subject_label: atom.subject_label } };
  }

  const value = correctedAtomValue(atom, decision.contact_name);
  if (!otherRefs.length) {
    hub.prepare(`
      UPDATE knowledge_atoms
      SET subject_kind = 'contact', subject_id = ?, subject_label = ?, value = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(decision.contact_id, decision.contact_name, value, atom.id);
    return { target_key: decision.target_key, before, after: { subject_id: decision.contact_id, subject_label: decision.contact_name } };
  }

  hub.prepare('UPDATE knowledge_atoms SET source_refs = ?, updated_at = unixepoch() WHERE id = ?')
    .run(JSON.stringify(otherRefs), atom.id);
  const newAtomId = upsertAtom(user, {
    subjectKind: 'contact',
    subjectId: decision.contact_id,
    subjectLabel: decision.contact_name,
    predicate: atom.predicate,
    value,
    sourceRef: meetingRefs,
    confidence: atom.confidence,
    status: atom.status,
    derivedBy: 'attribution_reconciliation',
    excludeAtomIds: [atom.id],
  });
  return { target_key: decision.target_key, before, after: { split_to_atom_id: newAtomId, subject_id: decision.contact_id, subject_label: decision.contact_name } };
}

function applyOutcomeDecision(user, decision) {
  const hub = db.hub();
  const outcomeId = decision.target_key.slice('outcome:'.length);
  const row = hub.prepare('SELECT * FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) throw new Error('Action outcome not found');
  const payload = parseJson(row.payload, {});
  const before = JSON.parse(JSON.stringify(payload.action || {}));
  payload.action = { ...(payload.action || {}) };
  payload.candidate = { ...(payload.candidate || {}) };
  if (decision.verdict === 'remove_link') {
    payload.action.owner = null;
    payload.action.person = null;
  } else {
    payload.action.owner = decision.contact_name;
    payload.action.person = decision.contact_name;
    payload.candidate.owner = decision.contact_name;
  }
  payload.attribution_reconciliation = {
    version: ATTRIBUTION_RECONCILIATION_VERSION,
    applied_at: now(),
    verdict: decision.verdict,
    contact_id: decision.contact_id,
    evidence_quote: decision.evidence_quote,
    reason: decision.reason,
  };
  hub.prepare('UPDATE crm_action_outcomes SET payload = ?, updated_at = unixepoch() WHERE id = ?')
    .run(JSON.stringify(payload), row.id);
  return { target_key: decision.target_key, before, after: payload.action, task_id: row.task_id || null, outcome_id: row.id };
}

function applyDecision(user, intakeId, decision) {
  if (decision.target_key.startsWith('atom:')) return applyAtomDecision(user, intakeId, decision);
  if (decision.target_key.startsWith('outcome:')) return applyOutcomeDecision(user, decision);
  return applyExtractionDecision(user, intakeId, decision);
}

function canonicalOwner(user, owner) {
  const contacts = db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const clean = String(owner || '').trim();
  if (['douglas', 'douglas mclellan'].includes(norm(clean))) {
    const self = contacts.find(contact => norm(contact.name) === 'douglas mclellan') || null;
    return { key: 'self:douglas', contact: self, name: self?.name || 'Douglas McLellan' };
  }
  const contact = contactForName(contacts, owner);
  if (contact) return { key: contact.id, contact, name: contact.name };
  return clean ? { key: `name:${norm(clean)}`, contact: null, name: clean } : null;
}

function claimTaskCorrection(user, outcomeId, desired) {
  const hub = db.hub();
  const row = hub.prepare('SELECT payload FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) throw new Error('Action outcome not found for task correction');
  const payload = parseJson(row.payload, {});
  const prior = payload.attribution_task_correction;
  if (prior?.state === 'applied' && prior.assignee === desired.assignee && prior.task_id === desired.taskId) {
    return { claimed: false, alreadyApplied: true };
  }
  payload.attribution_task_correction = {
    version: ATTRIBUTION_RECONCILIATION_VERSION,
    state: 'pending',
    task_id: desired.taskId,
    assignee: desired.assignee,
    claimed_at: now(),
  };
  const changed = hub.prepare(`
    UPDATE crm_action_outcomes SET payload = ?, updated_at = unixepoch()
    WHERE id = ? AND user = ? AND payload = ?
  `).run(JSON.stringify(payload), outcomeId, user, row.payload).changes;
  return { claimed: changed === 1, alreadyApplied: false };
}

function finishTaskCorrection(user, outcomeId, desired, error = null) {
  const hub = db.hub();
  const row = hub.prepare('SELECT payload FROM crm_action_outcomes WHERE id = ? AND user = ?').get(outcomeId, user);
  if (!row) return;
  const payload = parseJson(row.payload, {});
  payload.attribution_task_correction = {
    ...(payload.attribution_task_correction || {}),
    version: ATTRIBUTION_RECONCILIATION_VERSION,
    state: error ? 'error' : 'applied',
    task_id: desired.taskId,
    assignee: desired.assignee,
    finished_at: now(),
    error: error ? String(error.message || error).slice(0, 500) : null,
  };
  hub.prepare('UPDATE crm_action_outcomes SET payload = ?, updated_at = unixepoch() WHERE id = ? AND user = ?')
    .run(JSON.stringify(payload), outcomeId, user);
}

async function reconcileTaskAssignee(user, taskId, { updateTaskFn = updateTask, outcomeId = null } = {}) {
  const hub = db.hub();
  const task = hub.prepare('SELECT * FROM google_tasks WHERE id = ? AND user = ?').get(taskId, user);
  if (!task || task.status !== 'needsAction' || task.deleted_at) return { task_id: taskId, skipped: 'task_not_open' };
  const rows = hub.prepare('SELECT * FROM crm_action_outcomes WHERE user = ? AND task_id = ?').all(user, taskId);
  const owners = new Map();
  for (const row of rows) {
    const owner = canonicalOwner(user, parseJson(row.payload, {}).action?.owner);
    if (owner) owners.set(owner.key, owner);
  }
  if (owners.size > 1) {
    return {
      task_id: taskId,
      review: true,
      reason: 'linked_action_outcomes_disagree_on_owner',
      owners: [...owners.values()].map(owner => ({ contact_id: owner.contact?.id || null, name: owner.name })),
      title: task.title,
      current_assignee: parseTaskTags(task.notes).assignee,
    };
  }
  const owner = [...owners.values()][0] || null;
  const isDouglas = !owner || norm(owner.name) === 'douglas' || norm(owner.name) === 'douglas mclellan';
  const assignee = isDouglas ? null : owner.name;
  const current = parseTaskTags(task.notes).assignee;
  if (norm(current) === norm(assignee)) return { task_id: taskId, unchanged: true, assignee };
  const sourceOutcomeId = outcomeId || rows[0]?.id;
  if (!sourceOutcomeId) return { task_id: taskId, review: true, reason: 'task_has_no_action_outbox_row' };
  const desired = { taskId, assignee };
  const claim = claimTaskCorrection(user, sourceOutcomeId, desired);
  if (!claim.claimed && claim.alreadyApplied) return { task_id: taskId, unchanged: true, assignee };
  if (!claim.claimed) return { task_id: taskId, review: true, reason: 'task_correction_claim_conflict' };
  try {
    await updateTaskFn(user, taskId, { notes: withTaskTags(task.notes, { assignee }) });
    finishTaskCorrection(user, sourceOutcomeId, desired);
    return { task_id: taskId, updated: true, assignee };
  } catch (err) {
    finishTaskCorrection(user, sourceOutcomeId, desired, err);
    throw err;
  }
}

function reviewItem(decision, reason, intake) {
  const reviewKey = shortHash([
    ATTRIBUTION_RECONCILIATION_VERSION,
    intake.id,
    decision.target_key,
    decision.verdict,
    decision.contact_id,
    decision.evidence_quote,
  ]);
  return {
    review_key: reviewKey,
    target_key: decision.target_key,
    target_kind: decision.target_kind,
    verdict: decision.verdict,
    current_contact: decision.current_contact,
    proposed_contact_id: decision.contact_id,
    proposed_contact_name: decision.contact_name,
    written_name: decision.written_name,
    confidence: decision.confidence,
    evidence_quote: decision.evidence_quote,
    reason: decision.reason || reason,
    gate_reason: reason,
    context: decision.context,
    task: decision.task,
  };
}

async function reconcileOneMeeting(user, intake, {
  reviewer = requestReview,
  updateTaskFn = updateTask,
  force = false,
} = {}) {
  const evidence = resolveSourceEvidence(user, 'meeting_intake', intake);
  if (!evidence) return { skipped: true, reason: 'source_not_canonical' };
  let packet = buildPacket(user, intake);
  const beforeHash = stateHash(packet);
  const prior = latestAttributionReceipt(user, intake.id, evidence.revision_hash);
  const priorPayload = parseJson(prior?.payload, {});
  if (!force && prior && prior.status !== 'error' && priorPayload.state_hash_after === beforeHash) {
    return { skipped: true, reason: 'unchanged', receipt_id: prior.id };
  }

  let review;
  try {
    review = await reviewer(user, packet);
  } catch (err) {
    const receiptId = writeReceipt(user, 'meeting_intake', intake.id, ATTRIBUTION_RECONCILIATION_STAGE, {
      status: 'error',
      summary: `Whole-transcript attribution review failed: ${err.message}`,
      payload: { error: err.message, state_hash_before: beforeHash },
      modelKey: 'attribution_reconciliation',
      sourceRevision: evidence.revision_hash,
      pipelineVersion: ATTRIBUTION_RECONCILIATION_VERSION,
    });
    return { processed: true, errors: 1, receipt_id: receiptId };
  }
  const parsed = review?.parsed || review || {};
  const modelId = review?.modelId || null;
  const normalized = (Array.isArray(parsed.decisions) ? parsed.decisions : [])
    .map(raw => normalizeDecision(raw, packet))
    .filter(Boolean);
  const applied = [];
  const reviews = [];
  const settledTargetKeys = new Set();
  const affectedTasks = new Map();
  for (const decision of normalized) {
    const gate = automaticDecision(decision, packet);
    if (!gate.automatic) {
      if (!['already_correct', 'target_already_linked', 'human_correction_is_authoritative'].includes(gate.reason)) {
        reviews.push(reviewItem(decision, gate.reason, intake));
      } else {
        settledTargetKeys.add(decision.target_key);
      }
      continue;
    }
    try {
      const result = applyDecision(user, intake.id, decision);
      applied.push({ ...result, decision });
      settledTargetKeys.add(decision.target_key);
      if (result.task_id) affectedTasks.set(result.task_id, result.outcome_id || null);
    } catch (err) {
      reviews.push(reviewItem(decision, `apply_failed:${err.message}`, intake));
    }
  }

  const taskUpdates = [];
  for (const [taskId, outcomeId] of affectedTasks) {
    try {
      const result = await reconcileTaskAssignee(user, taskId, { updateTaskFn, outcomeId });
      taskUpdates.push(result);
      if (result.review) {
        reviews.push({
          review_key: shortHash([ATTRIBUTION_RECONCILIATION_VERSION, intake.id, 'task', taskId, result.reason]),
          target_key: `task:${taskId}`,
          target_kind: 'task_owner_conflict',
          verdict: 'needs_review',
          current_contact: result.current_assignee ? { name: result.current_assignee } : null,
          proposed_contact_id: null,
          proposed_contact_name: null,
          written_name: result.current_assignee || 'Douglas/unassigned',
          confidence: 0,
          evidence_quote: '',
          reason: result.reason,
          gate_reason: result.reason,
          context: result.title,
          owners: result.owners || [],
          task: { id: taskId, title: result.title, current_assignee: result.current_assignee },
        });
      }
    } catch (err) {
      taskUpdates.push({ task_id: taskId, error: err.message });
      reviews.push({
        review_key: shortHash([ATTRIBUTION_RECONCILIATION_VERSION, intake.id, 'task_error', taskId]),
        target_key: `task:${taskId}`,
        target_kind: 'task_owner_conflict',
        verdict: 'needs_review',
        current_contact: null,
        proposed_contact_id: null,
        proposed_contact_name: null,
        written_name: null,
        confidence: 0,
        evidence_quote: '',
        reason: `task_correction_failed:${err.message}`,
        gate_reason: 'task_correction_failed',
        context: null,
        task: { id: taskId },
      });
    }
  }

  const humanTargetKeys = new Set(humanCorrectionsForSource(user, intake.id)
    .map(resolution => resolution?.target_key)
    .filter(Boolean));
  const currentTargetKeys = new Set(packet.targets.map(target => target.key));
  const currentTaskIds = new Set(packet.tasks.map(task => task.id));
  const newReviewTargets = new Set(reviews.map(item => item.target_key));
  for (const oldReview of priorPayload.reviews || []) {
    const targetStillExists = currentTargetKeys.has(oldReview.target_key)
      || (oldReview.target_key?.startsWith('task:') && currentTaskIds.has(oldReview.target_key.slice('task:'.length)));
    if (!targetStillExists
      || humanTargetKeys.has(oldReview.target_key)
      || settledTargetKeys.has(oldReview.target_key)
      || newReviewTargets.has(oldReview.target_key)) continue;
    reviews.push(oldReview);
    newReviewTargets.add(oldReview.target_key);
  }

  packet = buildPacket(user, db.hub().prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intake.id, user));
  const afterHash = stateHash(packet);
  const followUpRequired = applied.length > 0 || taskUpdates.some(item => item.updated);
  const status = reviews.length ? 'review' : 'done';
  const receiptId = writeReceipt(user, 'meeting_intake', intake.id, ATTRIBUTION_RECONCILIATION_STAGE, {
    status,
    summary: `${applied.length} attribution correction(s) applied; ${reviews.length} need review; ${taskUpdates.filter(item => item.updated).length} task assignee(s) repaired.`,
    payload: {
      decisions: normalized,
      applied,
      reviews,
      task_updates: taskUpdates,
      state_hash_before: beforeHash,
      state_hash_after: followUpRequired ? null : afterHash,
      applied_state_hash: afterHash,
      follow_up_required: followUpRequired,
    },
    modelKey: 'attribution_reconciliation',
    modelId,
    sourceRevision: evidence.revision_hash,
    pipelineVersion: ATTRIBUTION_RECONCILIATION_VERSION,
  });
  return {
    processed: true,
    applied: applied.length,
    reviews: reviews.length,
    task_updates: taskUpdates.filter(item => item.updated).length,
    follow_up_required: followUpRequired,
    receipt_id: receiptId,
  };
}

function candidateIntakes(user, { sourceId = null } = {}) {
  const sql = sourceId
    ? `SELECT * FROM meeting_intakes WHERE user = ? AND id = ? AND status = 'processed' AND TRIM(COALESCE(transcript,'')) != ''`
    : `SELECT * FROM meeting_intakes WHERE user = ? AND status = 'processed' AND TRIM(COALESCE(transcript,'')) != '' ORDER BY created_at DESC, id`;
  return sourceId ? db.hub().prepare(sql).all(user, sourceId) : db.hub().prepare(sql).all(user);
}

function needsReconciliation(user, intake) {
  const evidence = resolveSourceEvidence(user, 'meeting_intake', intake);
  if (!evidence) return false;
  const packet = buildPacket(user, intake);
  const receipt = latestAttributionReceipt(user, intake.id, evidence.revision_hash);
  if (!receipt || receipt.status === 'error') return true;
  return parseJson(receipt.payload, {}).state_hash_after !== stateHash(packet);
}

function pendingAttributionReconciliations(user) {
  return candidateIntakes(user).filter(intake => needsReconciliation(user, intake)).length;
}

async function runAttributionReconciliation(user = 'douglas', {
  limit = 1,
  sourceId = null,
  force = false,
  reviewer = requestReview,
  updateTaskFn = updateTask,
} = {}) {
  const result = { considered: 0, processed: 0, applied: 0, reviews: 0, task_updates: 0, errors: 0, remaining: 0 };
  for (const intake of candidateIntakes(user, { sourceId })) {
    if (result.processed >= Math.max(1, Number(limit) || 1)) break;
    if (!force && !needsReconciliation(user, intake)) continue;
    result.considered += 1;
    const one = await reconcileOneMeeting(user, intake, { reviewer, updateTaskFn, force });
    if (one.processed) result.processed += 1;
    result.applied += Number(one.applied || 0);
    result.reviews += Number(one.reviews || 0);
    result.task_updates += Number(one.task_updates || 0);
    result.errors += Number(one.errors || 0);
  }
  result.remaining = sourceId ? 0 : pendingAttributionReconciliations(user);
  return result;
}

function latestReviewItem(user, intakeId, reviewKey) {
  const rows = db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'meeting_intake' AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC
  `).all(user, intakeId, ATTRIBUTION_RECONCILIATION_STAGE);
  for (const row of rows) {
    const payload = parseJson(row.payload, {});
    const item = (payload.reviews || []).find(review => review.review_key === reviewKey);
    if (item) return { receipt: row, item };
  }
  return null;
}

async function applyReviewedAttribution(user, {
  intakeId,
  reviewKey,
  contactId = null,
  updateTaskFn = updateTask,
} = {}) {
  const found = latestReviewItem(user, intakeId, reviewKey);
  if (!found) throw new Error('Attribution review item not found');
  const contact = contactId
    ? db.hub().prepare('SELECT id, name FROM contacts WHERE id = ? AND user = ?').get(contactId, user)
    : null;
  const item = found.item;
  if (item.target_kind === 'task_owner_conflict') {
    if (!contact) throw new Error('Choose the person who owns this task');
    const rows = db.hub().prepare('SELECT * FROM crm_action_outcomes WHERE user = ? AND task_id = ?').all(user, item.task?.id);
    if (!rows.length) throw new Error('The task no longer has an action outbox row');
    for (const row of rows) {
      const payload = parseJson(row.payload, {});
      payload.action = { ...(payload.action || {}), owner: contact.name, person: contact.name };
      payload.attribution_reconciliation = {
        version: ATTRIBUTION_RECONCILIATION_VERSION,
        applied_at: now(),
        verdict: 'human_owner_resolution',
        contact_id: contact.id,
        reason: 'Confirmed on /crm/questions',
      };
      db.hub().prepare('UPDATE crm_action_outcomes SET payload = ?, updated_at = unixepoch() WHERE id = ?')
        .run(JSON.stringify(payload), row.id);
    }
    const taskResult = await reconcileTaskAssignee(user, item.task.id, { updateTaskFn, outcomeId: rows[0]?.id });
    writeReceipt(user, 'meeting_intake', intakeId, 'attribution_correction', {
      status: 'done',
      summary: `Human confirmed ${contact.name} as owner of ${item.task?.title || 'the linked task'}.`,
      payload: {
        review_key: reviewKey,
        decision: { target_key: item.target_key, verdict: 'human_owner_resolution', contact_id: contact.id, contact_name: contact.name },
        task_update: taskResult,
        derived_by: 'human_correction',
      },
      modelKey: 'attribution_reconciliation',
      sourceRevision: parseJson(found.receipt.payload, {}).source_revision || null,
      pipelineVersion: ATTRIBUTION_RECONCILIATION_VERSION,
    });
    return { item, contact, taskResult, applied: { target_key: item.target_key, human: true } };
  }
  if (item.verdict === 'needs_review' && !contact && !item.proposed_contact_id) {
    throw new Error('Choose the correct person, or keep the current attribution');
  }
  const decision = {
    target_key: item.target_key,
    target_kind: item.target_kind,
    verdict: contact ? (item.current_contact ? 'correct_link' : 'link_missing') : item.verdict,
    contact_id: contact?.id || item.proposed_contact_id || null,
    contact_name: contact?.name || item.proposed_contact_name || null,
    confidence: 1,
    evidence_quote: item.evidence_quote || '',
    reason: 'Confirmed on /crm/questions',
    current_contact: item.current_contact || null,
    written_name: item.written_name || null,
  };
  if (['link_missing', 'correct_link'].includes(decision.verdict) && !decision.contact_id) {
    throw new Error('Choose the correct person');
  }
  const applied = applyDecision(user, intakeId, decision);
  let taskResult = null;
  if (applied.task_id) {
    taskResult = await reconcileTaskAssignee(user, applied.task_id, { updateTaskFn, outcomeId: applied.outcome_id });
  }
  writeReceipt(user, 'meeting_intake', intakeId, 'attribution_correction', {
    status: 'done',
    summary: `Human confirmed attribution correction for ${item.target_key}.`,
    payload: { review_key: reviewKey, decision, applied, task_update: taskResult, derived_by: 'human_correction' },
    modelKey: 'attribution_reconciliation',
    sourceRevision: parseJson(found.receipt.payload, {}).source_revision || null,
    pipelineVersion: ATTRIBUTION_RECONCILIATION_VERSION,
  });
  return { item, contact, applied, taskResult };
}

module.exports = {
  ATTRIBUTION_RECONCILIATION_VERSION,
  ATTRIBUTION_RECONCILIATION_STAGE,
  AUTO_LINK_CONFIDENCE,
  AUTO_CORRECT_CONFIDENCE,
  applyReviewedAttribution,
  buildPacket,
  evidenceIsExact,
  extractionTargetKey,
  latestReviewItem,
  needsReconciliation,
  pendingAttributionReconciliations,
  reconcileOneMeeting,
  reconcileTaskAssignee,
  runAttributionReconciliation,
  stateHash,
  _test: {
    applyDecision,
    automaticDecision,
    buildTargets,
    normalizeDecision,
    requestReview,
    reviewPrompt,
    speakerForEvidence,
  },
};
