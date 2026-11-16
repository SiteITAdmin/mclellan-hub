'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-prices-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const { normMerchant, addDays, CATEGORIES } = require('../lib/crm/money/common');
const prices = require('../lib/crm/money/prices');
const receipts = require('../lib/crm/money/receipts');
const subs = require('../lib/crm/money/subscriptions');
const insights = require('../lib/crm/money/insights');
const ledger = require('../lib/crm/money/ledger');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const T = Math.floor(Date.parse('2026-11-15T12:00:00Z') / 1000), TODAY = '2026-11-15';
const day = back => addDays(TODAY, -back);
const item = (product, cents, size, unit, more = {}) => ({ description: product.toUpperCase(), cents, category: 'Groceries', product, brand: '', quantity: 1, size, unit, ...more });
function receipt(shop, back, items) {
  n += 1;
  const total = items.reduce((s, i) => s + i.cents, 0);
  db.crm().prepare(`INSERT INTO money_receipts (id, upload_id, shop, shop_norm, bought_on, amount_cents, items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`r${n}`, `u${n}`, shop, normMerchant(shop), day(back), -total, JSON.stringify(items), T);
}
function tx(back, merchant, euros, category, o = {}) {
  n += 1;
  db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, category_by, kind, status, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'spend', 'confirmed', ?)`).run(`t${n}`, day(back), o.description || merchant, merchant, normMerchant(merchant), -Math.round(euros * 100), category, o.by || 'model', `k${n}`);
}
function fakeQueue() {
  const q = { sent: [], jobs: {}, enqueue(x) { const jobId = `job${q.sent.length + 1}`; q.sent.push({ ...x, jobId }); q.jobs[jobId] = { id: jobId, status: 'pending' }; return { jobId }; },
    getJob: id => q.jobs[id] || null,
    answer(reply, jobId = q.sent.at(-1).jobId) { q.jobs[jobId] = { id: jobId, status: 'completed', result: { output: JSON.stringify(reply), meta: { runner: 'claude', model: 'sonnet' } } }; } };
  return q;
}

// Milk six times at SuperValu and once at Lidl; bread and bananas in both; butter only at SuperValu, dearer than last time.
function plant() {
  for (const back of [70, 56, 42, 28, 14, 3]) receipt('SuperValu', back, [item('whole milk', 225, 2, 'l', { brand: 'Avonmore' }), item('sliced white bread', 199, 800, 'g'), item('Bananas', 96, 0.642, 'kg')]);
  receipt('SuperValu', 60, [item('butter', 329, 454, 'g')]);
  receipt('SuperValu', 5, [item('butter', 369, 454, 'g'), item('', -100, null, ''), item('lottery ticket', 400, null, '')]);
  receipt('Lidl', 10, [item('whole milk', 189, 2, 'l', { brand: 'own brand' }), item('sliced white bread', 119, 800, 'g'), item('banana', 79, 0.6, 'kg'), item('chocolate', 99, 100, 'g')]);
}

test('items are tracked by what they are, and the same thing cheaper in another shop on his own receipts is found', () => {
  plant();
  const prods = prices.products(T);
  assert.deepEqual(prods.map(p => [p.key, p.buys.length]).sort(), [['banana|kg', 7], ['butter|kg', 2], ['chocolate|kg', 1], ['lottery ticket|each', 1], ['sliced white bread|kg', 7], ['whole milk|l', 7]]);
  const cheaper = prices.cheaperElsewhere(T);
  assert.deepEqual(cheaper.map(c => [c.product, c.usual.shop, c.cheapest.shop, c.pct, c.over_cents]), [
    ['sliced white bread', 'SuperValu', 'Lidl', 67, 480],
    ['whole milk', 'SuperValu', 'Lidl', 19, 216],
    ['Bananas', 'SuperValu', 'Lidl', 14, 69],
  ]);
  assert.equal(cheaper[1].brands, 'Avonmore against own brand');
  assert.deepEqual(prices.changes(T).map(c => [c.product, c.shop, c.up, c.pct]), [['butter', 'SuperValu', true, 12]]);
  const pairs = prices.shopPairs(T);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].dear.shop, pairs[0].cheap.shop, pairs[0].common, pairs[0].cheap.wins], ['SuperValu', 'Lidl', 3, 3]);
  assert.ok(pairs[0].dear.cents > pairs[0].cheap.cents && pairs[0].pct > 10);
  assert.deepEqual(prices.knownProducts(150, T).sort(), ['Bananas', 'butter', 'chocolate', 'lottery ticket', 'sliced white bread', 'whole milk'], 'each product is offered to the reader once, as last written');
});

