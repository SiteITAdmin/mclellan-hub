'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-categories-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const { normMerchant, categories, billCategories, CATEGORIES, dublinDay, addDays } = require('../lib/crm/money/common');
const cats = require('../lib/crm/money/categories');
const ledger = require('../lib/crm/money/ledger');
const receipts = require('../lib/crm/money/receipts');
const budget = require('../lib/crm/money/budget');
const insights = require('../lib/crm/money/insights');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const T = Math.floor(Date.parse('2026-11-15T12:00:00Z') / 1000);
const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function tx(date, merchant, euros, category, by = 'model') {
  n += 1;
  db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, category_by, kind, status, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'spend', 'confirmed', ?)`).run(`t${n}`, date, merchant, merchant, normMerchant(merchant), -Math.round(euros * 100), category, by, `k${n}`);
  return `t${n}`;
}
const cat = id => db.crm().prepare('SELECT category, category_by FROM money_transactions WHERE id = ?').get(id);

test('a category he adds joins the list before Other, is checked for a sensible name, and can be a bill', () => {
  assert.deepEqual(categories(), CATEGORIES);
  assert.equal(cats.add({ name: '  Kids ', about: 'school, clubs and clothes for the children' }, T), 'Kids');
  cats.add({ name: 'Car loan', bill: '1' }, T + 1);
  assert.deepEqual(categories().slice(-3), ['Kids', 'Car loan', 'Other']);
  assert.ok(billCategories().has('Car loan') && !billCategories().has('Kids') && billCategories().has('Insurance'));
  assert.throws(() => cats.add({ name: 'kids' }, T), /already a category called Kids/);
  assert.throws(() => cats.add({ name: 'groceries' }, T), /already a category called Groceries/);
  assert.throws(() => cats.add({ name: '' }, T), /Give it a name/);
  assert.throws(() => cats.add({ name: '<script>' }, T), /Give it a name/);
  assert.throws(() => cats.save({ name: 'Groceries', about: 'x' }), /built in and stays/);
  cats.save({ name: 'Kids', about: 'anything for Nakai', bill: '' });
  assert.equal(cats.own()[0].about, 'anything for Nakai');
});

test('the readers are told about it and may use it; a picker and a correction accept it', () => {
  cats.add({ name: 'Kids', about: 'school, clubs and clothes for the children' }, T);
  const bankPrompt = ledger.userPrompt({ source: 'screenshot', account: 'AIB' }, T);
  assert.match(bankPrompt, /Douglas has added categories of his own\. They are as valid as those in the list; use one when a row fits it better:\n- "Kids": school, clubs and clothes for the children/);
  assert.match(receipts.userPrompt({ mime: 'image/png', created_at: T }, T), /- "Kids": school, clubs/);
  const read = ledger.parseReading(JSON.stringify({ readable: true, transactions: [
    { date: day(11, 10), description: 'SMYTHS TOYS', merchant: 'Smyths', amount: -30, kind: 'spend', category: 'kids' },
    { date: day(11, 10), description: 'MYSTERY', merchant: 'Mystery', amount: -5, kind: 'spend', category: 'Pets' }] }), { today: day(11, 15) });
  assert.deepEqual(read.rows.map(r => r.category), ['Kids', 'Other'], 'his category is taken; one he never made up is not');
  const r = receipts.parse(JSON.stringify({ readable: true, transactions: [], receipt: { shop: 'Smyths', date: day(11, 10), total: 30, items: [{ description: 'LEGO', amount: 30, category: 'Kids', product: 'lego set' }] } }), { today: day(11, 15), uploaded: day(11, 15) });
  assert.equal(r.items[0].category, 'Kids');
  const id = tx(day(11, 10), 'Smyths', 30, 'Shopping');
  ledger.updateTx(id, { category: 'Kids', always: '1' }, T);
  assert.deepEqual(cat(id), { category: 'Kids', category_by: 'you' });
  assert.equal(ledger.list({ category: 'Kids' }).totals.n, 1, 'the Transactions filter takes it');
});

test('moving shops in writes his rules: past lines move, his own choices stay, new lines follow', async () => {
  cats.add({ name: 'Kids' }, T);
  const a = tx(day(11, 1), 'Smyths', 30, 'Shopping'), b = tx(day(11, 3), 'Smyths', 12, 'Shopping', 'you'), c = tx(day(11, 4), 'Hamleys', 20, 'Entertainment'), d = tx(day(11, 5), 'Tesco', 50, 'Groceries');
  const shops = cats.shops(T);
  assert.deepEqual(shops.map(s => [s.merchant, s.category]), [['Tesco', 'Groceries'], ['Smyths', 'Shopping'], ['Hamleys', 'Entertainment']]);
  assert.throws(() => cats.moveShops({ name: 'Kids' }, T), /Tick at least one shop/);
  assert.throws(() => cats.moveShops({ name: 'Nope', shops: ['smyths'] }, T), /no longer there/);
  const r = cats.moveShops({ name: 'kids', shops: ['smyths', 'hamleys'] }, T);
  assert.deepEqual(r, { name: 'Kids', shops: 2, lines: 2 });
  assert.deepEqual([cat(a).category, cat(b).category, cat(c).category, cat(d).category], ['Kids', 'Shopping', 'Kids', 'Groceries']);
  assert.deepEqual(db.crm().prepare("SELECT merchant_norm, category FROM money_rules ORDER BY 1").all(), [{ merchant_norm: 'hamleys', category: 'Kids' }, { merchant_norm: 'smyths', category: 'Kids' }]);
  assert.match(ledger.userPrompt({ source: 'screenshot' }, T), /- Smyths → Kids, spend/, 'the reader is given the rule for new lines');
  const s = cats.screen(T).own[0];
  assert.deepEqual([s.n, s.cents, s.rules], [2, 5000, 2]);
});

test('the budget plans it, judges a bill as a bill, and the challenge counts it', () => {
  cats.add({ name: 'Kids' }, T); cats.add({ name: 'Car loan', bill: '1' }, T + 1);
  for (const m of [8, 9, 10]) { tx(day(m, 1), 'Tesco', 200, 'Groceries'); tx(day(m, 28), 'Tesco', 1, 'Groceries'); tx(day(m, 6), 'Smyths', 40, 'Kids'); tx(day(m, 2), 'Credit Union', 250, 'Car loan'); }
  for (let d = 1; d <= 20; d++) tx(day(7, d), 'Corner Shop', 1, 'Other');
  tx(day(11, 2), 'Credit Union', 250, 'Car loan'); tx(day(11, 6), 'Smyths', 30, 'Kids'); tx(day(11, 9), 'Smyths', 30, 'Kids'); tx(day(11, 14), 'Tesco', 90, 'Groceries');
  const v = budget.view({ t: T });
  const line = c => v.rows.find(r => r.category === c);
  assert.deepEqual([line('Kids').planned_cents, line('Kids').state], [4000, 'over']);
  assert.deepEqual([line('Car loan').planned_cents, line('Car loan').state, line('Car loan').projected], [25000, 'bill', null], 'a bill of his is judged against the plan only');
  cats.add({ name: 'Pets' }, T + 2);
  const after = budget.view({ t: T });
  assert.ok(after.categories.includes('Pets'), 'a new category with no spending can be added as a line');
  budget.setLine('Pets', '25', T);
  assert.equal(budget.view({ t: T }).rows.find(r => r.category === 'Pets').planned_cents, 2500);

  const packet = insights.buildPacket({ t: T });
  assert.ok(packet.stats.some(s => s.kind === 'category' && s.name === 'Kids' && /^Kids\. By month: .*Aug 2026 €40\.00 \(1\)/.test(s.text)));
  assert.ok(packet.rates['category:kids']);
  const capped = insights.capCategory('Kids', '50', { t: T });
  assert.deepEqual([capped.name, capped.norm, capped.monthly_cap_cents, capped.baseline_cents], ['Kids', 'kids', 5000, Math.round(6000 * 30 / 28)]);
  assert.deepEqual([budget.view({ t: T }).rows.find(r => r.category === 'Kids').planned_cents, budget.view({ t: T }).rows.find(r => r.category === 'Kids').source], [5000, 'cap'], 'a cap on his own category is its plan');
  assert.throws(() => insights.capCategory('Kids', '40', { t: T }), /already have a cap on Kids/);
  assert.throws(() => insights.capCategory('Sweets', '40', { t: T }), /Choose a kind of spending/);
  assert.equal(insights.capCategory('Shopping', '40', { t: T }).name, 'Shopping', 'any category can be capped, not only the three standing checks');
});

test('removing it sends its lines to Other and clears its rules, this month\'s budget line and any cap on it', () => {
  cats.add({ name: 'Kids' }, T);
  for (const m of [8, 9, 10]) tx(day(m, 6), 'Smyths', 40, 'Kids');
  const now = tx(day(11, 6), 'Smyths', 30, 'Kids', 'you');
  cats.moveShops({ name: 'Kids', shops: ['smyths'] }, T);
  budget.view({ t: T });
  const c = insights.capCategory('Kids', '50', { t: T });
  db.crm().prepare("INSERT INTO money_budgets (month, category, planned_cents, base_cents, updated_at) VALUES ('2026-10', 'Kids', 4000, 4000, 1)").run();
  assert.throws(() => cats.remove({ name: 'Groceries' }, T), /built in and stays/);
  assert.deepEqual(cats.remove({ name: 'kids' }, T), { name: 'Kids', moved: 4 });
  assert.equal(categories().includes('Kids'), false);
  assert.deepEqual(cat(now), { category: 'Other', category_by: 'model' });
  assert.equal(db.crm().prepare('SELECT COUNT(*) AS n FROM money_rules').get().n, 0);
  assert.deepEqual(db.crm().prepare("SELECT month FROM money_budgets WHERE category = 'Kids'").all(), [{ month: '2026-10' }], 'past plans are kept as a record');
  assert.equal(db.crm().prepare('SELECT status FROM money_commitments WHERE id = ?').get(c.id).status, 'dropped');
  assert.throws(() => cats.remove({ name: 'Kids' }, T), /no longer there/);
});

test('the screens: Categories with add, move and remove; the new category in Transactions and the Budget', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = new Proxy({ adminUser: 'douglas' }, { set(t, k, v) { if (k === 'crmFlash' && v) flashes.push(v); t[k] = v; return true; } }); next(); });
  app.use(require('../routes/crm'));
  app.use(require('../routes/money'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body = '') => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const get = async p => (await fetch(`${base}${p}`)).text();
  const today = dublinDay();
  try {
    const empty = await get('/money/categories');
    assert.match(empty, /aria-current="page">Categories</); assert.match(empty, /None yet\. Add one above\./); assert.match(empty, />Groceries</);
    assert.equal((await fetch(`${base}/crm/work/money/categories`)).status, 404);
    tx(addDays(today, -2), '<b>Smyths</b>', 30, 'Shopping'); tx(addDays(today, -1), 'Tesco', 50, 'Groceries');

    const added = await post('/money/categories/add', 'name=Kids&about=%3Ci%3Eschool%3C%2Fi%3E+things');
    assert.equal(added.headers.get('location'), '/money/categories#cat-kids');
    assert.match(flashes.pop().text, /^Kids added\. It is in every category list now/);
    assert.equal((await post('/money/categories/add', 'name=kids')).status, 302);
    assert.match(flashes.pop().text, /already a category called Kids/);
    const page = await get('/money/categories');
    assert.match(page, /id="cat-kids"/); assert.match(page, /&lt;i&gt;school&lt;\/i&gt; things/); assert.match(page, /&lt;b&gt;Smyths&lt;\/b&gt;/);
    assert.match(page, /Move shops into Kids/);

    assert.equal((await post('/money/categories/shops', `name=Kids&shop=${encodeURIComponent(normMerchant('<b>Smyths</b>'))}`)).status, 302);
    assert.match(flashes.pop().text, /^1 shop moved into Kids: 1 line changed, and new ones follow\.$/);
    const txPage = await get('/money/transactions?month=all&category=Kids');
    assert.match(txPage, /<option selected>Kids<\/option>/); assert.match(txPage, /1 row/);
    const budgetPage = await get('/money/budget');
    assert.match(budgetPage, /Kids/);
    assert.match(budgetPage, /Add one on Categories/);

    assert.equal((await post('/money/categories/save', 'name=Kids&about=for+Nakai&bill=1')).status, 302);
    assert.match(flashes.pop().text, /^Kids saved\.$/);
    assert.match(await get('/money/categories'), /<span class="pill neutral">Bill<\/span>/);
    assert.equal((await post('/money/categories/remove', 'name=Kids')).status, 302);
    assert.match(flashes.pop().text, /^Kids removed\. Its 1 line went to Other\.$/);
    assert.doesNotMatch(await get('/money/transactions'), /<option[^>]*>Kids<\/option>/);
  } finally { server.close(); }
});
