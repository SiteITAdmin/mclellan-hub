'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-offers-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const sources = require('../lib/crm/sources');
const offers = require('../lib/crm/money/offers');
const { normMerchant, dublinDay, addDays } = require('../lib/crm/money/common');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const today = dublinDay();
function charge(merchant, daysAgo, euro) {
  n += 1;
  db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, 'Groceries', 'spend', ?)`).run(`tx${n}`, addDays(today, -daysAgo), merchant.toUpperCase(), merchant, normMerchant(merchant), -Math.round(euro * 100), `k${n}`);
}
function mail(space, title, text, daysAgo = 2) {
  n += 1;
  return sources.admitSource({ space, kind: 'email', origin: 'gmail', externalId: `mail${n}`, title, occurredAt: db.now() - daysAgo * 86400 - n, text,
    participants: [{ role: 'from', email: `offers${n}@shop.example`, name: 'Shop' }], holdUnknownSender: true }).source;
}
function fakeJobs() {
  const jobs = { queued: [], state: {} };
  jobs.enqueue = ({ feature, dedupeKey, payload }) => { const id = `job${jobs.queued.length + 1}`; jobs.queued.push({ id, feature, dedupeKey, payload }); jobs.state[id] = { id, status: 'pending' }; return { jobId: id }; };
  jobs.getJob = id => jobs.state[id] || null;
  jobs.finish = output => { const j = jobs.queued.at(-1); jobs.state[j.id] = { id: j.id, status: 'completed', result: { output } }; };
  return jobs;
}
const offer = title => db.crm().prepare('SELECT * FROM money_offers WHERE title = ?').get(title);
const refsOf = () => Object.fromEntries(Object.entries(JSON.parse(db.crm().prepare("SELECT refs FROM money_mail_jobs WHERE purpose = 'offer' ORDER BY created_at DESC LIMIT 1").get().refs)).map(([k, v]) => [v, k]));

const DUNNES = `Dunnes Stores\nThis week only: €10 off when you spend €50 or more online. Use code SAVE10NOV at checkout.\nOffer ends ${addDays(today, 5)}. Shop now at https://www.dunnesstores.com/offers/save10`;
const BOOTS = `Boots Ireland\n20% off all fragrance this weekend. Use code SCENT20. Offer ends ${addDays(today, 3)}.`;

test('tick is safe with no data at all', async () => {
  const r = await offers.tick({ jobs: fakeJobs() });
  assert.deepEqual(r, { expired: 0, relevance: 0, mail: { idle: true } });
  assert.deepEqual(offers.summary().lines, ['No offers from your mail yet.']);
  assert.deepEqual(offers.problems(), []);
});

