'use strict';

// Budget: a plan for each calendar month, one line per kind of spending, and
// where the bank lines stand against it. The Hub proposes each line from his
// own recent months; a figure he types stands until he changes it. The plan
// follows what he has agreed elsewhere in Money: a cap taken on in a challenge
// is the plan for that line, a cap he kept carries into the next month, a
// cancelled subscription comes off. Each line shows the challenges, answers
// and agreements that touch it. No model is involved.

const { crm, now, setting, setSetting } = require('../db');
const { categories, billCategories, eur, dublinDay, addDays, SPEND_SQL } = require('./common');

const BASE = '/money/budget';
const HISTORY_MONTHS = 3;
// A plan is a round figure he can remember, never below what the months behind it averaged.
const ROUND_CENTS = 500;
// A pace says nothing before this many days of the month are held, or from a single purchase (one flight is
// not a habit). Weekly shops land in lumps, so "running ahead" means well past the plan, not a few euro.
const PACE_MIN_DAYS = 5, PACE_MIN_PURCHASES = 2, PACE_MARGIN = 1.15;

const SCHEMA = `
  -- One line of one month's plan. base_* is the line before his agreements (the Hub's figure, his own,
  -- or a cap he kept last month); planned_cents is what he is held to once caps and cancellations are
  -- applied. A month that has ended is never rewritten.
  CREATE TABLE IF NOT EXISTS money_budgets (
    month TEXT NOT NULL,
    category TEXT NOT NULL,
    planned_cents INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'history' CHECK (source IN ('history','you','kept','cap')),
    basis TEXT NOT NULL DEFAULT '',
    base_cents INTEGER NOT NULL,
    base_source TEXT NOT NULL DEFAULT 'history' CHECK (base_source IN ('history','you','kept')),
    base_basis TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (month, category)
  );
`;

// ---- Dates and small helpers ----

const monthOf = day => day.slice(0, 7);
const addMonths = (m, n) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);
const daysIn = m => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const monthEnd = m => `${m}-${String(daysIn(m)).padStart(2, '0')}`;
const monthName = (m, o = { month: 'long' }) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString('en-IE', { ...o, timeZone: 'UTC' });
const dayLabel = d => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IE', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const hasTable = name => !!crm().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

