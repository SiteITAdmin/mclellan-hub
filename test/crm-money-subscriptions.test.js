'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-subs-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const sources = require('../lib/crm/sources');
const subs = require('../lib/crm/money/subscriptions');
const { normMerchant, dublinDay, addDays } = require('../lib/crm/money/common');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const today = dublinDay();
const ago = d => addDays(today, -d);
function charge(merchant, daysAgo, euro, { category = 'Other', kind = 'spend', status = 'new' } = {}) {
  n += 1;
  db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, status, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`tx${n}`, ago(daysAgo), `POS ${merchant.toUpperCase()}`, merchant, normMerchant(merchant), -Math.round(euro * 100), category, kind, status, `k${n}`);
}
const row = merchant => db.crm().prepare('SELECT * FROM money_subscriptions WHERE merchant_norm = ?').get(normMerchant(merchant));
const shown = (s, merchant) => [...s.proven, ...s.mailOnly, ...s.watching, ...s.stopped, ...s.decided].find(x => x.merchant_norm === normMerchant(merchant));

function fakeJobs() {
  const jobs = { queued: [], state: {} };
  jobs.enqueue = ({ feature, dedupeKey, payload }) => { const id = `job${jobs.queued.length + 1}`; jobs.queued.push({ id, feature, dedupeKey, payload }); jobs.state[id] = { id, status: 'pending' }; return { jobId: id }; };
  jobs.getJob = id => jobs.state[id] || null;
  jobs.finish = (output, i = jobs.queued.length - 1) => { jobs.state[jobs.queued[i].id] = { id: jobs.queued[i].id, status: 'completed', result: { output } }; };
  return jobs;
}
function mail(space, title, text, { held = false, daysAgo = 2 } = {}) {
  n += 1;
  return sources.admitSource({ space, kind: 'email', origin: 'gmail', externalId: `mail${n}`, title, occurredAt: db.now() - daysAgo * 86400 - n, text,
    participants: [{ role: 'from', email: `noreply${n}@shop${n}.example`, name: 'Shop' }, { role: 'to', email: 'douglas@example.ie' }], holdUnknownSender: held }).source;
}

test('charges on a cadence become subscriptions; coffees, lapses and single charges do not', () => {
  for (const d of [74, 44, 14]) charge('Netflix', d, 12.99);
  charge('Amazon Prime', 370, 95); charge('Amazon Prime', 5, 95);
  for (const d of [100, 70, 40]) charge('Spotify', d, 10.99); charge('Spotify', 10, 11.99);
  charge('Starbucks', 20, 3.5); charge('Starbucks', 17, 3.5);
  charge('Tesco', 21, 54.2); charge('Tesco', 14, 81.07); charge('Tesco', 7, 33.9);
  charge('Old Magazine', 200, 6); charge('Old Magazine', 170, 6);
  charge('Audible', 3, 9.99, { category: 'Subscriptions' });
  charge('Netflix', 30, 50, { kind: 'transfer' });
  charge('Ignored Thing', 60, 5, { status: 'ignored' }); charge('Ignored Thing', 30, 5, { status: 'ignored' });
  subs.derive();
  const s = subs.screen();
  const netflix = shown(s, 'Netflix');
  assert.equal(netflix.cadence, 'monthly'); assert.equal(netflix.amount_cents, 1299); assert.equal(netflix.annual_cents, 15588);
  assert.equal(netflix.daily_cents, 43); assert.ok(netflix.next_due > today);
  assert.equal(shown(s, 'Amazon Prime').cadence, 'yearly');
  assert.ok(shown(s, 'Amazon Prime').renews_soon === false || shown(s, 'Amazon Prime').next_due > addDays(today, 14));
  const spotify = shown(s, 'Spotify');
  assert.deepEqual([spotify.amount_cents, spotify.rise.from_cents, spotify.rise.to_cents], [1199, 1099, 1199], 'price rise from the charges');
  assert.equal(row('Starbucks'), undefined, 'two coffees three days apart are not a subscription');
  assert.equal(row('Tesco'), undefined, 'weekly shopping of different amounts is not a subscription');
  assert.equal(row('Ignored Thing'), undefined, 'ignored transactions never count');
  assert.ok(s.stopped.some(x => x.merchant === 'Old Magazine'), 'no charge for over 1.6 cadences => seems to have stopped');
  assert.ok(s.watching.some(x => x.merchant === 'Audible'), 'one charge under Subscriptions is only watched');
  assert.equal(s.proven.length, 3);
  assert.equal(s.yearly_cents, 15588 + 9500 + 1199 * 12);
  assert.equal(s.proven[0].merchant, 'Netflix', 'sorted by annual cost');
  assert.deepEqual(s.overlaps.map(o => o.name), ['video streaming services'], 'Netflix and Amazon Prime overlap; Spotify alone does not');
  assert.match(subs.summary().lines[0], /^3 subscriptions, €394\.76 a year/);
});