test('offers come only from recent Personal mail, quote the mail, and are weighed against real spending', async () => {
  for (let i = 0; i < 14; i++) charge('Dunnes Stores Bray', 5 + i * 6, 15.15);
  const d = mail('personal', 'Your weekly offers from Dunnes', DUNNES);
  const b = mail('personal', 'Fragrance sale', BOOTS);
  const old = mail('personal', 'Summer sale: 50% off', '50% off everything. Use code SUMMER50.', 60);
  const work = mail('work', 'Discount on Adobe licences', 'Use code ADOBE15 for 15% off your renewal.');
  mail('personal', 'Dinner?', 'Free for dinner on Friday?');
  const jobs = fakeJobs(), t = db.now();
  const r = await offers.tick({ jobs, t });
  assert.equal(r.mail.mails, 2);
  const prompt = jobs.queued[0].payload.userPrompt;
  assert.equal(jobs.queued[0].feature, 'crm_money_mail');
  assert.ok(prompt.includes('SAVE10NOV') && prompt.includes('SCENT20'));
  assert.ok(!prompt.includes('ADOBE15'), 'Work mail is never read');
  assert.ok(!prompt.includes('SUMMER50'), 'mail older than 45 days is not read');
  assert.ok(!prompt.includes('dinner'), 'mail without offer words is not read');
  const refs = refsOf();
  jobs.finish(JSON.stringify({ findings: [
    { source_ref: refs[d.id], merchant: 'Dunnes Stores', title: '€10 off €50 online', code: 'SAVE10NOV', detail: 'Online, spend €50 or more', valid_until: addDays(today, 5), url: 'https://www.dunnesstores.com/offers/save10', quote: '€10 off when you spend €50 or more online' },
    { source_ref: refs[b.id], merchant: 'Boots', title: '20% off fragrance', code: 'SCENT20', valid_until: addDays(today, 3), url: 'https://www.boots.ie/fragrance', quote: '20% off all fragrance this weekend' },
    { source_ref: refs[b.id], merchant: 'Boots', title: 'Free delivery', code: 'FREESHIP', valid_until: 'next Tuesday', quote: 'Free delivery on all orders' },
    { source_ref: refs[d.id], merchant: 'Dunnes Stores', title: 'Bonus code', code: 'MADEUP99', valid_until: 'soon-ish', quote: 'Use code SAVE10NOV at checkout' },
  ] }));
  const done = await offers.tick({ jobs, t: t + 60 });
  assert.equal(done.mail.kept, 3);
  const dunnes = offer('€10 off €50 online');
  assert.deepEqual([dunnes.origin, dunnes.code, dunnes.url, dunnes.valid_until, dunnes.source_id], ['mail', 'SAVE10NOV', 'https://www.dunnesstores.com/offers/save10', addDays(today, 5), d.id]);
  assert.equal(dunnes.relevance, 'You spent €212.10 here in the last 180 days (14 purchases)', 'matched to "Dunnes Stores Bray" in the ledger');
  assert.equal(offer('20% off fragrance').url, '', 'a link that is not in the mail is dropped');
  assert.equal(offer('Free delivery'), undefined, 'a quote that is not in the mail is dropped');
  const bonus = offer('Bonus code');
  assert.deepEqual([bonus.code, bonus.valid_until], ['', null], 'a code not in the mail, and a date that does not parse, are dropped');
  assert.equal(db.crm().prepare('SELECT count(*) n FROM money_mail_seen WHERE source_id IN (?, ?)').get(work.id, old.id).n, 0);
  assert.equal(db.crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(d.id).atomise_status, 'held', 'reading releases nothing');
  const s = offers.screen();
  assert.deepEqual(s.useful.map(o => o.title), ['€10 off €50 online', 'Bonus code']);
  assert.deepEqual(s.temptation.map(o => o.title), ['20% off fragrance'], 'shops he does not buy from are temptation, not saving');
  assert.match(offers.summary().lines.join(' | '), /^2 offers from shops you use \(1 ending within 7 days\) \| 1 from shops you don't use/);
});

test('the same offer in two mails is stored once; offers expire; decisions are kept', async () => {
  const a = mail('personal', 'Offer', DUNNES), b = mail('personal', 'Offer again', DUNNES);
  const jobs = fakeJobs(), t = db.now();
  await offers.tick({ jobs, t });
  const f = ref => ({ source_ref: ref, merchant: 'Dunnes Stores', title: '€10 off €50 online', code: 'SAVE10NOV', valid_until: addDays(today, 5), quote: 'Use code SAVE10NOV at checkout' });
  const refs = refsOf();
  jobs.finish(JSON.stringify({ findings: [f(refs[a.id]), f(refs[b.id]), { ...f(refs[a.id]), title: 'Old one', valid_until: addDays(today, -1) }] }));
  assert.equal((await offers.tick({ jobs, t: t + 60 })).mail.kept, 1);
  assert.equal(offer('Old one'), undefined, 'an offer already over is not stored');
  const id = offer('€10 off €50 online').id;
  offers.decide(id, 'use', 750);
  assert.deepEqual([offer('€10 off €50 online').status, offer('€10 off €50 online').saved_cents], ['used', 750]);
  db.crm().prepare(`INSERT INTO money_offers (id, origin, dedupe_key, merchant, merchant_norm, title, valid_until, evidence) VALUES
    ('w1', 'web', 'k1', 'Tesco', 'tesco', 'Web code', ?, '{}'), ('m2', 'mail', 'k2', 'Lidl', 'lidl', 'Undated', NULL, ?)`)
    .run(addDays(today, -1), JSON.stringify({ quote: 'x', mail_on: addDays(today, -31) }));
  assert.equal(offers.expire(today), 2, 'past valid_until, and undated mail offers after 30 days');
  assert.equal(offer('€10 off €50 online').status, 'used', 'expiry never touches a used offer');
  assert.equal(offers.screen().saved_cents, 750);
  assert.throws(() => offers.decide('nope', 'save'), /not found/);
});

test('a malformed reply is a visible failure with a retry', async () => {
  mail('personal', 'Sale', BOOTS);
  const jobs = fakeJobs(), t = db.now();
  await offers.tick({ jobs, t });
  jobs.finish('{"findings": [ oops');
  await offers.tick({ jobs, t: t + 60 });
  const p = offers.problems();
  assert.equal(p.length, 1); assert.equal(p[0].module, 'offers'); assert.equal(p[0].retry, '/money/offers/retry');
  assert.match(p[0].text, /Offers mail reading: 1 batch of mail \(1 mails\) could not be read/);
});

test('the Offers screen renders mail and web offers, the deals panel, and records decisions', async () => {
  for (let i = 0; i < 3; i++) charge('Dunnes Stores', 10 + i, 40);
  charge('Tesco', 4, 60);
  const d = mail('personal', 'Dunnes offers', DUNNES);
  const jobs = fakeJobs(), t = db.now();
  await offers.tick({ jobs, t });
  jobs.finish(JSON.stringify({ findings: [
    { source_ref: 'M1', merchant: 'Dunnes Stores', title: '€10 off €50 online', code: 'SAVE10NOV', valid_until: addDays(today, 5), url: 'https://www.dunnesstores.com/offers/save10', quote: '€10 off when you spend €50 or more online' },
    { source_ref: 'M1', merchant: 'Harvey Norman', title: '15% off TVs', quote: 'Dunnes Stores' },
  ] }));
  await offers.tick({ jobs, t: t + 60 });
  db.crm().prepare(`INSERT INTO money_offers (id, origin, dedupe_key, merchant, merchant_norm, title, code, url, valid_until, evidence) VALUES
    ('w1', 'web', 'k1', 'Tesco', 'tesco', '5% off first order', 'TESCO5', 'https://www.example-codes.ie/tesco', ?, ?), ('w2', 'web', 'k2', 'Tesco', 'tesco', 'Bad link', '', 'javascript:alert(1)', NULL, '{}')`)
    .run(addDays(today, 9), JSON.stringify({ quote: 'Use TESCO5 for 5% off', source_url: 'https://www.example-codes.ie/tesco', checked_at: `${today}T09:00:00Z` }));
  const express = require('express');
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views')); app.use(express.urlencoded({ extended: false }));
  const session = {};
  app.use((req, res, next) => { req.session = session; Object.assign(res.locals, { flash: session.flash || null, reviewAll: 0, krispWaiting: 0, whatsappWaiting: 0, fmt: String, ago: String, hueStyle: () => '', icon: require('../lib/crm/icons') }); delete session.flash; next(); });
  const router = express.Router(), pass = (req, res, next) => next();
  offers.mount(router, { requireSameOrigin: pass, writeLimiter: pass, flash: (req, text, level = 'ok') => { req.session.flash = { text, level }; }, base: '/money' });
  app.use(router);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let html = await (await fetch(`${base}/money/offers`)).text();
    assert.match(html, /aria-current="page">Offers &amp; codes</);
    assert.match(html, /Searching the web for codes/, 'the deals panel is included');
    const main = html.slice(html.indexOf('At shops you already use'), html.indexOf('Not shops you use'));
    assert.match(main, /Dunnes Stores<\/span> · €10 off €50 online[^]*From your mail[^]*Code <code>SAVE10NOV<\/code>[^]*You spent €120\.00 here/);
    assert.match(main, /Tesco<\/span> · 5% off first order\s*<span class="pill warn">Found on the web — not tested<\/span>[^]*source example-codes\.ie[^]*<a href="https:\/\/www\.example-codes\.ie\/tesco" target="_blank" rel="noopener noreferrer nofollow">/);
    assert.ok(main.indexOf('SAVE10NOV') < main.indexOf('TESCO5'), 'sorted by what he spends there');
    assert.ok(!html.includes('href="javascript:'), 'only web links are linked');
    assert.match(html.slice(html.indexOf('Not shops you use')), /Harvey Norman/);
    assert.match(html, new RegExp(`href="/crm/personal/sources/${d.id}">open the email`));
    assert.equal((await fetch(`${base}/crm/work/money/offers`)).status, 404);
    const id = offer('€10 off €50 online').id;
    let res = await fetch(`${base}/money/offers/${id}/use`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'saved=12.50' });
    assert.equal(res.status, 302);
    assert.deepEqual([offer('€10 off €50 online').status, offer('€10 off €50 online').saved_cents], ['used', 1250]);
    html = await (await fetch(`${base}/money/offers`)).text();
    assert.match(html, /Noted: about €12\.50 saved at Dunnes Stores/); assert.match(html, /about €12\.50 saved/);
    res = await fetch(`${base}/money/offers/w1/use`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'saved=lots' });
    html = await (await fetch(`${base}/money/offers`)).text();
    assert.match(html, /Saved amount should be a number/); assert.equal(offer('5% off first order').status, 'new');
    await fetch(`${base}/money/offers/w1/dismiss`, { method: 'POST', redirect: 'manual' });
    assert.equal(offer('5% off first order').status, 'dismissed');
  } finally { server.close(); }
});
