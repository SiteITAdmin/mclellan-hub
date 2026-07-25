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
// Side chat the transcriber picked up — the material for the discard tests.
const NOISE_1 = 'Is the weather in Ireland relevant to the migration plan?';
const NOISE_2 = 'Speaker 3 mentioned hay fever; unable to match to a known CRM person.';
const IDENTITY_Q = "The identity of the meeting lead (Speaker 3) is not mentioned in the transcript.";
// Krisp puts "Name | 00:42" on its own line, then the turn beneath it.
const TRANSCRIPT = [
  '## Krisp Notes',
  'Speaker 1 | 00:01',
  'Morning all.',
  'Speaker 3 | 00:49',
  'Right, let me kick us off. I own the migration workstream end to end, so anything on sequencing '
    + 'or batch sizing comes through me. We agreed the pilot cohort last week and I have asked Neil to '
    + 'confirm the device list before Thursday so we are not guessing when the change window opens.',
  'Ken | 01:20',
  'Fine by me.',
  'Speaker 3 | 02:05',
  'One more thing on mailboxes.',
  'Ken | 03:00',
  'The E3 mailbox limit question is the one blocking the comms pack, everything else is drafted.',
].join('\n');

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
  `).run(INTAKE, USER, '__test-m365', 'Test migration call', TRANSCRIPT, JSON.stringify({
    open_questions: [QUESTION, NOISE_1, NOISE_2, IDENTITY_Q],
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

test('discarding drops a question for good, writes no knowledge, and can be undone', () => {
  const { discardClarification, restoreClarification } = require('../lib/crm-clarifications');
  const item = openClarifications(USER).find(i => i.question === NOISE_1);
  assert.ok(item, 'need an open question to discard');
  const atomsBefore = db.hub().prepare('SELECT COUNT(*) n FROM knowledge_atoms WHERE user = ?').get(USER).n;

  discardClarification(USER, { key: item.key, kind: item.kind, question: item.question });
  assert.equal(openClarifications(USER).some(i => i.key === item.key), false, 'a discarded question is gone');
  assert.equal(
    db.hub().prepare('SELECT COUNT(*) n FROM knowledge_atoms WHERE user = ?').get(USER).n,
    atomsBefore,
    'noise must not become knowledge',
  );

  assert.equal(restoreClarification(USER, item.key), true);
  assert.equal(openClarifications(USER).some(i => i.key === item.key), true, 'undo puts it back');
});

test('"Delete this - not relevant" in the answer box is a discard, not a fact', async () => {
  const { isDeleteIntent } = require('../lib/crm-clarifications');
  assert.equal(isDeleteIntent('Delete this - not relevant'), true);
  assert.equal(isDeleteIntent('Ignore'), true);
  assert.equal(isDeleteIntent('irrelevant'), true);
  // A real answer that merely contains the phrase must still become knowledge.
  assert.equal(isDeleteIntent(
    'The 50GB tier is not relevant any more because everyone was moved to 100GB in the July migration.'), false);

  const item = openClarifications(USER).find(i => i.question === NOISE_2);
  const before = db.hub().prepare('SELECT COUNT(*) n FROM knowledge_atoms WHERE user = ?').get(USER).n;
  const result = await answerMeetingQuestion(USER, {
    key: item.key, intakeId: INTAKE, question: item.question, answer: 'Delete this - not relevant',
    projectSlug: '__test-m365', meetingTitle: 'Test migration call',
  });
  assert.equal(result.discarded, true);
  assert.equal(result.atomId, null);
  assert.equal(db.hub().prepare('SELECT COUNT(*) n FROM knowledge_atoms WHERE user = ?').get(USER).n, before,
    'a deletion must never be written as a decision atom');
  assert.equal(openClarifications(USER).some(i => i.key === item.key), false);
});

test('a question about a speaker shows 50-100 words of that speaker, not the transcript link', () => {
  const { attachContext, transcriptTurns } = require('../lib/crm-clarifications');
  const turns = transcriptTurns(db.hub().prepare('SELECT transcript FROM meeting_intakes WHERE id = ?').get(INTAKE).transcript);
  assert.equal(turns.length, 5, '"Name | 00:00" headers become turns');
  assert.deepEqual(turns.map(t => t.speaker), ['Speaker 1', 'Speaker 3', 'Ken', 'Speaker 3', 'Ken']);

  const item = openClarifications(USER).find(i => i.question === IDENTITY_Q);
  attachContext(USER, [item]);
  assert.equal(item.context.speaker, 'Speaker 3');
  assert.equal(item.context.turn_count, 2, 'both of their turns are counted');
  const words = item.context.quotes.map(q => q.text).join(' ').split(/\s+/).length;
  assert.ok(words >= 40 && words <= 100, `expected a readable excerpt, got ${words} words`);
  assert.match(item.context.quotes[0].text, /migration workstream end to end/);
  assert.equal(item.context.quotes[0].time, '00:49');
});

test('with no speaker named, the excerpt is the turn that discusses the question', () => {
  const { attachContext } = require('../lib/crm-clarifications');
  const item = { kind: 'meeting_question', intake_id: INTAKE, question: QUESTION };
  attachContext(USER, [item]);
  assert.equal(item.context.matched, true);
  assert.equal(item.context.speaker, 'Ken');
  assert.match(item.context.quotes[0].text, /E3 mailbox limit question/);
});
