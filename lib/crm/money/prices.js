'use strict';

// Prices: what Douglas pays for the same thing, over time and between the shops
// he uses. Everything is worked out afresh from the item lines of his own
// receipts (money_receipts.items); nothing is looked up anywhere else. When a
// receipt from one shop shows something cheaper than the shop he usually buys
// it in, he is asked why, and his answer is kept so he is not asked again.

const { crm, now } = require('../db');
const { eur, dublinDay, addDays } = require('./common');

const BASE = '/money/prices';
const TRACK_DAYS = 400, COMPARE_DAYS = 120, SPEND_DAYS = 90;
// Under this, a difference is the rounding of a weight or a penny on a pack, not a cheaper shop.
const MIN_GAP = 0.05, MIN_CHANGE = 0.02;
// Further apart than this, the two lines are not the same thing (a single against a multipack with no size printed).
const MAX_RATIO = 2.5;
const PAIR_MIN_COMMON = 3;

const SCHEMA = `
  -- His answer to "why there, when it was cheaper in the other shop?". One per product and pair of shops;
  -- while it stands the question is not asked again.
  CREATE TABLE IF NOT EXISTS money_price_answers (
    product_key TEXT NOT NULL,
    usual_norm TEXT NOT NULL,
    cheaper_norm TEXT NOT NULL,
    product TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (product_key, usual_norm, cheaper_norm)
  );
`;

// ---- Items, from the receipts ----

const UNITS = Object.freeze({ g: ['kg', 0.001], kg: ['kg', 1], ml: ['l', 0.001], l: ['l', 1], each: ['each', 1] });
const PER = Object.freeze({ kg: 'a kg', l: 'a litre', each: 'each' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dayLabel = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const top = counts => [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] || '';

// "Bananas" and "banana" are one product.
function productNorm(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)).join(' ');
}

// What a line bought, in the unit it can be compared in: kilos, litres or a count.
function measure(size, unit, quantity) {
  const qty = quantity > 0 ? quantity : 1, u = UNITS[unit];
  if (!u || !(size > 0)) return { family: 'each', amount: qty };
  return { family: u[0], amount: qty * size * u[1] };
}
const sizeLabel = (size, unit) => (size > 0 && UNITS[unit] && !(unit === 'each' && size === 1) ? `${Number(size.toFixed(3))}${unit === 'each' ? ' pack' : ` ${unit}`}` : '');
const rateLabel = (rate, family) => `${eur(Math.round(rate))} ${PER[family]}`;

// Every priced, named item line on a receipt that was paid in euro. A refund receipt, a discount line and
// a line the reader could not name are left out.
function items(t = now()) {
  const since = addDays(dublinDay(t), -TRACK_DAYS), out = [];
  const rows = crm().prepare(`SELECT id, shop, shop_norm, bought_on, items FROM money_receipts
    WHERE currency = 'EUR' AND amount_cents < 0 AND status != 'dismissed' AND shop_norm != '' AND bought_on >= ? ORDER BY bought_on, rowid`).all(since);
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.items); } catch (_) { /* a receipt with no items has nothing to track */ }
    for (const i of Array.isArray(list) ? list : []) {
      const norm = productNorm(i.product);
      if (!norm || !(i.cents > 0)) continue;
      const m = measure(i.size, i.unit, i.quantity);
      out.push({ receipt_id: r.id, shop: r.shop, shop_norm: r.shop_norm, day: r.bought_on, product: clean(i.product, 60), norm, key: `${norm}|${m.family}`, family: m.family,
        brand: clean(i.brand, 40), size: i.size > 0 ? i.size : null, unit: UNITS[i.unit] ? i.unit : '', quantity: i.quantity > 0 ? i.quantity : 1,
        cents: i.cents, amount: m.amount, rate: i.cents / m.amount, category: i.category || 'Other', description: i.description });
    }
  }
  return out;
}

