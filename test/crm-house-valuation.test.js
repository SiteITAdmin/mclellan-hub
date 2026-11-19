'use strict';

const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-house-valuation-'));
process.env.CRM_DB_PATH = path.join(dir, 'crm.db');
process.env.HUB_DB_PATH = path.join(dir, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';

const db = require('../lib/crm/db');
const house = require('../lib/crm/house');
const valuation = require('../lib/crm/house/valuation');

const T = Date.parse('2026-11-19T10:00:00Z') / 1000;
const COUNTY = 'Wicklow';
const LOCALITY = 'Bray';
const REGISTER = 'https://www.propertypriceregister.ie/';

beforeEach(() => {
  db._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
});

after(() => {
  db._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function property(title = '25 Oak Row') {
  return house.saveProperty({ title, address: `${title}, Bray, Co. Wicklow`, status: 'shortlisted', asking_price: '400000' });
}

function register(address, sold, extra = {}) {
  return { address: `${address}, Bray, Co. Wicklow`, county: COUNTY, eircode: '', day: '2026-09-14', sold, newBuild: false, url: REGISTER, ...extra };
}

function daft(n, extra = {}) {
  return {
    address: `${n} Elm Crescent, Bray`, day: '2026-10-20', sold: '400000', asking: '400000', beds: '3', area: '105',
    url: `https://www.daft.ie/sold/house-${n}-elm-crescent-bray/${5300000 + n}`, ...extra,
  };
}

const refresh = (home, rows) => valuation.refresh(home, {
  county: COUNTY, locality: LOCALITY, salesFor: async () => ({ rows, asOf: T }), t: T,
});

test('a sold-price estimate uses recent local resale evidence and counts each address once', async () => {
  const home = property();
  const rows = [
    register('11 Harbour Road', 389000),
    register('11 Harbour Road', 388000, { day: '2026-06-10' }),
    register('12 Harbour Road', 421000),
    register('13 Harbour Road', 467000),
    register('14 Harbour Road', 850000, { newBuild: true }),
    register('15 Harbour Road', 190000, { day: '2024-12-01' }),
    register('16 Harbour Road', 223000, { address: '16 Harbour Street, Arklow, Co. Wicklow' }),
    register('17 Harbour Road', 790000, { county: 'Dublin' }),
    register('Apartment 6 Harbour Place', 305000),
    register('18 Harbour Road', 295000, { address: '18 Bray Road, Greystones, Co. Wicklow' }),
  ];
  const estimate = await refresh(home, rows);
  assert.equal(estimate.status, 'ready');
  assert.equal(estimate.comparisons.length, 3);
  assert.deepEqual(estimate.comparisons.map(row => row.sold).sort((a, b) => a - b), [389000, 421000, 467000]);
  assert.ok(estimate.comparisons.every(row => row.url === REGISTER));
  assert.equal(estimate.mid, 420000);
  assert.ok(estimate.low <= estimate.mid && estimate.mid <= estimate.high);
  assert.equal(estimate.low % 5000, 0);
  assert.equal(estimate.high % 5000, 0);
  assert.equal(estimate.pairCount, 0);
  assert.equal(estimate.medianGap, null);
  assert.deepEqual(valuation.get(home, T), estimate);
  assert.equal(house.dashboard().properties.find(item => item.id === home.id).asking_price, 400000);

  const failure = await valuation.refresh(home, {
    t: T + 60, salesFor: async () => { throw new Error('Synthetic register outage'); },
  });
  assert.equal(failure.status, 'unavailable');
  assert.deepEqual(valuation.get(home, T + 60), estimate);
});

test('three same-estate sales take precedence over wider locality sales', async () => {
  const estimate = await refresh(property(), [
    register('21 Oak Row', 365000),
    register('22 Oak Row', 395000),
    register('24 Oak Row', 410000),
    register('12 Harbour Road', 820000, { day: '2026-11-10' }),
    register('13 Harbour Road', 845000, { day: '2026-11-11' }),
  ]);
  assert.equal(estimate.comparisons.length, 3);
  assert.equal(estimate.mid, 395000);
  assert.ok(estimate.comparisons.every(row => row.match === 'Same street or estate'));
});

test('two eligible register sales display their evidence without producing an estimate', async () => {
  const estimate = await refresh(property(), [
    register('1 Harbour Road', 410000),
    register('2 Harbour Road', 440000),
    register('3 Harbour Road', 475000, { newBuild: true }),
  ]);
  assert.equal(estimate.status, 'thin');
  assert.equal(estimate.comparisons.length, 2);
  assert.ok([estimate.low, estimate.mid, estimate.high].every(value => value == null));
});

test('the asking-to-sold median uses three documented pairs and leaves the estimate based on sold prices', async () => {
  const home = property();
  valuation.addComparable(home, daft(1));
  valuation.addComparable(home, daft(2, { sold: '430000' }));
  valuation.addComparable(home, daft(3, { sold: '460000', asking: '' }));
  valuation.addComparable(home, daft(4, { day: '2024-12-01', sold: '990000', asking: '495000' }));
  const overlappingRegister = [register('2 Elm Crescent', 430000, { address: '2 Elm Crescent, Bray' })];

  const incomplete = await refresh(home, overlappingRegister);
  assert.equal(incomplete.comparisons.length, 3);
  assert.equal(incomplete.mid, 430000);
  assert.equal(incomplete.pairCount, 2);
  assert.equal(incomplete.medianGap, null);

  valuation.addComparable(home, daft(5, { sold: '600000', asking: '500000' }));
  const estimate = await refresh(home, overlappingRegister);
  assert.equal(estimate.comparisons.length, 4);
  assert.equal(estimate.pairCount, 3);
  assert.ok(Math.abs(estimate.medianGap - 0.075) < 0.000001);
  assert.equal(estimate.mid, 445000);
});

test('manual comparables require a genuine Daft sold link and are scoped to their property', () => {
  const home = property();
  const other = property('29 Oak Row');
  for (const url of [
    'javascript:alert(1)',
    'http://www.daft.ie/sold/house-bray/5300001',
    'https://www.daft.ie.evil.example/sold/house-bray/5300001',
    'https://www.daft.ie/for-sale/house-bray/5300001',
  ]) assert.throws(() => valuation.addComparable(home, daft(1, { url })));
  assert.equal(valuation.listComparables(home).length, 0);

  valuation.addComparable(home, daft(1));
  const [saved] = valuation.listComparables(home);
  assert.equal(saved.url, daft(1).url);
  assert.equal(saved.sold, 400000);
  assert.equal(saved.asking, 400000);
  assert.equal(valuation.listComparables(other).length, 0);
  assert.equal(valuation.removeComparable(other, saved.id), 0);
  valuation.removeComparable(home, saved.id);
  assert.equal(valuation.listComparables(home).length, 0);
});
