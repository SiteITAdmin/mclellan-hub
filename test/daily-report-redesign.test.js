'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-daily-report-redesign-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { fallbackNarrative, gatherTodayContent } = require('../lib/daily-narrative');
const { hardToPlaceContent, hardToPlaceSection, selfRepairsSection, selfRepairRollup } = require('../lib/system-report');

const user = 'daily-report-redesign-test';
let seq = 0;
const rollupPath = path.join(__dirname, '..', 'data', 'repair-rollup.json');

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { fs.rmSync(rollupPath); } catch (_) {}
});

test('fallback narrative describes a quiet day honestly, and a busy day without raw counts leaking through unexplained', () => {
  assert.equal(fallbackNarrative({ emails: [], atoms: [], meetings: [], documents: [] }), 'Quiet day — nothing new came in.');
  const busy = fallbackNarrative({
    emails: [{ project_slug: 'halbeath' }, { project_slug: 'halbeath' }],
    atoms: [{ subject_label: 'Alister', predicate: 'has_gp', value: 'Dr Smith' }],
    meetings: [{ title: 'Catriona catch-up' }],
    documents: [{ filename: 'care-plan.pdf', project_id: null }],
  });
  assert.match(busy, /halbeath/);
  assert.match(busy, /Catriona catch-up/);
  assert.match(busy, /not yet filed/);
});

test('hard to place surfaces unlinked emails, unfiled documents, and stays quiet when nothing is outstanding', () => {
  const since = Math.floor(Date.now() / 1000) - 3600;
  const id = `email-${++seq}`;
  db.hub().prepare(`
    INSERT INTO email_summaries (id, user, gmail_message_id, subject, from_name, received_at, summary, project_slug, direction)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'received')
  `).run(id, user, `${id}-msg`, 'Unfiled thing', 'Someone', since + 10, 'summary');

  const { unlinkedEmails } = hardToPlaceContent(user, since);
  assert.equal(unlinkedEmails.length, 1);
  assert.equal(unlinkedEmails[0].subject, 'Unfiled thing');

  const section = hardToPlaceSection(user, since);
  assert.match(section, /Unfiled thing/);

  const emptySection = hardToPlaceSection('nobody-with-no-data', since);
  assert.match(emptySection, /Nothing outstanding/);
});

test('self-repairs section reports remediation fixes and reads the venue rollup file, ignoring a stale one', () => {
  const withRemediation = selfRepairsSection({ fixed: ['fixed the thing'], dispatched: [] });
  assert.match(withRemediation, /Remediation \(automatic, VPS-side\): fixed the thing/);

  fs.writeFileSync(rollupPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    entries: [
      { error_class: 'embedding_500', outcome: 'deployed', pr_url: 'https://github.com/x/y/pull/9' },
      { error_class: 'flaky_parse', outcome: 'reverted', branch: 'repair/flaky_parse' },
    ],
  }));
  const fresh = selfRepairRollup();
  assert.equal(fresh.entries.length, 2);
  const section = selfRepairsSection(null);
  assert.match(section, /auto-deployed embedding_500/);
  assert.match(section, /auto-reverted/);

  // A rollup older than 48h should be treated as no activity, not stale news.
  fs.writeFileSync(rollupPath, JSON.stringify({
    generated_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
    entries: [{ error_class: 'old_news', outcome: 'deployed' }],
  }));
  assert.equal(selfRepairRollup(), null);
  const staleSection = selfRepairsSection(null);
  assert.doesNotMatch(staleSection, /old_news/);
});

test('gatherTodayContent reads new content since a given time without throwing on an empty DB slice', () => {
  const content = gatherTodayContent('nobody-with-no-data', Math.floor(Date.now() / 1000) - 3600);
  assert.deepEqual(content.emails, []);
  assert.deepEqual(content.atoms, []);
});
