'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { officialSourceUrl, connectionStatus } = require('../lib/m365-briefing-sources');
const { dateMeta, validateMarkdown, _test: { extractRollingWatchlistItems } } = require('../scripts/build-m365-daily-briefing');

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

test('Rolling Watchlist table rows become one consolidated task\'s subtask candidates, not many separate tasks', () => {
  const markdown = `# M365 Operations & Security Brief 003

## Executive Readout
Summary.

## Rolling Watchlist

| Item | Status | Why it stays open |
|---|---|---|
| Entra passkey default / SMS-voice retirement by 2027 | **Unverified** | Contextual digest only [S24] |
| CVE-2026-56191 Exchange Online auth bypass (CVSS 10.0) | **Open** | Service-side, scope changed [S46] |
| CloudWave and Artemis | **Unmapped** | Product and evidence channel not yet recorded |

## Coverage and Source Health
Fine.

## Sources
None.`;

  const items = extractRollingWatchlistItems(markdown);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { item: 'Entra passkey default / SMS-voice retirement by 2027', status: 'Unverified', why: 'Contextual digest only [S24]' });
  assert.equal(items[1].status, 'Open');
  assert.equal(items[2].item, 'CloudWave and Artemis');
});

test('extractRollingWatchlistItems returns nothing when the section is absent', () => {
  assert.deepEqual(extractRollingWatchlistItems('# M365 Operations & Security Brief 001\n\n## Sources\nNone.'), []);
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
