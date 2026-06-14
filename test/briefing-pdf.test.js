const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');

test('briefing PDF HTML uses long-form paged report styling', () => {
  const html = buildBriefingPdfHtml(
    '## Lead story\nA useful paragraph.\n\n### Evidence\n- First point\n- Second point',
    '9–13 June 2026'
  );

  assert.match(html, /@page cover/);
  assert.match(html, /@page report/);
  assert.match(html, /class="report-masthead"/);
  assert.match(html, /class="report-end"/);
  assert.match(html, /<h2 class="rpt-h2">Lead story<\/h2>/);
  assert.match(html, /break-inside:avoid/);
  assert.doesNotMatch(html, /content-page/);
  assert.doesNotMatch(html, /position:fixed/);
});

test('briefing PDF markdown supports links, quotes, ordered lists, and rules', () => {
  const html = buildBriefingPdfHtml(
    '## Sources\n[Anthropic](https://anthropic.com)\n\n> Important context\n\n1. First\n2. Second\n\n---',
    'June 2026'
  );

  assert.match(html, /<a href="https:\/\/anthropic\.com">Anthropic<\/a>/);
  assert.match(html, /<blockquote class="rpt-quote">Important context<\/blockquote>/);
  assert.match(html, /<ol class="rpt-list rpt-ol">/);
  assert.match(html, /<hr class="rpt-rule">/);
});
