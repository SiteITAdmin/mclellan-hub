'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  findExactContact,
  isAmbiguousBareFirstName,
  learnAlias,
  resolveMeetingEntities,
} = require('../lib/entity-resolution');
const {
  contactsNamedIn,
  learnAliasFromMeetingAnswer,
  unresolvedNameFromQuestion,
} = require('../lib/crm-clarifications');
const { intakeClarificationIssues } = require('../lib/hub-quality-board');

const USER = '__test_entity_resolution';

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM knowledge_receipts WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
}

function seed() {
  const hub = db.hub();
  const add = (id, name, aliases) => hub.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run(id, USER, name, JSON.stringify(aliases));
  add('er_ken', 'Ken Murray', ['Ken']);
  add('er_alec', 'Alec Hirst', ['Alec Kangley']);
  add('er_duncan', 'Duncan Sackfield', ['Nick']);
  add('er_nick', 'Nick Chin', []);
}

function contacts() {
  return db.hub().prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(USER);
}

test.before(() => { cleanup(); seed(); });
test.after(cleanup);

test('deterministic pass relinks garbled/partial names via existing aliases and clears stale warnings', async () => {
  const extraction = {
    meeting: { attendees: [{ name: 'Alec Kangley', matched_contact: null }, { name: 'Ken', matched_contact: null }] },
    action_register: [{ owner: 'Alec Kangley', matched_contact: null, owner_type: 'unknown_speaker', task: 'send HLD' }],
    warnings: [
      'Alec Kangley is not present in the known CRM people list, so matched_contact is null.',
      'Ken could not be confidently matched to a known CRM person.',
      'The plan versions are unclear.',
    ],
  };
  const result = await resolveMeetingEntities({ user: USER, extraction, contacts: contacts(), useModel: false, sourceId: 'er_i1' });
  assert.equal(extraction.meeting.attendees[0].matched_contact, 'Alec Hirst');
  assert.equal(extraction.meeting.attendees[1].matched_contact, 'Ken Murray');
  const action = extraction.action_register[0];
  assert.equal(action.matched_contact, 'Alec Hirst');
  assert.equal(action.owner_type, 'known_person', 'an unknown_speaker becomes known once linked');
  assert.equal(extraction.warnings.length, 1, 'only the non-identity warning survives');
  assert.match(extraction.warnings[0], /plan versions/);
  assert.equal(result.warningsStripped, 2);
});

test('a unique bare first name is safe to learn; an ambiguous one is context-only', () => {
  const list = contacts();
  assert.equal(isAmbiguousBareFirstName('Ken', list, 'er_ken'), false, 'only one Ken exists');
  assert.equal(isAmbiguousBareFirstName('Nick', list, 'er_duncan'), true, 'Nick Chin and Duncan(aka Nick) collide');
  assert.equal(isAmbiguousBareFirstName('Alec Kangley', list, 'er_alec'), false, 'a full name is distinctive');
});

test('a transcript name that is itself a known person is not flagged as someone else\'s near-name', () => {
  const knownContacts = [
    { id: 'a', name: 'Alan Garland', aliases: '[]' },
    { id: 'b', name: 'Alec Hirst', aliases: '[]' },
    { id: 't', name: 'Triona', aliases: '[]' },
  ];
  const intake = ({ name }) => [{
    id: 'i', title: 'call', status: 'processed',
    extraction: JSON.stringify({ meeting: { attendees: [{ name }] } }),
  }];
  const nearNames = names => intakeClarificationIssues(intake({ name: names }), knownContacts)
    .filter(i => i.type === 'near_name_audio_variant');
  assert.equal(nearNames('Alan').length, 0, '"Alan" is Alan Garland, not a mishearing of Alec Hirst');
  assert.ok(nearNames('Trina').some(i => i.evidence.includes('Trina may be Triona')),
    'a genuinely unknown near-name still flags');
});

test('a human answer that names one contact learns the spoken name as a durable alias', () => {
  assert.equal(unresolvedNameFromQuestion("Speaker 'Tesh' could not be matched to a known CRM person."), 'Tesh');
  assert.equal(contactsNamedIn('Its Ken Murray', contacts()).length, 1);
  const learned = learnAliasFromMeetingAnswer(USER, {
    question: "Speaker 'Tesh' could not be matched to a known CRM person.",
    answer: 'That is Ken Murray.',
  });
  assert.ok(learned, 'a confident single-contact answer learns');
  assert.ok(findExactContact(contacts(), 'Tesh'), 'the spoken name now resolves to a contact');
});

test('a "they are different people" answer never learns a false alias', () => {
  const before = contacts().find(c => c.id === 'er_alec').aliases;
  const learned = learnAliasFromMeetingAnswer(USER, {
    question: 'Alan may be Alec Hirst; ask for clarification before linking facts/actions',
    answer: 'Alan Garland and Alec Hirst are different people',
  });
  assert.equal(learned, null, 'a denial teaches nothing');
  assert.equal(contacts().find(c => c.id === 'er_alec').aliases, before, 'aliases are untouched');
});
