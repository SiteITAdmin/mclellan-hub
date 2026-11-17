'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-budget-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const { normMerchant } = require('../lib/crm/money/common');
const budget = require('../lib/crm/money/budget');
const insights = require('../lib/crm/money/insights');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

const at = iso => Math.floor(Date.parse(iso) / 1000);
const T = at('2026-11-15T12:00:00Z'), DEC = at('2026-12-01T09:00:00Z');
const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function tx(date, merchant, euros, category) {
  n += 1;
  db.crm().prepare(`INSERT INTO money_transactions (id, posted_on, description, merchant, merchant_norm, amount_cents, category, kind, status, dup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'spend', 'confirmed', ?)`).run(`t${n}`, date, merchant, merchant, normMerchant(merchant), -Math.round(euros * 100), category, `k${n}`);
}
const line = (v, c) => v.rows.find(r => r.category === c);

// Aug to Oct whole; November to the 14th. Coffee €40 a month then heavy in November; groceries steady; rent; Netflix.
function plant() {
  for (const m of [8, 9, 10]) {
    tx(day(m, 1), 'Landlord', 1400, 'Home & utilities'); tx(day(m, 8), 'Netflix', 15.99, 'Subscriptions'); tx(day(m, 12), 'Spotify', 11.99, 'Subscriptions');
    for (const d of [3, 10, 17, 24]) tx(day(m, d), 'SuperValu', 62, 'Groceries');
    for (const d of [2, 5, 9, 12, 16, 19, 23, 26, 28, 30]) tx(day(m, d), 'Starbucks', 4, 'Coffee');
    tx(day(m, 20), 'Just Eat', m === 10 ? 61 : 30, 'Eating out');
  }
  tx(day(11, 1), 'Landlord', 1400, 'Home & utilities'); tx(day(11, 8), 'Netflix', 15.99, 'Subscriptions'); tx(day(11, 12), 'Spotify', 11.99, 'Subscriptions');
  for (const d of [3, 10]) tx(day(11, d), 'SuperValu', 62, 'Groceries');
  for (let d = 1; d <= 14; d++) tx(day(11, d), 'Starbucks', 4, 'Coffee');
  tx(day(11, 6), 'Just Eat', 20, 'Eating out');
  tx(day(11, 9), 'Ryanair', 180, 'Travel');
}

test('the plan is drawn from his own whole months, and each line is judged against it and against the calendar', () => {
  plant();
  const v = budget.view({ t: T });
  assert.deepEqual(v.history_months, ['2026-10', '2026-09', '2026-08']);
  assert.deepEqual(v.rows.map(r => [r.category, r.planned_cents, r.spent, r.state]), [
    ['Coffee', 4000, 5600, 'over'],
    ['Home & utilities', 140000, 140000, 'bill'],
    ['Groceries', 25000, 12400, 'ok'],
    ['Eating out', 4500, 2000, 'ok'],
    ['Subscriptions', 3000, 2798, 'bill'],
  ]);
  assert.equal(line(v, 'Coffee').basis, 'your average for August to October');
  assert.equal(line(v, 'Eating out').base_cents, 4500, '€40.33 averaged, rounded up to €5');
  assert.deepEqual(v.unplanned.map(r => [r.category, r.spent]), [['Travel', 18000]], 'spending with nothing behind it to plan from is shown as unplanned');
  assert.deepEqual([v.elapsed, v.newest, v.days_left], [14, '2026-11-14', 15]);
  assert.deepEqual([v.total.planned, v.total.spent, v.total.left], [176500, 180798, -4298]);
  // Coffee and groceries at their pace over 14 of 30 days; one takeaway and one flight are not a pace; bills at plan.
  assert.equal(v.total.projected, 12000 + 26571 + 4500 + 140000 + 3000 + 18000);
  assert.equal(line(v, 'Groceries').projected, 26571, 'two weekly shops in a fortnight are a little ahead, not "running ahead"');

  tx(day(11, 13), 'Just Eat', 15, 'Eating out');
  const ahead = line(budget.view({ t: T }), 'Eating out');
  assert.deepEqual([ahead.state, ahead.projected], ['ahead', 7500], 'under plan today, but on course to pass it');
  assert.equal(budget.summary(T).lines.join(' | '), '€1,822.98 of the €1,765.00 planned for November is spent; €57.98 over | Over plan: Coffee | Running ahead: Eating out');
});

