'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  runAttributionReconciliation,
  evidenceIsExact,
  isAskableAttributionReview,
  reconcileTaskAssignee,
  settleOpenAttributionReviews,
  _test,
} = require('../lib/attribution-reconciliation');
const { withTaskTags, parseTaskTags } = require('../lib/google-tasks');
const { answerAttributionCorrection, openClarifications } = require('../lib/crm-clarifications');

const USER = '__test_attribution_reconciliation';
const REVIEW_USER = '__test_attribution_review';
const CLEAR_USER = '__test_attribution_clear_owner';
const STICKY_USER = '__test_attribution_sticky_review';
const FACT_USER = '__test_attribution_fact_unlink';
const SELF_USER = '__test_attribution_self_fact';
const SETTLE_USER = '__test_attribution_settle';

function cleanupUser(user) {
  const hub = db.hub();
  hub.prepare('DELETE FROM crm_clarification_answers WHERE user = ?').run(user);
  hub.prepare('DELETE FROM knowledge_receipts WHERE user = ?').run(user);
  hub.prepare('DELETE FROM crm_action_outcomes WHERE user = ?').run(user);
  hub.prepare('DELETE FROM google_tasks WHERE user = ?').run(user);
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(user);
  hub.prepare('DELETE FROM meeting_intakes WHERE user = ?').run(user);
  hub.prepare('DELETE FROM contacts WHERE user = ?').run(user);
}

function addContact(user, id, name) {
  db.hub().prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run(id, user, name, '[]');
}

function seedFullPath() {
  const hub = db.hub();
  addContact(USER, 'attr-duncan', 'Duncan Sackfield');
  addContact(USER, 'attr-nick', 'Nick Chin');
  const transcript = [
    'Duncan | 00:01',
    'Nick will handle the imports.',
    'Nick | 00:10',
    'I will send the HLD today.',
  ].join('\n');
  const action = {
    owner: 'Duncan Sackfield', matched_contact: 'Duncan Sackfield', owner_type: 'known_person',
    task: 'Send the HLD today', detail: 'The draft is ready.', project_slug: 'test-project',
  };
  hub.prepare(`
    INSERT INTO meeting_intakes (id, user, title, transcript, extraction, status, created_at)
    VALUES ('attr-intake', ?, 'Attribution test', ?, ?, 'processed', unixepoch())
  `).run(USER, transcript, JSON.stringify({
    meeting: { attendees: [{ name: 'Duncan', matched_contact: 'Duncan Sackfield' }, { name: 'Nick', matched_contact: 'Duncan Sackfield' }] },
    action_register: [action],
    crm_updates: [{ subject: 'Duncan Sackfield', matched_contact: 'Duncan Sackfield', type: 'action', text: 'Will send the HLD today.' }],
  }));
  hub.prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, title, notes, status, source, source_id)
    VALUES ('attr-task', ?, 'attr-google-task', 'Send the HLD today', ?, 'needsAction', 'crm-engine', 'crm-action:attr-key')
  `).run(USER, withTaskTags('Evidence: I will send the HLD today.', { assignee: 'Duncan Sackfield' }));
  hub.prepare(`
    INSERT INTO crm_action_outcomes
      (id,user,source_kind,source_id,source_revision,pipeline_version,action_key,candidate_title,evidence_text,
       disposition,reason,task_id,payload)
    VALUES ('attr-outcome',?,'meeting_intake','attr-intake','test-revision','crm-evidence-actions-v2','attr-key',
      'Send the HLD today','I will send the HLD today.','task_created','task_created','attr-task',?)
  `).run(USER, JSON.stringify({
    action: { title: 'Send the HLD today', owner: 'Duncan Sackfield', person: 'Duncan Sackfield', evidence: 'I will send the HLD today.' },
    candidate: { candidate_key: 'attr-key', owner: 'Duncan Sackfield' },
  }));
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id,user,subject_kind,subject_id,subject_label,predicate,value,source_refs,confidence,status,derived_by)
    VALUES ('attr-atom',?,'contact','attr-duncan','Duncan Sackfield','open_commitment',
      'Duncan Sackfield owns: Send the HLD today.','[{"kind":"meeting_intake","id":"attr-intake"}]',0.95,'active','test')
  `).run(USER);
}

