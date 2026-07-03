'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { getDailyPipelineRunState } = require('../lib/nakai-intelligence-pipeline');

const DATE_OK = '2099-02-01';
const DATE_FAILED = '2099-02-02';
const IDS = [
  'pipeline-state-unreported',
  'pipeline-state-reported-ok',
  'pipeline-state-reported-failed',
];

test.after(() => {
  const hub = db.hub();
  for (const id of IDS) hub.prepare('DELETE FROM reg_monitor_runs WHERE id = ?').run(id);
});

test('daily pipeline state ignores unreported runs', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO reg_monitor_runs
      (id, run_date, started_at, finished_at, briefing_ok, report_email_sent)
    VALUES (?, ?, ?, ?, 1, 0)
  `).run(IDS[0], DATE_OK, 4_071_000_000, 4_071_000_010);

  assert.deepEqual(getDailyPipelineRunState(DATE_OK), {
    reported: false,
    dateKey: DATE_OK,
  });
});

test('daily pipeline state reports an already emailed successful run', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO reg_monitor_runs
      (id, run_date, started_at, finished_at, briefing_edition, briefing_ok, report_email_sent)
    VALUES (?, ?, ?, ?, '999', 1, 1)
  `).run(IDS[1], DATE_OK, 4_071_000_020, 4_071_000_030);

  const state = getDailyPipelineRunState(DATE_OK);
  assert.equal(state.reported, true);
  assert.equal(state.runId, IDS[1]);
  assert.equal(state.briefingOk, true);
  assert.equal(state.briefingEdition, '999');
});

test('daily pipeline state exposes reported briefing failures for retry resume', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO reg_monitor_runs
      (id, run_date, started_at, finished_at, briefing_ok, briefing_error, report_email_sent)
    VALUES (?, ?, ?, ?, 0, 'OpenRouter HTTP 402', 1)
  `).run(IDS[2], DATE_FAILED, 4_071_000_040, 4_071_000_050);

  const state = getDailyPipelineRunState(DATE_FAILED);
  assert.equal(state.reported, true);
  assert.equal(state.runId, IDS[2]);
  assert.equal(state.briefingOk, false);
  assert.equal(state.briefingError, 'OpenRouter HTTP 402');
});