test('a single against a multipack with no size printed is not called cheaper', () => {
  receipt('SuperValu', 20, [item('eggs', 320, 1, 'each')]); receipt('SuperValu', 6, [item('eggs', 320, 1, 'each')]);
  receipt('Lidl', 8, [item('eggs', 30, 1, 'each')]);
  assert.deepEqual(prices.cheaperElsewhere(T), []);
});

test('the receipt reader is asked for product, brand and size, and its reply is kept', () => {
  assert.match(receipts.PROMPT, /"product": the plain everyday name/);
  plant();
  const prompt = receipts.userPrompt({ mime: 'image/png', created_at: T }, T);
  assert.match(prompt, /Products on his earlier receipts.*whole milk/s);
  const p = receipts.parse(JSON.stringify({ readable: true, transactions: [], receipt: { shop: 'Tesco', date: TODAY, total: 4.5, items: [
    { description: 'AVON MILK 2L', amount: 2.25, category: 'groceries', product: 'Whole Milk', brand: 'Avonmore', quantity: 1, size: 2, unit: 'L' },
    { description: 'AMERICANO', amount: 2.25, category: 'Coffee', product: 'americano', size: 'big', unit: 'cup', quantity: -1 }] } }), { today: TODAY, uploaded: TODAY });
  assert.deepEqual(p.items.map(i => [i.product, i.brand, i.quantity, i.size, i.unit, i.category]), [['whole milk', 'Avonmore', 1, 2, 'l', 'Groceries'], ['americano', '', 1, null, '', 'Coffee']]);
});

test('he is asked why, his answer stops the question, and "ask me again" reopens it', () => {
  plant();
  const s = prices.screen(T);
  assert.deepEqual([s.asked.map(c => c.product), s.asked_cents, s.answered.length], [['sliced white bread', 'whole milk', 'Bananas'], 765, 0]);
  assert.match(prices.summary(T).lines[0], /^3 things cheaper in another shop you use: €7\.65 over 90 days\. Why there\?$/);
  const stats = prices.stats(T);
  assert.deepEqual(stats.map(x => x.kind), ['cheaper_elsewhere', 'cheaper_elsewhere', 'cheaper_elsewhere', 'shop_basket', 'price_rise']);
  assert.match(stats[0].text, /sliced white bread is €2\.49 a kg at SuperValu, where he bought it 6 times in the last 90 days, and was €1\.49 a kg at Lidl on 5 Nov: 67% more at SuperValu\. Bought at Lidl instead, those purchases would have cost €4\.80 less\./);
  assert.match(stats.at(-1).text, /butter at SuperValu went from €7\.25 a kg on 16 Sept to €8\.13 a kg on 10 Nov, up 12%/);

  const milk = s.asked[1], ids = { key: milk.key, usual: milk.usual.shop_norm, cheaper: milk.cheapest.shop_norm };
  assert.throws(() => prices.answerWhy({ ...ids, reason: '  ' }, T), /Say why in a line/);
  assert.throws(() => prices.answerWhy({ ...ids, cheaper: 'tesco', reason: 'x' }, T), /no longer open/);
  prices.answerWhy({ ...ids, reason: 'Lidl is a 20 minute drive' }, T);
  const after = prices.screen(T);
  assert.deepEqual([after.asked.map(c => c.product), after.asked_cents], [['sliced white bread', 'Bananas'], 549]);
  assert.deepEqual(after.answered.map(c => [c.product, c.answer.reason]), [['whole milk', 'Lidl is a 20 minute drive']]);
  assert.equal(prices.stats(T).filter(x => x.kind === 'cheaper_elsewhere').length, 2, 'an answered question is not put to the challenge');
  prices.askAgain(ids);
  assert.equal(prices.screen(T).asked.length, 3);
  assert.throws(() => prices.askAgain(ids), /no answer to remove/);
  assert.equal(require('../lib/crm/money/index').MODULES.includes('prices'), true);
  assert.equal(prices.tick, undefined, 'nothing is looked up anywhere: there is no background work');
});