function products(t = now(), list = items(t)) {
  const by = new Map();
  for (const i of list) { if (!by.has(i.key)) by.set(i.key, []); by.get(i.key).push(i); }
  const out = [];
  for (const [key, buys] of by) {
    const names = new Map(), cats = new Map(), shops = new Map();
    for (const b of buys) {
      names.set(b.product, (names.get(b.product) || 0) + 1); cats.set(b.category, (cats.get(b.category) || 0) + 1);
      if (!shops.has(b.shop_norm)) shops.set(b.shop_norm, { shop: b.shop, shop_norm: b.shop_norm, buys: [] });
      shops.get(b.shop_norm).buys.push(b);
    }
    out.push({ key, norm: buys[0].norm, family: buys[0].family, product: top(names), category: top(cats), buys, cents: buys.reduce((n, b) => n + b.cents, 0),
      shops: [...shops.values()].map(s => ({ ...s, n: s.buys.length, latest: s.buys.at(-1) })) });
  }
  return out.sort((a, b) => b.cents - a.cents || (a.key < b.key ? -1 : 1));
}

// What these purchases cost above a given rate: each one at the price actually paid for it.
const paidAbove = (buys, rate) => Math.round(buys.reduce((n, b) => n + Math.max(0, b.rate - rate) * b.amount, 0));
const comparable = (a, b) => Math.max(a, b) / Math.min(a, b) <= MAX_RATIO;
const brandNote = (a, b) => (a.brand && b.brand && a.brand.toLowerCase() !== b.brand.toLowerCase() ? `${a.brand} against ${b.brand}` : '');

// The same thing on receipts from two shops: where he usually buys it, and where his own receipt shows it
// cheaper. Each carries his answer when he has given one.
function cheaperElsewhere(t = now(), prods = products(t)) {
  const today = dublinDay(t), recent = addDays(today, -COMPARE_DAYS), spendFrom = addDays(today, -SPEND_DAYS), out = [];
  const answers = new Map(crm().prepare('SELECT * FROM money_price_answers').all().map(a => [`${a.product_key}|${a.usual_norm}|${a.cheaper_norm}`, a]));
  for (const p of prods) {
    const shops = p.shops.map(s => ({ ...s, recent: s.buys.filter(b => b.day >= recent) })).filter(s => s.recent.length);
    if (shops.length < 2) continue;
    const usual = [...shops].sort((a, b) => b.recent.length - a.recent.length || (a.latest.day < b.latest.day ? 1 : -1))[0];
    const cheapest = [...shops].sort((a, b) => a.latest.rate - b.latest.rate)[0];
    if (usual === cheapest || !comparable(usual.latest.rate, cheapest.latest.rate) || usual.latest.rate < cheapest.latest.rate * (1 + MIN_GAP)) continue;
    const bought = usual.buys.filter(b => b.day >= spendFrom);
    const answer = answers.get(`${p.key}|${usual.shop_norm}|${cheapest.shop_norm}`);
    out.push({ key: p.key, product: p.product, family: p.family,
      usual: { shop: usual.shop, shop_norm: usual.shop_norm, rate: usual.latest.rate, n: bought.length, day: usual.latest.day, brand: usual.latest.brand },
      cheapest: { shop: cheapest.shop, shop_norm: cheapest.shop_norm, rate: cheapest.latest.rate, day: cheapest.latest.day, brand: cheapest.latest.brand },
      pct: Math.round((usual.latest.rate / cheapest.latest.rate - 1) * 100), over_cents: paidAbove(bought, cheapest.latest.rate), brands: brandNote(usual.latest, cheapest.latest),
      answer: answer ? { reason: answer.reason, on: dublinDay(answer.created_at) } : null });
  }
  return out.sort((a, b) => b.over_cents - a.over_cents || b.pct - a.pct);
}

// "Why there?" answered in his own words. The question must still be a live one: it is checked against the receipts.
function answerWhy(body = {}, t = now()) {
  const key = String(body.key || ''), usual = String(body.usual || ''), cheaper = String(body.cheaper || '');
  const q = cheaperElsewhere(t).find(c => c.key === key && c.usual.shop_norm === usual && c.cheapest.shop_norm === cheaper);
  if (!q) throw new Error('That question is no longer open: the prices on your receipts have changed.');
  const reason = clean(body.reason, 300);
  if (!reason) throw new Error('Say why in a line, so you are not asked again.');
  crm().prepare(`INSERT INTO money_price_answers (product_key, usual_norm, cheaper_norm, product, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_key, usual_norm, cheaper_norm) DO UPDATE SET reason = excluded.reason, product = excluded.product, created_at = excluded.created_at`).run(key, usual, cheaper, q.product, reason, t);
  return q;
}

