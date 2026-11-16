'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-receipts-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const ledger = require('../lib/crm/money/ledger');
const receipts = require('../lib/crm/money/receipts');
const { dublinDay, addDays } = require('../lib/crm/money/common');
const agent = require('../lib/subscription-agent');
const { resolveFeatureRunner } = require('../lib/feature-runners');
const PDFKit = require('pdfkit');
const cliKeys = ['CLAUDE_CLI_PATH', 'CODEX_CLI_PATH', 'GROK_CLI_PATH'];
const cliBefore = Object.fromEntries(cliKeys.map(k => [k, process.env[k]]));
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); for (const k of cliKeys) cliBefore[k] === undefined ? delete process.env[k] : process.env[k] = cliBefore[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

// Mid-month, so "this month" holds every day used below.
const T = Math.floor(new Date(`${dublinDay().slice(0, 8)}20T12:00:00Z`).getTime() / 1000), TODAY = dublinDay(T);
const day = n => addDays(TODAY, n);

function png(seed = 0) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(2, 0); head.writeUInt32BE(2, 4); head[8] = 8; head[9] = 2;
  const pixels = Buffer.from([0, seed & 255, (seed >> 8) & 255, 90, 255, 255, 255, 0, 20, 20, 20, 200, 200, 200]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function makePdf(lines) {
  return new Promise(resolve => {
    const doc = new PDFKit({ autoFirstPage: false }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.addPage(); for (const [x, y, t] of lines) doc.fontSize(10).text(t, x, y, { lineBreak: false });
    doc.end();
  });
}

function fakeQueue() {
  const q = { sent: [], jobs: {}, enqueue(x) { const jobId = `job${q.sent.length + 1}`; q.sent.push({ ...x, jobId }); q.jobs[jobId] = { id: jobId, status: 'pending', created_at: T }; return { jobId }; },
    getJob: id => q.jobs[id] || null,
    answer(reading, jobId = q.sent.at(-1).jobId) { q.jobs[jobId] = { id: jobId, status: 'completed', created_at: T, result: { output: JSON.stringify(reading), meta: { runner: 'claude', model: 'sonnet' } } }; } };
  return q;
}
const receiptReading = (more = {}) => ({ readable: true, reason: '', transactions: [], receipt: { shop: 'Tesco', date: day(-2), total: 42.1, refund: false, tip: 0, currency: 'EUR', paid_by: 'card', card_last4: '4821',
  items: [{ description: 'Milk 2L', amount: 2.1, category: 'Groceries' }, { description: 'Washing powder', amount: 40, category: 'Shopping' }], unsure: false, why_unsure: '', ...more } });
const line = (date, description, amount, more = {}) => ({ date, description, merchant: description, amount, kind: amount > 0 ? 'income' : 'spend', category: 'Other', pending: false, unsure: false, why_unsure: '', ...more });
const bankReading = transactions => ({ readable: true, reason: '', account_hint: '', period: { from: day(-10), to: TODAY }, transactions });
const all = () => db.crm().prepare('SELECT * FROM money_receipts ORDER BY rowid').all();
const txs = () => db.crm().prepare('SELECT * FROM money_transactions ORDER BY rowid').all();

async function receipt(q, reading, seed) {
  const { id } = await receipts.addReceipt({ buffer: png(seed), filename: `r${seed}.jpg` }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer(reading);
  await ledger.tick({ jobs: q, t: T });
  return db.crm().prepare('SELECT * FROM money_receipts WHERE upload_id = ?').get(id);
}
async function bank(q, rows, seed, account = 'AIB current') {
  ledger.addUpload({ buffer: png(1000 + seed), filename: `b${seed}.png`, account }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer(bankReading(rows));
  await ledger.tick({ jobs: q, t: T });
  await receipts.tick({ t: T });
}

test('a receipt uploaded first waits, counts in the running total and not in spending, then sits beside its bank line when it arrives', async () => {
  const q = fakeQueue();
  const r = await receipt(q, receiptReading(), 1);
  const sent = q.sent[0].payload;
  assert.equal(sent.systemPrompt, receipts.PROMPT, 'a receipt is read with the receipt prompt');
  assert.equal(sent.documents[0].type, 'image');
  assert.match(sent.userPrompt, /Read the attached receipt/);
  assert.deepEqual([r.shop, r.bought_on, r.amount_cents, r.status, r.card_last4, JSON.parse(r.items).length], ['Tesco', day(-2), -4210, 'waiting', '4821', 2]);
  let s = receipts.standing(T);
  assert.deepEqual([s.waitingTotal, s.expectedCount, s.missingCount, s.month.bank, s.month.coming, s.month.likely], [4210, 1, 0, 0, 4210, 4210]);
  assert.equal(txs().length, 0, 'a receipt never becomes a transaction');

  await bank(q, [line(day(-1), 'VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco' }), line(day(-1), 'SPAR', -5)], 1);
  const m = receipts.get(r.id);
  assert.deepEqual([m.status, m.decided_by], ['matched', 'auto']);
  assert.equal(m.transaction_id, txs().find(x => x.merchant === 'Tesco').id);
  s = receipts.standing(T);
  assert.deepEqual([s.waitingTotal, s.month.bank, s.month.backed, s.month.backedCount, s.month.likely], [0, 4710, 4210, 1, 4710], 'the bank line is counted once; the receipt adds nothing');
  assert.equal(ledger.spendBetween(day(-30), TODAY).total, 4710);
});

test('a near miss is offered, not matched; "No" and "Not this line" are remembered; a match by hand holds', async () => {
  const q = fakeQueue();
  await bank(q, [line(day(-3), 'SQ *THE BEAN HOUSE', -18.5, { merchant: 'Bean House' }), line(day(-2), 'BRASSERIE 9', -60, { merchant: 'Brasserie 9' }), line(day(-2), 'CIRCLE K', -61.1, { merchant: 'Circle K' })], 1);
  const cafe = await receipt(q, receiptReading({ shop: 'The Coffee Room', date: day(-3), total: 18.5, items: [] }), 2);
  const dinner = await receipt(q, receiptReading({ shop: 'Brasserie 9', date: day(-2), total: 52, items: [] }), 3);
  assert.deepEqual([receipts.get(cafe.id).status, receipts.get(dinner.id).status], ['waiting', 'waiting'], 'a different name, or a different amount, is never matched on its own');
  const [s1] = receipts.suggestions(receipts.get(cafe.id));
  assert.equal(s1.merchant, 'Bean House'); assert.match(s1.why, /Same amount; the bank names the shop differently/);
  const [s2] = receipts.suggestions(receipts.get(dinner.id));
  assert.equal(s2.merchant, 'Brasserie 9'); assert.match(s2.why, /the bank took €8\.00 more\. A tip/);
  assert.equal(receipts.suggestions(receipts.get(dinner.id)).length, 1, 'Circle K is not offered: not the shop, not the amount');

  receipts.decide(cafe.id, 'reject', { transaction_id: s1.id }, T);
  assert.equal(receipts.suggestions(receipts.get(cafe.id)).length, 0);
  assert.ok(receipts.pickable(receipts.get(cafe.id)).some(x => x.id === s1.id), 'still there to match by hand');
  assert.match(receipts.decide(cafe.id, 'match', { transaction_id: s1.id }, T), /Matched/);
  assert.deepEqual([receipts.get(cafe.id).status, receipts.get(cafe.id).decided_by], ['matched', 'you']);
  assert.throws(() => receipts.decide(dinner.id, 'match', { transaction_id: s1.id }, T), /already has a receipt/);
  receipts.decide(dinner.id, 'match', { transaction_id: s2.id }, T);

  receipts.decide(dinner.id, 'unmatch', {}, T);
  receipts.reconcile(T);
  assert.equal(receipts.get(dinner.id).status, 'waiting', 'an unmatched line is not matched again');
  assert.equal(receipts.suggestions(receipts.get(dinner.id)).length, 0);

  // Deleting the bank line frees its receipt.
  ledger.setStatus(s1.id, 'ignored');
  receipts.reconcile(T);
  assert.equal(receipts.get(cafe.id).status, 'waiting');
});

test('cash is never added again, a receipt the bank should already show is flagged, and reading again keeps his decision', async () => {
  const q = fakeQueue();
  const cash = await receipt(q, receiptReading({ shop: 'Market stall', paid_by: 'cash', total: 12, items: [] }), 1);
  assert.equal(cash.status, 'cash');
  let s = receipts.standing(T);
  assert.deepEqual([s.waitingCount, s.month.cashCount, s.month.cash], [0, 1, 1200], 'counted as cash taken out, not as spending or waiting');

  const old = await receipt(q, receiptReading({ shop: 'Boots', date: day(-14), total: 9.99, items: [] }), 2);
  const fresh = await receipt(q, receiptReading({ shop: 'Lidl', date: day(-1), total: 30, items: [] }), 3);
  s = receipts.standing(T);
  assert.deepEqual([s.missingCount, s.expectedCount], [0, 2], 'with no bank lines held, nothing is "not found"');
  await bank(q, [line(day(-1), 'SPAR', -5)], 1);
  s = receipts.standing(T);
  assert.deepEqual([s.missingCount, s.missingTotal, s.expectedCount, s.expectedTotal], [1, 999, 1, 3000], 'Boots is due on the uploads; Lidl is not yet');
  assert.ok(s.waiting.find(r => r.id === old.id).missing);
  assert.ok(!s.waiting.find(r => r.id === fresh.id).missing);
  assert.deepEqual(receipts.health(T).map(h => h.text), ['1 receipt not found on your bank uploads']);
  assert.match(receipts.summary().lines.join(' '), /€39\.99 on 2 receipts waiting for the bank\. 1 receipt not found/);

  receipts.decide(old.id, 'dismiss', {}, T);
  ledger.retry(old.upload_id, { jobs: q });
  q.answer(receiptReading({ shop: 'Boots', date: day(-14), total: 9.99, items: [] }));
  await ledger.tick({ jobs: q, t: T });
  const again = receipts.get(old.id);
  assert.deepEqual([again.status, again.decided_by], ['dismissed', 'you'], 'reading again never undoes his decision');
  assert.equal(receipts.standing(T).missingCount, 0);
});

test('a receipt with no date uses the upload day and is marked; a non-receipt is refused politely; a PDF receipt is checked against its text', async () => {
  const q = fakeQueue();
  const undated = await receipt(q, receiptReading({ date: null, total: 7.5, items: [{ description: 'Sandwich', amount: 5, category: 'Eating out' }] }), 1);
  assert.equal(undated.bought_on, TODAY);
  assert.equal(undated.unsure, 1); assert.match(undated.why_unsure, /no date is printed, so the day it was uploaded is used/);
  assert.match(ledger.upload(undated.upload_id).note, /The items add up to €5\.00, not the total of €7\.50/);

  const { id } = await receipts.addReceipt({ buffer: png(9), filename: 'screen.png' }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer({ readable: false, reason: 'This is a banking app screen, not a receipt.', transactions: [], receipt: null });
  await ledger.tick({ jobs: q, t: T });
  assert.deepEqual([ledger.upload(id).status, ledger.upload(id).error], ['empty', 'This is a banking app screen, not a receipt.']);
  assert.ok(receipts.screen(T).reading.some(u => u.id === id));

  await assert.rejects(receipts.addReceipt({ buffer: Buffer.from('Date,Description,Amount\n1,2,3\n'), filename: 'x.csv' }, T), err => err.polite && /x\.csv is not a photo \(PNG, JPEG or WebP\) or a PDF of a receipt/.test(err.message));
  await assert.rejects(receipts.addReceipt({ buffer: png(1), filename: 'again.jpg' }, T), err => err.polite && /already uploaded/.test(err.message));

  const wrong = ledger.addUpload({ buffer: png(77), filename: 'IMG_1.jpg', account: 'Revolut' }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer({ readable: false, reason: 'This is a till receipt, not a list of bank transactions.', transactions: [] });
  await ledger.tick({ jobs: q, t: T });
  assert.equal(ledger.upload(wrong.id).status, 'empty');
  const moved = await receipts.addReceipt({ buffer: png(77), filename: 'IMG_1.jpg' }, T);
  assert.ok(moved.id, 'a receipt first put in with the bank uploads, and refused there, can be uploaded as a receipt');

  const pdf = await makePdf([[50, 50, 'Synthetic Online Shop'], [50, 70, 'Order total'], [300, 70, '€64.99'], [50, 90, 'Paid by Visa ending 4821']]);
  const { id: pid } = await receipts.addReceipt({ buffer: pdf, filename: 'order.pdf' }, T);
  await ledger.tick({ jobs: q, t: T });
  const sent = q.sent.at(-1).payload;
  assert.equal(sent.documents[0].type, 'document');
  assert.match(sent.userPrompt, /<<<RECEIPT\n[\s\S]*Order total\s+€64\.99[\s\S]*RECEIPT>>>/);
  q.answer(receiptReading({ shop: 'Synthetic Online Shop', total: 69.99, items: [] }));
  await ledger.tick({ jobs: q, t: T });
  const r = db.crm().prepare('SELECT * FROM money_receipts WHERE upload_id = ?').get(pid);
  assert.equal(r.unsure, 1); assert.match(r.why_unsure, /€69\.99 is not in the receipt as written/);
});

test('a receipt reply passes the Mac worker\'s check for this feature', async () => {
  const script = path.join(tmp, 'claude-receipt');
  fs.writeFileSync(script, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.stringify({type:'result',result:${JSON.stringify(JSON.stringify(receiptReading()))}}));});\n`, { mode: 0o755 });
  process.env.CLAUDE_CLI_PATH = script;
  const r = await agent.runSubscriptionText({ feature: 'crm_money_read', systemPrompt: receipts.PROMPT, userPrompt: 'Read the attached receipt.', force: true, timeoutMs: 10000,
    config: { ...resolveFeatureRunner('crm_money_read'), feature: 'crm_money_read' }, documents: [{ type: 'image', mime: 'image/png', data: png(1).toString('base64') }] });
  assert.equal(r.runner, 'claude');
  assert.equal(receipts.parse(r.text ?? r.output, { today: TODAY, uploaded: TODAY }).shop, 'Tesco');
});

test('bank uploads: the app\'s day and the statement\'s settled day pair up, and another page of the same file cannot pair with the same line', async () => {
  const q = fakeQueue();
  await bank(q, [line(day(-6), 'Tesco', -42.1, { merchant: 'Tesco' })], 1, 'Test current');
  const lines = [`${day(-4)},VDP-TESCO STORES 5821,-42.10`, ...Array.from({ length: 79 }, (_, i) => `${day(-8)},SHOP ${i},-1.00`), `${day(-3)},VDP-TESCO STORES 5821,-42.10`];
  const { ids } = await ledger.addFile({ buffer: Buffer.from(`Date,Description,Amount\n${lines.join('\n')}\n`), filename: 'x.csv', account: 'Test current' }, T);
  assert.equal(ids.length, 2, 'two parts');
  await ledger.tick({ jobs: q, t: T });
  q.answer(bankReading([line(day(-4), 'VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco' }), ...Array.from({ length: 79 }, (_, i) => line(day(-8), `SHOP ${i}`, -1))]), q.sent.at(-2).jobId);
  q.answer(bankReading([line(day(-3), 'VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco' })]), q.sent.at(-1).jobId);
  await ledger.tick({ jobs: q, t: T });
  const tesco = txs().filter(x => x.merchant === 'Tesco');
  assert.deepEqual(tesco.map(x => x.posted_on), [day(-6), day(-3)], 'the app\'s line two days before the statement\'s is the same payment; the second Tesco on the other part is new');
  assert.match(ledger.upload(ids[0]).note, /1 line matched one already held from another kind of upload \(same amount and shop, within 4 days\)/);
});

test('the screens: Receipts with its running total and a suggestion, the Overview line, the upload form', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = new Proxy({ adminUser: 'douglas' }, { set(t, k, v) { if (k === 'crmFlash' && v) flashes.push(v); t[k] = v; return true; } }); next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const empty = await (await fetch(`${base}/crm/personal/money/receipts`)).text();
    assert.match(empty, /No receipts yet/); assert.match(empty, /aria-current="page">Receipts</);
    assert.equal((await fetch(`${base}/crm/work/money/receipts`)).status, 404);

    const form = new FormData();
    form.append('receipts', new Blob([png(5)]), 'till.png'); form.append('receipts', new Blob([Buffer.from('a,b\n1,2\n')]), 'x.csv');
    const r = await fetch(`${base}/crm/personal/money/receipts/upload`, { method: 'POST', redirect: 'manual', headers: { Origin: base }, body: form });
    assert.equal(r.status, 302);
    assert.match(flashes.pop().text, /^1 receipt uploaded\. The Mac is reading it.*x\.csv is not a photo/);
    const jobs = require('../lib/subscription-agent-jobs');
    const j = jobs.claim({ workerId: 'test' }).jobs[0];
    assert.equal(j.payload.systemPrompt, receipts.PROMPT);
    await jobs.complete({ jobId: j.id, claimToken: j.claim_token, output: JSON.stringify(receiptReading({ shop: '<b>Cafe</b>', total: 18.5, date: day(-2) })), meta: { runner: 'claude', model: 'sonnet' } });
    await ledger.tick();
    const q = fakeQueue();
    await bank(q, [line(day(-1), 'SQ *BEAN', -18.5, { merchant: 'Bean' })], 1);

    const page = await (await fetch(`${base}/crm/personal/money/receipts`)).text();
    assert.match(page, /Waiting for the bank/); assert.match(page, /€18\.50/);
    assert.match(page, /Is this it\?/); assert.match(page, /Same amount; the bank names the shop differently/);
    assert.match(page, /&lt;b&gt;Cafe&lt;\/b&gt;/, 'escaped');
    assert.match(page, /Bank lines held up to: AIB current/);
    const overview = await (await fetch(`${base}/crm/personal/money`)).text();
    assert.match(overview, /1 receipt \(€18\.50\)<\/a> from this month is not on a bank upload yet/);
    assert.match(overview, /<h2>Receipts<\/h2>/);
    assert.doesNotMatch(overview, /till\.png/, 'receipts are not listed with bank uploads');

    const rec = all()[0], sug = receipts.suggestions(rec)[0];
    const yes = await fetch(`${base}/crm/personal/money/receipts/${rec.id}/match`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `transaction_id=${sug.id}` });
    assert.equal(yes.status, 302); assert.equal(yes.headers.get('location'), `/crm/personal/money/receipts#receipt-${rec.id}`);
    assert.equal(receipts.get(rec.id).status, 'matched');
    const after = await (await fetch(`${base}/crm/personal/money/receipts`)).text();
    assert.match(after, /Matched \(latest 1\)/); assert.match(after, /Matched by you\./);
    const { id: failed } = await receipts.addReceipt({ buffer: png(77), filename: 'blurry.jpg' }, T);
    db.crm().prepare("UPDATE money_uploads SET status = 'failed', error = 'The Mac could not read it' WHERE id = ?").run(failed);
    const cashRec = await receipt(fakeQueue(), receiptReading({ shop: 'Chipper', paid_by: 'cash', total: 9, items: [] }), 78);
    const more = await (await fetch(`${base}/crm/personal/money/receipts`)).text();
    assert.match(more, /blurry\.jpg <span class="pill neg">Could not be read/); assert.match(more, /The Mac could not read it/); assert.match(more, /Read again/);
    assert.match(more, /Cash and set aside \(1\)/); assert.match(more, /Paid in cash\. Not added to spending/);
    assert.match(more, /1 receipt could not be read: The Mac could not read it/, 'the failure shows at the top');
    receipts.decide(cashRec.id, 'delete', {}, T);
    db.crm().prepare('DELETE FROM money_uploads WHERE id = ?').run(failed);
    const del = await fetch(`${base}/crm/personal/money/receipts/${rec.id}/delete`, { method: 'POST', redirect: 'manual', headers: { Origin: base } });
    assert.equal(del.status, 302);
    assert.deepEqual([all().length, db.crm().prepare("SELECT COUNT(*) n FROM money_uploads WHERE source = 'receipt'").get().n], [0, 0]);
  } finally { server.close(); }
});

test('a pocket in another currency is counted in euro at the rate of his own exchanges, and is not added again by a later statement', async () => {
  const q = fakeQueue(), X = { kind: 'transfer' };
  // The pound page is read before the euro page that holds the other side of each exchange.
  await bank(q, [
    line(day(-9), 'Exchanged to GBP', 50, { ...X, currency: 'GBP' }), line(day(-8), 'Co-op', -5.55, { currency: 'GBP' }), line(day(-8), 'Greggs', -2.7, { currency: 'gbp' }),
    line(day(-3), 'Exchanged to EUR', -0.05, { ...X, currency: 'GBP' }), line(day(-3), 'Exchanged to EUR', -40, { ...X, currency: 'GBP' }), line(day(-2), 'Post Office', -10, { currency: 'GBP' }),
    line(day(-2), 'Openrouter', -9.59, { currency: 'USD' }),
  ], 1, 'Revolut');
  let rows = txs();
  assert.ok(rows.every(r => r.currency !== 'EUR' && r.fx_cents === r.amount_cents), 'nothing is converted before a rate is known');
  assert.match(rows.find(r => r.description === 'Co-op').why_unsure, /Amount is in GBP and no exchange on this account shows a rate/);

  await bank(q, [line(day(-9), 'Exchanged to GBP', -57.92, X), line(day(-3), 'Exchanged to EUR', 46.09, X), line(day(-3), 'Exchanged to EUR', 0.05, X), line(day(-1), 'Tesco', -12)], 2, 'Revolut');
  await ledger.tick({ jobs: q, t: T });
  rows = txs();
  const by = d => rows.filter(r => r.description === d).map(r => [r.amount_cents, r.currency, r.fx_cents]);
  assert.deepEqual(by('Exchanged to GBP'), [[5792, 'EUR', 5000], [-5792, 'EUR', null]], 'an exchange takes its own euro figure');
  assert.deepEqual(by('Exchanged to EUR'), [[-5, 'EUR', -5], [-4609, 'EUR', -4000], [4609, 'EUR', null], [5, 'EUR', null]], 'two exchanges on one day pair by size');
  assert.deepEqual(by('Co-op'), [[Math.round(-555 * 5792 / 5000), 'EUR', -555]], 'a purchase takes the nearest exchange rate');
  assert.deepEqual([rows.find(r => r.description === 'Co-op').unsure, rows.find(r => r.description === 'Co-op').why_unsure], [0, ''], 'the "no rate yet" flag goes once there is a rate');
  assert.deepEqual(by('Post Office'), [[Math.round(-1000 * 4609 / 4000), 'EUR', -1000]], 'the rate from a five cent exchange is not used');
  assert.deepEqual(by('Openrouter'), [[-959, 'USD', -959]], 'a currency with no exchange stays as read, and says so');
  assert.match(rows.find(r => r.description === 'Openrouter').why_unsure, /Amount is in USD/);

  const before = rows.length;
  await bank(q, [line(day(-8), 'Co-op', -5.55, { currency: 'GBP' }), line(day(-2), 'Post Office', -10, { currency: 'GBP' })], 3, 'Revolut');
  assert.equal(txs().length, before, 'the same pound lines on a later statement are recognised by the figure the bank showed');

  const coop = txs().find(r => r.description === 'Co-op');
  ledger.updateTx(coop.id, { category: 'Groceries' }, T);
  assert.equal(ledger.dupKey('Revolut', coop.posted_on, -555, 'Co-op'), txs().find(r => r.id === coop.id).dup_key, 'correcting a converted line keeps it recognisable');
  const usd = txs().find(r => r.description === 'Openrouter');
  ledger.updateTx(usd.id, { amount: '-8.24' }, T);
  const typed = txs().find(r => r.id === usd.id);
  assert.deepEqual([typed.amount_cents, typed.currency], [-824, 'EUR'], 'an amount he types is euro');
  assert.equal((await ledger.tick({ jobs: q, t: T })).fx, undefined, 'nothing is left to convert');
});

test('a pound or dollar figure in a statement passes the check against the file text', () => {
  const files = require('../lib/crm/money/files');
  const held = files.amountsIn('Mar 14, 2026  Co-op  £5.55  £10.45\nApr 23  Openrouter  $9.59  1,234.50GBP');
  assert.ok(held.has(555) && held.has(959) && held.has(123450));
});
