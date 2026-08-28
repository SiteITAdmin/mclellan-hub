'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-source-admission-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { admitSource, admissionHealth, ADMISSION_STAGE } = require('../lib/source-admission');

const user = 'source-admission-test';
let seq = 0;

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function email({ body = null, subject = 'Outstanding items', from = 'Neil Brennan', fromEmail = 'neil@beaconhospital.ie' } = {}) {
  const id = `admission-email-${++seq}`;
  db.hub().prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, `${id}-msg`, subject, from, fromEmail, 1785900000 + seq, 'multiple items', body);
  return id;
}

function receipts(sourceId) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_id = ? AND stage = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(user, sourceId, ADMISSION_STAGE);
}

test('a complete capture is admitted and says so', () => {
  const id = email({ body: 'Please approve the agency invoice before Friday.' });
  const result = admitSource(user, 'email_summary', id, { ingester: 'agentmail' });

  assert.equal(result.admitted, true);
  assert.equal(result.complete, true);
  assert.equal(result.completeness, 'complete');
  const rows = receipts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'done');
  assert.equal(JSON.parse(rows[0].payload).ingester, 'agentmail');
});

test('a body-less capture fails at the door it came through, not three stages later', () => {
  // The 2 August shape: AgentMail stored the record, reported success, and the
  // forwarded body was never there.
  const id = email({ body: null });
  const result = admitSource(user, 'email_summary', id, { ingester: 'agentmail' });

  assert.equal(result.admitted, true, 'a partial source is kept, not discarded');
  assert.equal(result.complete, false);
  assert.equal(result.completeness, 'summary_only_missing_raw_body');

  const rows = receipts(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'review', 'an unreadable capture must not look done');
  assert.match(rows[0].summary, /agentmail captured incomplete evidence/);
});

test('re-admitting the same revision does not pile up receipts', () => {
  const id = email({ body: 'Confirm the theatre list dates for September.' });
  const first = admitSource(user, 'email_summary', id, { ingester: 'agentmail' });
  const second = admitSource(user, 'email_summary', id, { ingester: 'agentmail' });

  assert.equal(second.repeat, true);
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(receipts(id).length, 1);
});

test('a later body backfill is admitted again as a new revision', () => {
  const id = email({ body: null });
  const before = admitSource(user, 'email_summary', id, { ingester: 'agentmail' });
  assert.equal(before.complete, false);

  db.hub().prepare('UPDATE email_summaries SET body_text = ? WHERE id = ?')
    .run('The body that should have been captured the first time.', id);
  const after = admitSource(user, 'email_summary', id, { ingester: 'agentmail-backfill' });

  assert.equal(after.complete, true, 'a repaired source must be able to become complete');
  assert.notEqual(after.revision_hash, before.revision_hash);
  const rows = receipts(id);
  assert.equal(rows.length, 2, 'the original incomplete verdict stays as audit evidence');
  assert.equal(rows[0].status, 'review');
  assert.equal(rows[1].status, 'done');
});

test("the Hub's own report mail is admitted as excluded, not as a failure", () => {
  const id = email({
    subject: 'Fwd: M365 Operations & Security Brief 018 - 18 August 2026',
    body: 'Jane Whelan ’ s E3 administrative function/licence gap for RoPA and data-protection work [S25] [S9]',
  });
  const result = admitSource(user, 'email_summary', id, { ingester: 'gmail:received' });

  assert.equal(result.excluded, true);
  assert.equal(result.exclusion_reason, 'hub_generated_report');
  const receipt = receipts(id)[0];
  assert.equal(receipt.status, 'skipped', 'a deliberate boundary is not a capture error');
  assert.match(receipt.summary, /hub_generated_report/);
  assert.equal(JSON.parse(receipt.payload).exclusion_reason, 'hub_generated_report');
});