test('subscriptions: his own answer on use gives a cost per use, is asked again after three months, and reaches the challenge', () => {
  const c = db.crm();
  for (const [id, name, cents] of [['s1', 'Netflix', 1599], ['s2', 'Spotify', 1199], ['s3', 'Gym Plus', 4500]]) {
    c.prepare(`INSERT INTO money_subscriptions (id, merchant, merchant_norm, amount_cents, cadence, last_charge_on, first_seen, basis, evidence) VALUES (?, ?, ?, ?, 'monthly', ?, ?, 'recurring', '{}')`)
      .run(id, name, normMerchant(name), cents, day(5), day(200));
  }
  tx(1, 'Tesco', 10, 'Groceries');
  let s = subs.screen({ today: TODAY, t: T });
  assert.deepEqual([s.value.asked, s.value.unrated.length, s.value.unrated_monthly_cents, s.value.poor.length], [3, 3, 7298, 0]);
  subs.rateUse('s1', 'never', T); subs.rateUse('s2', 'daily', T); subs.rateUse('s3', 'monthly', T);
  assert.throws(() => subs.rateUse('s3', 'sometimes', T), /Choose how often/);
  s = subs.screen({ today: TODAY, t: T });
  const by = id => s.proven.find(x => x.id === id).value;
  assert.equal(by('s1').text, 'You said you do not use it: €191.88 a year for nothing.');
  assert.equal(by('s2').text, 'You said you use it most days: about €0.55 each time.');
  assert.equal(by('s3').text, 'You said you use it once or twice: about €30.00 each time.');
  assert.deepEqual([s.value.unrated.length, s.value.poor.map(x => x.merchant), s.value.poor_yearly_cents], [0, ['Netflix'], 19188]);
  assert.match(subs.summary().lines.join(' '), /€191\.88 a year on 1 you say you hardly use/);
  const later = subs.screen({ today: addDays(TODAY, 91), t: T + 91 * 86400 });
  assert.equal(later.value.unrated.length, 3, 'an answer about use goes stale');
  assert.equal(later.value.poor.length, 0);
});

test('coffee is its own category: lines already filed under Eating out are moved once, and his own choices are left', async () => {
  assert.ok(CATEGORIES.includes('Coffee'));
  assert.match(ledger.PROMPT || '', /"Coffee": coffee shops/);
  tx(3, 'Costa Coffee', 3.7, 'Eating out'); tx(3, 'Insomnia', 4.1, 'Eating out'); tx(4, 'Smudgy Café', 4.5, 'Eating out'); tx(4, 'Smudgy Café', 24, 'Eating out');
  tx(5, 'Just Eat', 25, 'Eating out'); tx(5, 'Starbucks', 5.2, 'Eating out', { by: 'you' }); tx(6, 'Tesco', 30, 'Groceries', { description: 'TESCO COFFEE AISLE' });
  const q = fakeQueue();
  await ledger.tick({ jobs: q, t: T });
  const rows = db.crm().prepare('SELECT merchant, amount_cents, category FROM money_transactions ORDER BY rowid').all().map(r => `${r.merchant} ${-r.amount_cents} ${r.category}`);
  assert.deepEqual(rows, ['Costa Coffee 370 Coffee', 'Insomnia 410 Coffee', 'Smudgy Café 450 Coffee', 'Smudgy Café 2400 Eating out', 'Just Eat 2500 Eating out', 'Starbucks 520 Eating out', 'Tesco 3000 Groceries']);
  tx(1, 'Costa Coffee', 3.7, 'Eating out');
  await ledger.tick({ jobs: q, t: T + 60 });
  assert.equal(db.crm().prepare("SELECT category FROM money_transactions ORDER BY rowid DESC LIMIT 1").get().category, 'Eating out', 'it runs once: later lines are the reader\'s to file');
});

