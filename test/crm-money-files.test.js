'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-money-files-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const ledger = require('../lib/crm/money/ledger');
const files = require('../lib/crm/money/files');
const { dublinDay, addDays } = require('../lib/crm/money/common');
const agent = require('../lib/subscription-agent');
const { resolveFeatureRunner } = require('../lib/feature-runners');
const PDFKit = require('pdfkit');
const cliKeys = ['CLAUDE_CLI_PATH', 'CODEX_CLI_PATH', 'GROK_CLI_PATH'];
const cliBefore = Object.fromEntries(cliKeys.map(k => [k, process.env[k]]));
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); });
after(() => { db._reset(); for (const k of cliKeys) cliBefore[k] === undefined ? delete process.env[k] : process.env[k] = cliBefore[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

const T = Math.floor(Date.now() / 1000), TODAY = dublinDay(T), D1 = addDays(TODAY, -3), D2 = addDays(TODAY, -2);

function png(seed = 0) {
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(2, 0); head.writeUInt32BE(2, 4); head[8] = 8; head[9] = 2;
  const pixels = Buffer.from([0, seed & 255, (seed >> 8) & 255, 90, 255, 255, 255, 0, 20, 20, 20, 200, 200, 200]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

// A synthetic statement: each page is a list of [x, y, text] placed where a bank would print it.
function makePdf(pages, opts = {}) {
  return new Promise(resolve => {
    const doc = new PDFKit({ autoFirstPage: false, ...opts }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    for (const lines of pages) { doc.addPage(); for (const [x, y, t] of lines) doc.fontSize(10).text(t, x, y, { lineBreak: false }); }
    doc.end();
  });
}
const statementPage = [[50, 50, 'Synthetic Bank statement 1 Oct 2026 to 31 Oct 2026'], [50, 80, 'Date'], [120, 80, 'Details'], [350, 80, 'Paid out'], [430, 80, 'Paid in'], [500, 80, 'Balance'],
  [50, 100, '03 Oct'], [120, 100, 'VDP-TESCO STORES 5821'], [350, 100, '42.10'], [500, 100, '1,957.90'], [50, 115, '04 Oct'], [120, 115, 'SALARY ACME'], [430, 115, '2,500.00'], [500, 115, '4,457.90']];
const termsPage = [[50, 50, 'Terms and conditions apply to every account we hold for you.'], [50, 70, 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'],
  [50, 90, 'Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure.']];

function fakeQueue() {
  const q = { sent: [], jobs: {}, enqueue(x) { const jobId = `job${q.sent.length + 1}`; q.sent.push({ ...x, jobId }); q.jobs[jobId] = { id: jobId, status: 'pending', created_at: T }; return { jobId }; },
    getJob: id => q.jobs[id] || null,
    answer(reading, jobId = q.sent.at(-1).jobId) { q.jobs[jobId] = { id: jobId, status: 'completed', created_at: T, result: { output: JSON.stringify(reading), meta: { runner: 'claude', model: 'sonnet' } } }; } };
  return q;
}
const line = (description, amount, more = {}) => ({ date: D1, description, merchant: description, amount, kind: amount > 0 ? 'income' : 'spend', category: 'Other', pending: false, unsure: false, why_unsure: '', ...more });
const reading = transactions => ({ readable: true, reason: '', account_hint: '', period: { from: D1, to: D1 }, transactions });
const rows = () => db.crm().prepare('SELECT * FROM money_transactions ORDER BY rowid').all();
const uploadsOf = () => db.crm().prepare('SELECT * FROM money_uploads ORDER BY rowid').all();

const csv = (n, extra = '') => ['Synthetic Bank export,,,', 'Account,Test current,,', 'Type,Started Date,Description,Amount,Fee,Currency,State,Balance',
  ...Array.from({ length: n }, (_, i) => `CARD_PAYMENT,${D1} 10:${String(i % 60).padStart(2, '0')}:00,Shop ${i},-${(i + 1)}.50,0.00,EUR,COMPLETED,${1000 - i}.00`), extra].filter(Boolean).join('\r\n');

test('CSV: cut into runs under the header, a bank preamble left out, quoted line breaks kept, binary and huge files refused', () => {
  const cut = files.csvParts(Buffer.from(`﻿${csv(170)}`));
  assert.equal(cut.total, 170);
  assert.deepEqual(cut.parts.map(p => [p.from, p.to]), [[1, 80], [81, 160], [161, 170]]);
  for (const p of cut.parts) assert.ok(p.text.startsWith('Type,Started Date,Description,Amount'), 'every part starts with the header row');
  assert.doesNotMatch(cut.parts[0].text, /Synthetic Bank export|Account,Test current/);
  const quoted = files.csvParts(Buffer.from('Date,Description,Amount\n03/10/2026,"CAFE\nDUBLIN",-4.50\n04/10/2026,SHOP,-1.00\n'));
  assert.deepEqual([quoted.total, quoted.parts[0].text.split('\n').length], [2, 4], 'a line break inside quotes does not start a new line');
  assert.equal(files.csvParts(Buffer.from('just one line, nothing else')), null);
  assert.equal(files.csvParts(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2])), null, 'a zip (xlsx) is not CSV');
  assert.throws(() => files.csvParts(Buffer.from(csv(5001))), err => err.polite && /5001 lines; the most one upload can take is 5000/.test(err.message));
  const long = files.csvParts(Buffer.from(['Date,Description,Amount', ...Array.from({ length: 30 }, (_, i) => `03/10/2026,${'X'.repeat(900)}${i},-1.00`)].join('\n')));
  assert.ok(long.parts.length > 1 && long.parts.every(p => p.text.length < 14000), 'long lines cut a part short of 80 lines');
});

test('an amount is found however the bank writes it, and not inside another number', () => {
  const page = 'Paid 1,234.56 and 4.5 and 12,30 and 1.000,00 and €7.25 42.10DR (3.00) -8.80 and 99';
  for (const cents of [-123456, 450, 1230, 100000, 725, 4210, 300, 880, -9900]) assert.equal(files.amountIn(page, cents), true, String(cents));
  for (const cents of [23456, 3456, 12345, 2500, 9800, 5600]) assert.equal(files.amountIn(page, cents), false, String(cents));
  // In a CSV the comma is a column break: "-42.1,0.00" is two amounts, and "*4821,200" is a reference and 200.
  const sheet = 'Type,Description,Amount,Fee,Balance\nCARD,Tesco,-42.1,0.00,957.90\nTOPUP,Top-Up by *4821,200,0.50,"1,157.90"\nCARD,Cafe;Bar,-4.5,0.00,1153.40';
  for (const cents of [-4210, 20000, 50, 115790, -450, 95790]) assert.equal(files.amountIn(sheet, cents, { csv: true }), true, String(cents));
  for (const cents of [482120, 15790, 4200]) assert.equal(files.amountIn(sheet, cents, { csv: true }), false, String(cents));
  const semi = 'Datum;Omschrijving;Bedrag\n03-11-2026;Albert;-1.234,56';
  assert.equal(files.amountIn(semi, 123456, { csv: true }), true, 'semicolon files with decimal commas');
  assert.equal(files.hasAmounts('no money here 2026'), false);
});

test('PDF: one part per page with its text in columns; a page without amounts is not sent; a password stops it politely', async () => {
  const pages = await files.pdfPages(await makePdf([statementPage, termsPage]));
  assert.equal(pages.length, 2);
  assert.ok(pages[0].bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  const [head, tesco, salary] = pages[0].text.split('\n').slice(1);
  assert.equal(tesco.indexOf('42.10'), head.indexOf('Paid out'), 'money out sits under Paid out');
  assert.equal(salary.indexOf('2,500.00'), head.indexOf('Paid in'), 'money in sits under Paid in');
  assert.equal(files.hasAmounts(pages[1].text), false);
  await assert.rejects(files.pdfPages(await makePdf([statementPage], { userPassword: 'x', ownerPassword: 'y', pdfVersion: '1.7' })), err => err.polite && /password-protected/.test(err.message));
  const locked = await files.pdfPages(await makePdf([statementPage], { ownerPassword: 'y', pdfVersion: '1.7', permissions: { printing: 'lowResolution' } }));
  assert.deepEqual([locked[0].bytes, /VDP-TESCO/.test(locked[0].text)], [null, true], 'a statement that opens without a password but cannot be split goes as text');
  await assert.rejects(files.pdfPages(Buffer.from('%PDF-1.7 not really')), /could not be opened as a PDF/);
  await assert.rejects(files.pdfPages(await makePdf(Array.from({ length: 31 }, () => termsPage))), /31 pages; the most one upload can take is 30/);
});

test('a PDF statement is read page by page: the page and its text go to the reader, and a figure not on the page is marked', async () => {
  const q = fakeQueue(), pdf = await makePdf([statementPage, termsPage]);
  const r = await ledger.addFile({ buffer: pdf, filename: 'october.pdf', account: 'Test current' }, T);
  assert.deepEqual([r.ids.length, r.parts], [2, 1]);
  const [p1, p2] = uploadsOf();
  assert.deepEqual([p1.source, p1.part, p1.status, p2.part, p2.status, p2.error], ['pdf', 'page 1 of 2', 'pending', 'page 2 of 2', 'empty', 'No amounts on this page, so it was not sent for reading.']);
  await assert.rejects(ledger.addFile({ buffer: pdf, filename: 'again.pdf', account: 'Test current' }, T), /again\.pdf was already uploaded/);

  await ledger.tick({ jobs: q, t: T });
  assert.equal(q.sent.length, 1);
  const sent = q.sent[0].payload;
  assert.deepEqual([sent.documents[0].type, sent.documents[0].mime], ['document', 'application/pdf']);
  assert.ok(Buffer.from(sent.documents[0].data, 'base64').equals(p1.image));
  assert.match(sent.userPrompt, /This is page 1 of 2 of a PDF bank statement \("october\.pdf"\)\. The page is attached\./);
  assert.match(sent.userPrompt, /<<<PAGE\n[\s\S]*VDP-TESCO STORES 5821[\s\S]*\nPAGE>>>/);
  assert.match(sent.systemPrompt, /one page of a bank statement/); assert.match(sent.systemPrompt, /balance brought forward/);

  q.answer(reading([line('VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco', category: 'Groceries' }), line('SALARY ACME', 2500), line('INVENTED', -13.37)]));
  await ledger.tick({ jobs: q, t: T });
  const held = rows();
  assert.deepEqual(held.map(x => [x.description, x.unsure]), [['VDP-TESCO STORES 5821', 0], ['SALARY ACME', 0], ['INVENTED', 1]]);
  assert.match(held[2].why_unsure, /-€13\.37 is not in the file as written/);
  assert.match(uploadsOf()[0].note, /1 amount could not be found in the file as written/);
  assert.equal(ledger.upload(p1.id).has_image, 1);
});

test('a CSV goes as text in parts; lines in different parts are never taken for overlaps, and reading a part again adds nothing', async () => {
  const q = fakeQueue();
  const body = ['Date,Description,Amount,Balance', ...Array.from({ length: 79 }, (_, i) => `${D1.split('-').reverse().join('/')},FILLER ${i},-1.${String(i).padStart(2, '0')},10.00`),
    `${D2.split('-').reverse().join('/')},COFFEE DOCK,-3.80,9.00`, `${D2.split('-').reverse().join('/')},COFFEE DOCK,-3.80,5.20`].join('\n');
  const r = await ledger.addFile({ buffer: Buffer.from(body), filename: 'export.csv', account: 'Test current' }, T);
  assert.equal(r.parts, 2);
  await ledger.tick({ jobs: q, t: T });
  assert.equal(q.sent.length, 2);
  const [a, b] = q.sent;
  assert.equal(a.payload.documents, undefined, 'a CSV is sent as text, with no attachment');
  assert.match(a.payload.userPrompt, /Below are lines 1–80 of 81 of a CSV file exported from his bank \("export\.csv"\)/);
  assert.match(b.payload.userPrompt, /<<<CSV\nDate,Description,Amount,Balance\n[^\n]*COFFEE DOCK,-3\.80,5\.20\nCSV>>>/);
  assert.match(b.payload.userPrompt, /Never use a balance column as an amount/);
  q.answer(reading([...Array.from({ length: 79 }, (_, i) => line(`FILLER ${i}`, -(100 + i) / 100)), line('COFFEE DOCK', -3.8, { date: D2 })]), a.jobId);
  q.answer(reading([line('COFFEE DOCK', -3.8, { date: D2 })]), b.jobId);
  await ledger.tick({ jobs: q, t: T });
  assert.equal(rows().filter(x => x.description === 'COFFEE DOCK').length, 2, 'the second coffee, in the next part, is its own line');
  assert.equal(rows().length, 81);
  const second = uploadsOf()[1];
  ledger.retry(second.id, { jobs: q });
  q.answer(reading([line('COFFEE DOCK', -3.8, { date: D2 })]));
  await ledger.tick({ jobs: q, t: T });
  assert.equal(rows().length, 81, 'reading the same part again adds nothing');
  assert.equal(ledger.upload(second.id).added, 0);
});

test('the same payment from a screenshot and a statement counts once; a different shop on the same day and amount does not', async () => {
  const q = fakeQueue();
  ledger.addUpload({ buffer: png(1), filename: 'shot.png', account: 'Test current' }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer(reading([line('Tesco', -42.1, { merchant: 'Tesco' }), line('Tesco', -42.1, { merchant: 'Tesco' })]));
  await ledger.tick({ jobs: q, t: T });
  const body = `Date,Description,Amount\n${D1},VDP-TESCO STORES 5821,-42.10\n${D1},VDP-TESCO STORES 5821,-42.10\n${D1},VDP-TESCO STORES 5821,-42.10\n${D1},CIRCLE K,-42.10\n`;
  await ledger.addFile({ buffer: Buffer.from(body), filename: 'x.csv', account: 'Test current' }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer(reading([...[1, 2, 3].map(() => line('VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco' })), line('CIRCLE K', -42.1, { merchant: 'Circle K' })]));
  await ledger.tick({ jobs: q, t: T });
  assert.deepEqual(rows().map(x => x.description), ['Tesco', 'Tesco', 'VDP-TESCO STORES 5821', 'CIRCLE K'], 'two Tesco lines were already held; the third and Circle K are new');
  const u = uploadsOf().at(-1);
  assert.deepEqual([u.found, u.added], [4, 2]);
  assert.match(u.note, /2 lines matched ones already held from another kind of upload/);
  await ledger.addFile({ buffer: Buffer.from(body.replace('Date', 'Date ')), filename: 'other-account.csv', account: 'Credit card' }, T);
  await ledger.tick({ jobs: q, t: T });
  q.answer(reading([line('VDP-TESCO STORES 5821', -42.1, { merchant: 'Tesco' })]));
  await ledger.tick({ jobs: q, t: T });
  assert.equal(rows().length, 5, 'another account is never a match');
});

test('the text leaves the queue when the job is over and goes from the Hub after 30 days; the reader takes a PDF page for money', async () => {
  const jobs = require('../lib/subscription-agent-jobs'), hub = require('../lib/db').hub();
  const { ids } = await ledger.addFile({ buffer: Buffer.from(`Date,Description,Amount\n${D1},SECRET SHOP,-9.99\n`), filename: 's.csv', account: 'A' }, T);
  await ledger.tick({ t: T });
  const claimed = jobs.claim({ workerId: 'test' }).jobs[0];
  assert.match(claimed.payload.userPrompt, /SECRET SHOP/);
  await jobs.complete({ jobId: claimed.id, claimToken: claimed.claim_token, output: JSON.stringify(reading([line('SECRET SHOP', -9.99)])), meta: { runner: 'claude', model: 'sonnet' } });
  assert.equal((await ledger.tick({ t: T })).scrubbed, 1);
  const payload = JSON.parse(hub.prepare('SELECT payload FROM subscription_agent_jobs WHERE id = ?').get(claimed.id).payload);
  assert.equal(payload.userPrompt, '(removed after reading)');
  assert.equal((await ledger.tick({ t: T })).scrubbed, 0, 'scrubbed once');
  assert.equal(ledger.image(ids[0]).text.includes('SECRET SHOP'), true);
  assert.equal((await ledger.tick({ t: T + 31 * 86400 })).purged, 1);
  assert.equal(ledger.image(ids[0]), null);
  assert.equal(db.crm().prepare('SELECT text FROM money_uploads WHERE id = ?').get(ids[0]).text, null);

  const page = (await files.pdfPages(await makePdf([statementPage])))[0].bytes.toString('base64');
  const script = path.join(tmp, 'claude-pdf');
  fs.writeFileSync(script, `#!${process.execPath}\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=JSON.parse(s).message.content;
    if(c[1].type!=='document'||c[1].source.media_type!=='application/pdf'||c[1].source.data!=='${page}')process.exit(2);
    console.log(JSON.stringify({type:'result',result:${JSON.stringify(JSON.stringify(reading([line('X', -1)])))}}));});\n`, { mode: 0o755 });
  process.env.CLAUDE_CLI_PATH = script;
  const r = await agent.runSubscriptionText({ feature: 'crm_money_read', systemPrompt: 'Return JSON.', userPrompt: 'Read the page.', force: true, timeoutMs: 10000,
    config: { ...resolveFeatureRunner('crm_money_read'), feature: 'crm_money_read' }, documents: [{ type: 'document', mime: 'application/pdf', data: page }] });
  assert.equal(r.runner, 'claude');
  const job = require('../lib/model').enqueueModelJob({ feature: 'crm_money_read', dedupeKey: 'pdf-ok', userPrompt: 'x', documents: [{ type: 'document', mime: 'application/pdf', data: page }] });
  assert.ok(job.jobId);
  hub.prepare('DELETE FROM subscription_agent_jobs WHERE id = ?').run(job.jobId);
});

test('the screens: a CSV and a PDF upload from the form, are listed by part, and open as text or as the page', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  const flashes = [];
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = new Proxy({ adminUser: 'douglas' }, { set(t, k, v) { if (k === 'crmFlash' && v) flashes.push(v); t[k] = v; return true; } }); next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = filesIn => {
    const form = new FormData(); form.append('account', 'Test current');
    for (const [name, bytes] of filesIn) form.append('images', new Blob([bytes]), name);
    return fetch(`${base}/crm/personal/money/upload`, { method: 'POST', redirect: 'manual', headers: { Origin: base }, body: form });
  };
  try {
    const r = await send([['export.csv', Buffer.from(`Date,Description,Amount\n${D1},<script>alert(1)</script>,-1.00\n`)], ['statement.pdf', await makePdf([statementPage, termsPage])], ['locked.pdf', await makePdf([statementPage], { userPassword: 'x', ownerPassword: 'y', pdfVersion: '1.7' })]]);
    assert.equal(r.status, 302);
    const said = flashes.pop();
    assert.match(said.text, /^2 files uploaded\. The Mac is reading them\b/); assert.match(said.text, /locked\.pdf is password-protected/);
    const page = await (await fetch(`${base}/crm/personal/money`)).text();
    assert.match(page, /Uploads \(3\)/); assert.match(page, /export\.csv, lines 1–1 of 1/); assert.match(page, /statement\.pdf, page 2 of 2/); assert.match(page, /No amounts on this page/);
    const [csvUp, pdfUp] = uploadsOf();
    const text = await fetch(`${base}/crm/personal/money/uploads/${csvUp.id}/image`);
    assert.deepEqual([text.headers.get('content-type'), text.headers.get('content-security-policy'), text.headers.get('x-content-type-options')], ['text/plain; charset=utf-8', 'sandbox', 'nosniff']);
    assert.match(await text.text(), /<script>alert\(1\)<\/script>/, 'served as inert text');
    const jobs = require('../lib/subscription-agent-jobs');
    for (let n = 0; n < 2; n++) {
      const j = jobs.claim({ workerId: 'test' }).jobs[0];
      await jobs.complete({ jobId: j.id, claimToken: j.claim_token, output: JSON.stringify(reading([j.payload.documents ? line('VDP-TESCO STORES 5821', -42.1) : line('<script>alert(1)</script>', -1)])), meta: { runner: 'claude', model: 'sonnet' } });
    }
    await ledger.tick();
    const checking = await (await fetch(`${base}/crm/personal/money`)).text();
    assert.match(checking, new RegExp(`<a class="money-file" href="/crm/personal/money/uploads/${pdfUp.id}/image"[^>]*><strong>statement\\.pdf</strong><span>page 1 of 2</span><span>Open this page</span>`));
    assert.match(checking, /These match the page/); assert.match(checking, /These match the file/); assert.match(checking, /Open these lines/);
    assert.match(checking, /As read: &lt;script&gt;/);
    const pdf = await fetch(`${base}/crm/personal/money/uploads/${pdfUp.id}/image`);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).equals(Buffer.from('%PDF-')));
  } finally { server.close(); }
});