test('his own figure stands and carries forward; the Hub\'s figure can be taken back; pay and savings are optional', () => {
  plant();
  budget.view({ t: T });
  assert.throws(() => budget.setLine('Groceries', 'lots', T), /Write the plan as euro/);
  assert.throws(() => budget.setLine('Sweets', '10', T), /Choose a kind of spending/);
  const g = budget.setLine('Groceries', '€220', T);
  assert.deepEqual([g.planned_cents, g.source, g.basis], [22000, 'you', 'your own figure, set on 15 November']);
  budget.setLine('Travel', '200', T);
  let v = budget.view({ t: T });
  assert.equal(v.unplanned.length, 0); assert.equal(line(v, 'Travel').state, 'ok');

  budget.tick({ t: DEC });
  const dec = budget.view({ t: DEC });
  assert.deepEqual([line(dec, 'Groceries').planned_cents, line(dec, 'Groceries').basis], [22000, 'your own figure, carried from November']);
  assert.equal(line(dec, 'Coffee').source, 'history', 'a line he never touched is worked out afresh');
  assert.equal(budget.view({ month: '2026-11', t: DEC }).rows.find(r => r.category === 'Groceries').planned_cents, 22000, 'a month that has ended keeps its plan');
  assert.equal(budget.view({ month: '2026-11', t: DEC }).current, false);
  assert.deepEqual(dec.history[0].over, ['Coffee'], 'November is listed with what went over');

  assert.deepEqual(budget.resetLine('Groceries', T), { cents: 25000, basis: 'your average for August to October' });
  assert.equal(budget.resetLine('Travel', T), null);
  v = budget.view({ t: T });
  assert.equal(line(v, 'Groceries').source, 'history'); assert.equal(line(v, 'Travel'), undefined);

  assert.equal(v.money.free, null);
  assert.throws(() => budget.setMoney({ income: 'plenty' }), /take-home pay as euro/);
  budget.setMoney({ income: '2,400', savings: '300' });
  v = budget.view({ t: T });
  assert.deepEqual([v.money.income, v.money.savings, v.money.free], [240000, 30000, 240000 - 30000 - 176500]);
  assert.equal(v.money.heading, 240000 - v.total.projected);
});

test('the plan follows his agreements: a cap is the plan, a dropped cap gives the line back, a kept cap carries, a broken one is asked again', () => {
  plant();
  budget.view({ t: T });
  const cap = insights.capCategory('Coffee', '60', { t: T });
  let c = line(budget.view({ t: T }), 'Coffee');
  assert.deepEqual([c.planned_cents, c.source, c.basis, c.base_cents, c.state], [6000, 'cap', 'your cap, taken on 15 November', 4000, 'ahead']);
  assert.match(c.links[0].text, /^You agreed: Coffee under €60\.00 this month\. €56\.00 spent, €4\.00 left, 15 days to go\.$/);
  assert.equal(c.links[0].kind, 'agreed');
  budget.setLine('Coffee', '45', T);
  assert.equal(line(budget.view({ t: T }), 'Coffee').planned_cents, 6000, 'the cap is what counts while it runs');
  insights.closeCommitment(cap.id, 'drop', { t: T });
  c = line(budget.view({ t: T }), 'Coffee');
  assert.deepEqual([c.planned_cents, c.source], [4500, 'you'], 'dropped: his own figure applies');

  // Groceries capped and kept; eating out capped and broken. Statements reach into December, so November can be judged.
  insights.capCategory('Groceries', '200', { t: T });
  insights.capCategory('Eating out', '10', { t: T });
  tx(day(11, 30), 'Landlord', 5, 'Home & utilities'); tx(day(12, 1), 'Landlord', 1400, 'Home & utilities');
  assert.equal(insights.closeCommitments({ t: DEC }), 2);
  const dec = budget.view({ t: DEC });
  assert.deepEqual([line(dec, 'Groceries').planned_cents, line(dec, 'Groceries').source, line(dec, 'Groceries').basis], [20000, 'kept', 'you kept it under €200.00 in November']);
  const eating = line(dec, 'Eating out');
  assert.equal(eating.source, 'history');
  assert.deepEqual([eating.again.cap_cents, /€10\.00 over/.test(eating.again.note)], [1000, true], 'the broken cap is put to him again');
  insights.capCategory('Eating out', '10', { t: DEC });
  assert.equal(line(budget.view({ t: DEC }), 'Eating out').again, null);
});