test('standing checks: by shop, what a visit costs, top-up trips, and a cap he sets is judged from the ledger', () => {
  for (const back of [1, 3, 5, 8, 10, 12, 15, 20, 30, 40]) tx(back, 'Starbucks', 5.4, 'Coffee');
  for (const back of [2, 9, 16, 35]) tx(back, 'Insomnia', 3.9, 'Coffee');
  tx(50, 'Bean There', 3, 'Coffee');
  for (const back of [4, 11, 18, 25, 60]) tx(back, 'SuperValu', 62, 'Groceries');
  for (const back of [2, 6, 13]) tx(back, 'Centra', 7.5, 'Groceries');
  const checks = insights.checks({ t: T });
  assert.deepEqual(checks.map(c => c.name), ['Coffee', 'Groceries']);
  const coffee = checks[0];
  assert.equal(coffee.as_of, day(1));
  assert.deepEqual(coffee.shops.map(s => [s.name, s.n, s.cents, s.avg]), [['Starbucks', 10, 5400, 540], ['Insomnia', 4, 1560, 390], ['Bean There', 1, 300, 300]]);
  assert.deepEqual([coffee.spread.low.name, coffee.spread.high.name], ['Insomnia', 'Starbucks'], 'a shop used once is not the benchmark');
  assert.deepEqual([coffee.l28.n, coffee.l28.cents, coffee.yearly], [11, 5490, Math.round(5490 * 365 / 28)]);
  assert.equal(coffee.suggested_cap_cents, 4500);
  assert.deepEqual(checks[1].topups, { n: 3, cents: 2250, limit: 1500 });

  assert.throws(() => insights.capCategory('Coffee', 'lots', { t: T }), /Write the cap as euro/);
  assert.throws(() => insights.capCategory('Travel', '40', { t: T }), /no spending of that kind/);
  const c = insights.capCategory('Coffee', '€40', { t: T });
  assert.deepEqual([c.scope, c.name, c.norm, c.monthly_cap_cents, c.month, c.status], ['category', 'Coffee', 'coffee', 4000, '2026-11', 'active']);
  assert.throws(() => insights.capCategory('Coffee', '30', { t: T }), /already have a cap on Coffee/);
  const held = insights.checks({ t: T })[0].commitment.progress;
  assert.deepEqual([held.spent, held.over], [5 * 540 + 2 * 390 + 540, true], 'November so far is already over');
});

