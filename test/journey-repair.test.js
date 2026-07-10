'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessLinkedInPost, PURPOSE: LINKEDIN_PURPOSE } = require('../lib/linkedin-journey');
const { sourceJourneyIssue, CRM_JOURNEY_PURPOSE } = require('../lib/crm-knowledge-engine');

const NOW = 1_783_526_400;

function receipt(stage, status, payload = {}, createdAt = NOW - 60) {
  return { stage, status, payload: JSON.stringify(payload), created_at: createdAt };
}

function linkedInPost(overrides = {}) {
  return {
    id: 'post-1',
    topic: 'Agentic systems',
    status: 'needs_revision',
    carousel_url: '',
    quality_override: null,
    created_at: NOW - 3600,
    ...overrides,
  };
}

test('LinkedIn journey treats a content veto as a repair instruction', () => {
  const assessment = assessLinkedInPost(linkedInPost(), [
    receipt('agent:linkedin_quality_board', 'fail', {
      quality_veto: true,
      blocking_checks: ['post_has_specific_voice'],
    }),
  ], NOW);
  assert.equal(assessment.action, 'regenerate');
  assert.equal(assessment.achieved, false);
  assert.match(assessment.reason, /content repair/i);
  assert.match(assessment.purpose, /carousel PDF/);
});

test('LinkedIn override continues to artifact generation instead of ending the journey', () => {
  const assessment = assessLinkedInPost(linkedInPost({ quality_override: NOW - 30 }), [
    receipt('agent:linkedin_quality_board', 'fail', {
      quality_veto: true,
      blocking_checks: ['post_has_specific_voice'],
    }),
  ], NOW);
  assert.equal(assessment.action, 'resume_artifact');
  assert.match(assessment.reason, /overrode|override/i);
});

test('LinkedIn draft is complete only when the PDF exists', () => {
  const missing = assessLinkedInPost(linkedInPost({ status: 'draft' }), [], NOW);
  assert.equal(missing.action, 'resume_artifact');

  const ready = assessLinkedInPost(linkedInPost({ status: 'draft', carousel_url: 'https://drive.google.com/file/d/pdf/view' }), [], NOW);
  assert.equal(ready.achieved, true);
  assert.equal(ready.action, null);
  assert.equal(LINKEDIN_PURPOSE, ready.purpose);
});

test('LinkedIn processing has a stall window and then becomes repairable', () => {
  const recent = assessLinkedInPost(linkedInPost({ status: 'processing', created_at: NOW - 10 }), [], NOW);
  assert.equal(recent.waiting, true);
  assert.equal(recent.action, null);

  const stale = assessLinkedInPost(linkedInPost({ status: 'processing', created_at: NOW - 7200 }), [], NOW);
  assert.equal(stale.action, 'regenerate');
});

function crmSource(overrides = {}) {
  return { id: 'source-1', ts: NOW - 7200, ...overrides };
}

test('CRM journey reopens a source whose triage wrote an error receipt', () => {
  const issue = sourceJourneyIssue({
    sourceKind: 'email_summary',
    row: crmSource(),
    receipts: [receipt('crm_source_triage', 'error', { error: 'bad shape' })],
    nowTs: NOW,
  });
  assert.equal(issue.stage, 'crm_source_triage');
  assert.match(issue.reason, /failed/i);
  assert.equal(issue.repairable, true);
});

test('CRM journey escalates permanent model/config failures instead of replaying them', () => {
  const permanent = sourceJourneyIssue({
    sourceKind: 'email_summary',
    row: crmSource(),
    receipts: [{ ...receipt('crm_source_triage', 'error', {}, NOW - 60), summary: 'CRM source triage OpenRouter 402' }],
    nowTs: NOW,
  });
  assert.equal(permanent.repairable, false);
  assert.equal(permanent.disposition, 'config');
});

test('CRM journey detects approved synthesis that never produced compiled knowledge', () => {
  const issue = sourceJourneyIssue({
    sourceKind: 'meeting_intake',
    row: crmSource(),
    receipts: [receipt('crm_source_triage', 'done', { should_synthesise: true, candidate_actions: [] }, NOW - 3600)],
    synthesisProcessed: false,
    nowTs: NOW,
  });
  assert.equal(issue.stage, 'crm_knowledge_synthesised');
  assert.match(issue.reason, /no compiled-knowledge outcome/i);
});

test('CRM journey detects candidate actions that were never projected', () => {
  const issue = sourceJourneyIssue({
    sourceKind: 'document',
    row: crmSource(),
    receipts: [receipt('crm_source_triage', 'done', {
      should_synthesise: false,
      candidate_actions: [{ action: 'Call Rob' }],
    }, NOW - 3600)],
    nowTs: NOW,
  });
  assert.equal(issue.stage, 'crm_action_projected');
});

test('CRM journey accepts an intentional skip as a terminal outcome', () => {
  const issue = sourceJourneyIssue({
    sourceKind: 'crm_fact',
    row: crmSource(),
    receipts: [receipt('crm_source_triage', 'skipped', { should_synthesise: false, candidate_actions: [] })],
    nowTs: NOW,
  });
  assert.equal(issue, null);
  assert.match(CRM_JOURNEY_PURPOSE, /provenance-backed/);
});
