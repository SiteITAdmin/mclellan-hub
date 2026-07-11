'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');

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