test('the challenge is given the new figures: shops, top-ups, subscription use and prices', () => {
  for (let back = 1; back <= 120; back += 2) tx(back, 'Starbucks', 5.4, 'Coffee');
  for (let back = 2; back <= 120; back += 9) tx(back, 'Insomnia', 3.9, 'Coffee');
  for (let back = 3; back <= 120; back += 7) tx(back, 'SuperValu', 62, 'Groceries');
  for (let back = 4; back <= 120; back += 10) tx(back, 'Centra', 7.5, 'Groceries');
  plant();
  db.crm().prepare(`INSERT INTO money_subscriptions (id, merchant, merchant_norm, amount_cents, cadence, last_charge_on, first_seen, basis, evidence, use_level, use_at)
    VALUES ('s1', 'Netflix', 'netflix', 1599, 'monthly', ?, ?, 'recurring', '{}', 'rarely', ?), ('s2', 'Spotify', 'spotify', 1199, 'monthly', ?, ?, 'recurring', '{}', '', NULL)`).run(day(5), day(200), T, day(5), day(200));
  const packet = insights.buildPacket({ t: T });
  assert.equal(packet.ok, true);
  const of = kind => packet.stats.filter(s => s.kind === kind);
  assert.match(of('by_shop')[0].text, /^Coffee by shop in the 90 days to 14 Nov: Starbucks 45 purchases, €243\.00, average €5\.40; Insomnia 10 purchases, €39\.00, average €3\.90\. Of the shops used more than once, the average is lowest at Insomnia and highest at Starbucks: €1\.50 more each time\.$/);
  assert.match(of('top_ups')[0].text, /^Grocery purchases under €15\.00 in the 90 days to 14 Nov: 9, adding up to €67\.50/);
  assert.equal(of('subscription_value')[0].text, 'He says he hardly or never uses: Netflix (hardly ever, €191.88 a year). Together €191.88 a year, €15.99 a month.');
  assert.match(of('subscription_unrated')[0].text, /^1 of his 2 subscriptions has no answer yet for how much he uses it: Spotify\. Together €11\.99 a month\.$/);
  assert.equal(of('cheaper_elsewhere').length, 3); assert.equal(of('shop_basket').length, 1); assert.equal(of('price_rise').length, 1);
  assert.match(insights.SYSTEM_PROMPT, /ask why he buys it there/);
  const before = packet.hash;
  subs.rateUse('s2', 'never', T);
  assert.notEqual(insights.buildPacket({ t: T }).hash, before, 'a new answer on use is something new to read');

  // The checker lets a challenge quote these figures and nothing else.
  const cheap = of('cheaper_elsewhere')[0], shop = of('by_shop')[0];
  const body = insights.validate({ headline: 'Bread costs 67% more at SuperValu.', challenges: [
    { title: 'Bread at SuperValu', question: 'Why buy bread at SuperValu at €2.49 a kg when Lidl had it at €1.49?', observation: 'It cost €4.80 more over 90 days.', evidence: [cheap.id], saving_cents_per_month: 160, saving_basis: `${cheap.id}: buy it at Lidl`, action: 'Buy bread at Lidl this week.', target: null },
    { title: 'Coffee at Starbucks', question: 'Starbucks is €1.50 more each time than Insomnia. What do you get for it?', observation: '45 purchases, €243.00.', evidence: [shop.id], saving_cents_per_month: 2000, saving_basis: `${shop.id}: half of them at Insomnia`, action: 'Cap coffee.', target: { scope: 'category', name: 'Coffee', monthly_cap_cents: 6000 } },
    { title: 'Made up', question: 'Milk is €9.99 at SuperValu?', observation: '', evidence: [cheap.id], saving_cents_per_month: 100, saving_basis: '', action: 'x', target: null },
  ], habits: [], wins: [] }, packet);
  assert.deepEqual(body.challenges.map(c => c.title), ['Coffee at Starbucks', 'Bread at SuperValu']);
  assert.equal(body.dropped.length, 1);
});

