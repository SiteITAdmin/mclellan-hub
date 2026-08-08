'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFeatureRunner, listFeatureRunners, MODELS } = require('../lib/feature-runners');

// The contract is the tier, not the vendor behind it: which runner backs Luna is
// a deployment choice that has already changed once (Codex -> Grok on 4 Aug 2026,
// when Codex exhausted its quota). Assert every high-volume feature lands on the
// same tier, and that the tier resolves consistently.
test('high-volume extraction routes to Luna', () => {
  const expected = MODELS.luna.runner;
  for (const feature of ['email_classifier', 'atom_extractor', 'crm_parser', 'agentmail_extractor', 'newsletter_extractor']) {
    const r = resolveFeatureRunner(feature);
    assert.equal(r.tier, 'luna', feature);
    assert.equal(r.runner, expected, feature);
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

test('research stays on the grok tier, behind Claude Haiku (tool/web lane)', () => {
  // Grok ran out of credits on 8 Aug 2026. The grok research tier keeps the
  // Claude Haiku stopgap because content research needs web/tool capability the
  // opencode free tier does not offer. The tier identity stays 'grok'.
  const r = resolveFeatureRunner('content_research_driver');
  assert.equal(r.tier, 'grok');
  assert.equal(r.runner, 'claude');
  assert.equal(r.model, 'haiku');
});

test('bulk tiers (Luna/Terra) run on the opencode free lane until Grok credits return', () => {
  // Both bulk lane Tiers moved to opencode/deepseek-v4-flash-free on 8 Aug 2026
  // after Grok exhausted credits and Claude became the only paid lane. This is
  // the $0 temporary path — flip MODELS back to 'grok' when the subscription
  // resets. The opencode runner must never silently reach a paid API.
  for (const tier of ['luna', 'terra']) {
    const r = MODELS[tier];
    assert.equal(r.runner, 'opencode', tier);
    assert.ok(r.model.includes('deepseek-v4-flash'), tier);
  }
  const triage = resolveFeatureRunner('crm_source_triage');
  assert.equal(triage.runner, 'opencode');
  assert.notEqual(triage.runner, 'openrouter');
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
