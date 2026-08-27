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
  for (const feature of ['crm_source_triage', 'crm_duplicate_review', 'crm_action_projection', 'crm_action_resolution', 'entity_linker']) {
    const r = resolveFeatureRunner(feature);
    assert.equal(r.tier, 'terra', feature);
  }
});

test('whole-transcript attribution reconciliation uses the dedicated GPT-5.6 Terra runner', () => {
  const r = resolveFeatureRunner('attribution_reconciliation');
  assert.equal(r.tier, 'terra');
  assert.equal(r.runner, 'codex');
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.equal(r.effort, 'high');
  assert.ok(r.maxInputChars >= 200000);
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

test('bulk tiers (Luna/Terra) run on a single Codex gpt-5.6-luna lane', () => {
  // Both bulk tiers point at Codex gpt-5.6-luna as of 9 Aug 2026 — one Luna
  // lane, no separate gpt-5.6-terra — after the 4 Aug Codex "usage limit" was
  // traced to a one-off sol-5.6 job rather than the Hub's steady load. The
  // effort split is kept: extraction at low, operational reasoning at medium.
  for (const tier of ['luna', 'terra']) {
    const r = MODELS[tier];
    assert.equal(r.runner, 'codex', tier);
    assert.equal(r.model, 'gpt-5.6-luna', tier);
  }
  assert.equal(MODELS.luna.effort, 'low');
  assert.equal(MODELS.terra.effort, 'medium');
  const triage = resolveFeatureRunner('crm_source_triage');
  assert.equal(triage.runner, 'codex');
  assert.equal(triage.model, 'gpt-5.6-luna');
  assert.notEqual(triage.runner, 'openrouter');
});

test('nakai daily briefing is Opus', () => {
  const r = resolveFeatureRunner('nakai_daily_briefing');
  assert.equal(r.tier, 'opus');
});

test('newsletter digest briefing uses ChatGPT Go/Codex with a full-edition markdown output cap', () => {
  const r = resolveFeatureRunner('newsletter_digest_briefing');
  assert.equal(r.tier, 'luna');
  assert.equal(r.runner, 'codex');
  assert.equal(r.model, 'gpt-5.6-luna');
  assert.equal(r.effort, 'high');
  assert.equal(r.jsonMode, false);
  assert.ok(r.maxInputChars >= 200000);
  assert.ok(r.maxOutputChars >= 120000);
});

test('unknown features default to Terra, never openrouter', () => {
  const r = resolveFeatureRunner('brand_new_unknown_feature_xyz');
  assert.equal(r.tier, 'terra');
  assert.notEqual(r.runner, 'openrouter');
});

test('registry lists many features', () => {
  assert.ok(listFeatureRunners().length > 40);
});
