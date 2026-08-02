'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  isNonPersonEntityName,
  normalizeActionRegister,
  processMeetingTranscript,
  speakerReviewForTranscript,
  applySpeakerMap,
} = require('../lib/meeting-intake');

const USER = '__test_meeting_intake_contact_boundary';

function cleanup() {
  const h = db.hub();
  h.prepare('DELETE FROM meeting_intakes WHERE user = ?').run(USER);
  const meetingIds = h.prepare('SELECT id FROM meetings WHERE user = ?').all(USER).map(row => row.id);
  for (const meetingId of meetingIds) h.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meetingId);
  h.prepare('DELETE FROM meetings WHERE user = ?').run(USER);
  h.prepare('DELETE FROM documents WHERE user = ?').run(USER);
  h.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
  h.prepare('DELETE FROM projects WHERE user = ?').run(USER);
}

test.beforeEach(cleanup);
test.after(cleanup);

test('meeting intake treats project and company labels as non-person entities', () => {
  const context = {
    projects: [{ slug: 'm365-rollout', name: 'M365 Rollout' }],
    companies: [{ name: 'Beacon Hospital' }],
  };

  assert.equal(isNonPersonEntityName(context, 'M365 Rollout'), true);
  assert.equal(isNonPersonEntityName(context, 'm365-rollout'), true);
  assert.equal(isNonPersonEntityName(context, 'Beacon Hospital'), true);
  assert.equal(isNonPersonEntityName(context, 'Alec Hirst'), false);
});

test('meeting intake detects Krisp pipe-format placeholder speakers', () => {
  const review = speakerReviewForTranscript([
    'Douglas McLellan | 09:02',
    'Thanks.',
    'Speaker 2 | 09:20',
    'I will circulate the persona matrix today.',
  ].join('\n'));

  assert.equal(review.speakers.length, 1);
  assert.equal(review.speakers[0].label, 'Speaker 2');
  assert.match(review.speakers[0].samples[0], /I will circulate/);
});

test('meeting intake keeps unknown-owner actions in an action register', () => {
  const context = {
    contacts: [{ name: 'Douglas McLellan', aliases: '[]' }],
    projects: [{ slug: 'm365-rollout', name: 'M365 Rollout' }],
  };

  const actions = normalizeActionRegister({
    crm_updates: [{
      subject: 'Speaker 2',
      matched_contact: null,
      type: 'action',
      text: 'Circulate the application/persona matrix by end of day.',
      project_slug: 'm365-rollout',
      due_date: '2026-06-29',
      google_task: false,
    }],
  }, context, context.projects[0]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0].owner, 'Speaker 2');
  assert.equal(actions[0].task, 'Circulate the application/persona matrix by end of day.');
  assert.equal(actions[0].project_slug, 'm365-rollout');
});

test('applySpeakerMap rewrites Krisp pipe-format labels and legacy colon labels', () => {
  const krisp = '## Krisp Notes\nSpeaker 1 | 00:00\nHello.\nDouglas McLellan | 00:27\nHi.\nSpeaker 1 | 00:53\nBye.';
  const resolved = applySpeakerMap(krisp, { 'Speaker 1': 'Jane Whelan' });
  assert.equal(resolved.includes('Jane Whelan | 00:00'), true);
  assert.equal(resolved.includes('Jane Whelan | 00:53'), true);
  assert.equal(resolved.includes('Speaker 1'), false);

  const legacy = 'Speaker 2: old style\nSpeaker 2 - dashed';
  const legacyResolved = applySpeakerMap(legacy, { 'Speaker 2': 'Rob' });
  assert.equal(legacyResolved, 'Rob: old style\nRob: dashed');

  const midLine = 'He said Speaker 1 | is a label';
  assert.equal(applySpeakerMap(midLine, { 'Speaker 1': 'X' }), midLine);
});

