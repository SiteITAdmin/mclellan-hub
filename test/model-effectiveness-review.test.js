const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAppeals,
  isMonthlyEffectivenessReviewDue,
  reviewPackets,
  resolveReviewer,
  reviewerForDate,
  validateReview,
} = require('../lib/model-effectiveness-review');

test('monthly reviewer rotates Luna, Grok, Sonnet from July 2026', () => {
  assert.equal(reviewerForDate(new Date(2026, 6, 18)).key, 'luna');
  assert.equal(reviewerForDate(new Date(2026, 7, 18)).key, 'grok');
  assert.equal(reviewerForDate(new Date(2026, 8, 18)).key, 'sonnet');
  assert.equal(reviewerForDate(new Date(2026, 9, 18)).key, 'luna');
});

test('monthly review becomes due at 05:00 on the 18th, catches up later, and runs once per month', () => {
  const due = new Date(2026, 6, 18, 5, 0, 0);
  assert.equal(isMonthlyEffectivenessReviewDue(due, null), true);
  assert.equal(isMonthlyEffectivenessReviewDue(new Date(2026, 6, 18, 4, 59, 0), null), false);
  assert.equal(isMonthlyEffectivenessReviewDue(new Date(2026, 6, 17, 5, 0, 0), null), false);
  assert.equal(isMonthlyEffectivenessReviewDue(new Date(2026, 6, 19, 12, 0, 0), null), true);
  assert.equal(isMonthlyEffectivenessReviewDue(due, { month: '2026-07' }), false);
  assert.equal(isMonthlyEffectivenessReviewDue(due, { month: '2026-06' }), true);
});

test('review validation recomputes the total and rejects invalid axis scores', () => {
  const packet = { feature: 'worker', reviewable: true };
  const reviewer = { key: 'luna', label: 'Luna', modelId: 'openai/gpt-5.6-luna', resolvedModelId: 'openai/gpt-5.6-luna' };
  const valid = validateReview({
    evidence_status: 'limited',
    scores: { observed_effectiveness: 24, prompt_quality: 20, model_task_fit: 16, reliability: 8, cost_latency: 7, governance: 5 },
    failure_category: 'none', remedy_class: 'none', rationale: 'Evidence is limited.',
  }, packet, reviewer);
  assert.equal(valid.total_score, 80);
  const invalid = validateReview({
    evidence_status: 'sufficient',
    scores: { observed_effectiveness: 31, prompt_quality: 20, model_task_fit: 16, reliability: 8, cost_latency: 7, governance: 5 },
  }, packet, reviewer);
  assert.equal(invalid.total_score, null);
  assert.equal(invalid.evidence_status, 'insufficient');
});

test('appeal requires all three reviewers below threshold with the same issue and remedy', () => {
  const review = (label, score, category = 'reliability', remedy = 'prompt_revision') => ({
    feature: 'worker', total_score: score, failure_category: category, remedy_class: remedy,
    reviewer: { label },
  });
  const primary = [review('Luna', 68)];
  assert.equal(buildAppeals(primary, [[review('Grok', 70)], [review('Sonnet', 72)]])[0].unanimous, true);
  assert.equal(buildAppeals(primary, [[review('Grok', 76)], [review('Sonnet', 72)]])[0].unanimous, false);
  assert.equal(buildAppeals(primary, [[review('Grok', 70, 'model_fit')], [review('Sonnet', 72)]])[0].unanimous, false);
});

test('missing panel model resolves to closest same-provider equivalent and records substitution', () => {
  const selected = { key: 'luna', label: 'Luna', modelId: 'openai/gpt-5.6-luna', provider: 'openai', familyTerms: ['gpt', '5.6', 'luna'] };
  const resolved = resolveReviewer(selected, [
    { id: 'anthropic/claude-sonnet-5', context_length: 1000000 },
    { id: 'openai/gpt-5.6-pro', context_length: 1000000, supported_parameters: ['reasoning', 'structured_outputs'] },
    { id: 'openai/gpt-4.1-mini', context_length: 1000000, supported_parameters: ['structured_outputs'] },
  ]);
  assert.equal(resolved.resolvedModelId, 'openai/gpt-5.6-pro');
  assert.equal(resolved.substituted, true);
  assert.match(resolved.substitutionReason, /absent from the live catalogue/);
});

test('appeal calls carry identical raw evidence without a primary score or recommendation', async () => {
  const calls = [];
  const checkpoints = [];
  const reviewer = { key: 'grok', label: 'Grok', modelId: 'x-ai/grok-4.5', resolvedModelId: 'x-ai/grok-4.5', substituted: false };
  const packet = {
    feature: 'worker', label: 'Worker', reviewable: true, prompt: { text: 'Return JSON.', sha256: 'abc' },
    model_id: 'acme/model', observed: { direct_call_count: 4 },
  };
  const request = async args => {
    calls.push(args);
    return {
      reviews: [{
        feature: 'worker', evidence_status: 'limited',
        scores: { observed_effectiveness: 20, prompt_quality: 18, model_task_fit: 15, reliability: 8, cost_latency: 7, governance: 5 },
        failure_category: 'multiple', remedy_class: 'human_review', rationale: 'Limited evidence.', recommendation: 'Review it.',
      }],
    };
  };
  const reviews = await reviewPackets([packet], reviewer, { status: 'available', sources: [] }, {
    appeal: true,
    request,
    onBatch: rows => checkpoints.push(rows),
  });
  assert.equal(reviews[0].total_score, 73);
  assert.match(calls[0].messages[0].content, /independent appeal/i);
  assert.match(calls[0].messages[1].content, /Return JSON\./);
  assert.doesNotMatch(calls[0].messages[1].content, /primary_score|primary recommendation/i);
  assert.deepEqual(calls[0].extraBody, { reasoning: { effort: 'high' } });
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0][0].feature, 'worker');
});
