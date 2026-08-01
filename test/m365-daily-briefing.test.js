'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { officialSourceUrl, connectionStatus } = require('../lib/m365-briefing-sources');
const { dateMeta, validateMarkdown } = require('../scripts/build-m365-daily-briefing');

test('official source boundary accepts first-party sources and rejects commentary', () => {
  assert.equal(officialSourceUrl('https://learn.microsoft.com/en-us/intune/whats-new/'), true);
  assert.equal(officialSourceUrl('https://www.cisa.gov/known-exploited-vulnerabilities-catalog'), true);
  assert.equal(officialSourceUrl('https://example.com/microsoft-news'), false);
});

test('M365 date metadata creates a stable edition', () => {
  const meta = dateMeta(new Date('2026-08-01T12:00:00Z'));
  assert.equal(meta.iso, '2026-08-01');
  assert.equal(meta.edition, '001');
  assert.match(meta.title, /M365 Operations & Security Brief 001/);
});

test('connection status is explicit for integrations not yet configured', () => {
  const status = connectionStatus();
  assert.ok(status.some(row => row.source === 'Endpoint Central' && row.status === 'not connected'));
  assert.ok(status.some(row => row.source === 'SentinelOne' && row.status === 'not connected'));
  assert.ok(status.every(row => row.note));
});

test('briefing validator requires coverage and sources sections', () => {
  const markdown = `# M365 Operations & Security Brief 001

## Executive Readout
No material tenant-specific claim can be made.

## Coverage and Source Health
Endpoint Central is not connected.

## Sources
No sources cited.`;
  assert.equal(validateMarkdown(markdown, { edition: '001' }), markdown);
  assert.throws(() => validateMarkdown('# M365 Operations & Security Brief 001', { edition: '001' }), /Executive Readout/);
});