test.before(() => {
  cleanupUser(USER);
  cleanupUser(REVIEW_USER);
  cleanupUser(CLEAR_USER);
  cleanupUser(STICKY_USER);
  cleanupUser(FACT_USER);
  cleanupUser(SELF_USER);
  cleanupUser(SETTLE_USER);
  seedFullPath();
});

test.after(() => {
  cleanupUser(USER);
  cleanupUser(REVIEW_USER);
  cleanupUser(CLEAR_USER);
  cleanupUser(STICKY_USER);
  cleanupUser(FACT_USER);
  cleanupUser(SELF_USER);
  cleanupUser(SETTLE_USER);
});

test('whole-source reconciliation repairs extraction, atoms, outcomes and the existing task once', async () => {
  let calls = 0;
  const reviewer = async (_user, packet) => {
    calls += 1;
    const decisions = packet.targets
      .filter(target => ['action_owner', 'projected_action_owner', 'fact_subject'].includes(target.kind))
      .map(target => ({
        target_key: target.key,
        verdict: 'correct_link',
        contact_id: 'attr-nick',
        confidence: 0.999,
        evidence_quote: 'I will send the HLD today.',
        reason: 'Nick speaks the commitment in his own turn.',
      }));
    return { parsed: { decisions }, modelId: 'codex/gpt-5.6-terra' };
  };
  const fakeUpdateTask = async (user, taskId, fields) => {
    db.hub().prepare('UPDATE google_tasks SET notes = ?, synced_at = unixepoch() WHERE id = ? AND user = ?')
      .run(fields.notes, taskId, user);
  };

  const first = await runAttributionReconciliation(USER, { limit: 1, reviewer, updateTaskFn: fakeUpdateTask });
  assert.equal(first.processed, 1);
  assert.ok(first.applied >= 4);
  assert.equal(first.task_updates, 1);
  assert.equal(calls, 1);

  const extraction = JSON.parse(db.hub().prepare('SELECT extraction FROM meeting_intakes WHERE id = ?').get('attr-intake').extraction);
  assert.equal(extraction.action_register[0].owner, 'Nick Chin');
  assert.equal(extraction.action_register[0].matched_contact, 'Nick Chin');
  assert.equal(extraction.crm_updates[0].subject, 'Nick Chin');
  assert.equal(extraction.crm_updates[0].matched_contact, 'Nick Chin');
  const atom = db.hub().prepare('SELECT subject_id, subject_label, value FROM knowledge_atoms WHERE id = ?').get('attr-atom');
  assert.equal(atom.subject_id, 'attr-nick');
  assert.equal(atom.subject_label, 'Nick Chin');
  assert.match(atom.value, /^Nick Chin owns:/);
  const outcome = JSON.parse(db.hub().prepare('SELECT payload FROM crm_action_outcomes WHERE id = ?').get('attr-outcome').payload);
  assert.equal(outcome.action.owner, 'Nick Chin');
  assert.equal(outcome.attribution_task_correction.state, 'applied');
  const task = db.hub().prepare('SELECT notes FROM google_tasks WHERE id = ?').get('attr-task');
  assert.equal(parseTaskTags(task.notes).assignee, 'Nick Chin');

  const second = await runAttributionReconciliation(USER, { limit: 1, reviewer, updateTaskFn: fakeUpdateTask });
  assert.equal(second.processed, 1, 'a mutating pass gets one stabilization reread for related compiled copies');
  assert.equal(second.applied, 0);
  const third = await runAttributionReconciliation(USER, { limit: 1, reviewer, updateTaskFn: fakeUpdateTask });
  assert.equal(third.processed, 0, 'stable derived state does not spend another model call');
  assert.equal(calls, 2);
});

