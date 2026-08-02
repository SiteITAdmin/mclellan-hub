'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const view = path.join(__dirname, '..', 'views', 'hub', 'crm-knowledge.ejs');
const locals = {
  user: 'crm-knowledge-view-test',
  nav: [],
  query: 'review action outcomes',
  result: null,
  error: null,
  insights: [],
  browse: false,
  browseAtoms: null,
  browseFilters: null,
  engineStages: [],
  engineErrors: [],
  engineErrorSourceCount: 0,
  engineCoverage: null,
  health: { duplicateEmails: 0, orphanFacts: 0, staleAtoms: 0, disputedAtoms: 0 },
};

test('unreconciled provider side-effect reviews cannot render a Create task control', async () => {
  const html = await ejs.renderFile(view, {
    ...locals,
    actionOutcomeQueue: [{
      id: 'ambiguous-provider-call',
      disposition: 'review',
      candidate_title: 'Send the signed minutes',
      source_kind: 'email_summary',
      source_id: 'source-id',
      source_revision: 'revision',
      reason: 'task_side_effect_ambiguous_requires_human_review',
      evidence_text: 'Please send the signed minutes.',
      payload: {
        non_creatable: true,
        side_effect_ambiguity: {
          type: 'unreconciled_provider_side_effect',
          phase: 'task',
          requires_reconciliation: true,
        },
      },
    }],
  });

  assert.doesNotMatch(html, /data-outcome="ambiguous-provider-call" data-action="accept"/);
  assert.match(html, /Provider reconciliation required/);
  assert.match(html, /data-outcome="ambiguous-provider-call" data-action="dismiss"/);
});

test('ordinary review actions retain their Create task control', async () => {
  const html = await ejs.renderFile(view, {
    ...locals,
    actionOutcomeQueue: [{
      id: 'ordinary-review',
      disposition: 'review',
      candidate_title: 'Prepare project update',
      source_kind: 'email_summary',
      source_id: 'source-id',
      source_revision: 'revision',
      reason: 'medium_confidence_explicit_ask',
      evidence_text: 'Please prepare the project update.',
      payload: {},
    }],
  });

  assert.match(html, /data-outcome="ordinary-review" data-action="accept">Create task/);
});

test('duplicate/supersession source gates render dedicated skip and retry controls, never generic dismissal', async () => {
  const html = await ejs.renderFile(view, {
    ...locals,
    actionOutcomeQueue: [{
      id: 'duplicate-source-gate',
      disposition: 'review',
      candidate_title: 'email summary source',
      source_kind: 'email_summary',
      source_id: 'source-id',
      source_revision: 'revision',
      reason: 'duplicate_review_uncertain',
      evidence_text: 'Potentially duplicate durable claim.',
      payload: {
        non_creatable: true,
        source_level: true,
        source_stage: 'duplicate_review_gate',
        synthesis_gate: { mode: 'review', reason: 'duplicate_review_uncertain' },
      },
    }],
  });

  assert.match(html, /data-outcome="duplicate-source-gate" data-action="skip">Skip atom synthesis/);
  assert.match(html, /data-outcome="duplicate-source-gate" data-action="retry">Re-run duplicate review/);
  assert.doesNotMatch(html, /data-outcome="duplicate-source-gate" data-action="dismiss"/);
  assert.match(html, /source-level duplicate\/supersession decision/);
});

test('an unproven duplicate confirmation uses the same dedicated source-resolution controls', async () => {
  const html = await ejs.renderFile(view, {
    ...locals,
    actionOutcomeQueue: [{
      id: 'duplicate-confirmation-unproven',
      disposition: 'review',
      candidate_title: 'email summary source',
      source_kind: 'email_summary',
      source_id: 'source-id',
      source_revision: 'revision',
      reason: 'duplicate_confirmation_unproven',
      evidence_text: 'A novel claim was stored but the confirmation target was not proven.',
      payload: {
        non_creatable: true,
        source_level: true,
        source_stage: 'duplicate_confirmation_unproven',
      },
    }],
  });

  assert.match(html, /data-outcome="duplicate-confirmation-unproven" data-action="skip">Skip atom synthesis/);
  assert.match(html, /data-outcome="duplicate-confirmation-unproven" data-action="retry">Re-run duplicate review/);
  assert.doesNotMatch(html, /data-outcome="duplicate-confirmation-unproven" data-action="dismiss"/);
});
