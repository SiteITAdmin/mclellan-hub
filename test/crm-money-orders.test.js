'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-orders-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const orders = require('../lib/crm/money/orders');
const { dublinDay, addDays } = require('../lib/crm/money/common');
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

// 09:00 Dublin on a fixed winter day, so the scan hour is always reached.
const at = (day, hh = 9) => Math.floor(Date.parse(`${day}T${String(hh).padStart(2, '0')}:00:00Z`) / 1000);
const DAY = '2026-11-18', T = at(DAY);

const AMAZON = `Your Orders
https://www.amazon.co.uk/gp/css/order-history?ref_=fed_yo_default
Thanks for your order!
Order #
203-1112223-4445556
View or edit order
* Garden Solar Lights 10 Pack, Warm White, Waterproof
 Quantity: 2
 14.00 GBP
* Plant Pot Saucers
 Quantity: 1
 6.00 GBP
Total
27.50 EUR
Exchange rate: 1 GBP = 1.2 EUR`;

function body(text) { return { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } }; }
function message(id, from, subject, text, epoch, labelIds = ['INBOX']) {
  return { id, threadId: `t${id}`, labelIds, internalDate: String(epoch * 1000),
    payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'To', value: 'douglas@mclellan.scot' }, { name: 'Subject', value: subject }], parts: [body(text)] } };
}
function fakeGmail(msgs) {
  const g = { queries: [], gets: [] };
  g.users = { messages: {
    list: async ({ q }) => { g.queries.push(q); return { data: { messages: msgs.map(m => ({ id: m.id })) } }; },
    get: async ({ id }) => { g.gets.push(id); const m = msgs.find(x => x.id === id); if (!m) throw new Error('gone'); return { data: m }; },
  } };
  return g;
}
function fakeJobs() {
  const jobs = { queued: [], state: {} };
  jobs.enqueue = ({ feature, dedupeKey, payload }) => { const id = `job${jobs.queued.length + 1}`; jobs.queued.push({ id, feature, dedupeKey, payload }); jobs.state[id] = { id, status: 'pending' }; return { jobId: id }; };
  jobs.getJob = id => jobs.state[id] || null;
  jobs.finish = output => { const j = jobs.queued.at(-1); jobs.state[j.id] = { id: j.id, status: 'completed', result: { output } }; };
  return jobs;
}
const amazon = (extra = {}) => ({ source_ref: 'M1', kind: 'order', merchant: 'Amazon.co.uk', order_ref: '203-1112223-4445556', ordered_on: DAY, total: 27.5, currency: 'EUR',
  items: [{ name: 'Garden Solar Lights 10 Pack, Warm White, Waterproof', quantity: 2 }, { name: 'Plant Pot Saucers', quantity: 1 }], payment: null, quote: 'Total 27.50 EUR', ...extra });

async function readOne(msgs, findings, t = T) {
  const jobs = fakeJobs(), gmail = fakeGmail(msgs);
  const first = await orders.tick({ jobs, gmail, t });
  jobs.finish(JSON.stringify({ findings }));
  const second = await orders.tick({ jobs, gmail, t: t + 60 });
  return { jobs, gmail, first, second };
}

test('a daily search finds an Amazon order, reads it through the queue and keeps what the mail says', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: ‘Garden Solar Lights…’ and 1 more item', AMAZON, T - 600)];
  const { jobs, gmail, first, second } = await readOne(msgs, [amazon()]);
  assert.equal(first.scan.fetched, 1);
  assert.match(gmail.queries[0], /category:purchases/);
  assert.match(gmail.queries[0], /-in:sent/);
  assert.equal(jobs.queued.length, 1);
  assert.equal(jobs.queued[0].feature, 'crm_money_mail');
  assert.ok(jobs.queued[0].payload.userPrompt.includes('203-1112223-4445556'));
  assert.equal(second.read.kept, 1);
  const o = db.crm().prepare('SELECT * FROM money_orders').get();
  assert.equal(o.merchant, 'Amazon.co.uk');
  assert.equal(o.order_ref, '203-1112223-4445556');
  assert.equal(o.total_cents, 2750);
  assert.equal(o.currency, 'EUR');
  assert.equal(o.ordered_on, DAY);
  assert.deepEqual(JSON.parse(o.items).map(i => i.quantity), [2, 1]);
  assert.equal(o.gmail_id, 'g1');
  assert.equal(orders.list()[0].shown, '€27.50');
  assert.match(orders.summary().lines[0], /1 order or receipt found/);
});