test('non-exact or lower-confidence corrections surface for confirmation and stick without learning an alias', async () => {
  const hub = db.hub();
  addContact(REVIEW_USER, 'review-duncan', 'Duncan Sackfield');
  addContact(REVIEW_USER, 'review-nick', 'Nick Chin');
  hub.prepare(`
    INSERT INTO meeting_intakes (id,user,title,transcript,extraction,status,created_at)
    VALUES ('review-intake',?,'Review meeting','Nick | 00:01\nI will send it.',?,'processed',unixepoch())
  `).run(REVIEW_USER, JSON.stringify({
    meeting: { attendees: [{ name: 'Nick', matched_contact: null }] },
    action_register: [{ owner: 'Duncan Sackfield', matched_contact: 'Duncan Sackfield', owner_type: 'known_person', task: 'Send it' }],
    crm_updates: [],
  }));
  const reviewer = async (_user, packet) => ({
    parsed: { decisions: [{
      target_key: packet.targets.find(target => target.kind === 'action_owner').key,
      verdict: 'correct_link', contact_id: 'review-nick', confidence: 0.99,
      evidence_quote: 'I will send it.', reason: 'Nick owns the action.',
    }] },
    modelId: 'codex/gpt-5.6-terra',
  });
  const run = await runAttributionReconciliation(REVIEW_USER, { limit: 1, reviewer });
  assert.equal(run.applied, 0);
  assert.equal(run.reviews, 1);
  const item = openClarifications(REVIEW_USER).find(row => row.kind === 'attribution_correction');
  assert.ok(item);
  await answerAttributionCorrection(REVIEW_USER, {
    key: item.key,
    intakeId: item.intake_id,
    reviewKey: item.review_key,
    question: item.question,
    contactId: 'review-nick',
  });
  const extraction = JSON.parse(hub.prepare('SELECT extraction FROM meeting_intakes WHERE id = ?').get('review-intake').extraction);
  assert.equal(extraction.action_register[0].owner, 'Nick Chin');
  assert.equal(openClarifications(REVIEW_USER).some(row => row.key === item.key), false);
  assert.equal(hub.prepare('SELECT aliases FROM contacts WHERE id = ?').get('review-nick').aliases, '[]');
});

test('evidence verification requires a real transcript quotation', () => {
  assert.equal(evidenceIsExact('Nick | 00:01\nI will send it today.', 'I will send it today.'), true);
  assert.equal(evidenceIsExact('Nick | 00:01\nI will send it today.', 'Nick promised to send it today.'), false);
});

test('missing fact links distinguish the subject from the person speaking', () => {
  const packet = {
    intake: { transcript: 'Nick | 00:01\nAlec is away traveling in Europe.\nNeil | 00:10\nI had physio last night.' },
    contacts: [
      { id: 'nick', name: 'Nick Chin', aliases: '[]', scheduled_attendee: true },
      { id: 'alec', name: 'Alec Hirst', aliases: '[]', scheduled_attendee: false },
      { id: 'neil', name: 'Neil Midlane', aliases: '["Neil"]', scheduled_attendee: true },
    ],
    targets: [
      { key: 'atom:away', kind: 'fact_subject' },
      { key: 'atom:physio', kind: 'fact_subject' },
    ],
  };
  const wrongSpeakerLink = _test.automaticDecision({
    target_key: 'atom:away', target_kind: 'fact_subject', verdict: 'link_missing',
    contact_id: 'nick', confidence: 0.999, evidence_quote: 'Alec is away traveling in Europe.',
    context: 'fact: Alec is away traveling in Europe.', current_contact: null,
  }, packet);
  assert.deepEqual(wrongSpeakerLink, { automatic: false, reason: 'fact_text_names_a_different_person' });

  const selfFact = _test.automaticDecision({
    target_key: 'atom:physio', target_kind: 'fact_subject', verdict: 'link_missing',
    contact_id: 'neil', confidence: 0.999, evidence_quote: 'I had physio last night.',
    context: 'fact: Attended physio last night.', current_contact: null,
  }, packet);
  assert.deepEqual(selfFact, { automatic: true });
});

