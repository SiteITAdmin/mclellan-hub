'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { _test: regTest } = require('../lib/regulatory-monitor');

test('Nakai regulatory monitor contains no US federal or state sources', () => {
  const rows = db.hub().prepare(`
    SELECT id, name
    FROM nakai_reg_monitor_sites
    WHERE id IN ('nrs_or_doj', 'nrs_tx_ag', 'nrs_naag')
       OR id LIKE 'nrs_us_%'
       OR name LIKE 'US financial regulator — %'
       OR name LIKE 'US Attorney General — %'
  `).all();
  assert.deepEqual(rows, []);
});

test('FCA uses its server-rendered HTML instead of the broken browser route', () => {
  const source = db.hub().prepare(`
    SELECT url, browser, cadence, active
    FROM nakai_reg_monitor_sites
    WHERE id = 'nrs_fca'
  `).get();
  assert.deepEqual(source, {
    url: 'https://www.fca.org.uk/news',
    browser: 0,
    cadence: 'daily',
    active: 1,
  });
});

test('Central Bank Markets Update is a first-class daily EU source', () => {
  const source = db.hub().prepare(`
    SELECT name, url, browser, cadence, active
    FROM nakai_reg_monitor_sites
    WHERE id = 'nrs_cbi_markets'
  `).get();
  assert.deepEqual(source, {
    name: 'Central Bank of Ireland Markets Update',
    url: 'https://www.centralbank.ie/regulation/markets-update',
    browser: 0,
    cadence: 'daily',
    active: 1,
  });
});

test('server-rendered scraper keeps long regulator headline anchors', () => {
  const padding = '<span class="meta">Regulator publication metadata</span>'.repeat(5);
  const html = `<a href="/news/blogs/strengthening-resilience">${padding}<span>Strengthening resilience across an increasingly interconnected financial system</span><time>28/07/2026</time></a>`;
  const rows = regTest.extractSameDomainLinks(html, 'https://www.fca.org.uk/news');
  assert.deepEqual(rows, [{
    url: 'https://www.fca.org.uk/news/blogs/strengthening-resilience',
    title: 'Regulator publication metadata'.repeat(5) + 'Strengthening resilience across an increasingly interconnected financial system28/07/2026',
  }]);
});

test('regulator search-result navigation cannot consume the new-item cap', () => {
  assert.equal(regTest.isJunkUrl('https://www.fca.org.uk/news/search-results?n_search_term=&category=blogs'), true);
  assert.equal(regTest.isJunkUrl('https://www.fca.org.uk/news/blogs/outcomes-monitoring'), false);
});
