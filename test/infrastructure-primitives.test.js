'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildIngestionPackage,
  chunkMarkdown,
} = require('../lib/heavy-file-ingestion');
const {
  shouldUseCurrentInfoSearch,
  formatCurrentInfoContext,
} = require('../lib/current-info-search');
const {
  buildHtmlArtifact,
} = require('../lib/html-artifact-builder');
const {
  systemReportMarkdown,
} = require('../lib/system-report');

test('heavy ingestion writes a reusable artifact package', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ingest-'));
  const pkg = await buildIngestionPackage({
    id: 'doc-123',
    user: 'douglas',
    filename: 'care plan.pdf',
    mimetype: 'application/pdf',
    sizeBytes: 42,
    markdown: '# Care Plan\n\nAlister lives at 12 Example Street.\n\nMedication visit due.',
    project: { id: 'p1', slug: 'dad', name: 'Dad' },
    rootDir,
  });

  assert.equal(pkg.markdown.includes('Alister lives'), true);
  assert.equal(fs.existsSync(pkg.indexPath), true);
  const index = JSON.parse(fs.readFileSync(pkg.indexPath, 'utf8'));
  assert.equal(index.schema, 'mclellan.ingestion-package.v1');
  assert.equal(index.project.slug, 'dad');
  assert.equal(index.artifacts[0].path, 'artifacts/source.md');
});

test('heavy ingestion chunks large markdown at readable boundaries', () => {
  const chunks = chunkMarkdown(`${'A sentence. '.repeat(800)}\n\n## Next\n\n${'B sentence. '.repeat(200)}`, 1000);
  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every(chunk => chunk.length <= 1300), true);
});

test('current info primitive recognises stale-risk questions and formats dated sources', () => {
  assert.equal(shouldUseCurrentInfoSearch('What is the latest OpenAI API pricing?'), true);
  assert.equal(shouldUseCurrentInfoSearch('Summarise this uploaded document'), false);

  const context = formatCurrentInfoContext({
    query: 'latest CBI guidance',
    provider: 'brave',
    checkedAt: '2026-06-20T09:00:00.000Z',
    sources: [{
      title: 'Central Bank update',
      url: 'https://example.test/cbi',
      snippet: 'Guidance changed.',
      checkedAt: '2026-06-20T09:00:00.000Z',
    }],
  });
  assert.match(context, /Checked: 2026-06-20T09:00:00.000Z/);
  assert.match(context, /\[1\] Central Bank update/);
});

test('html artifact builder produces a single offline HTML document', () => {
  const html = buildHtmlArtifact({
    title: 'Connectivity Review',
    subtitle: 'Synthetic check',
    markdown: '## Findings\n\n- One orphan task\n\n[Source](https://example.test)',
    generatedAt: new Date('2026-06-20T09:00:00.000Z'),
  });

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<style>/);
  assert.match(html, /One orphan task/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /rel="stylesheet"/i);
});

test('system report sections can be converted to artifact markdown', () => {
  const markdown = systemReportMarkdown([
    'McLellan Hub — Daily System Report\nSaturday 20 June 2026',
    'MODULE HEALTH — all checks passed',
    'ACTIVITY SUMMARY\nGmail processed     : 3 emails',
  ]);

  assert.match(markdown, /^# McLellan Hub/);
  assert.match(markdown, /## MODULE HEALTH/);
  assert.match(markdown, /Gmail processed/);
});