test('removing the only owner claim clears a stale open-task assignee', async () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, title, notes, status, source, source_id)
    VALUES ('clear-task', ?, 'clear-google-task', 'Clarify owner', ?, 'needsAction', 'crm-engine', 'crm-action:clear-key')
  `).run(CLEAR_USER, withTaskTags('Evidence is ambiguous.', { assignee: 'Wrong Person' }));
  hub.prepare(`
    INSERT INTO crm_action_outcomes
      (id,user,source_kind,source_id,source_revision,pipeline_version,action_key,candidate_title,evidence_text,
       disposition,reason,task_id,payload)
    VALUES ('clear-outcome',?,'meeting_intake','clear-intake','test-revision','crm-evidence-actions-v2','clear-key',
      'Clarify owner','Evidence is ambiguous.','task_created','task_created','clear-task',?)
  `).run(CLEAR_USER, JSON.stringify({ action: { title: 'Clarify owner', owner: null, person: null } }));
  const fakeUpdateTask = async (user, taskId, fields) => {
    hub.prepare('UPDATE google_tasks SET notes = ? WHERE id = ? AND user = ?').run(fields.notes, taskId, user);
  };

  const result = await reconcileTaskAssignee(CLEAR_USER, 'clear-task', {
    updateTaskFn: fakeUpdateTask,
    outcomeId: 'clear-outcome',
  });
  assert.equal(result.updated, true);
  assert.equal(result.assignee, null);
  assert.equal(parseTaskTags(hub.prepare('SELECT notes FROM google_tasks WHERE id = ?').get('clear-task').notes).assignee, null);
});

test('unlinking an atom removes only the bad meeting provenance when other evidence exists', () => {
  const hub = db.hub();
  addContact(CLEAR_USER, 'mixed-contact', 'Mixed Contact');
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id,user,subject_kind,subject_id,subject_label,predicate,value,source_refs,confidence,status,derived_by)
    VALUES ('mixed-atom',?,'contact','mixed-contact','Mixed Contact','fact','Mixed evidence',?,0.8,'active','test')
  `).run(CLEAR_USER, JSON.stringify([
    { kind: 'meeting_intake', id: 'bad-meeting' },
    { kind: 'document', id: 'good-document' },
  ]));
  const result = _test.applyDecision(CLEAR_USER, 'bad-meeting', {
    target_key: 'atom:mixed-atom', verdict: 'remove_link', contact_id: null, contact_name: null,
  });
  assert.equal(result.after.meeting_provenance_removed, true);
  const atom = hub.prepare('SELECT subject_kind, subject_id, source_refs FROM knowledge_atoms WHERE id = ?').get('mixed-atom');
  assert.equal(atom.subject_kind, 'contact');
  assert.equal(atom.subject_id, 'mixed-contact');
  assert.deepEqual(JSON.parse(atom.source_refs), [{ kind: 'document', id: 'good-document' }]);
});

test('a stabilization pass cannot silently drop an unresolved review', async () => {
  const hub = db.hub();
  addContact(STICKY_USER, 'sticky-nick', 'Nick Chin');
  hub.prepare('UPDATE contacts SET aliases = ? WHERE id = ?').run('["Nick"]', 'sticky-nick');
  hub.prepare(`
    INSERT INTO meeting_intakes (id,user,title,transcript,extraction,status,created_at)
    VALUES ('sticky-intake',?,'Sticky review','Nick | 00:01\nI will send it.\nNick will send it.',?,'processed',unixepoch())
  `).run(STICKY_USER, JSON.stringify({
    meeting: { attendees: [{ name: 'Nick', matched_contact: null }] },
    action_register: [{ owner: 'Nick', matched_contact: null, owner_type: 'unknown_speaker', task: 'Send it' }],
    crm_updates: [],
  }));
  let calls = 0;
  const reviewer = async (_user, packet) => {
    calls += 1;
    if (calls > 1) return { parsed: { decisions: [] }, modelId: 'codex/gpt-5.6-terra' };
    return {
      parsed: { decisions: [
        {
          target_key: packet.targets.find(target => target.kind === 'action_owner').key,
          verdict: 'link_missing', contact_id: 'sticky-nick', confidence: 0.99,
          evidence_quote: 'I will send it.', reason: 'Nick owns this action.',
        },
        {
          target_key: packet.targets.find(target => target.kind === 'attendee').key,
          verdict: 'needs_review', contact_id: null, confidence: 0.8,
          evidence_quote: 'Nick will send it.', reason: 'Attendance is unclear.',
        },
      ] },
      modelId: 'codex/gpt-5.6-terra',
    };
  };

  const first = await runAttributionReconciliation(STICKY_USER, { reviewer });
  assert.equal(first.applied, 1);
  assert.equal(first.reviews, 1);
  const second = await runAttributionReconciliation(STICKY_USER, { reviewer });
  assert.equal(second.processed, 1);
  assert.equal(second.reviews, 1, 'the prior unresolved review remains even when the second response omits it');
  const third = await runAttributionReconciliation(STICKY_USER, { reviewer });
  assert.equal(third.processed, 0);
  assert.equal(openClarifications(STICKY_USER).filter(item => item.kind === 'attribution_correction').length, 1);
});

