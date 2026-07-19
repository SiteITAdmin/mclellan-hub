'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { upsertAtom } = require('../lib/atoms');
const { uuid } = require('../lib/id');
const {
  acceptSuggestionById,
  compileAcceptedContactSuggestionAtom,
  contactSuggestionCandidates,
  runContactSuggester,
} = require('../lib/suggestion-engine');

const USER = '__test_contact_suggestions';
const ELIGIBLE_ID = uuid();
const TASKED_ID = uuid();
const SELF_ID = `self-${uuid()}`;
const SERVICE_ID = uuid();

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM suggestions WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM google_tasks WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
}

test.before(() => {
  cleanup();
  const hub = db.hub();
  const insertContact = hub.prepare('INSERT INTO contacts (id, user, name, notes) VALUES (?, ?, ?, ?)');
  insertContact.run(ELIGIBLE_ID, USER, 'Ada Example', 'Former colleague working in public-service technology.');
  insertContact.run(TASKED_ID, USER, 'Ben Example', 'Already has a follow-up.');
  insertContact.run(SELF_ID, USER, 'Test Self', 'Synthetic self record.');
  insertContact.run(SERVICE_ID, USER, 'Benefits Team', 'A service contact, not an individual.');
  hub.prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status, source, contact_id)
    VALUES (?, ?, ?, '@default', 'Existing follow-up', 'needsAction', 'test', ?)
  `).run(uuid(), USER, `google-${uuid()}`, TASKED_ID);
  upsertAtom(USER, {
    subjectKind: 'contact',
    subjectId: ELIGIBLE_ID,
    subjectLabel: 'Ada Example',
    predicate: 'professional_interest',
    value: 'Interested in practical AI governance for public services.',
    sourceRef: { kind: 'test', id: 'ada-interest' },
    confidence: 0.9,
    derivedBy: 'test',
  });
});

test.after(cleanup);

test('only non-self contacts without an open task enter the raw review set', () => {
  const candidates = contactSuggestionCandidates(USER);
  assert.deepEqual(new Set(candidates.map(contact => contact.id)), new Set([ELIGIBLE_ID, SERVICE_ID]));
});

test('a model batch failure creates no fallback flood', async () => {
  await assert.rejects(
    runContactSuggester(USER, { synthesise: async () => { throw new Error('network unavailable'); } }),
    /no contact suggestions were created/i,
  );
  assert.equal(db.hub().prepare(
    "SELECT COUNT(*) AS n FROM suggestions WHERE user = ? AND domain = 'contact'"
  ).get(USER).n, 0);
});

test('contact reasons stay candidates until acceptance, then create a linked task and atom', async () => {
  const created = await runContactSuggester(USER, {
    synthesise: async (_prompt, batch) => ({
      suggestions: batch.filter(contact => contact.id !== SERVICE_ID).map(contact => ({
        contact_id: contact.id,
        title: 'compare practical AI governance notes',
        reason: 'The Hub records a shared thread around practical AI governance in public services.',
        suggested_action: 'Ask what governance problem is proving hardest in practice and offer to compare notes.',
        source_keys: contact.sources.filter(source => source.key.startsWith('atom:')).map(source => source.key),
        uses_hypothesis: false,
        hypothesis: '',
        confidence: 0.86,
      })),
      excluded_contacts: [{ contact_id: SERVICE_ID, reason: 'This is a service team, not a person.' }],
    }),
  });
  assert.equal(created.length, 1);
  const suggestion = created[0];
  const evidence = JSON.parse(suggestion.evidence);
  assert.equal(evidence.contactId, ELIGIBLE_ID);
  assert.equal(evidence.knowledgeStatus, 'candidate_only_until_accepted');
  assert.ok(evidence.selectedSourceKeys.some(key => key.startsWith('atom:')));
  assert.equal(db.hub().prepare(`
    SELECT COUNT(*) AS n FROM knowledge_atoms
    WHERE user = ? AND derived_by = 'suggestion_contact_accepted'
  `).get(USER).n, 0);

  let taskInput = null;
  const accepted = await acceptSuggestionById(USER, suggestion.id, {
    createTaskFn: async (_user, input) => {
      taskInput = input;
      return { id: 'mock-google-task' };
    },
    promote: (user, row) => compileAcceptedContactSuggestionAtom(user, row, { index: async () => 1 }),
  });
  assert.equal(accepted.ok, true);
  assert.equal(taskInput.contactId, ELIGIBLE_ID);
  assert.equal(db.hub().prepare('SELECT status FROM suggestions WHERE id = ?').get(suggestion.id).status, 'accepted');
  const atom = db.hub().prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ? AND derived_by = 'suggestion_contact_accepted'
  `).get(USER);
  assert.equal(atom.subject_id, ELIGIBLE_ID);
  assert.equal(atom.predicate, 'accepted_outreach_reason');
  assert.ok(JSON.parse(atom.source_refs).some(ref => ref.kind === 'suggestion' && ref.id === suggestion.id));
});