test('the screens: Prices, the standing checks on Challenge with a cap, and the use buttons on Subscriptions', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = new Proxy({ adminUser: 'douglas' }, { set(t, k, v) { if (k === 'crmFlash' && v) flashes.push(v); t[k] = v; return true; } }); next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = '') => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const today = require('../lib/crm/money/common').dublinDay(), ago = k => addDays(today, -k);
  const real = (shop, back, items) => { n += 1; db.crm().prepare(`INSERT INTO money_receipts (id, upload_id, shop, shop_norm, bought_on, amount_cents, items) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`r${n}`, `u${n}`, shop, normMerchant(shop), ago(back), -500, JSON.stringify(items)); };
  try {
    const empty = await (await fetch(`${base}/crm/personal/money/prices`)).text();
    assert.match(empty, /No receipts yet/); assert.match(empty, /aria-current="page">Prices</);
    assert.equal((await fetch(`${base}/crm/work/money/prices`)).status, 404);

    for (const back of [30, 20, 9, 2]) real('SuperValu', back, [item('whole milk', 225, 2, 'l'), item('<i>bread</i>', 199, 800, 'g'), item('bananas', 96, 0.642, 'kg')]);
    real('Lidl', 5, [item('whole milk', 189, 2, 'l'), item('<i>bread</i>', 119, 800, 'g'), item('bananas', 79, 0.6, 'kg')]);
    const page = await (await fetch(`${base}/crm/personal/money/prices`)).text();
    assert.match(page, /whole milk: why SuperValu\?/);
    assert.match(page, /You buy it at <strong>SuperValu<\/strong> for €1\.13 a litre \(4 times in 90 days\)\. Your <strong>Lidl<\/strong> receipt of \d+ \w+ has it for €0\.95 a litre/);
    assert.match(page, /SuperValu against Lidl/); assert.match(page, /3 things bought in both; 3 cheaper at Lidl/);
    assert.doesNotMatch(page, /on the web/i);
    assert.match(page, /&lt;i&gt;bread&lt;\/i&gt;/, 'escaped'); assert.doesNotMatch(page, /<i>bread<\/i>/);
    assert.match(page, /What you buy again and again/);
    const overview = await (await fetch(`${base}/crm/personal/money`)).text();
    assert.match(overview, /<h2>Prices<\/h2>/); assert.match(overview, /3 things cheaper in another shop you use/);
    assert.equal((await post('/crm/personal/money/prices/why', 'key=whole+milk%7Cl&usual=supervalu&cheaper=lidl&reason=Lidl+is+too+far')).status, 302);
    assert.match(flashes.pop().text, /^Noted for whole milk\. You will not be asked again/);
    const answered = await (await fetch(`${base}/crm/personal/money/prices`)).text();
    assert.doesNotMatch(answered, /whole milk: why SuperValu\?/); assert.match(answered, /Answered \(1\)/); assert.match(answered, /“Lidl is too far”/);
    assert.equal((await post('/crm/personal/money/prices/ask-again', 'key=whole+milk%7Cl&usual=supervalu&cheaper=lidl')).status, 302);
    assert.match(await (await fetch(`${base}/crm/personal/money/prices`)).text(), /whole milk: why SuperValu\?/);

    const txAgo = (back, merchant, euros, category) => { n += 1; db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, status, dup_key) VALUES (?, ?, ?, ?, ?, ?, ?, 'spend', 'confirmed', ?)`).run(`t${n}`, ago(back), merchant, merchant, normMerchant(merchant), -Math.round(euros * 100), category, `k${n}`); };
    for (const back of [0, 2, 4, 6, 8]) txAgo(back, 'Starbucks', 5.4, 'Coffee');
    for (const back of [1, 9]) txAgo(back, 'Insomnia', 3.9, 'Coffee');
    db.crm().prepare(`INSERT INTO money_subscriptions (id, merchant, merchant_norm, amount_cents, cadence, last_charge_on, first_seen, basis, evidence) VALUES ('s1', 'Netflix', 'netflix', 1599, 'monthly', ?, ?, 'recurring', '{}')`).run(ago(3), ago(200));
    const challenge = await (await fetch(`${base}/crm/personal/money/challenge`)).text();
    assert.match(challenge, /Standing checks/); assert.match(challenge, /<th scope="row">Starbucks<\/th><td>5<\/td><td>€5\.40<\/td><td>€27\.00<\/td>/);
    assert.match(challenge, /A visit to <strong>Starbucks<\/strong> costs €1\.50 more than one to Insomnia/);
    assert.match(challenge, /1 not rated for how much you use it\./); assert.match(challenge, />Rate them</); assert.match(challenge, />Answer why</); assert.match(challenge, /Why SuperValu\?/);
    assert.equal((await post('/crm/personal/money/challenge/cap', 'category=Coffee&cap=20')).status, 302);
    assert.match(flashes.pop().text, /^Taken on: Coffee under €20\.00 this month/);
    assert.match(await (await fetch(`${base}/crm/personal/money/challenge`)).text(), /Your cap this month: €\d+\.\d\d of €20\.00/);

    const subsPage = await (await fetch(`${base}/crm/personal/money/subscriptions`)).text();
    assert.match(subsPage, /Are they worth it\?/); assert.match(subsPage, /1 of 1 has no answer yet \(€15\.99 a month\)/);
    assert.match(subsPage, /In the last month, how much did you use it\?/); assert.match(subsPage, /name="level" value="never">Not at all</);
    assert.equal((await post('/crm/personal/money/subscriptions/s1/use', 'level=never')).status, 302);
    assert.match(flashes.pop().text, /^Netflix: not at all\. Asked again in three months\.$/);
    const rated = await (await fetch(`${base}/crm/personal/money/subscriptions`)).text();
    assert.match(rated, /<strong>€191\.88 a year<\/strong> goes on one you say you hardly use/); assert.match(rated, /You said you do not use it: €191\.88 a year for nothing\./);
  } finally { server.close(); }
});