test('a cancelled subscription comes off the plan; his answers and open questions sit on the lines they concern', () => {
  plant();
  const c = db.crm();
  c.prepare(`INSERT INTO money_subscriptions (id, merchant, merchant_norm, amount_cents, cadence, last_charge_on, first_seen, basis, evidence, status, decided_at, use_level, use_at)
    VALUES ('s1', 'Netflix', 'netflix', 1599, 'monthly', ?, ?, 'recurring', '{}', 'cancelled', ?, '', NULL), ('s2', 'Spotify', 'spotify', 1199, 'monthly', ?, ?, 'recurring', '{}', 'active', NULL, 'rarely', ?)`)
    .run(day(11, 8), day(8, 8), T - 3600, day(11, 12), day(8, 12), T);
  c.prepare(`INSERT INTO money_challenge_feedback (id, kind, title, title_norm, scope, norm, reason, created_at) VALUES ('f1', 'wrong', 'Groceries crept up', 'groceries crept up', 'category', 'groceries', 'Nakai was home for a month', ?)`).run(T - 86400);
  c.prepare(`INSERT INTO money_challenge_feedback (id, kind, title, title_norm, scope, norm, reason, until_at, created_at) VALUES ('f2', 'snooze', 'Coffee every day', 'coffee every day', 'merchant', 'starbucks', '', ?, ?)`).run(T + 20 * 86400, T - 86400);
  const v = budget.view({ t: T });
  const subs = line(v, 'Subscriptions');
  assert.deepEqual([subs.base_cents, subs.planned_cents], [3000, 1401]);
  assert.equal(subs.basis, 'your average for August to October; less Netflix (€15.99 a month), cancelled on 15 November');
  assert.deepEqual(subs.links.map(l => [l.kind, l.text]), [['said', 'You said you hardly use Spotify: €143.88 a year.']]);
  assert.equal(subs.state, 'over', 'the plan no longer has room for the one he cancelled');
  assert.deepEqual(line(v, 'Groceries').links.map(l => l.text), ['You said "Groceries crept up" was wrong: “Nakai was home for a month”']);
  assert.deepEqual(line(v, 'Coffee').links.map(l => l.text), ['You said "not now" to "Coffee every day" until 5 December.'], 'a merchant belongs to the kind of spending it is filed under');
});

test('the challenge is told where he stands against the plan, and may quote those figures', () => {
  plant();
  for (let d = 1; d <= 31; d++) tx(day(7, d), 'Corner Shop', 3, 'Other');
  insights.capCategory('Coffee', '50', { t: T });
  const packet = insights.buildPacket({ t: T });
  const of = kind => packet.stats.filter(s => s.kind === kind);
  assert.match(of('budget')[0].text, /^His plan for November 2026: €1,775\.00 over 5 kinds of spending\. Spent to 14 November: €1,807\.98, €32\.98 over the plan\. Going on as he is, the month ends at €2,040\.71, €265\.71 over the plan\.$/);
  assert.deepEqual(of('budget_line').map(s => s.text), ['Coffee is over its plan for November 2026: €56.00 spent against €50.00 (a cap he took on), €6.00 over, counted to 14 November.']);
  assert.match(insights.SYSTEM_PROMPT, /hold him to it/);
  const b = of('budget_line')[0];
  const body = insights.validate({ headline: 'Coffee is €6 over its cap.', challenges: [
    { title: 'Coffee over its cap', question: 'You took on €50.00 for coffee and have spent €56.00. What happened?', observation: '€6.00 over with half the month left.', evidence: [b.id], saving_cents_per_month: 600, saving_basis: `${b.id}: back to the cap`, action: 'No coffee out this week.', target: null },
    { title: 'Invented', question: 'Coffee is €99.00 over.', observation: '', evidence: [b.id], saving_cents_per_month: 100, saving_basis: '', action: 'x', target: null }], habits: [], wins: [] }, packet);
  assert.deepEqual(body.challenges.map(c => c.title), ['Coffee over its cap']);
});

test('with no whole month held the plan comes from the last 28 days; with nothing held there is no plan; a past month is never rewritten', () => {
  assert.equal(budget.view({ t: T }).any, false);
  assert.equal(budget.summary(T), null);
  for (const d of [1, 5, 9, 13]) tx(day(11, d), 'SuperValu', 70, 'Groceries');
  const v = budget.view({ t: T });
  assert.deepEqual(v.rows.map(r => [r.category, r.planned_cents, r.basis]), [['Groceries', 30000, 'your last 28 days of bank lines, as no whole month is held yet']]);
  db.crm().prepare("UPDATE money_budgets SET planned_cents = 12345 WHERE month = '2026-11'").run();
  budget.tick({ t: DEC });
  assert.equal(db.crm().prepare("SELECT planned_cents FROM money_budgets WHERE month = '2026-11'").get().planned_cents, 12345);
});

