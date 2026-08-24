'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  aliasCollidesWithOtherContact,
  findExactContact,
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
  add('er_alan', 'Alan Garland', ['Alan']);
  add('er_duncan', 'Duncan Sackfield', []);
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

test('deterministic source identity corrects a contradictory model assignment', async () => {
  const extraction = {
    meeting: {
      attendees: [
        { name: 'Alan', matched_contact: 'Alec Hirst' },
        { name: 'Alec Hirst', matched_contact: 'Nick Chin' },
      ],
    },
    action_register: [
      { owner: 'Alan', matched_contact: 'Alec Hirst', owner_type: 'known_person', task: 'send plan' },
    ],
  };
  const result = await resolveMeetingEntities({
    user: USER,
    extraction,
    contacts: contacts(),
    useModel: false,
    sourceId: 'er_wrong_links',
  });
  assert.equal(extraction.meeting.attendees[0].matched_contact, 'Alan Garland');
  assert.equal(extraction.meeting.attendees[1].matched_contact, 'Alec Hirst');
  assert.equal(extraction.action_register[0].matched_contact, 'Alan Garland');
  assert.equal(result.resolved.length, 2);
  assert.ok(result.resolved.every(item => item.method === 'deterministic_correction'));
});

test('the alias invariant: a name denoting another contact can never be an alias', () => {
  const list = contacts();
  assert.equal(aliasCollidesWithOtherContact('Ken', 'er_ken', list), false, 'only one Ken exists');
  assert.equal(aliasCollidesWithOtherContact('Nick', 'er_duncan', list), true, 'Nick Chin exists, so Nick is not Duncan');
  assert.equal(aliasCollidesWithOtherContact('Alec Kangley', 'er_alec', list), false, 'a distinctive full name is fine');
});

test('duplicate exact aliases fail closed instead of selecting the first contact', () => {
  const list = [
    { id: 'one', name: 'One Person', aliases: '["Shared"]' },
    { id: 'two', name: 'Two Person', aliases: '["Shared"]' },
  ];
  assert.equal(findExactContact(list, 'Shared'), null);
});

test('learnAlias refuses to alias a contact to a name that denotes a different contact', () => {
  const duncan = contacts().find(c => c.id === 'er_duncan');
  const learned = learnAlias(USER, duncan, 'Nick', { source: 'human_correction' });
  assert.equal(learned, false, 'Nick belongs to Nick Chin; it cannot become Duncan\'s alias');
  const after = db.hub().prepare('SELECT aliases FROM contacts WHERE id = ?').get('er_duncan').aliases;
  assert.equal(after, '[]', 'Duncan gains no alias');
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
