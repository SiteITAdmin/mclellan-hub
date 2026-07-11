'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  US_STATE_FINANCIAL_REGULATORS,
  US_STATE_AG_NEWSROOMS,
  NAAG_NEWSROOM,
} = require('../lib/us-regulatory-sources');

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

test('all supplied state AG newsrooms are normal daily monitor sites', () => {
  const seeded = db.hub().prepare(`
    SELECT name, browser, cadence, active
    FROM nakai_reg_monitor_sites
    WHERE name LIKE 'US Attorney General — %'
  `).all();
  const separatelySeeded = db.hub().prepare(`
    SELECT COUNT(*) AS n FROM nakai_reg_monitor_sites WHERE id IN ('nrs_or_doj', 'nrs_tx_ag')
  `).get().n;

  assert.equal(seeded.length + separatelySeeded, US_STATE_AG_NEWSROOMS.length);
  assert.ok(seeded.every(row => row.browser === 0 && row.cadence === 'daily' && row.active === 1));
  assert.ok(seeded.some(row => /California Department/.test(row.name)));
  assert.ok(seeded.some(row => /New York Attorney/.test(row.name)));
});

test('NAAG newsroom is a normal daily multistate-action source', () => {
  const source = db.hub().prepare(`
    SELECT name, url, browser, cadence, active FROM nakai_reg_monitor_sites WHERE id = 'nrs_naag'
  `).get();
  assert.deepEqual(source, {
    name: NAAG_NEWSROOM.name,
    url: NAAG_NEWSROOM.url,
    browser: 0,
    cadence: 'daily',
    active: 1,
  });
});