test('the screens: Budget with its lines, links and forms; the Overview card; a cap from the Budget page', async () => {
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
  const get = async p => (await fetch(`${base}${p}`)).text();
  const { dublinDay, addDays } = require('../lib/crm/money/common');
  const today = dublinDay(), month = today.slice(0, 7), first = `${month}-01`;
  const monthsBack = k => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 - k, 1)).toISOString().slice(0, 7);
  try {
    const empty = await get('/crm/personal/money/budget');
    assert.match(empty, /Nothing to plan from yet/); assert.match(empty, /aria-current="page">Budget</);
    assert.equal((await fetch(`${base}/crm/work/money/budget`)).status, 404);

    for (const k of [1, 2, 3]) { const m = monthsBack(k); for (const d of ['02', '09', '16', '23', '27']) { tx(`${m}-${d}`, 'SuperValu', 50, 'Groceries'); tx(`${m}-${d}`, '<b>Bean</b>', 4, 'Coffee'); } tx(`${m}-01`, 'Landlord', 900, 'Home & utilities'); }
    tx(first, 'Landlord', 900, 'Home & utilities'); tx(first, '<b>Bean</b>', 90, 'Coffee'); tx(today, 'SuperValu', 20, 'Groceries'); tx(today, 'Ryanair', 80, 'Travel');
    const page = await get('/crm/personal/money/budget');
    assert.match(page, /The plan, line by line/); assert.match(page, /<strong>€90\.00<\/strong> of €20\.00/); assert.match(page, /Over by €70\.00/);
    assert.match(page, /The Hub’s figure: your average for /); assert.match(page, /Spent, but not in the plan/); assert.match(page, /Earlier months/);
    assert.match(page, /Tell it your monthly take-home pay/);
    assert.ok(page.indexOf('id="line-coffee"') < page.indexOf('id="line-groceries"'), 'the line over plan comes first');

    assert.equal((await post('/crm/personal/money/budget/line', 'category=Groceries&amount=180')).status, 302);
    assert.match(flashes.pop().text, /^Groceries: €180\.00 a month, and it carries forward until you change it\.$/);
    assert.equal((await post('/crm/personal/money/budget/line', 'category=Travel&amount=100')).status, 302); flashes.pop();
    assert.equal((await post('/crm/personal/money/budget/money', 'income=2000&savings=200')).status, 302); flashes.pop();
    assert.equal((await post('/crm/personal/money/challenge/cap', 'category=Coffee&cap=100')).status, 302);
    assert.match(flashes.pop().text, /^Taken on: Coffee under €100\.00 this month/);
    const after = await get('/crm/personal/money/budget');
    assert.match(after, /Your own figure: your own figure, set on /); assert.match(after, /Your cap: your cap, taken on /);
    assert.match(after, /<span class="challenge-ref">Agreed<\/span> <a href="\/crm\/personal\/money\/challenge">You agreed: Coffee under €100\.00 this month\. €90\.00 spent/);
    assert.match(after, /Take-home €2,000\.00, less €200\.00 to put away, less the €1,280\.00 planned:\s*<strong class="">€520\.00 not given a job<\/strong>/);
    assert.doesNotMatch(after, /Spent, but not in the plan/);
    assert.equal((await post('/crm/personal/money/budget/reset', 'category=Groceries')).status, 302);
    assert.match(flashes.pop().text, /^Back to the Hub's figure: €250\.00\.$/);
    assert.equal((await post('/crm/personal/money/budget/line', 'category=Groceries&amount=abc')).status, 302);
    assert.match(flashes.pop().text, /Write the plan as euro/);

    const past = await get(`/crm/personal/money/budget?month=${monthsBack(1)}`);
    assert.match(past, /No plan was held for /); assert.match(past, /Back to this month/); assert.doesNotMatch(past, /Change the plan for/);
    const overview = await get('/crm/personal/money');
    assert.match(overview, /<h2>Budget<\/h2>/); assert.match(overview, /planned for \w+ is spent/);
    assert.match(await get('/crm/personal/money/challenge'), /Your cap this month: €90\.00 of €100\.00/);
    void addDays;
  } finally { server.close(); }
});
