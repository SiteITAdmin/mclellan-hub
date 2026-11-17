'use strict';

// Categories of his own, added to the fixed list in common.js. A category he
// adds is offered to the readers of bank lines and receipts (with his own words
// for what goes in it), to every category picker, to the budget and to the
// challenge. Shops can be moved into it in one go: that writes his usual rules,
// so their past lines move too and new ones follow.

const { crm, now } = require('../db');
const { CATEGORIES, categories, normMerchant, eur, dublinDay, addDays, SPEND_SQL } = require('./common');

const BASE = '/crm/personal/money/categories';
const MAX_OWN = 30, SHOP_DAYS = 180, SHOP_LIST = 40, STAT_DAYS = 90;

const SCHEMA = `
  -- A category Douglas added. about is his own line on what goes in it, given to the readers. bill = 1 for
  -- something paid in one go (a fee, a standing order): the budget judges it against the plan, not the calendar.
  CREATE TABLE IF NOT EXISTS money_categories (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    about TEXT NOT NULL DEFAULT '',
    bill INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`;

const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const own = () => crm().prepare('SELECT * FROM money_categories ORDER BY created_at, name').all();

function add({ name, about = '', bill = '' } = {}, t = now()) {
  const n = clean(name, 40);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &'’\-/]{0,29}$/u.test(n)) throw new Error('Give it a name of up to 30 letters, like "Kids" or "Car loan".');
  const taken = categories().find(c => c.toLowerCase() === n.toLowerCase());
  if (taken) throw new Error(`There is already a category called ${taken}.`);
  if (own().length >= MAX_OWN) throw new Error(`You have ${MAX_OWN} categories of your own already. Remove one first.`);
  crm().prepare('INSERT INTO money_categories (name, about, bill, created_at) VALUES (?, ?, ?, ?)').run(n, clean(about, 200), bill ? 1 : 0, t);
  return n;
}

function find(name) {
  const row = crm().prepare('SELECT * FROM money_categories WHERE name = ?').get(clean(name, 40));
  if (!row) throw new Error(CATEGORIES.some(c => c.toLowerCase() === clean(name, 40).toLowerCase()) ? 'That one is built in and stays.' : 'That category is no longer there.');
  return row;
}

function save({ name, about = '', bill = '' } = {}) {
  const row = find(name);
  crm().prepare('UPDATE money_categories SET about = ?, bill = ? WHERE name = ?').run(clean(about, 200), bill ? 1 : 0, row.name);
  return row.name;
}

// Its lines go to Other, its rules and this month's budget line go, and a cap on it is dropped.
// Past months' plans keep the name: they are a record of what was planned then.
function remove({ name } = {}, t = now()) {
  const row = find(name), db = crm(), month = dublinDay(t).slice(0, 7);
  let moved = 0;
  db.transaction(() => {
    moved = db.prepare("UPDATE money_transactions SET category = 'Other', category_by = 'model' WHERE category = ?").run(row.name).changes;
    db.prepare('DELETE FROM money_rules WHERE category = ?').run(row.name);
    db.prepare('DELETE FROM money_budgets WHERE category = ? AND month >= ?').run(row.name, month);
    db.prepare(`UPDATE money_commitments SET status = 'dropped', note = ?, closed_at = ? WHERE status = 'active' AND scope = 'category' AND norm = ?`)
      .run(`The category ${row.name} was removed.`, t, row.name.toLowerCase());
    db.prepare('DELETE FROM money_categories WHERE name = ?').run(row.name);
  })();
  return { name: row.name, moved };
}