function askAgain(body = {}) {
  if (!crm().prepare('DELETE FROM money_price_answers WHERE product_key = ? AND usual_norm = ? AND cheaper_norm = ?').run(String(body.key || ''), String(body.usual || ''), String(body.cheaper || '')).changes) throw new Error('There was no answer to remove.');
}

// The same thing in the same shop, dearer or cheaper than the time before.
function changes(t = now(), prods = products(t)) {
  const recent = addDays(dublinDay(t), -COMPARE_DAYS), out = [];
  for (const p of prods) for (const s of p.shops) {
    const last = s.latest;
    if (last.day < recent) continue;
    const before = [...s.buys].reverse().find(b => b.day < last.day && (b.brand || '').toLowerCase() === (last.brand || '').toLowerCase());
    if (!before || !comparable(last.rate, before.rate) || Math.abs(last.rate - before.rate) < before.rate * MIN_CHANGE) continue;
    out.push({ key: p.key, product: p.product, family: p.family, shop: s.shop, from: before.rate, from_day: before.day, to: last.rate, to_day: last.day,
      pct: Math.round(Math.abs(last.rate / before.rate - 1) * 100), up: last.rate > before.rate });
  }
  return out.sort((a, b) => Number(b.up) - Number(a.up) || b.pct - a.pct);
}

// Two shops, over the things he has bought in both: the same basket priced at each.
function shopPairs(t = now(), prods = products(t)) {
  const recent = addDays(dublinDay(t), -COMPARE_DAYS), pairs = new Map();
  for (const p of prods) {
    const shops = p.shops.filter(s => s.latest.day >= recent);
    const typical = p.buys.map(b => b.amount).sort((a, b) => a - b)[Math.floor(p.buys.length / 2)];
    for (const a of shops) for (const b of shops) {
      if (a.shop_norm >= b.shop_norm || !comparable(a.latest.rate, b.latest.rate)) continue;
      const k = `${a.shop_norm}|${b.shop_norm}`;
      if (!pairs.has(k)) pairs.set(k, { a: a.shop, b: b.shop, common: 0, a_cents: 0, b_cents: 0, a_cheaper: 0, b_cheaper: 0 });
      const pair = pairs.get(k);
      pair.common += 1; pair.a_cents += a.latest.rate * typical; pair.b_cents += b.latest.rate * typical;
      if (a.latest.rate < b.latest.rate * (1 - MIN_CHANGE)) pair.a_cheaper += 1; else if (b.latest.rate < a.latest.rate * (1 - MIN_CHANGE)) pair.b_cheaper += 1;
    }
  }
  return [...pairs.values()].filter(p => p.common >= PAIR_MIN_COMMON).map(p => {
    const dearIsA = p.a_cents > p.b_cents;
    const dear = dearIsA ? { shop: p.a, cents: Math.round(p.a_cents) } : { shop: p.b, cents: Math.round(p.b_cents) };
    const cheap = dearIsA ? { shop: p.b, cents: Math.round(p.b_cents), wins: p.b_cheaper } : { shop: p.a, cents: Math.round(p.a_cents), wins: p.a_cheaper };
    return { common: p.common, dear, cheap, pct: cheap.cents ? Math.round((dear.cents / cheap.cents - 1) * 100) : 0 };
  }).filter(p => p.pct >= 3).sort((a, b) => (b.dear.cents - b.cheap.cents) - (a.dear.cents - a.cheap.cents));
}

// ---- What the screens and the challenge are given ----

// Names already in use, so the receipt reader writes the same thing the same way each time.
function knownProducts(limit = 150, t = now()) {
  const seen = new Map();
  for (const i of items(t).reverse()) if (!seen.has(i.norm)) seen.set(i.norm, i.product);
  return [...seen.values()].slice(0, limit);
}

function screen(t = now()) {
  const list = items(t), prods = products(t, list);
  const receipts = crm().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(items != '[]'), 0) AS itemised FROM money_receipts WHERE status != 'dismissed'").get();
  const all = cheaperElsewhere(t, prods), asked = all.filter(c => !c.answer);
  return {
    any: list.length > 0, receipts, lines: list.length, rateLabel, sizeLabel,
    asked, asked_cents: asked.reduce((n, c) => n + c.over_cents, 0), answered: all.filter(c => c.answer),
    pairs: shopPairs(t, prods), changes: changes(t, prods),
    repeats: prods.filter(p => p.buys.length >= 2).slice(0, 60).map(p => ({ ...p, history: [...p.buys].reverse().slice(0, 12) })),
    once: prods.filter(p => p.buys.length < 2).length,
  };
}

