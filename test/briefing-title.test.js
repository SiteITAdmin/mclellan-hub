const test = require('node:test');
const assert = require('node:assert/strict');

const {
  briefingFormatName,
  briefingTitle,
  briefingPdfFilename,
} = require('../lib/newsletter-pipeline');

test('briefing title uses its saved format name and date range', () => {
  const briefing = {
    format_name: 'Anthropic / Claude',
    date_from: '2026-06-08',
    date_to: '2026-06-14',
  };

  assert.equal(briefingFormatName(briefing), 'Anthropic / Claude');
  assert.equal(briefingTitle(briefing), 'Anthropic / Claude — 8 Jun – 14 Jun 2026');
  assert.equal(briefingPdfFilename(briefing), 'anthropic-claude-8-jun-14-jun-2026.pdf');
});

test('briefing title falls back to a linked format for existing records', () => {
  assert.equal(
    briefingFormatName({ linked_format_name: 'Daily Intelligence' }),
    'Daily Intelligence'
  );
});