// Shops he spends with, most first, and the category each is in now.
function shops(t = now()) {
  return crm().prepare(`SELECT merchant_norm AS norm, MAX(merchant) AS merchant, COUNT(*) AS n, SUM(-amount_cents) AS cents,
      (SELECT category FROM money_transactions y WHERE y.merchant_norm = x.merchant_norm AND ${SPEND_SQL} GROUP BY category ORDER BY COUNT(*) DESC LIMIT 1) AS category
    FROM money_transactions x WHERE ${SPEND_SQL} AND merchant_norm != '' AND posted_on >= ? GROUP BY merchant_norm ORDER BY cents DESC LIMIT ?`).all(addDays(dublinDay(t), -SHOP_DAYS), SHOP_LIST);
}

// The same as "always do this for <shop>" on a transaction, for several shops at once.
function moveShops({ name, shops: picked } = {}, t = now()) {
  const target = categories().find(c => c.toLowerCase() === clean(name, 40).toLowerCase());
  if (!target) throw new Error('That category is no longer there.');
  const norms = [...new Set((Array.isArray(picked) ? picked : picked ? [picked] : []).map(s => normMerchant(s)).filter(Boolean))];
  if (!norms.length) throw new Error('Tick at least one shop to move.');
  const { setRule } = require('./ledger');
  let lines = 0;
  crm().transaction(() => { for (const n of norms) lines += setRule(n, target, 'spend', '', t); })();
  return { name: target, shops: norms.length, lines };
}

function screen(t = now()) {
  const since = addDays(dublinDay(t), -STAT_DAYS), mine = own();
  const used = new Map(crm().prepare(`SELECT category, COUNT(*) AS n, SUM(-amount_cents) AS cents FROM money_transactions WHERE ${SPEND_SQL} AND posted_on >= ? GROUP BY 1`).all(since).map(r => [r.category, r]));
  const rules = new Map(crm().prepare('SELECT category, COUNT(*) AS n FROM money_rules GROUP BY 1').all().map(r => [r.category, r.n]));
  const stat = name => ({ n: used.get(name)?.n || 0, cents: used.get(name)?.cents || 0, rules: rules.get(name) || 0 });
  return { builtIn: CATEGORIES.map(name => ({ name, ...stat(name) })), own: mine.map(c => ({ ...c, ...stat(c.name) })), shops: shops(t), days: STAT_DAYS, max: MAX_OWN, all: categories() };
}

// For the readers: what each of his categories is for, in his words.
function forReaders() {
  const mine = own();
  if (!mine.length) return '';
  return `Douglas has added categories of his own. They are as valid as those in the list; use one when a row fits it better:\n${mine.map(c => `- "${c.name}"${c.about ? `: ${c.about}` : ''}`).join('\n')}`;
}

function mount(router, h) {
  router.get('/crm/:space/money/categories', (req, res) => {
    res.render('crm/money/categories', { page: 'money', title: 'Categories', tab: 'categories', eur, base: h.base, v: screen() });
  });
  const post = (sub, fn) => router.post(`/crm/:space/money/categories/${sub}`, h.requireSameOrigin, h.writeLimiter, (req, res) => {
    let anchor = '';
    try { const r = fn(req); h.flash(req, r.text); anchor = r.anchor || ''; } catch (err) { h.flash(req, err.message, 'bad'); }
    res.redirect(`${BASE}${anchor}`);
  });
  const slug = n => `#cat-${String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  post('add', req => { const n = add(req.body); return { text: `${n} added. It is in every category list now, and the readers will use it. Move shops into it below.`, anchor: slug(n) }; });
  post('save', req => { const n = save(req.body); return { text: `${n} saved.`, anchor: slug(n) }; });
  post('remove', req => { const r = remove(req.body); return { text: `${r.name} removed.${r.moved ? ` Its ${plural(r.moved, 'line')} went to Other.` : ''}` }; });
  post('shops', req => { const r = moveShops({ name: req.body.name, shops: req.body.shop }); return { text: `${plural(r.shops, 'shop')} moved into ${r.name}: ${plural(r.lines, 'line')} changed, and new ones follow.`, anchor: slug(r.name) }; });
}

module.exports = { SCHEMA, mount, add, save, remove, moveShops, shops, screen, forReaders, own };
