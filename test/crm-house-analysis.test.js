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

test('keyword detector catches Vacant Home Grant, refurbishment, AMV, management fees, BER, heating, and 2nd-bath WC warning', () => {
  const { signals, heating } = daft.extractSignals({
    title: '12 Old Lane, Bray',
    baths: 2,
    ber: 'F',
    selling_type: 'Online Auction',
    features: ['May qualify for Vacant Property Refurbishment Grant', 'Gas fired central heating', 'Chain-free', 'Downstairs guest WC'],
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
  assert.ok(keys.includes('bathroom_wc_only'), 'flags when 2-bath listing mentions guest WC with no en-suite/shower room');
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
      bathroom_verdict: 'one_full_plus_wc',
      bathroom_confidence: 'high',
      full_bathrooms_visible: 1,
      wc_only_visible: 1,
      bathroom_summary: 'Advertised as 2 bathrooms, but photos show 1 main bathroom with bath/shower and 1 toilet-only downstairs WC.',
      bathroom_evidence: [
        { photo: 1, room: 'Main bathroom', has_bath_or_shower: true, observation: 'Bath with overhead shower and glass screen' },
        { photo: 2, room: 'Downstairs WC', has_bath_or_shower: false, observation: 'Toilet and small handbasin only, no shower or bath' },
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
  assert.equal(collected.photo_result.bathroom_verdict, 'one_full_plus_wc');
  assert.equal(collected.photo_result.full_bathrooms_visible, 1);
  assert.equal(collected.photo_result.wc_only_visible, 1);
  assert.equal(house.dashboard().properties.find(x => x.id === prop.id).baths, 2);

  // Add a second smaller/dearer property to test price/beds/baths filters on /house/properties
  house.saveProperty({
    title: 'Small Studio Flat',
    address: '10 Small St, Dublin 1',
    asking_price: '210000',
    beds: '1',
    baths: '1',
    status: 'researching',
  });
  house.saveProperty({
    title: 'Big Detached House',
    address: '50 Grand Ave, Bray',
    asking_price: '650000',
    beds: '4',
    baths: '3',
    status: 'shortlisted',
  });

  // Verify HTTP rendering of property detail (keywords + heating + bathroom verdict) & filters on /house/properties
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
    assert.match(html, /View on Daft ↗/);
    assert.match(html, /Street View ↗/);
    assert.match(html, new RegExp(`/house/streetview\\?id=${prop.id}&amp;q=.*Santry`));
    assert.match(html, /Vacant Home \/ Derelict Grant/);
    assert.match(html, /Gas central heating likely/);
    assert.match(html, /White wall-mounted gas boiler/);
    assert.match(html, /1 bathroom\/shower \+ WC\/cloakroom only/);
    assert.match(html, /Downstairs WC/);

    // Once coordinates are saved, Street View links directly to the Google Street View panorama
    house.saveCoordinates(prop.id, 53.3951, -6.2452);
    const panoHtml = await (await fetch(`${base}/house/properties/${prop.id}`)).text();
    assert.match(panoHtml, /google\.com\/maps\/@\?api=1&amp;map_action=pano&amp;viewpoint=53\.3951,-6\.2452/);

    // /house/streetview redirects straight to the saved panorama
    const svRes = await fetch(`${base}/house/streetview?id=${prop.id}`, { redirect: 'manual' });
    assert.equal(svRes.status, 302);
    assert.equal(svRes.headers.get('location'), 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=53.3951,-6.2452');

    // Geocoder strips leading Apt/No prefixes on retry and returns lat/lng
    const geo = await house.geocodeAddress('Apt 2, Millrace Park, Saggart, Co. Dublin', {
      fetcher: async url => ({
        ok: true,
        json: async () => url.includes('Apt') ? [] : [{ lat: '53.2809463', lon: '-6.4527956' }],
      }),
    });
    assert.deepEqual(geo, { lat: 53.2809463, lng: -6.4527956 });

    // Filter by price range + minBeds + minBaths
    const filteredHtml = await (await fetch(`${base}/house/properties?minPrice=250000&maxPrice=400000&minBeds=3&minBaths=2`)).text();
    assert.match(filteredHtml, /Apartment 2, The Kilmore, Santry/);
    assert.match(filteredHtml, /View on Daft ↗/);
    assert.match(filteredHtml, /Street View ↗/);
    assert.doesNotMatch(filteredHtml, /Small Studio Flat/);
    assert.doesNotMatch(filteredHtml, /Big Detached House/);

    const bath3Html = await (await fetch(`${base}/house/properties?minBaths=3`)).text();
    assert.match(bath3Html, /Big Detached House/);
    assert.doesNotMatch(bath3Html, /Apartment 2, The Kilmore, Santry/);

    const histRes = await fetch(`${base}/house/history`);
    assert.equal(histRes.status, 200);
    assert.match(await histRes.text(), /Area sold history/);

    // Comparable sales render inside a collapsible <details> section
    valuation.saveDaftSoldRows([{
      source_id: 'comp-collapse-1', county: 'Dublin', locality: 'Santry',
      address: '5 The Kilmore, Santry, Dublin 9', day: '2026-08-01', sold: 340000, asking: 320000,
      beds: 3, baths: 2, area: 95, property_type: 'Apartment', ber: 'B3', lat: 53.395, lng: -6.245,
      url: 'https://www.daft.ie/sold/5-the-kilmore/comp-collapse-1',
    }], T);
    const compHtml = await (await fetch(`${base}/house/properties/${prop.id}`)).text();
    assert.match(compHtml, /<details class="house-aging house-valuation-manual house-valuation-comps">\s*<summary>Comparable sales \(1 shown\)<\/summary>/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('Daft listing & sold fetches route through daft-capable dev-server worker and stay invisible to legacy workers', async () => {
  const prop = house.saveProperty({
    title: '12 Oakwood Park, Santry, Dublin 9',
    address: '12 Oakwood Park, Santry, Dublin 9',
    url: 'https://www.daft.ie/for-sale/terraced-house-12-oakwood-park-santry/9999999',
    status: 'shortlisted',
  });

  // 1. Enqueue full inspection via worker
  const queued = await listing.inspect(prop, { analyzePhotos: true, useWorker: true, jobs: subJobs, t: 1795205000 });
  assert.equal(queued.photo_status, 'waiting');
  assert.ok(queued.photo_job_id);

  // Legacy worker (no 'daft' capability) MUST NOT claim it
  const legacyClaim = subJobs.claim({ workerId: 'mac:legacy', limit: 1, capabilities: [] });
  assert.equal(legacyClaim.jobs.length, 0);

  // dev-server-fast worker WITH 'daft' capability claims it immediately (priority 15 <= 30)
  const devClaim = subJobs.claim({ workerId: 'dev-server-fast', limit: 1, maxPriority: 30, capabilities: ['daft'] });
  assert.equal(devClaim.jobs.length, 1);
  const job = devClaim.jobs[0];
  assert.equal(job.payload.task, 'daft_inspect');
  assert.equal(job.payload.requiresWorkerCapability, 'daft');

  const workerResult = await listing.runDaftInspectTask(job.payload, {
    fetchListing: async () => ({
      url: prop.url,
      title: '12 Oakwood Park, Santry, Dublin 9',
      asking_price: 425000,
      beds: 3,
      baths: 2,
      area: 102,
      property_type: 'Terraced House',
      ber: 'C1',
      selling_type: 'Private Treaty',
      date_of_construction: '1988',
      description: 'Gas fired central heating. Main bathroom upstairs and en-suite shower room off master bedroom.',
      features: ['GFCH', 'Master En-suite'],
      facilities: ['Gas Fired Central Heating'],
      images: [
        { url: 'https://media.daft.ie/1.jpg', thumb: 'https://media.daft.ie/1t.jpg' },
        { url: 'https://media.daft.ie/2.jpg', thumb: 'https://media.daft.ie/2t.jpg' },
      ],
      lat: 53.3951,
      lng: -6.2452,
    }),
    fetchImage: async () => PNG,
    runModel: async ({ documents }) => {
      assert.equal(documents.length, 2);
      return {
        runner: 'claude',
        model: 'sonnet',
        effort: 'medium',
        tier: 'sonnet',
        durationMs: 1200,
        text: JSON.stringify({
          heating_verdict: 'gas_likely',
          heating_confidence: 'high',
          heating_summary: 'Gas boiler and wet radiators clearly visible.',
          heating_evidence: [{ photo: 1, room: 'Kitchen', observation: 'Wall-mounted gas boiler' }],
          bathroom_verdict: 'two_plus_full',
          bathroom_confidence: 'high',
          full_bathrooms_visible: 2,
          wc_only_visible: 0,
          bathroom_summary: 'Main family bathroom with tub plus en-suite shower room.',
          bathroom_evidence: [
            { photo: 1, room: 'Main bathroom', has_bath_or_shower: true, observation: 'Full bathtub' },
            { photo: 2, room: 'En-suite', has_bath_or_shower: true, observation: 'Glass shower enclosure' },
          ],
          condition: 'good',
          condition_summary: 'Well kept throughout.',
          notes: [],
        }),
      };
    },
  });

  await subJobs.complete({
    jobId: job.id,
    claimToken: job.claim_token,
    output: JSON.stringify(workerResult.output),
    meta: workerResult.meta,
  });

  const collected = listing.collect(prop.id, { jobs: subJobs, t: 1795205010 });
  assert.equal(collected.photo_status, 'done');
  assert.equal(collected.ber, 'C1');
  assert.equal(collected.baths, 2);
  assert.equal(collected.photo_result.bathroom_verdict, 'two_plus_full');
  assert.equal(collected.photo_result.full_bathrooms_visible, 2);
  assert.equal(collected.photo_model, 'claude/sonnet');
  // Blank property fields auto-filled from worker listing data
  const updatedProp = house.dashboard().properties.find(p => p.id === prop.id);
  assert.equal(updatedProp.asking_price, 425000);
  assert.equal(updatedProp.beds, 3);
  assert.equal(updatedProp.baths, 2);
  assert.equal(updatedProp.area, 102);
  assert.equal(updatedProp.listing_lat, 53.3951);
  assert.equal(updatedProp.listing_lng, -6.2452);

  // 2. Keywords-only via worker preserves prior photo_result_json without invoking AI
  const kwQueued = await listing.inspect(prop, { analyzePhotos: false, useWorker: true, jobs: subJobs, t: 1795205020 });
  assert.equal(kwQueued.photo_status, 'waiting');
  const kwClaim = subJobs.claim({ workerId: 'dev-server-fast', limit: 1, maxPriority: 30, capabilities: ['daft'] });
  assert.equal(kwClaim.jobs.length, 1);
  const kwOut = await listing.runDaftInspectTask(kwClaim.jobs[0].payload, {
    fetchListing: async () => ({
      url: prop.url,
      title: prop.title,
      asking_price: 425000,
      beds: 3,
      baths: 2,
      area: 102,
      property_type: 'Terraced House',
      ber: 'B3',
      selling_type: 'Private Treaty',
      date_of_construction: '1988',
      description: 'Updated BER B3 listing.',
      features: [],
      facilities: [],
      images: [],
    }),
  });
  await subJobs.complete({
    jobId: kwClaim.jobs[0].id,
    claimToken: kwClaim.jobs[0].claim_token,
    output: JSON.stringify(kwOut.output),
    meta: kwOut.meta,
  });
  const kwDone = listing.collect(prop.id, { jobs: subJobs, t: 1795205025 });
  assert.equal(kwDone.ber, 'B3');
  assert.equal(kwDone.photo_status, 'done');
  assert.equal(kwDone.photo_result.bathroom_verdict, 'two_plus_full');

  // 3. Daft Sold via worker (synchronous wait resolved by worker claim/complete)
  const soldPromise = valuation.refreshAreaHistory({ county: 'Dublin', locality: 'Santry', useWorker: true, jobs: subJobs, t: 1795205030 });
  await new Promise(r => setTimeout(r, 40));
  // Legacy worker must not see it
  assert.equal(subJobs.claim({ workerId: 'mac:legacy', limit: 1, capabilities: [] }).jobs.length, 0);
  const soldClaim = subJobs.claim({ workerId: 'dev-server-fast', limit: 1, maxPriority: 30, capabilities: ['daft'] });
  assert.equal(soldClaim.jobs.length, 1);
  assert.equal(soldClaim.jobs[0].payload.task, 'daft_sold');
  await subJobs.complete({
    jobId: soldClaim.jobs[0].id,
    claimToken: soldClaim.jobs[0].claim_token,
    output: JSON.stringify({
      areaSlug: 'santry-dublin',
      rows: [{
        source_id: 'daft-worker-1',
        county: 'Dublin',
        locality: 'Santry',
        address: '8 Oakwood Park, Santry, Dublin 9',
        day: '2026-09-12',
        sold: 440000,
        asking: 415000,
        beds: 3,
        baths: 2,
        area: 100,
        property_type: 'Terraced House',
        ber: 'C2',
        lat: null,
        lng: null,
        url: 'https://www.daft.ie/sold/8-oakwood-park-santry/daft-worker-1',
      }],
    }),
    meta: { runner: 'daft-worker', model: 'http', rows: 1 },
  });
  const soldRes = await soldPromise;
  assert.equal(soldRes.saved, 1);
  assert.equal(soldRes.areaSlug, 'santry-dublin');
});

test('auctioneer / estate agent tracking builds asking-vs-sold margin patterns and flags same-seller comparables', async () => {
  // 1. Parse seller from both Daft Sold HTML and Daft For-Sale HTML
  const soldPayload = {
    props: {
      pageProps: {
        listings: [
          {
            listing: {
              adId: 'rc1', title: '10 Millrace Road, Saggart, Co. Dublin', seoFriendlyPath: '/sold/10-millrace-road/rc1',
              price: '€300,000', soldPrice: '€390,000', soldDate: '12/09/2026',
              numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertySize: '95 m²', propertyType: 'Terraced House',
              ber: { rating: 'B3' },
              seller: { branch: 'Ray Cooke Auctioneers', name: 'Sales Team 3', licenceNumber: '002307', sellerType: 'BRANDED_AGENT' },
            },
          },
          {
            listing: {
              adId: 'rc2', title: '12 Millrace Drive, Saggart, Co. Dublin', seoFriendlyPath: '/sold/12-millrace-drive/rc2',
              price: '€320,000', soldPrice: '€416,000', soldDate: '20/08/2026',
              numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertySize: '98 m²', propertyType: 'Terraced House',
              ber: { rating: 'B3' },
              seller: { branch: 'Ray Cooke Auctioneers', name: 'Sales Team 10', licenceNumber: '002307', sellerType: 'BRANDED_AGENT' },
            },
          },
          {
            listing: {
              adId: 'rc3', title: '14 Millrace Court, Saggart, Co. Dublin', seoFriendlyPath: '/sold/14-millrace-court/rc3',
              price: '€350,000', soldPrice: '€420,000', soldDate: '01/07/2026',
              numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertySize: '96 m²', propertyType: 'Terraced House',
              ber: { rating: 'C1' },
              seller: { branch: 'Ray Cooke Auctioneers', name: 'Sales Team 1', licenceNumber: '002307', sellerType: 'BRANDED_AGENT' },
            },
          },
          {
            listing: {
              adId: 'qa1', title: '5 Quiet Grove, Saggart, Co. Dublin', seoFriendlyPath: '/sold/5-quiet-grove/qa1',
              price: '€380,000', soldPrice: '€395,000', soldDate: '15/08/2026',
              numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertySize: '97 m²', propertyType: 'Terraced House',
              ber: { rating: 'B3' },
              seller: { branch: 'Steady Estates', name: 'Jane Byrne', licenceNumber: '009999', sellerType: 'BRANDED_AGENT' },
            },
          },
        ],
      },
    },
  };
  const parsedSold = daft.parseSoldListings(`<script id="__NEXT_DATA__">${JSON.stringify(soldPayload)}</script>`, { county: 'Dublin', locality: 'Saggart' });
  assert.equal(parsedSold.length, 4);
  assert.equal(parsedSold[0].seller_agency, 'Ray Cooke Auctioneers');
  assert.equal(parsedSold[0].seller_licence, '002307');
  assert.equal(parsedSold[0].seller_key, 'ray cooke auctioneers');
  valuation.saveDaftSoldRows(parsedSold, T);

  const fsPayload = {
    props: {
      pageProps: {
        listing: {
          id: 6727500, title: '19 Millrace Park, Saggart, Co. Dublin',
          seoFriendlyPath: '/for-sale/19-millrace-park-saggart-co-dublin/6727500',
          price: '€325,000', numBedrooms: '3 Bed', numBathrooms: '2 Bath', propertySize: '96 m²',
          propertyType: 'Terraced House', ber: { rating: 'B3' }, sellingType: 'By Private Treaty',
          description: 'Turnkey 3 bed home.', features: [], facilities: [], media: { images: [] },
          seller: { branch: 'Ray Cooke Auctioneers', name: 'Sales Team 10', licenceNumber: '002307', sellerType: 'BRANDED_AGENT' },
        },
      },
    },
  };
  const parsedListing = daft.parseListingHtml(`<script id="__NEXT_DATA__">${JSON.stringify(fsPayload)}</script>`);
  assert.equal(parsedListing.seller_agency, 'Ray Cooke Auctioneers');
  assert.equal(parsedListing.seller_agent, 'Sales Team 10');

  // 2. Inspecting the property saves the selling agent and feeds valuation + sameSeller flags
  const prop = house.saveProperty({
    title: '19 Millrace Park, Saggart, Co. Dublin',
    address: '19 Millrace Park, Saggart, Co. Dublin',
    url: 'https://www.daft.ie/for-sale/19-millrace-park-saggart-co-dublin/6727500',
    asking_price: '325000',
    beds: '3',
    area: '96',
    status: 'shortlisted',
  });
  const analyzed = await listing.inspect(prop, { analyzePhotos: false, fetchListing: async () => parsedListing, jobs: subJobs, t: T });
  assert.equal(analyzed.seller_agency, 'Ray Cooke Auctioneers');

  const updatedProp = house.dashboard().properties.find(p => p.id === prop.id);
  assert.equal(updatedProp.seller_agency, 'Ray Cooke Auctioneers');

  const val = valuation.get(updatedProp, T, { listing: analyzed });
  assert.equal(val.sellerStats.agency, 'Ray Cooke Auctioneers');
  assert.equal(val.sellerStats.pairedCount, 3);
  // Gaps are +30%, +30%, +20% -> median +30% -> 325k * 1.30 = 422.5k -> rounded to 5k = 425,000
  assert.ok(Math.abs(val.sellerStats.medianGap - 0.30) < 0.001);
  assert.equal(val.sellerStats.expectedMid, 425000);
  assert.equal(val.sellerStats.confidence, 'medium');
  assert.equal(val.comparisons.filter(c => c.sameSeller).length, 3);
  assert.match(val.gapExplanation, /Selling agent Ray Cooke Auctioneers/);

  // 3. Leaderboard ranks agencies by paired sales & exposes margins on /house/history and /house/properties/:id
  const board = valuation.sellerLeaderboard();
  assert.equal(board[0].agency, 'Ray Cooke Auctioneers');
  assert.equal(board[0].pairedCount, 3);
  assert.equal(board[1].agency, 'Steady Estates');
  assert.equal(board[1].pairedCount, 1);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: 'douglas' }; next(); });
  app.use(require('../routes/house'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const propHtml = await (await fetch(`${base}/house/properties/${prop.id}`)).text();
    assert.match(propHtml, /Auctioneer pricing pattern · Ray Cooke Auctioneers/);
    assert.match(propHtml, /€425,000/);
    assert.match(propHtml, /Same agent/);

    const histHtml = await (await fetch(`${base}/house/history`)).text();
    assert.match(histHtml, /Auctioneer pricing patterns/);
    assert.match(histHtml, /Ray Cooke Auctioneers/);
    assert.match(histHtml, /Steady Estates/);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