test('an ingester that captured nothing readable is named as silently failing', () => {
  const health = admissionHealth(user, { sinceSeconds: 3600 });
  const agentmail = health.ingesters.find(entry => entry.ingester === 'agentmail');
  assert.ok(agentmail, 'the ingester must appear in health by name');
  assert.ok(agentmail.captured > 0);

  // Give a fresh ingester nothing but body-less captures — the exact state
  // that stayed invisible on 2 August.
  for (let i = 0; i < 3; i += 1) {
    admitSource(user, 'email_summary', email({ body: null }), { ingester: 'broken-reader' });
  }
  const after = admissionHealth(user, { sinceSeconds: 3600 });
  const broken = after.silentlyFailing.find(entry => entry.ingester === 'broken-reader');
  assert.ok(broken, 'an ingester with no complete captures at all must be flagged');
  assert.equal(broken.complete, 0);
  assert.equal(broken.incomplete, 3);
  assert.equal(broken.reasons.summary_only_missing_raw_body, 3);

  assert.ok(
    !after.silentlyFailing.some(entry => entry.ingester === 'agentmail'),
    'an ingester with healthy captures must not be flagged',
  );
});

test('the daily report names the failing ingester in plain words', () => {
  // A receipt nobody reads is still a silent failure. This is the line that
  // should have appeared on the morning of 2 August.
  const reportUser = 'source-admission-report';
  for (let i = 0; i < 3; i += 1) {
    const id = `admission-report-${++seq}`;
    db.hub().prepare(`
      INSERT INTO email_summaries
        (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
      VALUES (?, ?, ?, 'Outstanding items', 'Neil', 'neil@beaconhospital.ie', ?, 'multiple items', NULL)
    `).run(id, reportUser, `${id}-msg`, 1785900000 + seq);
    admitSource(reportUser, 'email_summary', id, { ingester: 'agentmail' });
  }

  const section = require('../lib/system-report').ingestSection(reportUser);
  assert.match(section, /INGEST/);
  assert.match(section, /0\/3 readable/);
  assert.match(section, /NEEDS YOU — agentmail captured 3 source\(s\) and could not read any of them/);
});

test('an unreadable row is recorded as an error against its ingester', () => {
  const result = admitSource(user, 'email_summary', 'admission-does-not-exist', { ingester: 'agentmail' });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'raw_source_not_readable');
  assert.equal(receipts('admission-does-not-exist')[0].status, 'error');
});

test('an unknown source kind is refused rather than silently recorded', () => {
  const result = admitSource(user, 'carrier_pigeon', 'whatever', { ingester: 'agentmail' });
  assert.equal(result.admitted, false);
  assert.equal(result.reason, 'unsupported_source_kind');
});

test('an unintelligible Krisp transcript is an admission error, named in INGEST', () => {
  const fragments = [];
  for (let i = 0; i < 400; i++) {
    fragments.push('Something.', 'The man had black teeth.', "I don't know.", 'Yeah.');
  }
  const transcript = ['Douglas McLellan | 00:00', ...fragments].join('\n');
  const id = `admission-noise-${++seq}`;
  db.hub().prepare(`
    INSERT INTO meeting_intakes
      (id, user, title, transcript, status, extraction, created_counts)
    VALUES (?, ?, ?, ?, 'draft', '{}', '{}')
  `).run(id, user, 'Mobile recording', transcript);

  const result = admitSource(user, 'meeting_intake', id, { ingester: 'krisp' });
  assert.equal(result.admitted, true);
  assert.equal(result.complete, false);
  assert.equal(result.completeness, 'unintelligible_transcript');
  const receipt = receipts(id)[0];
  assert.equal(receipt.status, 'error');
  assert.match(receipt.summary, /unintelligible transcript/);

  const section = require('../lib/system-report').ingestSection(user);
  assert.match(section, /NEEDS YOU — krisp captured 1 unintelligible transcript/);
  assert.match(section, new RegExp(`/crm/meeting-intake\\?intake=${id}`));
});