test('organisational fact unlinks auto-apply and never become questions', async () => {
  const hub = db.hub();
  addContact(FACT_USER, 'fact-douglas', 'Douglas McLellan');
  const transcript = ['Douglas McLellan | 00:01', 'We do not have a retention policy.'].join('\n');
  hub.prepare(`
    INSERT INTO meeting_intakes (id,user,title,transcript,extraction,status,created_at)
    VALUES ('fact-intake',?,'Policy meeting',?,?,'processed',unixepoch())
  `).run(FACT_USER, transcript, JSON.stringify({
    meeting: { attendees: [{ name: 'Douglas McLellan', matched_contact: 'Douglas McLellan' }] },
    action_register: [],
    crm_updates: [{ subject: 'Douglas McLellan', matched_contact: 'Douglas McLellan', type: 'fact', text: 'The organisation does not have a retention policy.' }],
  }));
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id,user,subject_kind,subject_id,subject_label,predicate,value,source_refs,confidence,status,derived_by)
    VALUES ('fact-atom',?,'contact','fact-douglas','Douglas McLellan','fact',
      'The organisation does not currently have a clear data retention policy.',
      '[{"kind":"meeting_intake","id":"fact-intake"}]',0.9,'active','test')
  `).run(FACT_USER);

  const reviewer = async (_user, packet) => ({
    parsed: {
      decisions: packet.targets.filter(target => target.kind === 'fact_subject').map(target => ({
        target_key: target.key,
        verdict: 'remove_link',
        contact_id: null,
        confidence: 0.995,
        evidence_quote: 'We do not have a retention policy.',
        reason: 'This is an organisational fact, not a personal fact about Douglas.',
      })),
    },
    modelId: 'codex/gpt-5.6-terra',
  });

  const run = await runAttributionReconciliation(FACT_USER, { reviewer });
  assert.ok(run.applied >= 1);
  assert.equal(run.reviews, 0);
  assert.equal(openClarifications(FACT_USER).filter(item => item.kind === 'attribution_correction').length, 0);
  const atom = hub.prepare('SELECT subject_kind, subject_id FROM knowledge_atoms WHERE id = ?').get('fact-atom');
  assert.equal(atom.subject_kind, 'unresolved_person');
  assert.equal(atom.subject_id, null);
});

test('first-person self facts are not unlinked or asked', async () => {
  const hub = db.hub();
  addContact(SELF_USER, 'self-douglas', 'Douglas McLellan');
  const transcript = ['Douglas McLellan | 00:01', 'they are sitting in my OneDrive and the SharePoint.'].join('\n');
  hub.prepare(`
    INSERT INTO meeting_intakes (id,user,title,transcript,extraction,status,created_at)
    VALUES ('self-intake',?,'Drive meeting',?,?,'processed',unixepoch())
  `).run(SELF_USER, transcript, JSON.stringify({
    meeting: { attendees: [{ name: 'Douglas McLellan', matched_contact: 'Douglas McLellan' }] },
    action_register: [],
    crm_updates: [],
  }));
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id,user,subject_kind,subject_id,subject_label,predicate,value,source_refs,confidence,status,derived_by)
    VALUES ('self-atom',?,'contact','self-douglas','Douglas McLellan','fact',
      'Files sitting in my OneDrive would raise the record count.',
      '[{"kind":"meeting_intake","id":"self-intake"}]',0.9,'active','test')
  `).run(SELF_USER);

  const reviewer = async (_user, packet) => ({
    parsed: {
      decisions: packet.targets.filter(target => target.kind === 'fact_subject').map(target => ({
        target_key: target.key,
        verdict: 'remove_link',
        contact_id: null,
        confidence: 0.998,
        evidence_quote: 'they are sitting in my OneDrive and the SharePoint.',
        reason: 'The claim concerns record count, not Douglas as subject.',
      })),
    },
    modelId: 'codex/gpt-5.6-terra',
  });

  const run = await runAttributionReconciliation(SELF_USER, { reviewer });
  assert.equal(run.applied, 0);
  assert.equal(run.reviews, 0);
  assert.equal(openClarifications(SELF_USER).filter(item => item.kind === 'attribution_correction').length, 0);
  const atom = hub.prepare('SELECT subject_kind, subject_id FROM knowledge_atoms WHERE id = ?').get('self-atom');
  assert.equal(atom.subject_kind, 'contact');
  assert.equal(atom.subject_id, 'self-douglas');
});