function toCents(v) {
  const s = String(v ?? '').replace(/[€\s]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  return /^\d+(\.\d{1,2})?$/.test(s) && Number(s) < 1e7 ? Math.round(Number(s) * 100) : NaN;
}

// ---- What the ledger holds ----

function spendByMonth(from, to) {
  const out = new Map();
  for (const r of crm().prepare(`SELECT substr(posted_on, 1, 7) AS month, category, SUM(-amount_cents) AS cents, COUNT(*) AS n FROM money_transactions
    WHERE ${SPEND_SQL} AND posted_on >= ? AND posted_on <= ? GROUP BY 1, 2`).all(`${from}-01`, monthEnd(to))) out.set(`${r.month}|${r.category}`, r);
  return out;
}

function span(today) {
  return crm().prepare(`SELECT MIN(posted_on) AS oldest, MAX(posted_on) AS newest FROM money_transactions WHERE ${SPEND_SQL} AND posted_on <= ?`).get(today);
}

// The months a figure may be averaged from: whole months, held from their first days to their last.
function historyMonths(month, s) {
  const out = [];
  if (!s.oldest) return out;
  for (let i = 1; i <= 6 && out.length < HISTORY_MONTHS; i++) {
    const m = addMonths(month, -i);
    if (s.oldest <= `${m}-05` && s.newest >= addDays(monthEnd(m), -3)) out.push(m);
  }
  return out;
}

// The Hub's own figure for a line: what he has actually spent on it lately, rounded up.
function suggestions(month, t = now()) {
  const today = dublinDay(t), s = span(today), months = historyMonths(month, s), out = new Map();
  if (months.length) {
    const spend = spendByMonth(months.at(-1), months[0]);
    const basis = months.length === 1 ? `what you spent in ${monthName(months[0])}` : `your average for ${monthName(months.at(-1))} to ${monthName(months[0])}`;
    for (const c of categories()) {
      const avg = months.reduce((n, m) => n + (spend.get(`${m}|${c}`)?.cents || 0), 0) / months.length;
      if (avg > 0) out.set(c, { cents: Math.ceil(avg / ROUND_CENTS) * ROUND_CENTS, basis });
    }
    return { months, lines: out };
  }
  if (!s.newest) return { months, lines: out };
  for (const r of crm().prepare(`SELECT category, SUM(-amount_cents) AS cents FROM money_transactions WHERE ${SPEND_SQL} AND posted_on > ? AND posted_on <= ? GROUP BY 1`).all(addDays(s.newest, -28), s.newest)) {
    out.set(r.category, { cents: Math.ceil(r.cents * 30 / 28 / ROUND_CENTS) * ROUND_CENTS, basis: 'your last 28 days of bank lines, as no whole month is held yet' });
  }
  return { months, lines: out };
}

// ---- The plan ----

const lines = month => crm().prepare('SELECT * FROM money_budgets WHERE month = ?').all(month);
const capsFor = month => (hasTable('money_commitments') ? crm().prepare(`SELECT * FROM money_commitments WHERE month = ? AND scope = 'category' AND monthly_cap_cents IS NOT NULL
  AND status IN ('active','kept','broken') ORDER BY created_at`).all(month) : []);

// A subscription he has cancelled still sits in the months a figure was averaged from, so it comes off.
function cancelled(months) {
  if (!months.length || !hasTable('money_subscriptions')) return [];
  const since = Math.floor(Date.parse(`${months.at(-1)}-01T00:00:00Z`) / 1000), out = [];
  for (const sub of crm().prepare("SELECT merchant, merchant_norm, decided_at FROM money_subscriptions WHERE status = 'cancelled' AND decided_at >= ?").all(since)) {
    const rows = crm().prepare(`SELECT category, SUM(-amount_cents) AS cents FROM money_transactions WHERE ${SPEND_SQL} AND merchant_norm = ? AND posted_on >= ? AND posted_on <= ? GROUP BY 1 ORDER BY 2 DESC`)
      .all(sub.merchant_norm, `${months.at(-1)}-01`, monthEnd(months[0]));
    if (rows.length) out.push({ merchant: sub.merchant, category: rows[0].category, cents: Math.round(rows[0].cents / months.length), on: dublinDay(sub.decided_at) });
  }
  return out;
}

// Works out what each line holds him to this month, from its base and what he has agreed since.
function apply(month, t = now()) {
  const db = crm(), s = suggestions(month, t), caps = new Map(capsFor(month).map(c => [c.name, c])), off = cancelled(s.months);
  const insert = db.prepare(`INSERT INTO money_budgets (month, category, planned_cents, source, basis, base_cents, base_source, base_basis, updated_at) VALUES (?, ?, ?, 'history', ?, ?, 'history', ?, ?)`);
  const held = new Map(lines(month).map(l => [l.category, l]));
  // A cap on something with no line yet is still a plan for it.
  for (const c of caps.values()) {
    if (held.has(c.name) || !categories().includes(c.name)) continue;
    const base = s.lines.get(c.name) || { cents: c.monthly_cap_cents, basis: '' };
    insert.run(month, c.name, base.cents, base.basis, base.cents, base.basis, t);
  }
  const update = db.prepare('UPDATE money_budgets SET planned_cents = ?, source = ?, basis = ?, updated_at = ? WHERE month = ? AND category = ?');
  for (const l of lines(month)) {
    let planned = l.base_cents, source = l.base_source, basis = l.base_basis;
    if (l.base_source === 'history') {
      for (const c of off.filter(x => x.category === l.category)) { planned = Math.max(0, planned - c.cents); basis += `; less ${c.merchant} (${eur(c.cents)} a month), cancelled on ${dayLabel(c.on)}`; }
    }
    const cap = caps.get(l.category);
    if (cap) { planned = cap.monthly_cap_cents; source = 'cap'; basis = `your cap, taken on ${dayLabel(cap.started_on)}`; }
    if (planned !== l.planned_cents || source !== l.source || basis !== l.basis) update.run(planned, source, basis, t, month, l.category);
  }
}

// The month's plan, made once when the month is first seen. What he set himself carries forward, as does a cap he kept.
function ensureMonth(month, t = now()) {
  const db = crm();
  if (!lines(month).length) {
    const prev = addMonths(month, -1), before = new Map(lines(prev).map(l => [l.category, l])), s = suggestions(month, t);
    const kept = new Map((hasTable('money_commitments') ? db.prepare("SELECT * FROM money_commitments WHERE month = ? AND scope = 'category' AND status = 'kept' AND monthly_cap_cents IS NOT NULL").all(prev) : []).map(c => [c.name, c]));
    const insert = db.prepare(`INSERT INTO money_budgets (month, category, planned_cents, source, basis, base_cents, base_source, base_basis, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const c of categories()) {
        const p = before.get(c), k = kept.get(c), h = s.lines.get(c);
        const base = k ? { cents: k.monthly_cap_cents, source: 'kept', basis: `you kept it under ${eur(k.monthly_cap_cents)} in ${monthName(prev)}` }
          : p?.base_source === 'you' ? { cents: p.base_cents, source: 'you', basis: `your own figure, carried from ${monthName(prev)}` }
            : p?.base_source === 'kept' ? { cents: p.base_cents, source: 'kept', basis: p.base_basis }
              : h ? { cents: h.cents, source: 'history', basis: h.basis } : null;
        if (base) insert.run(month, c, base.cents, base.source, base.basis, base.cents, base.source, base.basis, t);
      }
    })();
  }
  apply(month, t);
}

function setLine(category, amount, t = now()) {
  if (!categories().includes(category)) throw new Error('Choose a kind of spending from the list.');
  const cents = toCents(amount);
  if (!Number.isFinite(cents)) throw new Error('Write the plan as euro, like 250.');
  const month = monthOf(dublinDay(t)), basis = `your own figure, set on ${dayLabel(dublinDay(t))}`;
  ensureMonth(month, t);
  crm().prepare(`INSERT INTO money_budgets (month, category, planned_cents, source, basis, base_cents, base_source, base_basis, updated_at) VALUES (?, ?, ?, 'you', ?, ?, 'you', ?, ?)
    ON CONFLICT(month, category) DO UPDATE SET base_cents = excluded.base_cents, base_source = 'you', base_basis = excluded.base_basis, updated_at = excluded.updated_at`).run(month, category, cents, basis, cents, basis, t);
  apply(month, t);
  return crm().prepare('SELECT * FROM money_budgets WHERE month = ? AND category = ?').get(month, category);
}

// Back to the Hub's figure. With nothing behind it to average, the line leaves the plan.
function resetLine(category, t = now()) {
  const month = monthOf(dublinDay(t)), h = suggestions(month, t).lines.get(category);
  if (!crm().prepare('SELECT 1 FROM money_budgets WHERE month = ? AND category = ?').get(month, category)) throw new Error('That line is not in the plan.');
  if (h) crm().prepare("UPDATE money_budgets SET base_cents = ?, base_source = 'history', base_basis = ?, updated_at = ? WHERE month = ? AND category = ?").run(h.cents, h.basis, t, month, category);
  else crm().prepare('DELETE FROM money_budgets WHERE month = ? AND category = ?').run(month, category);
  apply(month, t);
  return h || null;
}

function setMoney(body = {}) {
  for (const [field, key] of [['income', 'money_budget_income_cents'], ['savings', 'money_budget_savings_cents']]) {
    const raw = String(body[field] ?? '').trim(), cents = raw === '' ? 0 : toCents(raw);
    if (!Number.isFinite(cents)) throw new Error(field === 'income' ? 'Write your monthly take-home pay as euro, like 3200.' : 'Write what you want to put away each month as euro, like 300.');
    setSetting(key, String(cents));
  }
}

// ---- Where he stands ----

// Receipts the bank has not shown yet, by the kind of spending most of each receipt is.
function waitingReceipts(month) {
  const out = new Map();
  if (!hasTable('money_receipts')) return out;
  for (const r of crm().prepare("SELECT shop_norm, amount_cents, items FROM money_receipts WHERE status = 'waiting' AND currency = 'EUR' AND amount_cents < 0 AND bought_on >= ? AND bought_on <= ?").all(`${month}-01`, monthEnd(month))) {
    const by = new Map();
    try { for (const i of JSON.parse(r.items)) if (i.cents > 0) by.set(i.category, (by.get(i.category) || 0) + i.cents); } catch (_) { /* no items: the shop's usual kind is used */ }
    let category = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!category) category = crm().prepare(`SELECT category FROM money_transactions WHERE ${SPEND_SQL} AND merchant_norm = ? GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get(r.shop_norm)?.category || 'Other';
    out.set(category, (out.get(category) || 0) + -r.amount_cents);
  }
  return out;
}

// Everything elsewhere in Money that bears on a line: his agreements, his answers, and what is still open.
function linksFor(month, t) {
  const db = crm(), CATS = categories(), out = new Map(), add = (category, link) => { if (!CATS.includes(category)) return; if (!out.has(category)) out.set(category, []); out.get(category).push(link); };
  const kindOf = norm => db.prepare(`SELECT category FROM money_transactions WHERE ${SPEND_SQL} AND merchant_norm = ? GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`).get(norm)?.category;
  const where = x => (x.scope === 'category' ? CATS.find(c => c.toLowerCase() === x.norm) : x.scope === 'merchant' ? kindOf(x.norm) : null);
  const challenge = '/money/challenge';
  if (hasTable('money_commitments')) {
    const insights = require('./insights');
    for (const c of db.prepare("SELECT * FROM money_commitments WHERE month = ? AND status IN ('active','kept','broken') ORDER BY created_at").all(month)) {
      const category = where(c);
      if (!category) continue;
      const p = c.monthly_cap_cents === null ? null : insights.progress(c, { t });
      add(category, { kind: 'agreed', href: challenge, bad: !!p?.over || c.status === 'broken',
        text: p ? `You agreed: ${c.name} under ${eur(c.monthly_cap_cents)} this month. ${eur(p.spent)} spent, ${p.text}.` : `You agreed: ${c.title}.` });
    }
    for (const f of db.prepare("SELECT * FROM money_challenge_feedback WHERE (kind = 'wrong' AND created_at > ?) OR (kind = 'snooze' AND until_at > ?) ORDER BY created_at DESC").all(t - 120 * 86400, t)) {
      const category = where(f);
      if (category) add(category, { kind: 'said', href: challenge, text: f.kind === 'wrong' ? `You said "${clean(f.title, 80)}" was wrong: “${clean(f.reason, 160)}”` : `You said "not now" to "${clean(f.title, 80)}" until ${dayLabel(dublinDay(f.until_at))}.` });
    }
    const open = insights.screen({ t }).challenges;
    for (const c of open) {
      const category = c.target ? where(c.target) : null;
      if (category) add(category, { kind: 'open', href: challenge, text: `Open challenge: ${clean(c.question, 200)}` });
    }
  }
  if (hasTable('money_subscriptions')) {
    const s = require('./subscriptions').screen({ today: dublinDay(t), t }), href = '/money/subscriptions';
    const waiting = [...s.proven, ...s.mailOnly].filter(x => x.status === 'to_cancel');
    if (waiting.length) add('Subscriptions', { kind: 'agreed', href, text: `On your cancel list: ${waiting.map(x => `${x.merchant}${x.monthly_cents ? ` (${eur(x.monthly_cents)} a month)` : ''}`).join(', ')}. The plan drops when you mark ${waiting.length === 1 ? 'it' : 'them'} cancelled.` });
    if (s.value.poor.length) add('Subscriptions', { kind: 'said', href, bad: true, text: `You said you hardly use ${s.value.poor.map(x => x.merchant).join(', ')}: ${eur(s.value.poor_yearly_cents)} a year.` });
    if (s.value.unrated.length) add('Subscriptions', { kind: 'open', href, text: `${plural(s.value.unrated.length, 'subscription')} not rated for how much you use ${s.value.unrated.length === 1 ? 'it' : 'them'}.` });
  }
  if (hasTable('money_receipts') && hasTable('money_price_answers')) {
    const p = require('./prices').screen(t), href = '/money/prices';
    if (p.asked.length) add('Groceries', { kind: 'open', href, text: `${plural(p.asked.length, 'thing')} cheaper in another shop you use (${eur(p.asked_cents)} over 90 days). Why there?` });
    for (const a of p.answered.slice(0, 3)) add('Groceries', { kind: 'said', href, text: `${a.product} at ${a.usual.shop}, not ${a.cheapest.shop}: “${clean(a.answer.reason, 120)}”` });
  }
  return out;
}

function view({ month, t = now() } = {}) {
  const db = crm(), today = dublinDay(t), thisMonth = monthOf(today);
  month = /^\d{4}-\d{2}$/.test(String(month || '')) && month <= thisMonth ? month : thisMonth;
  const current = month === thisMonth;
  if (current) ensureMonth(month, t);
  const spend = spendByMonth(month, month), end = monthEnd(month), days = daysIn(month);
  const newest = db.prepare("SELECT MAX(posted_on) AS d FROM money_transactions WHERE status != 'ignored' AND posted_on <= ?").get(current ? today : end).d || '';
  // How much of the month the bank lines cover: a pace is worked out from that, not from today.
  const elapsed = !current ? days : newest >= `${month}-01` ? Number(newest.slice(8, 10)) : 0;
  const waiting = current ? waitingReceipts(month) : new Map(), links = current ? linksFor(month, t) : new Map();
  const s = current ? suggestions(month, t) : { months: [], lines: new Map() };
  const broken = current && hasTable('money_commitments') ? new Map(db.prepare("SELECT * FROM money_commitments WHERE month = ? AND scope = 'category' AND status = 'broken'").all(addMonths(month, -1)).map(c => [c.name, c])) : new Map();

  // Bills land in one lump on the day the bank takes them, so they are judged against the plan, not against the calendar.
  const CATS = categories(), BILLS = billCategories();
  const rows = lines(month).map(l => {
    const spent = spend.get(`${month}|${l.category}`)?.cents || 0, n = spend.get(`${month}|${l.category}`)?.n || 0, bill = BILLS.has(l.category);
    const left = l.planned_cents - spent, projected = !bill && elapsed >= PACE_MIN_DAYS && n >= PACE_MIN_PURCHASES ? Math.round(spent * days / elapsed) : null;
    const state = left < 0 ? 'over' : !current ? 'kept' : bill ? 'bill' : projected !== null && projected > l.planned_cents * PACE_MARGIN ? 'ahead' : 'ok';
    const again = broken.get(l.category);
    return { ...l, spent, n, left, bill, projected, state, pct: l.planned_cents ? Math.min(100, Math.round(spent * 100 / l.planned_cents)) : spent ? 100 : 0,
      waiting: waiting.get(l.category) || 0, links: links.get(l.category) || [], suggestion: s.lines.get(l.category) || null,
      // Last month's cap was broken and nothing has been agreed for this one: the question is put again.
      again: again && l.source !== 'cap' ? { cap_cents: again.monthly_cap_cents, note: clean(again.note, 200) } : null };
  }).sort((a, b) => ({ over: 0, ahead: 1 }[a.state] ?? 2) - ({ over: 0, ahead: 1 }[b.state] ?? 2) || b.planned_cents - a.planned_cents || CATS.indexOf(a.category) - CATS.indexOf(b.category));
  const planned = new Set(rows.map(r => r.category));
  const unplanned = CATS.filter(c => !planned.has(c) && spend.get(`${month}|${c}`)).map(c => ({ category: c, spent: spend.get(`${month}|${c}`).cents, n: spend.get(`${month}|${c}`).n, waiting: waiting.get(c) || 0 }));

  const sum = (list, f) => list.reduce((n, r) => n + f(r), 0);
  const total = { planned: sum(rows, r => r.planned_cents), spent: sum(rows, r => r.spent) + sum(unplanned, r => r.spent), waiting: sum([...waiting.values()], x => x) };
  total.left = total.planned - total.spent;
  total.pct = total.planned ? Math.min(100, Math.round(total.spent * 100 / total.planned)) : 0;
  // Month end, if he goes on as he is: what has a pace at its pace, everything else at its plan or what it already cost.
  total.projected = current && elapsed >= PACE_MIN_DAYS ? sum(rows, r => (r.projected !== null ? r.projected : Math.max(r.planned_cents, r.spent))) + sum(unplanned, r => (r.n >= PACE_MIN_PURCHASES ? Math.round(r.spent * days / elapsed) : r.spent)) : null;
  const income = Number(setting('money_budget_income_cents', '0')) || 0, savings = Number(setting('money_budget_savings_cents', '0')) || 0;
  const money = { income, savings, free: income ? income - savings - total.planned : null,
    // What is left of the month's pay once the month is spent as it is going, against what he meant to put away.
    heading: income && total.projected !== null ? income - total.projected : null };

  const history = [];
  for (let i = 1; i <= 6; i++) {
    const m = addMonths(thisMonth, -i), sp = spendByMonth(m, m), ls = lines(m), spentAll = [...sp.values()].reduce((n, r) => n + r.cents, 0);
    if (!spentAll && !ls.length) continue;
    history.push({ month: m, name: monthName(m, { month: 'long', year: 'numeric' }), spent: spentAll, planned: ls.length ? ls.reduce((n, l) => n + l.planned_cents, 0) : null,
      over: ls.filter(l => (sp.get(`${m}|${l.category}`)?.cents || 0) > l.planned_cents).map(l => l.category) });
  }
  return { month, current, name: monthName(month, { month: 'long', year: 'numeric' }), short: monthName(month), today, days, elapsed, days_left: current ? days - Number(today.slice(8, 10)) : 0,
    newest, stale: current && newest && newest < addDays(today, -3), rows, unplanned, total, money, history, any: rows.length > 0 || unplanned.length > 0,
    over: rows.filter(r => r.state === 'over'), ahead: rows.filter(r => r.state === 'ahead'), history_months: s.months, categories: CATS.filter(c => !planned.has(c)) };
}

// Sentences for the weekly challenge, with the exact figures its wording is checked against.
function stats(t = now()) {
  const v = view({ t }), out = [];
  if (!v.rows.length) return out;
  const to = v.newest >= `${v.month}-01` ? ` to ${dayLabel(v.newest)}` : '';
  out.push({ kind: 'budget', amounts: [v.total.planned, v.total.spent, Math.abs(v.total.left), ...(v.total.projected !== null ? [v.total.projected, Math.abs(v.total.projected - v.total.planned)] : [])],
    text: `His plan for ${v.name}: ${eur(v.total.planned)} over ${plural(v.rows.length, 'kind')} of spending. Spent${to}: ${eur(v.total.spent)}, ${v.total.left < 0 ? `${eur(-v.total.left)} over the plan` : `${eur(v.total.left)} left`}.${v.total.projected !== null ? ` Going on as he is, the month ends at ${eur(v.total.projected)}, ${eur(Math.abs(v.total.projected - v.total.planned))} ${v.total.projected > v.total.planned ? 'over' : 'under'} the plan.` : ''}` });
  for (const r of [...v.over, ...v.ahead].slice(0, 5)) {
    const how = r.source === 'cap' ? 'a cap he took on' : r.source === 'you' ? 'a figure he set himself' : r.source === 'kept' ? 'a cap he kept last month' : 'his own recent average';
    out.push({ kind: 'budget_line', scope: 'category', name: r.category, norm: r.category.toLowerCase(), monthly: r.planned_cents,
      amounts: [r.planned_cents, r.spent, Math.abs(r.left), ...(r.projected !== null ? [r.projected, Math.abs(r.projected - r.planned_cents)] : [])],
      text: r.state === 'over' ? `${r.category} is over its plan for ${v.name}: ${eur(r.spent)} spent against ${eur(r.planned_cents)} (${how}), ${eur(-r.left)} over${to ? `, counted${to}` : ''}.`
        : `${r.category} is running ahead of its plan for ${v.name}: ${eur(r.spent)} of ${eur(r.planned_cents)} (${how}) spent${to}. At this pace it ends the month at ${eur(r.projected)}, ${eur(r.projected - r.planned_cents)} over.` });
  }
  return out;
}

function summary(t = now()) {
  const v = view({ t });
  if (!v.rows.length) return null;
  const out = [`${eur(v.total.spent)} of the ${eur(v.total.planned)} planned for ${v.short} is spent; ${v.total.left < 0 ? `${eur(-v.total.left)} over` : `${eur(v.total.left)} left`}`];
  if (v.over.length) out.push(`Over plan: ${v.over.map(r => r.category).join(', ')}`);
  if (v.ahead.length) out.push(`Running ahead: ${v.ahead.map(r => r.category).join(', ')}`);
  return { title: 'Budget', lines: out, href: BASE };
}

// The plan exists from the first minute of a month, whether or not he opens the screen.
function tick({ t = now() } = {}) {
  const month = monthOf(dublinDay(t)), had = lines(month).length;
  ensureMonth(month, t);
  return had ? {} : { started: month, lines: lines(month).length };
}

function mount(router, h) {
  const root = h.base || '/money', path = `${root}/budget`;
  router.get(path, (req, res) => {
    res.render('crm/money/budget', { page: 'money', title: 'Budget', tab: 'budget', eur, dayLabel, base: root, v: view({ month: req.query.month }) });
  });
  const post = (sub, fn) => router.post(`${path}/${sub}`, h.requireSameOrigin, h.writeLimiter, (req, res) => {
    try { h.flash(req, fn(req)); } catch (err) { h.flash(req, err.message, 'bad'); }
    res.redirect(path);
  });
  post('line', req => { const l = setLine(String(req.body.category || ''), req.body.amount); return `${l.category}: ${eur(l.planned_cents)} a month${l.source === 'cap' ? ' is your cap this month; your own figure applies once the cap ends' : ', and it carries forward until you change it'}.`; });
  post('reset', req => { const s = resetLine(String(req.body.category || '')); return s ? `Back to the Hub's figure: ${eur(s.cents)}.` : 'Taken out of the plan: there is no spending behind it to plan from.'; });
  post('money', req => { setMoney(req.body); return 'Saved.'; });
}

module.exports = { SCHEMA, mount, tick, summary, view, stats, ensureMonth, apply, setLine, resetLine, setMoney, suggestions, historyMonths };
