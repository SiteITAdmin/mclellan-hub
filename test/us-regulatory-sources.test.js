'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  US_STATE_FINANCIAL_REGULATORS,
  PRODUCT_REGULATORY_QUERIES,
  regulatorForUrl,
  sourceIsFresh,
  officialDiscoverySources,
} = require('../lib/us-regulatory-sources');

test('US authority registry covers every state financial regulator plus DC', () => {
  assert.ok(US_STATE_FINANCIAL_REGULATORS.length >= 51);
  assert.ok(US_STATE_FINANCIAL_REGULATORS.some(s => /Oregon Division/.test(s.name)));
  assert.ok(US_STATE_FINANCIAL_REGULATORS.some(s => /New York State/.test(s.name)));
  assert.ok(US_STATE_FINANCIAL_REGULATORS.some(s => /District of Columbia/.test(s.name)));
});

test('official discovery admits Oregon DOJ and rejects press coverage', () => {
  assert.equal(
    regulatorForUrl('https://www.doj.state.or.us/wp-content/uploads/2026/07/cash-app.pdf'),
    'Oregon Department of Justice'
  );
  assert.equal(regulatorForUrl('https://techcrunch.com/example'), null);
  assert.equal(regulatorForUrl('https://www.reuters.com/example'), null);
  assert.equal(
    regulatorForUrl('https://portal.ct.gov/ag/press-releases/2026/cash-app'),
    'US official source (portal.ct.gov)'
  );

  const sources = officialDiscoverySources([
    { title: 'Cash App judgment', url: 'https://www.doj.state.or.us/example.pdf' },
    { title: 'Cash App story', url: 'https://techcrunch.com/example' },
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].regulator, 'Oregon Department of Justice');
});

test('official discovery rejects stale dated regulator documents', () => {
  assert.equal(sourceIsFresh(
    { url: 'https://dfpi.ca.gov/wp-content/uploads/sites/337/2020/03/afterpay-settlement.pdf' },
    { now: new Date('2026-07-11T00:00:00Z') }
  ), false);
  assert.equal(sourceIsFresh(
    { url: 'https://www.doj.state.or.us/2026/07/cash-app.pdf' },
    { now: new Date('2026-07-11T00:00:00Z') }
  ), true);
});

test('official product discovery covers the full Block product family', () => {
  const queryText = PRODUCT_REGULATORY_QUERIES.join(' ');
  for (const product of ['Block Inc', 'Cash App', 'Square', 'Afterpay', 'Clearpay', 'Bitkey', 'Proto', 'TIDAL']) {
    assert.match(queryText, new RegExp(product, 'i'));
  }
});
