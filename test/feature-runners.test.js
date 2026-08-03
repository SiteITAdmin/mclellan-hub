'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFeatureRunner, listFeatureRunners } = require('../lib/feature-runners');

test('high-volume extraction routes to Luna', () => {
  for (const feature of ['email_classifier', 'atom_extractor', 'crm_parser', 'agentmail_extractor', 'newsletter_extractor']) {
    const r = resolveFeatureRunner(feature);
    assert.equal(r.tier, 'luna', feature);
    assert.equal(r.runner, 'codex');
  }
});

test('CRM decisions route to Terra', () => {
  for (const feature of ['crm_source_triage', 'crm_duplicate_review', 'crm_action_projection', 'entity_linker']) {
    const r = resolveFeatureRunner(feature);
    assert.equal(r.tier, 'terra', feature);
  }
});

test('cross-entity synthesis is Sonnet not Luna', () => {
  const r = resolveFeatureRunner('cross_entity_synthesis');
  assert.equal(r.tier, 'sonnet');
  assert.equal(r.runner, 'claude');
  assert.ok(r.maxEvidenceRecords <= 100);
});

test('research routes to Grok', () => {
  const r = resolveFeatureRunner('content_research_driver');
  assert.equal(r.tier, 'grok');
  assert.equal(r.runner, 'grok');
});

test('nakai daily briefing is Opus', () => {
  const r = resolveFeatureRunner('nakai_daily_briefing');
  assert.equal(r.tier, 'opus');
});

test('unknown features default to Terra, never openrouter', () => {
  const r = resolveFeatureRunner('brand_new_unknown_feature_xyz');
  assert.equal(r.tier, 'terra');
  assert.notEqual(r.runner, 'openrouter');
});

test('registry lists many features', () => {
  assert.ok(listFeatureRunners().length > 40);
});