test('decisions survive re-derivation: dismissed stays dismissed, to_cancel and cancelled flag new charges', async () => {
  for (const d of [60, 30]) charge('Gym Plus', d, 40);
  for (const d of [65, 35]) charge('Disney Plus', d, 8.99);
  for (const d of [66, 36]) charge('Now TV', d, 14.99);
  await subs.tick({ jobs: fakeJobs() });
  subs.decide(row('Gym Plus').id, 'dismiss');
  subs.decide(row('Disney Plus').id, 'cancel');
  subs.decide(row('Now TV').id, 'cancelled');
  db.crm().prepare('UPDATE money_subscriptions SET decided_at = ?').run(db.now() - 10 * 86400);
  charge('Gym Plus', 1, 40); charge('Disney Plus', 5, 8.99); charge('Now TV', 6, 14.99);
  const r = await subs.tick({ jobs: fakeJobs() });
  assert.ok(r.derived, 'a change in the ledger re-derives');
  assert.equal((await subs.tick({ jobs: fakeJobs() })).derived, undefined, 'no change, no re-derivation');
  assert.equal(row('Gym Plus').status, 'dismissed');
  const s = subs.screen();
  assert.equal(s.proven.find(x => x.merchant === 'Gym Plus'), undefined, 'never re-suggested');
  assert.deepEqual(s.stillCharging.map(x => [x.merchant, x.status]).sort(), [['Disney Plus', 'to_cancel'], ['Now TV', 'cancelled']]);
  assert.match(subs.summary().lines[0], /2 still charging after you meant to cancel/);
  db.crm().prepare("UPDATE money_transactions SET status = 'ignored' WHERE merchant = 'Disney Plus'").run();
  subs.derive();
  assert.equal(row('Disney Plus').status, 'to_cancel', 'a decided row is kept even when its charges go');
  assert.equal(row('Disney Plus').basis, 'none');
});

const NETFLIX = `Hi Douglas,\nThanks for your payment. Your Netflix membership will renew on ${addDays(today, 16)} for €12.99 per month.\nTo cancel, visit https://www.netflix.com/cancelplan?ref=email at any time.\nNetflix Ireland`;
const TRIAL = `Welcome to Headspace!\nYour free trial ends on ${addDays(today, 5)}. After that you'll be charged €12.99 monthly unless you cancel.`;