// Sentences for the weekly challenge: the exact figures, so its wording can be checked against them.
// A question he has answered is not put to him again.
function stats(t = now()) {
  const prods = products(t), out = [];
  for (const c of cheaperElsewhere(t, prods).filter(x => !x.answer).slice(0, 5)) {
    out.push({ kind: 'cheaper_elsewhere', amounts: [Math.round(c.usual.rate), Math.round(c.cheapest.rate), c.over_cents], pcts: [c.pct],
      text: `From his own receipts: ${c.product} is ${rateLabel(c.usual.rate, c.family)} at ${c.usual.shop}, where he bought it ${plural(c.usual.n, 'time')} in the last ${SPEND_DAYS} days, and was ${rateLabel(c.cheapest.rate, c.family)} at ${c.cheapest.shop} on ${dayLabel(c.cheapest.day)}: ${c.pct}% more at ${c.usual.shop}${c.brands ? ` (${c.brands})` : ''}. Bought at ${c.cheapest.shop} instead, those purchases would have cost ${eur(c.over_cents)} less.` });
  }
  for (const p of shopPairs(t, prods).slice(0, 3)) {
    out.push({ kind: 'shop_basket', amounts: [p.dear.cents, p.cheap.cents, p.dear.cents - p.cheap.cents], pcts: [p.pct],
      text: `From his own receipts: of ${plural(p.common, 'thing')} he has bought in both ${p.dear.shop} and ${p.cheap.shop}, ${p.cheap.wins} ${p.cheap.wins === 1 ? 'was' : 'were'} cheaper at ${p.cheap.shop}. One of each costs ${eur(p.dear.cents)} at ${p.dear.shop} and ${eur(p.cheap.cents)} at ${p.cheap.shop}: ${p.pct}% more, ${eur(p.dear.cents - p.cheap.cents)}.` });
  }
  for (const c of changes(t, prods).filter(x => x.up).slice(0, 4)) {
    out.push({ kind: 'price_rise', amounts: [Math.round(c.from), Math.round(c.to)], pcts: [c.pct],
      text: `From his own receipts: ${c.product} at ${c.shop} went from ${rateLabel(c.from, c.family)} on ${dayLabel(c.from_day)} to ${rateLabel(c.to, c.family)} on ${dayLabel(c.to_day)}, up ${c.pct}%.` });
  }
  return out;
}

function summary(t = now()) {
  const s = screen(t);
  if (!s.any) return null;
  const lines = [];
  if (s.asked.length) lines.push(`${plural(s.asked.length, 'thing')} cheaper in another shop you use: ${eur(s.asked_cents)} over 90 days. Why there?`);
  const up = s.changes.filter(c => c.up).length;
  if (up) lines.push(`${plural(up, 'price')} gone up since you last bought`);
  if (!lines.length) lines.push(`${plural(s.repeats.length, 'product')} tracked from ${plural(s.receipts.itemised, 'receipt')}. Nothing is cheaper in another of your shops.`);
  return { title: 'Prices', lines, href: BASE };
}

function mount(router, h) {
  const root = h.base || '/money', path = `${root}/prices`;
  router.get(path, (req, res) => {
    res.render('crm/money/prices', { page: 'money', title: 'Prices', tab: 'prices', eur, dayLabel, base: root, v: screen() });
  });
  const post = (sub, fn) => router.post(`${path}/${sub}`, h.requireSameOrigin, h.writeLimiter, (req, res) => {
    try { h.flash(req, fn(req)); } catch (err) { h.flash(req, err.message, 'bad'); }
    res.redirect(path);
  });
  post('why', req => { const q = answerWhy(req.body); return `Noted for ${q.product}. You will not be asked again unless you choose to be.`; });
  post('ask-again', req => { askAgain(req.body); return 'Answer removed. The question is open again.'; });
}

module.exports = { SCHEMA, mount, summary, items, products, cheaperElsewhere, answerWhy, askAgain, changes, shopPairs, knownProducts, screen, stats, productNorm, measure, rateLabel, sizeLabel, PER };
