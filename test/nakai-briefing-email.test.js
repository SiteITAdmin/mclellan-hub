const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertStoredBriefingPdf,
  buildStoredBriefingEmailPayload,
  _test: { douglasSentConfirmationPayload, extractMarkdownSection },
} = require('../scripts/build-nakai-daily-briefing');

function makeTempManifest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nakai-briefing-email-'));
  const pdfPath = path.join(dir, 'briefing.pdf');
  const mdPath = path.join(dir, 'briefing.md');
  const htmlPath = path.join(dir, 'briefing.html');
  fs.writeFileSync(pdfPath, Buffer.concat([
    Buffer.from('%PDF-1.7\n'),
    Buffer.alloc(2048, 'x'),
  ]));
  fs.writeFileSync(mdPath, '# Daily Briefing 010\n\n28 June 2026\n\n## Signals\n\nUseful briefing body.\n');
  fs.writeFileSync(htmlPath, '<!doctype html><html><body><h1>Full report</h1></body></html>');
  return {
    edition: '010',
    date: '2026-06-28',
    label: '28 June 2026',
    title: 'Daily Briefing 010',
    mdPath,
    htmlPath,
    pdfPath,
  };
}

test('Nakai briefing email is a short cover note with a valid PDF attachment', () => {
  const manifest = makeTempManifest();
  const payload = buildStoredBriefingEmailPayload(manifest);

  assert.equal(payload.subject, 'Daily Briefing 010 - 28 June 2026');
  assert.match(payload.html, /The PDF report is attached/);
  assert.doesNotMatch(payload.html, /Full report/);
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].filename, 'Daily Briefing 010.pdf');
  assert.equal(payload.attachments[0].content_type, 'application/pdf');
  assert.equal(Buffer.from(payload.attachments[0].content, 'base64').slice(0, 4).toString(), '%PDF');
});

test('extractMarkdownSection pulls only the named heading\'s body', () => {
  const markdown = [
    '# Daily Briefing 010',
    '',
    '## Executive Readout',
    '- First highlight.',
    '- Second highlight.',
    '',
    '## Watchlist for Nakai',
    '1. Do the thing.',
    '',
    '## Sources',
    '1. [L1] Something - https://example.com',
  ].join('\n');

  assert.equal(extractMarkdownSection(markdown, 'Executive Readout'), '- First highlight.\n- Second highlight.');
  assert.equal(extractMarkdownSection(markdown, 'Watchlist for Nakai'), '1. Do the thing.');
  assert.equal(extractMarkdownSection(markdown, 'Missing Heading'), '');
});

test('Douglas sent-confirmation quotes the actual Readout and Watchlist, not just a status line', () => {
  const manifest = { edition: '010', label: '28 June 2026', to: 'nakai@mclellan.scot', sentAt: '2026-06-28T06:05:08.000Z' };
  const markdown = [
    '# Daily Briefing 010',
    '',
    '## Executive Readout',
    '- Nothing new from ESMA today.',
    '',
    '## Watchlist for Nakai',
    '1. Confirm the CMDI deadline.',
  ].join('\n');

  const { subject, text } = douglasSentConfirmationPayload(manifest, markdown);
  assert.match(subject, /Confirmed — Daily Briefing 010 written and sent to nakai@mclellan\.scot/);
  assert.match(text, /Nothing new from ESMA today\./);
  assert.match(text, /Confirm the CMDI deadline\./);
  assert.match(text, /generated and emailed to nakai@mclellan\.scot/);
});

test('Nakai briefing send refuses to proceed without a real stored PDF', () => {
  const manifest = makeTempManifest();
  fs.writeFileSync(manifest.pdfPath, 'not a pdf');

  assert.throws(
    () => assertStoredBriefingPdf(manifest),
    /not a valid PDF artifact/
  );
});