test('unknown model-extracted attendees remain evidence and do not create contacts', async () => {
  const h = db.hub();
  const before = h.prepare('SELECT COUNT(*) AS n FROM contacts WHERE user = ?').get(USER).n;
  const result = await processMeetingTranscript(USER, {
    intakeId: uuid(),
    transcript: 'Speaker 1: We discussed the plan.',
    title: 'Unknown attendee boundary',
    meetingDate: '2026-08-02',
    extractMeetingIntelligenceFn: async () => ({
      meeting: {
        title: 'Unknown attendee boundary',
        date: '2026-08-02',
        summary: 'Model guessed a person not in the CRM.',
        attendees: [{ name: 'Model Guessed Person' }],
        projects: [],
      },
      crm_updates: [],
      action_register: [],
      project_notes: [],
      open_questions: [],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(h.prepare('SELECT COUNT(*) AS n FROM contacts WHERE user = ?').get(USER).n, before);
  assert.equal(h.prepare('SELECT COUNT(*) AS n FROM meeting_attendees WHERE meeting_id = ?').get(result.meetingId).n, 0);
  const extraction = JSON.parse(h.prepare('SELECT extraction FROM meeting_intakes WHERE id = ?').get(result.intakeId).extraction);
  assert.equal(extraction.meeting.attendees[0].name, 'Model Guessed Person');
});

test('raw transcript is persisted before extraction and remains retryable after failure', async () => {
  const h = db.hub();
  const intakeId = uuid();
  const raw = '  Opening line\n' + 'x'.repeat(220_000) + '\nTAIL-MUST-SURVIVE  ';
  await assert.rejects(
    processMeetingTranscript(USER, {
      intakeId,
      transcript: raw,
      title: 'Raw preservation',
      extractMeetingIntelligenceFn: async () => { throw new Error('model unavailable'); },
    }),
    /model unavailable/,
  );
  const stored = h.prepare('SELECT transcript, status, error FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, USER);
  assert.equal(stored.transcript, raw.replace(/\r\n/g, '\n'));
  assert.equal(stored.transcript.length > 200_000, true);
  assert.match(stored.transcript, /TAIL-MUST-SURVIVE/);
  assert.equal(stored.status, 'error');
  assert.equal(stored.error, 'model unavailable');
});

test('model-inferred projects do not create project documents or routes', async () => {
  const h = db.hub();
  const projectId = uuid();
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
    .run(projectId, USER, 'Model Project', 'model-project');

  const result = await processMeetingTranscript(USER, {
    intakeId: uuid(),
    transcript: 'Speaker 1: We discussed model project actions.',
    title: 'Model project boundary',
    extractMeetingIntelligenceFn: async () => ({
      meeting: {
        title: 'Model project boundary',
        date: '2026-08-02',
        summary: 'Model inferred a project destination.',
        attendees: [],
        projects: ['model-project'],
      },
      crm_updates: [{
        subject: 'Unknown speaker',
        type: 'decision',
        text: 'Keep this decision as source evidence.',
        project_slug: 'model-project',
      }],
      action_register: [{
        owner: 'Unknown speaker',
        task: 'Review the model project action.',
        project_slug: 'model-project',
      }],
      project_notes: [{ project_slug: 'model-project', note: 'Model project note.' }],
      open_questions: [],
    }),
  });

  assert.equal(result.counts.projectDocuments, 0);
  const intake = h.prepare('SELECT project_slug, extraction FROM meeting_intakes WHERE id = ?').get(result.intakeId);
  assert.equal(intake.project_slug, null);
  const extraction = JSON.parse(intake.extraction);
  assert.deepEqual(extraction.meeting.projects, ['model-project']);
  assert.equal(extraction.project_notes[0].project_slug, 'model-project');
  assert.equal(h.prepare('SELECT COUNT(*) AS n FROM documents WHERE user = ?').get(USER).n, 0);
});

test('explicit project selection remains the only meeting project route', async () => {
  const h = db.hub();
  const projectId = uuid();
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
    .run(projectId, USER, 'Selected Project', 'selected-project');

  const result = await processMeetingTranscript(USER, {
    intakeId: uuid(),
    transcript: 'Speaker 1: We discussed the selected project.',
    title: 'Explicit project route',
    projectSlug: 'selected-project',
    extractMeetingIntelligenceFn: async () => ({
      meeting: {
        title: 'Explicit project route',
        date: '2026-08-02',
        summary: 'Explicit project metadata was supplied by the user.',
        attendees: [],
        projects: ['model-project'],
      },
      crm_updates: [],
      action_register: [{
        owner: 'Unknown speaker',
        task: 'Review the selected project action.',
        project_slug: 'model-project',
      }],
      project_notes: [{ project_slug: 'model-project', note: 'Model project note.' }],
      open_questions: [],
    }),
  });

  assert.equal(result.counts.projectDocuments, 1);
  const intake = h.prepare('SELECT project_slug FROM meeting_intakes WHERE id = ?').get(result.intakeId);
  assert.equal(intake.project_slug, 'selected-project');
  const doc = h.prepare('SELECT project_id FROM documents WHERE user = ?').get(USER);
  assert.equal(doc.project_id, projectId);
});
