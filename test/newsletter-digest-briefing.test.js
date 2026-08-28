'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  START_DATE,
  parseDigestSubject,
  editionForCoverageDate,
  validateMarkdown,
  _test,
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

test('previous Dublin day selection uses original newsletter evidence only, without a catch-up scan', () => {
  const rows = [
    { id: 'wanted', subject: 'Editorial newsletter', from_name: 'Editor', from_email: 'editor@example.com', body_text: 'Full editorial body', received_at: Date.parse('2026-08-27T10:00:00Z') / 1000 },
    { id: 'digest', subject: 'Newsletter digest — Wednesday 26 August 2026 (9 emails)', from_name: 'Hub', from_email: 'douglasnewsletters@agentmail.to', body_text: 'Wrapper', received_at: Date.parse('2026-08-27T08:00:00Z') / 1000 },
    { id: 'other-day', subject: 'Older newsletter', from_name: 'Editor', from_email: 'editor@example.com', body_text: 'Older body', received_at: Date.parse('2026-08-26T10:00:00Z') / 1000 },
  ];
  const hub = { prepare: () => ({ all: () => rows }) };
  const found = _test.briefingForCoverageDate(hub, '2026-08-27');
  assert.equal(found.meta.iso, '2026-08-27');
  assert.equal(found.meta.emailCount, 1);
  assert.deepStrictEqual(found.meta.sourceNewsletterIds, ['wanted']);
  assert.match(found.text, /Full editorial body/);
  assert.doesNotMatch(found.text, /Wrapper|Older body/);
});

test('previousDublinCoverageDate is the preceding calendar day', () => {
  assert.equal(_test.previousDublinCoverageDate(Date.parse('2026-08-28T04:30:00Z')), '2026-08-27');
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

test('validateMarkdown unwraps a fenced markdown response', () => {
  const meta = { edition: '002' };
  const inner = [
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
  assert.strictEqual(validateMarkdown('```markdown\n' + inner + '\n```', meta), inner);
});

test('validateMarkdown includes a snippet when the title is missing', () => {
  let err;
  try {
    validateMarkdown('Selected model is at capacity. Please try a different model.', { edition: '002' });
  } catch (caught) { err = caught; }
  assert.ok(err);
  assert.match(err.message, /required title/);
  assert.match(err.message, /at capacity/);
});