test('mail is read in bounded batches from Personal only; findings must quote the mail', async () => {
  for (const d of [74, 44, 14]) charge('Netflix', d, 12.99);
  const nf = mail('personal', 'Your Netflix receipt', NETFLIX);
  const hs = mail('personal', 'Your Headspace free trial', TRIAL, { held: true });
  const work = mail('work', 'Subscription renewal for Adobe', 'Your Adobe subscription renewal is due. Billing at €60 per month.');
  const plain = mail('personal', 'Lunch Saturday?', 'Are you free for lunch on Saturday?');
  assert.equal(db.crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(hs.id).atomise_status, 'held');
  const jobs = fakeJobs(), t = db.now();
  const first = await subs.tick({ jobs, t });
  assert.equal(first.mail.mails, 2);
  assert.equal(jobs.queued.length, 1);
  const q = jobs.queued[0];
  assert.equal(q.feature, 'crm_money_mail');
  assert.match(q.payload.userPrompt, /Your Netflix receipt/); assert.match(q.payload.userPrompt, /Headspace/);
  assert.ok(!q.payload.userPrompt.includes('Adobe'), 'Work mail is never read');
  assert.ok(!q.payload.userPrompt.includes('lunch'), 'mail without subscription words is not sent');
  assert.equal((await subs.tick({ jobs, t: t + 60 })).mail.waiting, q.payload.meta.moneyMail, 'one batch in flight at a time');
  assert.equal(jobs.queued.length, 1);
  const refs = Object.fromEntries(Object.entries(JSON.parse(db.crm().prepare('SELECT refs FROM money_mail_jobs').get().refs)).map(([k, v]) => [v, k]));
  jobs.finish(JSON.stringify({ findings: [
    { source_ref: refs[nf.id], merchant: 'Netflix', kind: 'receipt', amount: 12.99, currency: 'EUR', cadence: 'monthly', next_charge_on: addDays(today, 16), cancel_url: 'https://www.netflix.com/cancelplan?ref=email', quote: 'Your Netflix membership will renew on' },
    { source_ref: refs[hs.id], merchant: 'Headspace', kind: 'trial', amount: '12.99', currency: 'EUR', cadence: 'monthly', trial_ends_on: addDays(today, 5), cancel_url: 'https://www.headspace.com/cancel', quote: "After that you’ll be charged €12.99 monthly" },
    { source_ref: refs[nf.id], merchant: 'Hulu', kind: 'subscription', amount: 7.99, cadence: 'monthly', quote: 'Your Hulu plan renews next week' },
    { source_ref: 'M9', merchant: 'Ghost', kind: 'subscription', quote: 'Thanks for your payment' },
  ] }));
  const done = await subs.tick({ jobs, t: t + 120 });
  assert.equal(done.mail.kept, 2);
  assert.equal(row('Hulu'), undefined, 'a quote that is not in the mail is dropped');
  assert.equal(row('Ghost'), undefined, 'an unknown mail reference is dropped');
  const netflix = row('Netflix');
  assert.equal(netflix.origin, 'both'); assert.equal(netflix.cancel_url, 'https://www.netflix.com/cancelplan?ref=email');
  const head = row('Headspace');
  assert.deepEqual([head.origin, head.basis, head.amount_cents, head.cadence, head.trial_ends, head.cancel_url], ['mail', 'mail', 1299, 'monthly', addDays(today, 5), ''], 'a cancel link not in the mail is dropped');
  assert.equal(db.crm().prepare('SELECT count(*) n FROM money_mail_seen WHERE source_id = ?').get(work.id).n, 0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM atoms').get().n, 0, 'reading mail creates no facts');
  assert.equal(db.crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(hs.id).atomise_status, 'held', 'and releases nothing');
  const s = subs.screen();
  assert.ok(s.mailOnly.some(x => x.merchant === 'Headspace'));
  assert.ok(s.trials.some(x => x.merchant === 'Headspace'), 'trial ending within 7 days is flagged');
  assert.equal(s.yearly_cents, 15588, 'mail-only plans are not counted as proven');
  assert.equal(s.mail_yearly_cents, 15588);
  assert.equal((await subs.tick({ jobs, t: t + 180 })).mail.idle, true, 'read mail is not read again');
  mail('personal', 'Netflix: we have cancelled your membership', 'Your membership has been cancelled. We hope to see you again.');
  await subs.tick({ jobs, t: t + 240 });
  jobs.finish(JSON.stringify({ findings: [{ source_ref: 'M1', merchant: 'Netflix', kind: 'cancellation', quote: 'Your membership has been cancelled' }] }));
  await subs.tick({ jobs, t: t + 300 });
  assert.equal(row('Netflix').status, 'active', 'a cancellation mail is only a suggestion');
  assert.equal(row('Netflix').mail_cancelled_on, dublinDay(db.crm().prepare("SELECT occurred_at FROM sources WHERE title LIKE 'Netflix: we have%'").get().occurred_at));
});

test('a malformed reply fails visibly; a stale job is re-queued, then capped at three attempts', async () => {
  const jobs = fakeJobs();
  let t = db.now();
  mail('personal', 'Your invoice from Dropbox', 'Invoice: Dropbox Plus, billing yearly €119.88.');
  await subs.tick({ jobs, t });
  jobs.finish('Sorry, I cannot help with that {not json');
  await subs.tick({ jobs, t: t += 60 });
  let p = subs.problems();
  assert.equal(p.length, 1); assert.match(p[0].text, /could not be read.*Couldn't use the reader's reply/); assert.equal(p[0].retry, '/crm/personal/money/subscriptions/retry');
  assert.equal(require('../lib/crm/money').problems().filter(x => x.module === 'subscriptions').length, 1, 'shown on the Money screen');
  assert.equal(subs.retryFailed('subscription', { jobs }), 1);
  assert.equal(subs.problems().length, 0);
  jobs.finish(JSON.stringify({ findings: [] }));
  await subs.tick({ jobs, t: t += 60 });
  mail('personal', 'Your iCloud+ renewal', 'Your iCloud+ 200GB plan will renew for €2.99 monthly.');
  await subs.tick({ jobs, t: t += 3600 });
  const batch = () => db.crm().prepare("SELECT * FROM money_mail_jobs ORDER BY created_at DESC LIMIT 1").get();
  const before = jobs.queued.length;
  assert.equal((await subs.tick({ jobs, t: t += 19 * 60 })).mail.waiting, batch().id, 'under 20 minutes it waits');
  assert.ok((await subs.tick({ jobs, t: t += 2 * 60 })).mail.requeued);
  assert.equal(jobs.queued.length, before + 1); assert.notEqual(jobs.queued.at(-1).dedupeKey, jobs.queued.at(-2).dedupeKey);
  await subs.tick({ jobs, t: t += 21 * 60 });
  assert.equal(batch().attempts, 2);
  const last = await subs.tick({ jobs, t: t += 21 * 60 });
  assert.ok(last.mail.failed);
  assert.equal(batch().status, 'failed'); assert.equal(jobs.queued.length, before + 2, 'three attempts in all');
  assert.match(subs.problems()[0].text, /did not answer within 20 minutes/);
});

test('no more than three batches an hour, newest mail first', async () => {
  const jobs = fakeJobs(), t = db.now();
  for (let i = 0; i < 30; i++) mail('personal', `Receipt ${i}`, `Receipt for your subscription number ${i}. ${'x'.repeat(4000)}`, { daysAgo: 30 - i });
  for (let i = 0; i < 5; i++) { await subs.tick({ jobs, t: t + i * 120 }); jobs.finish(JSON.stringify({ findings: [] })); await subs.tick({ jobs, t: t + i * 120 + 60 }); }
  assert.equal(jobs.queued.length, 3);
  assert.match(jobs.queued[0].payload.userPrompt, /Receipt 29/, 'newest first');
  for (const j of jobs.queued) assert.ok(j.payload.userPrompt.length < 30000 && (j.payload.userPrompt.match(/\[M\d\]/g) || []).length <= 8, 'bounded batches');
});

test('the Subscriptions screen renders and its buttons record decisions', async () => {
  for (const d of [74, 44, 14]) charge('Netflix', d, 12.99);
  charge('Amazon Prime', 370, 95); charge('Amazon Prime', 5, 95);
  for (const d of [65, 35]) charge('Disney Plus', d, 8.99);
  charge('Audible', 3, 9.99, { category: 'Subscriptions' });
  subs.derive();
  subs.decide(row('Disney Plus').id, 'cancel');
  db.crm().prepare("UPDATE money_subscriptions SET decided_at = ?, cancel_url = 'https://www.disneyplus.com/account' WHERE merchant = 'Disney Plus'").run(db.now() - 10 * 86400);
  charge('Disney Plus', 5, 8.99); subs.derive();
  const express = require('express');
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views')); app.use(express.urlencoded({ extended: false }));
  const session = {};
  app.use((req, res, next) => { req.session = session; Object.assign(res.locals, { flash: session.flash || null, reviewAll: 0, krispWaiting: 0, whatsappWaiting: 0, fmt: String, ago: String, hueStyle: () => '', icon: require('../lib/crm/icons') }); delete session.flash; next(); });
  const router = express.Router();
  const pass = (req, res, next) => next();
  subs.mount(router, { spaceParam: (req, res, next) => { res.locals.space = req.params.space; next(); }, personalOnly: (req, res, next) => req.params.space === 'personal' ? next() : res.status(404).send('Not found'),
    requireSameOrigin: pass, writeLimiter: pass, flash: (req, text, level = 'ok') => { req.session.flash = { text, level }; } });
  app.use(router);
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/crm/personal/money/subscriptions`); assert.equal(res.status, 200);
    let html = await res.text();
    assert.match(html, /<link rel="stylesheet" href="\/money.css">/);
    assert.match(html, /aria-current="page">Subscriptions</);
    assert.match(html, /Every year<\/div><div class="value">€358\.76</);
    assert.match(html, /This costs <strong>€155\.88 a year<\/strong> — about €0\.43 a day/);
    assert.match(html, /Disney Plus<\/strong> is still charging after you said you wanted to cancel/);
    assert.match(html, /href="https:\/\/www\.disneyplus\.com\/account" target="_blank" rel="noopener noreferrer nofollow">open the cancel page/);
    assert.match(html, /You pay for 3 video streaming services: Netflix, Disney Plus, Amazon Prime/);
    assert.match(html, /Watching: one charge so far[^]*Audible/);
    assert.match(html, /No Personal mail has been captured yet/);
    assert.equal((await fetch(`${base}/crm/work/money/subscriptions`)).status, 404);
    res = await fetch(`${base}/crm/personal/money/subscriptions/${row('Netflix').id}/dismiss`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(row('Netflix').status, 'dismissed');
    html = await (await fetch(`${base}/crm/personal/money/subscriptions`)).text();
    assert.match(html, /Netflix won&#39;t be suggested as a subscription again/);
    assert.match(html, /Cancelled and not subscriptions \(1\)/);
    res = await fetch(`${base}/crm/personal/money/subscriptions/${row('Netflix').id}/keep`, { method: 'POST', redirect: 'manual' });
    assert.deepEqual([row('Netflix').status, row('Netflix').note], ['active', 'keep']);
  } finally { server.close(); }
});

test('rent, a loan and regular shop visits are not subscriptions; a small monthly bill and a mailed plan are', () => {
  for (const d of [64, 34, 4]) { charge('Landlord rent', d, 1400, { category: 'Home & utilities' }); charge('Credit union', d, 450); charge('Electric Example', d, 85, { category: 'Home & utilities' }); }
  for (const d of [22, 15, 8, 1]) { charge('Circle K', d, 55, { category: 'Fuel' }); charge('Deliveroo', d, 28.5, { category: 'Eating out' }); }
  for (const d of [15, 8, 1]) charge('Window cleaner', d, 20);
  for (const d of [61, 31, 1]) charge('Tesco Mobile', d, 20, { category: 'Shopping' });
  subs.derive();
  for (const m of ['Landlord rent', 'Credit union', 'Circle K', 'Deliveroo', 'Window cleaner', 'Tesco Mobile']) assert.equal(row(m), undefined, m);
  assert.equal(row('Electric Example').cadence, 'monthly');
  const m = mail('personal', 'Your Tesco Mobile plan', 'Your Tesco Mobile plan renews monthly at €20.00.');
  subs.applyMail([{ source_ref: 'M1', merchant: 'Tesco Mobile', kind: 'subscription', amount: 20, currency: 'EUR', cadence: 'monthly', quote: 'Your Tesco Mobile plan renews monthly at €20.00.' }], { M1: { ...m, haystack: `${m.title}\n${m.text}` } });
  subs.derive();
  assert.equal(row('Tesco Mobile').origin, 'both');
});

test('a quote that runs across reply-quoted lines is still the mail\'s own words', () => {
  const text = 'On 14 Nov, Support wrote:\r\n>>\r\n>> I am trying to use my Revolut Ultra plan subscription but I fear I have\r\n>> been set up before and its not working.';
  assert.ok(subs.quoteIn('I am trying to use my Revolut Ultra plan subscription but I fear I have been set up before and its not working.', text));
  assert.equal(subs.quoteIn('I cancelled my Revolut Ultra plan', text), null);
});
