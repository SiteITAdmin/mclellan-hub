'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../scripts/build-us-block-special-briefing');

function pack(snippet = 'Official action involving Block Inc and Cash App.') {
  return { items: [{ marker: 'U1', title: 'Official Block Inc Cash App action', url: 'https://example.gov/story', source: 'Example AG', snippet }] };
}

test('publication gate suppresses generic crypto or keyword-only stories', () => {
  const result = _test.gateDecision({
    publish: true,
    decision_reason: 'generic crypto story',
    stories: [{ title: 'Crypto enforcement update', url: 'https://example.gov/story', block_product: 'Cash App', what_happened: 'Unknown', why_it_matters: 'Unknown', source_markers: ['U1'], confidence: 'high' }],
  }, pack('Official update about an unrelated crypto company.'));
  assert.equal(result.publish, false);
  assert.equal(result.stories.length, 0);
});

test('publication gate accepts only a direct high-confidence Block/product story', () => {
  const result = _test.gateDecision({
    publish: true,
    decision_reason: 'State action names Block and Cash App.',
    stories: [{ title: 'State action names Block Inc and Cash App', url: 'https://example.gov/story', block_product: 'Cash App', what_happened: 'The authority announced an action.', why_it_matters: 'Review the product and control implications.', source_markers: ['U1'], confidence: 'high' }],
  }, pack());
  assert.equal(result.publish, true);
  assert.equal(result.stories[0].source_markers[0], 'U1');
});

test('special-edition markdown carries only gated source markers', () => {
  const markdown = _test.renderMarkdown({ title: 'US Block Special Edition', label: '1 August 2026' }, {
    decision_reason: 'A direct story cleared the gate.',
    stories: [{ title: 'State action names Block Inc and Cash App', block_product: 'Cash App', what_happened: 'The authority announced an action.', why_it_matters: 'Review the implications.', source_markers: ['U1'] }],
  }, pack());
  assert.match(markdown, /# US Block Special Edition/);
  assert.match(markdown, /\[U1\]/);
  assert.match(markdown, /https:\/\/example\.gov\/story/);
});