test('only person-decidable attribution reviews are askable', () => {
  assert.equal(isAskableAttributionReview({
    target_kind: 'fact_subject', verdict: 'remove_link', gate_reason: 'destructive_unlink_requires_review',
    current_contact: { name: 'Douglas McLellan' },
  }), false);
  assert.equal(isAskableAttributionReview({
    target_kind: 'fact_subject', verdict: 'correct_link',
    current_contact: { name: 'Ken Murray' }, proposed_contact_name: 'Alan Garland',
  }), false);
  assert.equal(isAskableAttributionReview({
    target_kind: 'action_owner', verdict: 'correct_link',
    current_contact: { name: 'Nicola Wolfe' }, proposed_contact_name: 'Douglas McLellan',
  }), true);
  assert.equal(isAskableAttributionReview({
    target_kind: 'attendee', verdict: 'not_participant', gate_reason: 'scheduled_attendee_requires_review',
    written_name: 'Alister McLellan',
  }), true);
  assert.equal(isAskableAttributionReview({
    target_kind: 'attendee', verdict: 'remove_link', gate_reason: 'destructive_unlink_requires_review',
    current_contact: { name: 'Douglas McLellan' },
  }), false);
  assert.equal(isAskableAttributionReview({
    target_kind: 'attendee', verdict: 'needs_review', gate_reason: 'model_requested_review',
    written_name: 'Speaker_1',
  }), false);
  assert.equal(isAskableAttributionReview({
    target_kind: 'projected_action_owner', verdict: 'needs_review', gate_reason: 'model_requested_review',
    current_contact: { name: 'Nicola Wolfe' }, written_name: 'Nicola',
  }), false);
  assert.equal(isAskableAttributionReview({
    target_kind: 'task_owner_conflict', verdict: 'needs_review',
    gate_reason: 'linked_action_outcomes_disagree_on_owner',
  }), true);
});