test('mail text is dropped once read and scrubbed from the queue', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: lights', AMAZON, T - 600)];
  await readOne(msgs, [amazon()]);
  assert.equal(db.crm().prepare('SELECT text FROM money_order_mails').get().text, null);
  assert.equal(db.crm().prepare("SELECT status FROM money_order_mails").get().status, 'read');
  const hub = require('../lib/db').hub();
  hub.prepare("INSERT INTO subscription_agent_jobs (id, feature, dedupe_key, status, payload) VALUES ('x','crm_money_mail','d','completed', ?)")
    .run(JSON.stringify({ userPrompt: 'Order 203-1112223-4445556', meta: { moneyOrders: 'b' } }));
  assert.equal(orders.scrubJobs(), 1);
  assert.equal(JSON.parse(hub.prepare("SELECT payload FROM subscription_agent_jobs WHERE id = 'x'").get().payload).userPrompt, '(removed after reading)');
});

test('a total, quote or currency that is not in the mail is dropped; a made-up item is left out', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: lights', AMAZON, T - 600)];
  const bad = [amazon({ total: 31.99 }), amazon({ quote: 'Total 31.99 EUR' }), amazon({ currency: 'USD' }), amazon({ kind: 'not_relevant' }), amazon({ merchant: '' })];
  const r = await readOne(msgs, bad);
  assert.equal(r.second.read.kept, 0);
  assert.equal(db.crm().prepare('SELECT count(*) n FROM money_orders').get().n, 0);
  db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true });
  await readOne(msgs, [amazon({ items: [{ name: 'Plant Pot Saucers', quantity: 1 }, { name: 'A Diamond Necklace', quantity: 1 }], order_ref: '999-0000000-0000000', payment: 'Visa ending 9999' })]);
  const o = db.crm().prepare('SELECT * FROM money_orders').get();
  assert.deepEqual(JSON.parse(o.items).map(i => i.name), ['Plant Pot Saucers']);
  assert.equal(o.order_ref, '', 'an order number that is not in the mail is not kept');
  assert.equal(o.payment, '', 'a payment line that is not in the mail is not kept');
});

test('the same order in a second mail is not added twice; a receipt firms it up; a cancellation marks it', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: lights', AMAZON, T - 600)];
  await readOne(msgs, [amazon()]);
  const d1 = at(DAY, 12);
  const dispatch = AMAZON.replace('Thanks for your order!', 'Your package has been dispatched') + '\nPaid by Visa ending in 4242';
  const g2 = [message('g2', 'Amazon.co.uk <shipment-tracking@amazon.co.uk>', 'Dispatched: lights', dispatch, d1)];
  const jobs = fakeJobs();
  db.crm().prepare("DELETE FROM settings WHERE key IN ('money_orders_day','money_orders_try')").run();
  await orders.tick({ jobs, gmail: fakeGmail(g2), t: d1 });
  jobs.finish(JSON.stringify({ findings: [amazon({ kind: 'receipt', payment: 'Visa ending in 4242' })] }));
  await orders.tick({ jobs, gmail: fakeGmail(g2), t: d1 + 60 });
  const rows = db.crm().prepare('SELECT * FROM money_orders').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'receipt');
  assert.equal(rows[0].payment, 'Visa ending in 4242');

  const cancelled = AMAZON.replace('Thanks for your order!', 'Your order has been cancelled');
  const g3 = [message('g3', 'Amazon.co.uk <order-update@amazon.co.uk>', 'Cancelled', cancelled, d1 + 100)];
  db.crm().prepare("DELETE FROM settings WHERE key IN ('money_orders_day','money_orders_try')").run();
  await orders.tick({ jobs, gmail: fakeGmail(g3), t: d1 + 200 });
  jobs.finish(JSON.stringify({ findings: [{ source_ref: 'M1', kind: 'cancelled', merchant: 'Amazon.co.uk', order_ref: '203-1112223-4445556', quote: 'Your order has been cancelled' }] }));
  await orders.tick({ jobs, gmail: fakeGmail(g3), t: d1 + 260 });
  assert.equal(db.crm().prepare('SELECT status FROM money_orders').get().status, 'cancelled');
  assert.equal(orders.list()[0].status, 'cancelled');
});

