'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  START_DATE,
  parseDigestSubject,
  editionForCoverageDate,
  validateMarkdown,
} = require('../scripts/build-newsletter-digest-briefing');

test('parseDigestSubject extracts coverage date and email count', () => {
  const parsed = parseDigestSubject('Newsletter digest — Tuesday 25 August 2026 (10 emails)');
  assert.deepStrictEqual(parsed, { coverageIso: '2026-08-25', emailCount: 10 });
});

test('parseDigestSubject handles single-email pluralisation', () => {
  const parsed = parseDigestSubject('Newsletter digest — Monday 24 August 2026 (1 email)');
  assert.strictEqual(parsed.coverageIso, '2026-08-24');
  assert.strictEqual(parsed.emailCount, 1);
});

test('parseDigestSubject rejects non-digest subjects', () => {
  assert.strictEqual(parseDigestSubject('Daily Consigliere Report — Tuesday, 25 August 2026'), null);
  assert.strictEqual(parseDigestSubject(''), null);
  assert.strictEqual(parseDigestSubject(null), null);
});

test('editions anchor to the coverage date with 25 Aug 2026 as edition 001', () => {
  assert.strictEqual(START_DATE, '2026-08-25');
  assert.strictEqual(editionForCoverageDate('2026-08-25'), '001');
  assert.strictEqual(editionForCoverageDate('2026-08-26'), '002');
});

test('editions before start date are inactive', () => {
  assert.strictEqual(editionForCoverageDate('2026-08-24'), null);
});

test('validateMarkdown enforces required house structure', () => {
  const meta = { edition: '002' };
  const good = [
    '# Newsletter Intelligence Brief 002',
    'Wednesday, 26 August 2026',
    '',
    '## Executive Readout',
    '- item',
    '',
    '## Coverage and Source Health',
    '- 9 of 10 emails carried editorial content.',
    '',
    '## Sources',
    '1. TLDR AI',
  ].join('\n');
  assert.strictEqual(validateMarkdown(good, meta), good);

  for (const missing of ['Executive Readout', 'Coverage and Source Health', 'Sources']) {
    const bad = good.replace(`## ${missing}`, '## Something Else');
    assert.throws(() => validateMarkdown(bad, meta), new RegExp(missing));
  }
  assert.throws(() => validateMarkdown('# Wrong Title\n\n## Executive Readout\n\n## Coverage and Source Health\n\n## Sources', meta), /required title/);
});
