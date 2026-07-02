'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the modules the pipeline pulls in before requiring it, so the retry
// path runs without network, Gmail, or a real OpenRouter call. Cache entries
// must be planted before nakai-intelligence-pipeline is required.
const buildPath = require.resolve('../scripts/build-nakai-daily-briefing');
const gmailPath = require.resolve('../lib/gmail');
const monitorPath = require.resolve('../lib/regulatory-monitor');

let briefingBehaviour = async () => { throw new Error('stub not configured'); };
const sentEmails = [];

require.cache[buildPath] = {
  id: buildPath,
  filename: buildPath,
  loaded: true,
  exports: { sendTodayNakaiDailyBriefing: (...args) => briefingBehaviour(...args) },
};
require.cache[gmailPath] = {
  id: gmailPath,
  filename: gmailPath,
  loaded: true,
  exports: { sendEmail: async (fromUser, to, subject, body) => { sentEmails.push({ fromUser, to, subject, body }); } },
};
require.cache[monitorPath] = {
  id: monitorPath,
  filename: monitorPath,
  loaded: true,
  exports: { runRegulatoryMonitor: async () => ({ runId: null, sourceSummary: [], panicReasons: [] }) },
};

const db = require('../lib/db');
const { retryDailyBriefing } = require('../lib/nakai-intelligence-pipeline');

const RUN_ID = `briefing-retry-test-${Date.now()}`;
// Far-future started_at so this row is the "latest run" the retry marks.
const FUTURE_EPOCH = Math.floor(Date.now() / 1000) + 1_000_000;

test.before(() => {
  db.hub().prepare(
    "INSERT INTO reg_monitor_runs (id, run_date, started_at) VALUES (?, '2099-01-01', ?)"
  ).run(RUN_ID, FUTURE_EPOCH);
});

test.after(() => {
  db.hub().prepare('DELETE FROM reg_monitor_runs WHERE id = ?').run(RUN_ID);
});

test('failed retry reports ok=false and sends no email', async () => {
  sentEmails.length = 0;
  briefingBehaviour = async () => { throw new Error('OpenRouter HTTP 402'); };
  const result = await retryDailyBriefing();
  assert.equal(result.ok, false);
  assert.equal(result.briefingError.message, 'OpenRouter HTTP 402');
  assert.equal(sentEmails.length, 0);
});

test('successful retry marks the latest run and emails a recovery confirmation', async () => {
  sentEmails.length = 0;
  briefingBehaviour = async () => ({ ok: true, skipped: false, manifest: { edition: '999', to: 'nakai@example.com' } });
  const result = await retryDailyBriefing();
  assert.equal(result.ok, true);
  const run = db.hub().prepare(
    'SELECT briefing_ok, briefing_edition, briefing_error FROM reg_monitor_runs WHERE id = ?'
  ).get(RUN_ID);
  assert.equal(run.briefing_ok, 1);
  assert.equal(run.briefing_edition, '999');
  assert.equal(run.briefing_error, null);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /RECOVERED — Daily Briefing 999/);
  assert.ok(sentEmails[0].to);
});

test('already-sent retry is ok but sends no duplicate recovery email', async () => {
  sentEmails.length = 0;
  briefingBehaviour = async () => ({ ok: true, skipped: true, manifest: { edition: '999', to: 'nakai@example.com' } });
  const result = await retryDailyBriefing();
  assert.equal(result.ok, true);
  assert.equal(sentEmails.length, 0);
});
