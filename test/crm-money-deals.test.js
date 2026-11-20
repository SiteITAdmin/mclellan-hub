'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-deals-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const deals = require('../lib/crm/money/deals');
const { addDays } = require('../lib/crm/money/common');
const ejs = require('ejs');

const T = Date.parse('2026-11-15T12:00:00Z') / 1000;
const TODAY = '2026-11-15';
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function tx(description, merchant, norm, cents, category, daysAgo, kind = 'spend', account = 'AIB Current 4417') {
  db.crm().prepare(`INSERT INTO money_transactions (id, account, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`t${++n}`, account, addDays(TODAY, -daysAgo), description, merchant, norm, cents, category, kind, `k${n}`);
}
// A believable 90 days for someone in Ireland.
function spending() {
  for (const d of [3, 10, 17, 24, 31, 38, 45]) tx('POS TESCO STORES 5821', 'Tesco', 'tesco stores', -8734, 'Groceries', d);
  for (const d of [5, 35, 65]) tx('NETFLIX.COM', 'Netflix', 'netflix', -1799, 'Subscriptions', d);
  for (const d of [8, 38]) tx('EIR BROADBAND DD', 'eir', 'eir', -6500, 'Home & utilities', d);
  for (const d of [6, 20, 34]) tx('CIRCLE K BRAY', 'Circle K', 'circle k bray', -7012, 'Fuel', d);
  tx('ARGOS', 'Argos', 'argos', -4599, 'Shopping', 12);
  for (const d of [2, 32, 62]) tx('RENT NOVEMBER', 'Rent', 'rent', -165000, 'Home & utilities', d);
  tx('ATM WITHDRAWAL BRAY', 'ATM', 'atm withdrawal bray', -20000, 'Cash', 9);
  tx('TRF TO SAVINGS', 'Savings', 'savings', -50000, 'Other', 4, 'transfer');
  tx('To John Murphy', 'John Murphy', 'john murphy', -5000, 'Other', 7);
  tx('To John Murphy', 'John Murphy', 'john murphy', -5000, 'Other', 27);
  tx('REVENUE COMMISSIONERS', 'Revenue', 'revenue commissioners', -40000, 'Other', 15);
  tx('MONTHLY FEE', 'AIB', 'monthly fee', -600, 'Fees & interest', 1);
  tx('CENTRA', 'Centra', 'centra', -350, 'Groceries', 3);
  tx('OLD SHOP', 'Old Shop', 'old shop', -90000, 'Shopping', 120);
}

function fakeJobs() {
  let k = 0;
  const jobs = new Map(), enqueued = [];
  return {
    enqueued, jobs,
    enqueue({ feature, dedupeKey, payload }) { const id = `job${++k}`; jobs.set(id, { id, feature, status: 'pending', dedupeKey, payload }); enqueued.push(jobs.get(id)); return { jobId: id }; },
    getJob(id) { return jobs.get(id) || null; },
    finish(id, output, meta = { runner: 'claude', model: 'opus' }) { Object.assign(jobs.get(id), { status: 'completed', result: { output: typeof output === 'string' ? output : JSON.stringify(output), meta } }); },
    last() { return enqueued[enqueued.length - 1]; },
  };
}
const result = (o = {}) => ({ merchant: 'Tesco', title: '€10 off a €60 shop', code: 'SAVE10', detail: 'New Clubcard app users', source_url: 'https://www.tesco.ie/offers',
  quote: 'Use code SAVE10 for €10 off when you spend €60. Ends 30/11/2026.', valid_until: '2026-11-30', kind: 'code', confidence: 'high', ...o });
const offers = () => db.crm().prepare("SELECT * FROM money_offers WHERE origin = 'web' ORDER BY title").all();
const runRow = norm => db.crm().prepare('SELECT * FROM money_deal_runs WHERE merchant_norm = ?').get(norm);

test('targets: real shops he uses, never rent, transfers, cash, tax, fees or people', () => {
  spending();
  const names = deals.targets(T).map(m => m.norm);
  for (const yes of ['tesco stores', 'netflix', 'eir', 'circle k bray', 'argos']) assert.ok(names.includes(yes), `${yes} should be searched`);
  for (const no of ['rent', 'atm withdrawal bray', 'savings', 'john murphy', 'revenue commissioners', 'monthly fee', 'old shop', 'centra']) assert.ok(!names.includes(no), `${no} should not be searched`);
  assert.equal(names[0], 'tesco stores', 'biggest recurring spend first');
  const tesco = deals.targets(T).find(m => m.norm === 'tesco stores');
  assert.equal(tesco.merchant, 'Tesco');
  assert.equal(tesco.category, 'Groceries');
});

test('a person known to the CRM is never searched even without "To" in the description', () => {
  tx('PAYPAL *MARY KELLY', 'Mary Kelly', 'mary kelly', -3000, 'Shopping', 4);
  tx('PAYPAL *MARY KELLY', 'Mary Kelly', 'mary kelly', -3000, 'Shopping', 14);
  tx('PAYPAL *MARY KELLY', 'Mary Kelly', 'mary kelly', -3000, 'Shopping', 24);
  assert.ok(deals.targets(T).some(m => m.norm === 'mary kelly'));
  db.crm().prepare("INSERT INTO people (id, space, name) VALUES ('p1', 'personal', 'Mary Kelly')").run();
  assert.ok(!deals.targets(T).some(m => m.norm === 'mary kelly'));
});

test('privacy: the prompt carries merchant names and categories only', () => {
  spending();
  tx('POS 4417 SPOTIFY P1234 douglas@mclellan.scot', 'Spotify P1234 douglas@mclellan.scot', 'spotify', -1199, 'Subscriptions', 4);
  tx('SPOTIFY', 'Spotify', 'spotify', -1199, 'Subscriptions', 34);
  const ts = deals.targets(T);
  const text = deals.SYSTEM_PROMPT + '\n' + deals.userPrompt(ts, T);
  assert.match(text, /Tesco/); assert.match(text, /Groceries/); assert.match(text, /Spotify/);
  for (const bad of ['Douglas', 'McLellan', 'mclellan', '@', 'AIB', '4417', 'P1234', '87.34', '8734', '€', '1799', '17.99']) assert.ok(!text.includes(bad), `prompt must not contain ${bad}`);
  const txDates = db.crm().prepare('SELECT DISTINCT posted_on FROM money_transactions').all().map(r => r.posted_on);
  for (const d of txDates) assert.ok(!text.includes(d), `prompt must not contain purchase date ${d}`);
  assert.ok(!/\d+[.,]\d{2}/.test(deals.userPrompt(ts, T)), 'no amounts');
});

test('a good result is stored as an untested web offer with evidence and relevance', async () => {
  spending();
  const jobs = fakeJobs();
  const r = await deals.tick({ jobs, t: T });
  assert.equal(r.started, true);
  assert.equal(jobs.enqueued.length, 1);
  assert.equal(jobs.last().feature, 'crm_money_deals');
  assert.equal(JSON.parse(db.crm().prepare('SELECT merchants FROM money_deal_jobs').get().merchants).length, 4, 'at most 4 merchants per job');
  jobs.finish(jobs.last().id, { results: [result()], searched: [{ merchant: 'Tesco', found: 1, note: '' }] });
  await deals.tick({ jobs, t: T + 300 });
  const [o] = offers();
  assert.equal(o.code, 'SAVE10'); assert.equal(o.status, 'new'); assert.equal(o.merchant_norm, 'tesco stores'); assert.equal(o.valid_until, '2026-11-30');
  assert.equal(o.relevance, 'You spent €611.38 here in 90 days');
  const ev = JSON.parse(o.evidence);
  assert.equal(ev.source_url, 'https://www.tesco.ie/offers'); assert.equal(ev.kind, 'code'); assert.equal(ev.confidence, 'high'); assert.equal(ev.model, 'claude/opus');
  assert.match(ev.quote, /SAVE10/);
  assert.equal(runRow('tesco stores').found_count, 1);
  assert.equal(runRow('netflix').found_count, 0);
  assert.ok(runRow('netflix').last_searched_at, 'searched with nothing found is still recorded');
  const s = deals.status(T + 300);
  assert.equal(s.lastRunAt, T + 300);
  assert.deepEqual(s.searching, ['Argos'], 'the day\'s second job takes the merchant left over');
  assert.equal(deals.summary(T + 300).lines[0], '1 code or offer found for shops you use; searched 4 shops this week');
});

test('validation drops what cannot be checked and says why', () => {
  const merchants = [{ norm: 'tesco stores', merchant: 'Tesco', category: 'Groceries' }, { norm: 'netflix', merchant: 'Netflix', category: 'Subscriptions' }];
  const { kept, dropped } = deals.validate({ results: [
    result({ code: 'MADEUP20', title: 'Invented' }),
    result({ title: 'http', source_url: 'http://www.tesco.ie/offers' }),
    result({ title: 'short', source_url: 'https://bit.ly/abc' }),
    result({ title: 'ip', source_url: 'https://192.168.1.4/offers' }),
    result({ title: 'js', source_url: 'javascript:alert(1)' }),
    result({ title: 'past', valid_until: '2026-11-01' }),
    result({ title: 'baddate', valid_until: '2026-02-30' }),
    result({ title: 'other shop', merchant: 'Dunnes Stores' }),
    result({ title: 'noquote', quote: 'SAVE10' }),
    result({ title: 'weird code', code: 'SAVE 10 NOW!', quote: 'Use SAVE 10 NOW! today at the till' }),
    result({ merchant: 'Netflix', title: 'Basic with ads', code: '', kind: 'switch', quote: 'Standard with adverts is €6.99 a month.', valid_until: '', source_url: 'https://help.netflix.com/en/node/24926' }),
    result({ merchant: 'Tesco (Groceries)', title: 'Echoed category', code: '', kind: 'sale' }),
  ] }, merchants, T);
  const why = Object.fromEntries(dropped.map(d => [d.title, d.reason]));
  assert.deepEqual(kept.map(k => [k.title, k.code, k.kind]).sort(), [['Basic with ads', '', 'switch'], ['Echoed category', '', 'sale'], ['Invented', '', 'sale']]);
  assert.match(why.Invented, /not in the quoted text/);
  assert.match(why.http, /not https/); assert.match(why.short, /shortener/); assert.match(why.ip, /not a real website/); assert.match(why.js, /not https/);
  assert.match(why.past, /expired/); assert.match(why.baddate, /could not be read/); assert.match(why['other shop'], /not one of those searched/);
  assert.match(why.noquote, /no quote/); assert.match(why['weird code'], /does not look like a code/);
  const many = deals.validate({ results: Array.from({ length: 7 }, (_, i) => result({ title: `Offer ${i}` })) }, merchants, T);
  assert.equal(many.kept.length, 5, 'at most 5 per merchant');
});

test('malformed reply is a visible failure, then retried, then given up after 3 tries', async () => {
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  jobs.finish(jobs.last().id, 'Sorry, I could not search today.');
  await deals.tick({ jobs, t: T + 60 });
  assert.equal(jobs.enqueued.length, 2, 'retried');
  assert.match(deals.status(T + 60).error, /Couldn't read the search reply.*trying again/);
  jobs.finish(jobs.last().id, '{"results": [ broken');
  await deals.tick({ jobs, t: T + 120 });
  assert.equal(jobs.enqueued.length, 3);
  jobs.finish(jobs.last().id, '{"nothing":true}');
  await deals.tick({ jobs, t: T + 180 });
  const batch = db.crm().prepare('SELECT * FROM money_deal_jobs ORDER BY created_at LIMIT 1').get();
  assert.equal(batch.status, 'failed');
  assert.match(batch.error, /gave up after 3 tries/);
  assert.match(runRow('tesco stores').last_error, /no results list/);
  const p = deals.problems(T + 180);
  assert.ok(p.some(x => /Web code search failed for Tesco/.test(x.text)));
  const s = deals.status(T + 180);
  assert.match(s.merchants.find(m => m.merchant === 'Tesco').error, /no results list/);
  assert.equal(jobs.enqueued.length, 4, 'a second batch of other merchants starts the same tick (2 per day)');
  const second = jobs.last();
  jobs.finish(second.id, { results: [], searched: [] });
  await deals.tick({ jobs, t: T + 240 });
  assert.equal(jobs.enqueued.length, 4, 'failed merchants wait a day; daily cap reached');
  await deals.tick({ jobs, t: T + 86400 + 600 });
  assert.equal(jobs.enqueued.length, 5, 'failed merchants retried the next day');
});

test('a job the Mac never picks up is requeued after 20 minutes, at most 3 times', async () => {
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  await deals.tick({ jobs, t: T + 19 * 60 });
  assert.equal(jobs.enqueued.length, 1, 'not stale yet');
  await deals.tick({ jobs, t: T + 21 * 60 });
  assert.equal(jobs.enqueued.length, 2);
  assert.notEqual(jobs.enqueued[0].dedupeKey, jobs.enqueued[1].dedupeKey);
  await deals.tick({ jobs, t: T + 42 * 60 });
  assert.equal(jobs.enqueued.length, 3);
  await deals.tick({ jobs, t: T + 63 * 60 });
  const batch = db.crm().prepare('SELECT * FROM money_deal_jobs ORDER BY created_at LIMIT 1').get();
  assert.equal(batch.status, 'failed');
  assert.match(batch.error, /did not answer within 20 minutes/);
  jobs.jobs.clear();
  const lost = db.crm().prepare("SELECT * FROM money_deal_jobs WHERE status = 'queued'").get();
  assert.ok(lost, 'second daily batch started');
  await deals.tick({ jobs, t: T + 64 * 60 });
  assert.match(db.crm().prepare('SELECT error FROM money_deal_jobs WHERE id = ?').get(lost.id).error, /lost/);
});

test('weekly cadence: searched merchants wait a week; a missed week is not caught up', async () => {
  spending();
  const jobs = fakeJobs();
  const done = async t => {
    for (let i = 0; i < 6; i++) { await deals.tick({ jobs, t: t + i * 60 }); const j = jobs.last(); if (j?.status === 'pending') jobs.finish(j.id, { results: [], searched: [] }); }
  };
  await done(T);
  const after1 = jobs.enqueued.length;
  assert.equal(after1, 2, 'two automatic jobs on day one, then the daily cap');
  const covered = db.crm().prepare('SELECT COUNT(*) n FROM money_deal_runs WHERE last_searched_at IS NOT NULL').get().n;
  assert.equal(covered, 5, 'all five targets covered on day one (4 + 1)');
  await deals.tick({ jobs, t: T + 3 * 86400 });
  assert.equal(jobs.enqueued.length, after1, 'nothing due mid-week');
  const s = deals.status(T + 3 * 86400);
  assert.ok(s.nextRunAt >= T + 7 * 86400 && s.nextRunAt < T + 7 * 86400 + 300);
  // Hub down for three weeks: each merchant is searched once, not three times.
  await done(T + 28 * 86400);
  assert.equal(jobs.enqueued.length, after1 + 2, 'two jobs, five merchants, once each');
  assert.equal(db.crm().prepare("SELECT COUNT(*) n FROM money_deal_jobs WHERE status = 'queued'").get().n, 0);
});

test('one deals job in flight at a time', async () => {
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  await deals.tick({ jobs, t: T + 60 });
  assert.equal(jobs.enqueued.length, 1);
  assert.throws(() => deals.searchNow({ jobs, t: T + 120 }), /Already searching/);
  assert.deepEqual(deals.status(T + 120).searching.length, 4);
});

test('a dismissed or saved offer keeps its status when found again; an undated one expires after 21 days', async () => {
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  const reply = { results: [result(), result({ title: 'Clubcard Prices', code: '', valid_until: '', kind: 'loyalty', quote: 'Clubcard Prices on hundreds of products every week.' })], searched: [] };
  jobs.finish(jobs.last().id, reply);
  await deals.tick({ jobs, t: T + 60 });
  db.crm().prepare("UPDATE money_offers SET status = 'dismissed' WHERE code = 'SAVE10'").run();
  db.crm().prepare("UPDATE money_offers SET status = 'saved' WHERE title = 'Clubcard Prices'").run();
  db.crm().prepare('DELETE FROM money_deal_jobs').run();
  db.crm().prepare('UPDATE money_deal_runs SET last_searched_at = NULL').run();
  await deals.tick({ jobs, t: T + 600 });
  jobs.finish(jobs.last().id, { ...reply, results: [result({ quote: 'Use code SAVE10 for €10 off when you spend €60. Ends 30/11/2026. Updated.' }), reply.results[1]] });
  await deals.tick({ jobs, t: T + 660 });
  const rows = offers();
  assert.equal(rows.length, 2, 'deduped');
  assert.equal(rows.find(o => o.code === 'SAVE10').status, 'dismissed');
  assert.match(JSON.parse(rows.find(o => o.code === 'SAVE10').evidence).quote, /Updated/);
  assert.equal(rows.find(o => o.title === 'Clubcard Prices').status, 'saved');
  db.crm().prepare("UPDATE money_offers SET status = 'new'").run();
  deals.expire(T + 660 + 14 * 86400);
  assert.equal(offers().filter(o => o.status === 'expired').length, 0);
  deals.expire(T + 660 + 20 * 86400);
  assert.deepEqual(offers().map(o => [o.title, o.status]), [['Clubcard Prices', 'new'], ['€10 off a €60 shop', 'expired']], 'past its end date');
  deals.expire(T + 660 + 22 * 86400);
  assert.deepEqual(offers().map(o => [o.title, o.status]), [['Clubcard Prices', 'expired'], ['€10 off a €60 shop', 'expired']], 'dated one passed 30 Nov, undated one aged out');
});

test('a search that returns nothing at all is shown, not silent', async () => {
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  jobs.finish(jobs.last().id, { results: [], searched: [{ merchant: 'Tesco', found: 0, note: 'Checked tesco.ie offers page' }] });
  await deals.tick({ jobs, t: T + 60 });
  assert.ok(deals.problems(T + 60).some(p => /Web search returned nothing for Tesco/.test(p.text)));
  const tesco = deals.status(T + 60).merchants.find(m => m.merchant === 'Tesco');
  assert.equal(tesco.found, 0); assert.equal(tesco.note, 'Checked tesco.ie offers page'); assert.ok(tesco.lastSearchedAt);
});

test('Search now: stalest first, once per 30 minutes, through the route with a flash', async () => {
  spending();
  const jobs = fakeJobs();
  const r = deals.searchNow({ jobs, t: T });
  assert.equal(r.merchants.length, 4);
  jobs.finish(jobs.last().id, { results: [], searched: [] });
  await deals.tick({ jobs, t: T + 60 });
  db.crm().prepare("DELETE FROM money_deal_jobs WHERE trigger = 'auto'").run();
  assert.throws(() => deals.searchNow({ jobs, t: T + 20 * 60 }), /less than 30 minutes ago.*10 minutes/);
  assert.ok(deals.status(T + 20 * 60).manualAt);
  const again = deals.searchNow({ jobs, t: T + 31 * 60 });
  assert.equal(again.merchants[0], 'Argos', 'the one not searched yet goes first');

  const routes = [];
  const router = { post: (p, ...fns) => routes.push({ p, fns }) };
  const flashes = [];
  deals.mount(router, { requireSameOrigin: (q, s, nx) => nx(), writeLimiter: (q, s, nx) => nx(), flash: (req, text, level = 'ok') => flashes.push({ text, level }),
    back: (req, res, fallback) => res.redirect(fallback), base: '/money' });
  assert.equal(routes[0].p, '/money/deals/search');
  let to = '';
  routes[0].fns[2]({ params: {} }, { redirect: u => { to = u; } });
  assert.equal(to, '/money/offers');
  assert.equal(flashes[0].level, 'bad', 'one already queued in this test, so it is refused visibly');
});

test('the partial renders status, per-merchant lines, errors and the button', async () => {
  const file = path.join(__dirname, '..', 'views', 'crm', 'money', '_deals.ejs');
  const empty = await ejs.renderFile(file, { deals: deals.status(T) });
  assert.match(empty, /Searching the web for codes/); assert.match(empty, /Not searched yet/); assert.match(empty, /No spending to search for yet/);
  assert.match(empty, /action="\/money\/deals\/search"/); assert.match(empty, /not tested/);
  spending();
  const jobs = fakeJobs();
  await deals.tick({ jobs, t: T });
  const busy = await ejs.renderFile(file, { deals: deals.status(T) });
  assert.match(busy, /Searching now/); assert.match(busy, /Searching Tesco/); assert.match(busy, /disabled/);
  jobs.finish(jobs.last().id, { results: [result()], searched: [] });
  await deals.tick({ jobs, t: T + 60 });
  const s = deals.status(T + 60);
  const done = await ejs.renderFile(file, { deals: s });
  assert.match(done, /Searched Sun,? 15 Nov, 1 found/); assert.match(done, /nothing found/);
  db.crm().prepare("UPDATE money_deal_runs SET last_error = 'The Mac could not run the search', last_tried_at = ? WHERE merchant_norm = 'netflix'").run(T + 120);
  const bad = await ejs.renderFile(file, { deals: deals.status(T + 120) });
  assert.match(bad, /class="deals-line bad"/); assert.match(bad, /Search failed: The Mac could not run the search/);
});
