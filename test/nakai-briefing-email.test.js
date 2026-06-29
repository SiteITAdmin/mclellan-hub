const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertStoredBriefingPdf,
  buildStoredBriefingEmailPayload,
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

test('Nakai briefing send refuses to proceed without a real stored PDF', () => {
  const manifest = makeTempManifest();
  fs.writeFileSync(manifest.pdfPath, 'not a pdf');

  assert.throws(
    () => assertStoredBriefingPdf(manifest),
    /not a valid PDF artifact/
  );
});
