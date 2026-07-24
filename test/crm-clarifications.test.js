'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  answerMeetingQuestion,
  answerPersonAlias,
  answerTaskOwner,
  answeredKeys,
  clarificationKey,
  openClarifications,
} = require('../lib/crm-clarifications');
const {
  buildCrmPeopleQualityReview,
  buildMeetingIntakeQualityReview,
  buildTaskActionQualityReview,
  crmContacts,
  crmProjectEvidence,
  crmTasks,
  recentMeetingIntakes,
} = require('../lib/hub-quality-board');

const USER = '__test_clarifications';
const INTAKE = '__test_intake_1';
const PROJECT = '__test_project_1';
const QUESTION = 'What is the exact mailbox size limit for E3 licenses (50GB or 100GB)?';
const ACTION = 'Send HLD draft for review by end of day.';

function cleanup() {
  const hub = db.hub();
  for (const sql of [
    'DELETE FROM crm_clarification_answers WHERE user = ?',
    'DELETE FROM knowledge_atoms WHERE user = ?',
    'DELETE FROM meeting_intakes WHERE user = ?',
    'DELETE FROM projects WHERE user = ?',
  ]) hub.prepare(sql).run(USER);
  hub.prepare('DELETE FROM contact_projects WHERE contact_id IN (SELECT id FROM contacts WHERE user = ?)').run(USER);
  hub.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
}

function seed() {
  const hub = db.hub();
  const nowTs = Math.floor(Date.now() / 1000);
  hub.prepare('INSERT INTO projects (id, user, slug, name) VALUES (?, ?, ?, ?)')
    .run(PROJECT, USER, '__test-m365', 'Test M365 Rollout');
  hub.prepare(`
    INSERT INTO meeting_intakes (id, user, project_slug, title, transcript, extraction, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'processed', ?)
  `).run(INTAKE, USER, '__test-m365', 'Test migration call', 'transcript', JSON.stringify({
    open_questions: [QUESTION],
    action_register: [
      { owner: 'Nick', owner_type: 'unknown_speaker', task: ACTION },
      { owner: 'Nick', owner_type: 'unknown_speaker', task: 'Chase Microsoft for the licensing agreement.' },
    ],
  }), nowTs);

  // Two people sharing an alias on the same project — the alias-overlap flag.
  hub.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run('__test_c_a', USER, 'Alister Test', JSON.stringify(['Dad', 'Iain']));
  hub.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run('__test_c_b', USER, 'Iain Testerson', JSON.stringify(['Iain']));
  for (const id of ['__test_c_a', '__test_c_b']) {
    hub.prepare('INSERT INTO contact_projects (contact_id, project_id) VALUES (?, ?)').run(id, PROJECT);
  }
}

function boards() {
  const intakes = recentMeetingIntakes(USER);
  const contacts = crmContacts(USER);
  const tasks = crmTasks(USER);
  const projectEvidence = crmProjectEvidence(USER);
  const answered = answeredKeys(USER);
  return {
    meeting: buildMeetingIntakeQualityReview({ intakes, contacts, answered }),
    tasksBoard: buildTaskActionQualityReview({ tasks, intakes, contacts, answered }),
    people: buildCrmPeopleQualityReview({ contacts, projectEvidence, answered }),
  };
}

test.before(() => { cleanup(); seed(); });
test.after(cleanup);

test('a flagged item keeps the same key across runs, so an answer stays answered', () => {
  const first = openClarifications(USER);
  const second = openClarifications(USER);
  assert.deepEqual(first.map(i => i.key), second.map(i => i.key));
  const question = first.find(i => i.question === QUESTION);
  assert.ok(question, 'the meeting open question must be answerable');
  assert.equal(question.key, clarificationKey({ ...question, kind: 'meeting_question' }));
});

test('answering a meeting question writes knowledge and stops the nightly flag', async () => {
  assert.ok(boards().meeting.clarification_requests.some(c => c.evidence === QUESTION));

  const item = openClarifications(USER).find(i => i.question === QUESTION);
  const { atomId, statement } = await answerMeetingQuestion(USER, {
    key: item.key, intakeId: INTAKE, question: QUESTION,
    answer: 'Everyone gets 100GB, not 50GB.',
    projectSlug: '__test-m365', meetingTitle: 'Test migration call',
  });

  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(atomId);
  assert.equal(atom.subject_kind, 'project');
  assert.equal(atom.subject_label, 'Test M365 Rollout');
  assert.equal(atom.derived_by, 'manual');
  assert.equal(atom.confidence, 1);
  assert.match(atom.value, /100GB/);
  assert.match(statement, /100GB/);
  assert.match(atom.source_refs, new RegExp(INTAKE), 'the atom must carry provenance to the intake');

  assert.equal(boards().meeting.clarification_requests.some(c => c.evidence === QUESTION), false,
    'an answered question must not be re-asked');
  assert.equal(openClarifications(USER).some(i => i.question === QUESTION), false);
});

test('naming an unknown speaker clears every action that speaker owns', async () => {
  const before = boards().tasksBoard.clarification_requests.filter(c => c.owner === 'Nick');
  assert.equal(before.length, 2, 'both of Nick\'s actions start out unowned');

  const item = openClarifications(USER).find(i => i.task === ACTION);
  const { contact } = await answerTaskOwner(USER, {
    key: item.key, intakeId: INTAKE, question: item.question, task: ACTION,
    spokenOwner: 'Nick', newContactName: 'Nick Testworth', meetingTitle: 'Test migration call',
  });

  const saved = db.hub().prepare('SELECT name, aliases FROM contacts WHERE id = ?').get(contact.id);
  assert.equal(saved.name, 'Nick Testworth');
  assert.deepEqual(JSON.parse(saved.aliases), ['Nick'], 'the transcript name becomes an alias');

  const commitment = db.hub().prepare(
    "SELECT value FROM knowledge_atoms WHERE user = ? AND predicate = 'open_commitment'"
  ).get(USER);
  assert.match(commitment.value, /Nick Testworth owns/);

  // The second action was never answered — it resolves because Nick is now known.
  assert.equal(boards().tasksBoard.clarification_requests.some(c => c.owner === 'Nick'), false);
});

test('an alias-overlap answer removes the clashing alias and records the decision', () => {
  assert.equal(boards().people.clarification_requests.length, 1);

  const item = openClarifications(USER).find(i => i.kind === 'person_alias');
  assert.ok(item.alias_overlaps.some(o => o.alias === 'Iain' && o.contact_name === 'Alister Test'));

  const result = answerPersonAlias(USER, {
    key: item.key, question: item.question, decision: 'different_people',
    contactIds: item.contact_ids, contactNames: item.contacts,
    removeAlias: 'Iain', removeFromContactId: '__test_c_a',
  });

  assert.equal(result.removed.alias, 'Iain');
  const aliases = JSON.parse(db.hub().prepare('SELECT aliases FROM contacts WHERE id = ?').get('__test_c_a').aliases);
  assert.deepEqual(aliases, ['Dad']);
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(result.atomId);
  assert.equal(atom.predicate, 'distinct_from');
  assert.equal(boards().people.clarification_requests.length, 0);
});
