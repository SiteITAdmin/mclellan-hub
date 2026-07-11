'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { US_STATE_FINANCIAL_REGULATORS } = require('../lib/us-regulatory-sources');

test('Oregon DOJ news is a normal daily regulatory monitor source', () => {
  const source = db.hub().prepare(`
    SELECT name, url, browser, cadence, active
    FROM nakai_reg_monitor_sites
    WHERE id = 'nrs_or_doj'
  `).get();

  assert.deepEqual(source, {
    name: 'Oregon Department of Justice',
    url: 'https://www.doj.state.or.us/media/news-media-releases/oregon-doj-news/',
    browser: 0,
    cadence: 'daily',
    active: 1,
  });
});

test('all supplied US financial regulator sources are normal daily monitor sites', () => {
  const rows = db.hub().prepare(`
    SELECT name, browser, cadence, active
    FROM nakai_reg_monitor_sites
    WHERE name LIKE 'US financial regulator — %'
  `).all();

  assert.equal(rows.length, US_STATE_FINANCIAL_REGULATORS.length);
  assert.ok(rows.every(row => row.browser === 0 && row.cadence === 'daily' && row.active === 1));
  assert.ok(rows.some(row => /California Department/.test(row.name)));
  assert.ok(rows.some(row => /Puerto Rico/.test(row.name)));
});

test('Texas Attorney General news is a normal daily monitor source', () => {
  const source = db.hub().prepare(`
    SELECT url, browser, cadence, active FROM nakai_reg_monitor_sites WHERE id = 'nrs_tx_ag'
  `).get();
  assert.deepEqual(source, {
    url: 'https://www.texasattorneygeneral.gov/news', browser: 0, cadence: 'daily', active: 1,
  });
});