test('it searches once a day, not before 06:00 Dublin, and never fetches a mail twice', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: lights', AMAZON, T - 600)];
  const gmail = fakeGmail(msgs), jobs = fakeJobs();
  const early = await orders.tick({ jobs, gmail, t: at(DAY, 4) });
  assert.equal(early.scan, undefined);
  assert.equal(gmail.queries.length, 0);
  await orders.tick({ jobs, gmail, t: T });
  await orders.tick({ jobs, gmail, t: T + 3600 });
  assert.equal(gmail.queries.length, 1, 'one search a day');
  assert.equal(orders.screen({ t: T + 3600 }).pending, false);
  await orders.tick({ jobs, gmail, t: at(addDays(DAY, 1), 7) });
  assert.equal(gmail.queries.length, 2);
  assert.equal(gmail.gets.filter(id => id === 'g1').length, 1, 'a mail already held is not fetched again');
  const q2 = gmail.queries[1], after = Number(/after:(\d+)/.exec(q2)[1]);
  assert.ok(after > T - 4 * 86400 && after < at(addDays(DAY, 1), 7), 'the next search starts from the last one, not from 90 days back');
});

test('a failed search is recorded, retried after half an hour, and does not stop the reading', async () => {
  const jobs = fakeJobs();
  const broken = { users: { messages: { list: async () => { throw new Error('invalid_grant'); }, get: async () => ({}) } } };
  await assert.rejects(orders.tick({ jobs, gmail: broken, t: T }), /invalid_grant/);
  const good = fakeGmail([]);
  await orders.tick({ jobs, gmail: good, t: T + 600 });
  assert.equal(good.queries.length, 0, 'not again within 30 minutes');
  await orders.tick({ jobs, gmail: good, t: T + 1900 });
  assert.equal(good.queries.length, 1);
});

test('sent mail is not kept; old unread mail is dropped rather than caught up on; failures show with a retry', async () => {
  const msgs = [message('g1', 'Douglas <douglas@mclellan.scot>', 'Receipt', 'Total 5.00 EUR', T - 60, ['SENT'])];
  const jobs = fakeJobs();
  await orders.tick({ jobs, gmail: fakeGmail(msgs), t: T });
  assert.equal(db.crm().prepare('SELECT count(*) n FROM money_order_mails').get().n, 0);

  db.crm().prepare("INSERT INTO money_order_mails (id, gmail_id, subject, occurred_at, text, status, fetched_at) VALUES ('old','gold','Old receipt',1,'Total 9.99 EUR','waiting',?)").run(T - 20 * 86400);
  const r = orders.purge(T);
  assert.equal(r.stale, 1);
  assert.equal(db.crm().prepare("SELECT text FROM money_order_mails WHERE id = 'old'").get().text, null);

  const jobs2 = fakeJobs();
  const m2 = [message('g2', 'Shop <shop@example.com>', 'Your receipt', 'Thank you. Total paid 12.34 EUR', T - 100)];
  await orders.tick({ jobs: jobs2, gmail: fakeGmail(m2), t: at(addDays(DAY, 1), 8) });
  jobs2.state[jobs2.queued[0].id] = { id: jobs2.queued[0].id, status: 'completed', result: { output: 'not json' } };
  await orders.tick({ jobs: jobs2, gmail: fakeGmail([]), t: at(addDays(DAY, 1), 8) + 60 });
  assert.match(orders.problems()[0].text, /could not be read/);
  assert.equal(orders.retryFailed({ jobs: jobs2 }), 1);
});

test('the Orders screen renders, and "not an order" sets one aside for good', async () => {
  const msgs = [message('g1', 'Amazon.co.uk <auto-confirm@amazon.co.uk>', 'Ordered: lights', AMAZON, T - 600)];
  await readOne(msgs, [amazon()]);
  const ejs = require('ejs');
  const views = path.join(__dirname, '..', 'views', 'crm');
  const html = await ejs.renderFile(path.join(views, 'money', 'orders.ejs'), { page: 'money', title: 'Orders', tab: 'orders', space: 'personal', flash: null, reviewAll: 0, whatsappWaiting: 0, krispWaiting: 0,
    icon: require('../lib/crm/icons'), eur: require('../lib/crm/money/common').eur, base: '/crm/personal/money', v: orders.screen({ t: T + 120 }) });
  assert.ok(html.includes('Amazon.co.uk') && html.includes('€27.50') && html.includes('203-1112223-4445556') && html.includes('Not an order'));
  assert.ok(html.includes('Orders</a>') || html.includes('>Orders<'), 'the tab is in the Money menu');
  const id = db.crm().prepare('SELECT id FROM money_orders').get().id;
  orders.dismiss(id);
  assert.equal(orders.list().length, 0);
  assert.equal(orders.screen().dismissed, 1);
  assert.throws(() => orders.dismiss('nope'), /no longer there/);
});
