'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReview } = require('../scripts/review-nakai-briefing-quality');

test('Nakai briefing quality review validates a seven-dimension comparison', () => {
  const dimensions = [
    'source_grounding',
    'regulatory_relevance',
    'prioritisation',
    'actionability',
    'continuity',
    'readability',
    'unsupported_claim_risk',
  ].map(name => ({ name, target: 82, baseline_average: 76, change: 6, evidence: 'Evidence.' }));
  const review = parseReview(JSON.stringify({
    verdict: 'improved',
    confidence: 0.8,
    target_score: 82,
    baseline_scores: [{ edition: '039', score: 77 }, { edition: '038', score: 75 }],
    dimensions,
    material_improvements: ['Better prioritisation.'],
    regressions: [],
    model_change_assessment: 'Consistent with the route change, but one edition is not causal proof.',
    recommendation: 'collect_more_evidence',
    summary: 'A measurable improvement.',
  }));
  assert.equal(review.verdict, 'improved');
  assert.equal(review.dimensions.length, 7);
});

test('Nakai briefing quality review rejects incomplete scoring', () => {
  assert.throws(
    () => parseReview('{"verdict":"mixed","target_score":70,"dimensions":[]}'),
    /all dimensions/,
  );
});
