'use strict';

const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-house-analysis-'));
process.env.CRM_DB_PATH = path.join(dir, 'crm.db');
process.env.HUB_DB_PATH = path.join(dir, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';

const hubDb = require('../lib/db');
const crmDb = require('../lib/crm/db');
const house = require('../lib/crm/house');
const daft = require('../lib/crm/house/daft');
const valuation = require('../lib/crm/house/valuation');
const listing = require('../lib/crm/house/listing');
const subJobs = require('../lib/subscription-agent-jobs');
const subAgent = require('../lib/subscription-agent');
const modelRoutes = require('../lib/model-routes');

const T = Date.parse('2026-11-20T12:00:00Z') / 1000;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

beforeEach(() => {
  crmDb._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  hubDb.hub().prepare('DELETE FROM subscription_agent_jobs').run();
});

after(() => {
  crmDb._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inferred locality prefers neighbourhood over Dublin postal district, and PPR extreme outliers are excluded', async () => {
  const prop = house.saveProperty({
    title: 'Apartment 2, The Kilmore, Santry',
    address: 'Apartment 2, The Kilmore, Santry, Dublin 9, D09E7K7',
    url: 'https://www.daft.ie/for-sale/apartment-2-the-kilmore-santry-dublin-9/6726265',
    asking_price: '290000',
    beds: '3',
    area: '83',
    status: 'researching',
  });

  const inf = valuation.inferred(prop);
  assert.equal(inf.county, 'Dublin');
  assert.equal(inf.locality, 'Santry');
  assert.equal(inf.district, 'Dublin 9');

  const pprRows = [
    { address: 'APT 7, COLLINS COURT, COLLINS AVE, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-10-20', sold: 370000, newBuild: false },
    { address: 'APT 18, GRACE PARK COURT, BEAUMONT RD, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-08-31', sold: 330000, newBuild: false },
    { address: 'APT 260, PARKLANDS, NORTHWOOD, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-08-20', sold: 355000, newBuild: false },
    { address: 'APT 20, GRACE PARK COURT, BEAUMONT RD, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-08-12', sold: 300000, newBuild: false },
    // Whole-building outliers that previously polluted the €355k–€440k range:
    { address: 'APT 1, 1 LOWER DRUMCONDRA ROAD, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-08-13', sold: 1400000, newBuild: false },
    { address: 'FLAT 1, 37 WHITWORTH RD, DRUMCONDRA, DUBLIN 9', county: 'Dublin', eircode: '', day: '2026-07-29', sold: 1180000, newBuild: false },
  ];

  const est = await valuation.refresh(prop, {
    salesFor: async () => ({ rows: pprRows, asOf: T }),
    t: T,
  });
  assert.equal(est.status, 'ready');
  assert.equal(est.outliersRemoved, 2);
  assert.ok(est.high <= 380000, `Expected outlier-free high <= 380000, got ${est.high}`);
  assert.ok(est.comparisons.every(c => c.sold < 500000));
});

test('Daft Sold parsing, similarity matching, 3 estimates (€/m², asking-trend, range) and Area History work end-to-end', async () => {
  const soldHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      pageProps: {
        listings: [
          { listing: { adId: 'S1', title: 'Apartment 33, The Charter, Santry Cross, Dublin 11', price: '€310,000', soldPrice: '€310,000', soldDate: '11/11/2026', propertySize: '82.0 m²', numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertyType: 'Apartment', ber: { rating: 'B3' }, seoFriendlyPath: '/sold/apt-33-charter/S1' } },
          { listing: { adId: 'S2', title: 'Apartment 107, The Plaza, Santry, Dublin 9', price: '€275,000', soldPrice: '€285,000', soldDate: '01/11/2026', propertySize: '81.0 m²', numBedrooms: '2 Bed', numBathrooms: '2 Bath', propertyType: 'Apartment', ber: { rating: 'C2' }, seoFriendlyPath: '/sold/apt-107-plaza/S2' } },
          { listing: { adId: 'S3', title: 'Apartment 14, The Kilmore, Santry, Dublin 9', price: '€295,000', soldPrice: '€315,000', soldDate: '15/10/2026', propertySize: '84.0 m²', numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertyType: 'Apartment', ber: { rating: 'C1' }, seoFriendlyPath: '/sold/apt-14-kilmore/S3' } },
          { listing: { adId: 'S4', title: '86 Lorcan Grove, Santry, Dublin 9', price: '€595,000', soldPrice: '€650,000', soldDate: '21/10/2026', propertySize: '142.0 m²', numBedrooms: '5 Bed', numBathrooms: '3 Bath', propertyType: 'Semi-D', ber: { rating: 'D1' }, seoFriendlyPath: '/sold/86-lorcan/S4' } },
        ],
      },
    },
  })}</script>`;

  const parsed = daft.parseSoldListings(soldHtml, { county: 'Dublin', locality: 'Santry' });
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].sold, 310000);
  assert.equal(parsed[0].asking, 310000);
  assert.equal(parsed[0].area, 82);
  assert.equal(parsed[0].beds, 3);
  assert.equal(parsed[0].day, '2026-11-11');

  const prop = house.saveProperty({
    title: 'Apartment 2, The Kilmore, Santry',
    address: 'Apartment 2, The Kilmore, Santry, Dublin 9, D09E7K7',
    asking_price: '290000',
    beds: '3',
    area: '83',
    status: 'researching',
  });

  const est = await valuation.refresh(prop, {
    salesFor: async () => ({ rows: [], asOf: T }),
    fetchSold: async () => ({ rows: parsed, areaSlug: 'santry-dublin', error: '' }),
    t: T,
  });

  // Semi-D 5-bed house (S4) must be excluded; only the 3 similar apartments match!
  assert.equal(est.status, 'ready');
  assert.equal(est.comparisons.length, 3);
  assert.ok(est.comparisons.every(c => c.property_type === 'Apartment'));
  // Same estate ("The Kilmore") ranks top
  assert.match(est.comparisons[0].address, /The Kilmore/);
  assert.equal(est.mid, 310000);
  assert.ok(est.sqmEstimate && est.sqmEstimate.perSqm > 3400 && est.sqmEstimate.estimate >= 290000 && est.sqmEstimate.estimate <= 325000);
  assert.equal(est.pairCount, 3);
  assert.ok(est.askEstimate >= 295000 && est.askEstimate <= 315000);
  assert.match(est.gapExplanation, /floor-area basis|paired Daft sales/i);

  // Area history aggregates all 4 stored Daft sales and filters by type & beds
  const allHist = valuation.areaHistory({ county: 'Dublin', locality: 'Santry' });
  assert.equal(allHist.count, 4);
  assert.equal(allHist.quarters[0].quarter, '2026 Q4');
  const apt3 = valuation.areaHistory({ county: 'Dublin', locality: 'Santry', propertyType: 'apartment', beds: 3 });
  assert.equal(apt3.count, 2);
});

test('keyword detector catches Vacant Home Grant, refurbishment, AMV, management fees, BER, and heating text', () => {
  const { signals, heating } = daft.extractSignals({
    title: '12 Old Lane, Bray',
    ber: 'F',
    selling_type: 'Online Auction',
    features: ['May qualify for Vacant Property Refurbishment Grant', 'Gas fired central heating', 'Chain-free'],
    facilities: ['Parking'],
    description: 'Advised Minimum Value €260,000. In need of modernisation throughout. Annual management fee is €2,950.',
  });

  const keys = signals.map(s => s.key);
  assert.ok(keys.includes('vacant_grant'));
  assert.ok(keys.includes('needs_work'));
  assert.ok(keys.includes('auction_amv'));
  assert.ok(keys.includes('management_fee'));
  assert.ok(keys.includes('ber_low'));
  assert.ok(keys.includes('chain_free'));
  assert.equal(heating.kind, 'gas');
  assert.ok(signals.every(s => s.quote && s.note));
});

test('listing inspection + multi-image photo heating analysis runs through model queue & /house routes', async () => {
  // Verify house_photos is registered in /models with image capability and priority 15
  assert.ok(modelRoutes.FUNCTIONS.some(f => f.fn === 'house_photos'));
  assert.equal(subJobs.priorityFor('crm_house_photos', {}), 15);
  assert.ok(subAgent.documentInput('check heating', [
    { type: 'image', mime: 'image/jpeg', data: JPEG.toString('base64') },
    { type: 'image', mime: 'image/png', data: PNG.toString('base64') },
  ], { maxImages: 10 }).includes('image/png'));

  const prop = house.saveProperty({
    title: 'Apartment 2, The Kilmore, Santry',
    address: 'Apartment 2, The Kilmore, Santry, Dublin 9',
    url: 'https://www.daft.ie/for-sale/apartment-2-the-kilmore-santry-dublin-9/6726265',
    asking_price: '290000',
    status: 'researching',
  });

  const inspected = await listing.inspect(prop, {
    analyzePhotos: true,
    fetchListing: async () => ({
      url: prop.url,
      title: prop.title,
      asking_price: 290000,
      property_type: 'Apartment',
      beds: 3,
      baths: 2,
      area: 83,
      ber: 'C3',
      selling_type: 'Private Treaty',
      date_of_construction: '2005',
      description: 'Spacious 3-bed ground-floor apartment. May qualify for Vacant Home Grant if vacant over 2 years. Chain-free sale.',
      features: ['South-facing patio', 'Allocated car parking space'],
      facilities: ['Parking'],
      images: [
        { url: 'https://media.daft.ie/photo1.jpg', thumb: 'https://media.daft.ie/photo1-sm.jpg' },
        { url: 'https://media.daft.ie/photo2.jpg', thumb: 'https://media.daft.ie/photo2-sm.jpg' },
      ],
    }),
    fetchImage: async () => JPEG,
    jobs: subJobs,
    t: T,
  });

  // Auto-filled beds/area from listing + queued vision job
  const updatedProp = house.dashboard().properties.find(x => x.id === prop.id);
  assert.equal(updatedProp.beds, 3);
  assert.equal(updatedProp.area, 83);
  assert.equal(inspected.photo_status, 'waiting');
  assert.equal(inspected.heating.kind, 'unlisted');
  assert.ok(inspected.signals.some(s => s.key === 'vacant_grant'));

  // Fast-lane worker claims priority 15 photo job and completes with boiler + wet radiator findings
  const claimed = subJobs.claim({ workerId: 'dev-server-fast', maxPriority: 30 }).jobs[0];
  assert.ok(claimed);
  assert.equal(claimed.feature, 'crm_house_photos');
  assert.equal(claimed.payload.documents.length, 2);

  await subJobs.complete({
    jobId: claimed.id,
    claimToken: claimed.claim_token,
    output: JSON.stringify({
      heating_verdict: 'gas_likely',
      heating_confidence: 'high',
      heating_summary: 'Wall-mounted gas boiler visible in kitchen and plumbed steel radiators under windows.',
      heating_evidence: [
        { photo: 1, room: 'Kitchen', observation: 'White wall-mounted gas boiler with copper pipework beside upper press' },
        { photo: 2, room: 'Living room', observation: 'Double-panel plumbed wet radiator with TRV beneath window' },
      ],
      condition: 'good',
      condition_summary: 'Clean, bright interiors with modern kitchen units and double glazing.',
      notes: ['No obvious damp or structural issues visible in the photos.'],
    }),
    meta: { runner: 'claude', model: 'sonnet' },
  });

  const collected = listing.get(updatedProp, { jobs: subJobs, t: T + 15 });
  assert.equal(collected.photo_status, 'done');
  assert.equal(collected.photo_result.heating_verdict, 'gas_likely');
  assert.equal(collected.photo_result.heating_evidence.length, 2);

  // Verify HTTP rendering of property detail (with keywords + photo findings) & Area History tab
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: 'douglas' }; next(); });
  app.use(require('../routes/house'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/house/properties/${prop.id}`)).text();
    assert.match(html, /Vacant Home \/ Derelict Grant/);
    assert.match(html, /Gas central heating likely/);
    assert.match(html, /White wall-mounted gas boiler/);
    const histRes = await fetch(`${base}/house/history`);
    assert.equal(histRes.status, 200);
    assert.match(await histRes.text(), /Area sold history/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
