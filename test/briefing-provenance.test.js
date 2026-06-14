const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBriefingProvenance,
  briefingProvenanceText,
  buildBriefingPdfHtml,
} = require('../lib/newsletter-pipeline');

test('briefing provenance groups extraction models and direct RSS sources', () => {
  const provenance = buildBriefingProvenance([
    {
      source_name: 'The Rundown AI',
      extraction_model_id: 'google/gemini-2.5-flash-lite',
      extraction_model_label: 'Gemini 2.5 Flash Lite',
      extraction_method: 'ai',
    },
    {
      source_name: 'The Rundown AI',
      extraction_model_id: 'google/gemini-2.5-flash-lite',
      extraction_model_label: 'Gemini 2.5 Flash Lite',
      extraction_method: 'ai',
    },
    {
      source_name: 'Financial Times',
      extraction_method: 'direct_rss',
    },
  ], 'anthropic/claude-sonnet-4-6');

  assert.equal(provenance.item_count, 3);
  assert.equal(provenance.source_count, 2);
  assert.equal(provenance.extraction_models[0].item_count, 2);
  assert.equal(provenance.extraction_models[0].source_count, 1);
  assert.equal(provenance.direct_ingestion.item_count, 1);

  const text = briefingProvenanceText({ provenance_json: JSON.stringify(provenance) });
  assert.match(text, /Briefing written by/);
  assert.match(text, /Gemini 2\.5 Flash Lite extracted 2 items from 1 source/);
  assert.match(text, /1 item was ingested directly from RSS/);
});

test('PDF includes production provenance when supplied', () => {
  const provenance = {
    writer: { label: 'Claude Sonnet 4.6' },
    item_count: 4,
    source_count: 3,
    extraction_models: [{
      label: 'Gemini 2.5 Flash Lite',
      item_count: 4,
      source_count: 3,
    }],
    direct_ingestion: { item_count: 0, source_count: 0 },
    unattributed_item_count: 0,
  };
  const html = buildBriefingPdfHtml(
    '## Lead\nText.',
    '8–14 June 2026',
    'Anthropic / Claude',
    provenance
  );

  assert.match(html, /Production provenance/);
  assert.match(html, /Claude Sonnet 4\.6/);
  assert.match(html, /Gemini 2\.5 Flash Lite extracted 4 items from 3 sources/);
});