test('settling stored reviews applies organisational unlinks and drops the rest', async () => {
  const hub = db.hub();
  const { writeReceipt } = require('../lib/crm-receipts');
  addContact(SETTLE_USER, 'settle-douglas', 'Douglas McLellan');
  addContact(SETTLE_USER, 'settle-nick', 'Nick Chin');
  const transcript = ['Douglas McLellan | 00:01', 'We do not have a retention policy.', 'Nick | 00:10', 'I will send it.'].join('\n');
  hub.prepare(`
    INSERT INTO meeting_intakes (id,user,title,transcript,extraction,status,created_at)
    VALUES ('settle-intake',?,'Settle meeting',?,?,'processed',unixepoch())
  `).run(SETTLE_USER, transcript, JSON.stringify({
    meeting: { attendees: [{ name: 'Nick', matched_contact: 'Duncan Sackfield' }] },
    action_register: [{ owner: 'Duncan Sackfield', matched_contact: 'Duncan Sackfield', owner_type: 'known_person', task: 'Send it' }],
    crm_updates: [],
  }));
  hub.prepare(`
    INSERT INTO knowledge_atoms
      (id,user,subject_kind,subject_id,subject_label,predicate,value,source_refs,confidence,status,derived_by)
    VALUES ('settle-atom',?,'contact','settle-douglas','Douglas McLellan','fact',
      'The organisation does not currently have a clear data retention policy.',
      '[{"kind":"meeting_intake","id":"settle-intake"}]',0.9,'active','test')
  `).run(SETTLE_USER);

  const packet = require('../lib/attribution-reconciliation').buildPacket(SETTLE_USER,
    hub.prepare('SELECT * FROM meeting_intakes WHERE id = ?').get('settle-intake'));
  const factTarget = packet.targets.find(target => target.key === 'atom:settle-atom');
  const actionTarget = packet.targets.find(target => target.kind === 'action_owner');
  writeReceipt(SETTLE_USER, 'meeting_intake', 'settle-intake', 'attribution_reconciliation', {
    status: 'review',
    summary: '0 attribution correction(s) applied; 2 need review; 0 task assignee(s) repaired.',
    payload: {
      reviews: [
        {
          review_key: 'fact-unlink',
          target_key: factTarget.key,
          target_kind: 'fact_subject',
          verdict: 'remove_link',
          current_contact: { id: 'settle-douglas', name: 'Douglas McLellan' },
          proposed_contact_id: null,
          proposed_contact_name: null,
          written_name: 'Douglas McLellan',
          confidence: 0.995,
          evidence_quote: 'We do not have a retention policy.',
          reason: 'Organisational fact.',
          gate_reason: 'destructive_unlink_requires_review',
          context: factTarget.context,
        },
        {
          review_key: 'junk-fact',
          target_key: factTarget.key,
          target_kind: 'fact_subject',
          verdict: 'needs_review',
          current_contact: { id: 'settle-douglas', name: 'Douglas McLellan' },
          proposed_contact_id: null,
          proposed_contact_name: null,
          written_name: 'Douglas McLellan',
          confidence: 0.82,
          evidence_quote: 'We do not have a retention policy.',
          reason: 'Unsure.',
          gate_reason: 'model_requested_review',
          context: factTarget.context,
        },
        {
          review_key: 'person-swap',
          target_key: actionTarget.key,
          target_kind: 'action_owner',
          verdict: 'correct_link',
          current_contact: actionTarget.current_contact,
          proposed_contact_id: 'settle-nick',
          proposed_contact_name: 'Nick Chin',
          written_name: 'Duncan Sackfield',
          confidence: 0.99,
          evidence_quote: 'I will send it.',
          reason: 'Nick owns the action.',
          gate_reason: 'below_auto_correct_confidence',
          context: actionTarget.context,
        },
      ],
      state_hash_after: 'stale',
    },
    modelKey: 'attribution_reconciliation',
    pipelineVersion: 'meeting-attribution-reconciliation-v1',
  });

  assert.ok(openClarifications(SETTLE_USER).some(item => item.kind === 'attribution_correction' && item.review_key === 'person-swap'));
  assert.equal(openClarifications(SETTLE_USER).some(item => item.review_key === 'junk-fact'), false);

  const dry = await settleOpenAttributionReviews(SETTLE_USER, { apply: false });
  assert.equal(dry.applied, 1);
  assert.equal(dry.kept, 1);
  assert.ok(dry.dropped >= 1);

  const applied = await settleOpenAttributionReviews(SETTLE_USER, { apply: true });
  assert.equal(applied.applied, 1);
  assert.equal(applied.kept, 1);
  const atom = hub.prepare('SELECT subject_kind FROM knowledge_atoms WHERE id = ?').get('settle-atom');
  assert.equal(atom.subject_kind, 'unresolved_person');
  const remaining = openClarifications(SETTLE_USER).filter(item => item.kind === 'attribution_correction');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].proposed_contact_name, 'Nick Chin');
});
