'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-knowledge-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const identity = require('../lib/crm/identity');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const documents = require('../lib/crm/documents');
const agentmail = require('../lib/crm/agentmail');
const ask = require('../lib/crm/ask');

const NOW = Math.floor(Date.parse('2026-11-10T09:00:00Z') / 1000);
const DAY = 86400;
let n = 0;

function pdf(pages) {
  return new Promise(resolve => {
    const doc = new (require('pdfkit'))(), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    pages.forEach((p, i) => { if (i) doc.addPage(); if (p) doc.text(p); });
    doc.end();
  });
}
function person(space, name, email, org = null) {
  const id = `p${++n}`;
  let orgId = null;
  if (org) {
    orgId = db.crm().prepare('SELECT id FROM organisations WHERE space = ? AND name = ?').get(space, org)?.id || `o${++n}`;
    db.crm().prepare('INSERT OR IGNORE INTO organisations (id, space, name, name_norm) VALUES (?, ?, ?, ?)').run(orgId, space, org, org.toLowerCase());
  }
  db.crm().prepare('INSERT INTO people (id, space, name, org_id) VALUES (?, ?, ?, ?)').run(id, space, name, orgId);
  identity.linkIdentifier(id, 'email', email);
  return id;
}

beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a PDF report becomes a readable source; the same file twice is one source; a scan says why it was not read', async () => {
  const file = await pdf(['Internal audit report. Finding one: access reviews were not completed for the finance system in Q3.', 'Finding two: leavers kept their accounts for up to 30 days.']);
  const r = await documents.admitFile({ space: 'work', buffer: file, name: 'Access audit Q3.pdf' });
  assert.equal(r.readable, true);
  assert.equal(r.sources.length, 1);
  assert.deepEqual([r.sources[0].kind, r.sources[0].origin, r.sources[0].title, r.sources[0].atomise_status], ['report', 'upload', 'Access audit Q3.pdf', 'pending']);
  assert.match(r.sources[0].text, /Finding one[\s\S]*Finding two/);
  assert.equal((await documents.admitFile({ space: 'work', buffer: file, name: 'Access audit Q3.pdf' })).created, false);
  const scan = await documents.admitFile({ space: 'work', buffer: await pdf(['']), name: 'Scanned letter.pdf' });
  assert.deepEqual([scan.readable, scan.reason, scan.sources[0].atomise_status], [false, 'No text in this PDF (it is probably a scan)', 'skipped']);
  const odd = await documents.admitFile({ space: 'work', buffer: Buffer.from('x'), name: 'deck.pptx' });
  assert.match(odd.reason, /can't read \.pptx files yet/);
  const other = await documents.admitFile({ space: 'personal', buffer: file, name: 'Access audit Q3.pdf' });
  assert.equal(other.sources[0].space, 'personal');
  assert.notEqual(other.sources[0].id, r.sources[0].id);
});

test('a long document is read in parts, cut at paragraph ends, without dropping the remainder', async () => {
  const para = `${'This paragraph is about the rollout and says enough to be worth keeping. '.repeat(20)}\n\n`;
  const text = para.repeat(40);
  const parts = documents.split(text.trim());
  assert.ok(parts.length >= 3 && parts.every(p => p.length <= documents.PART));
  assert.equal(parts.join('').replace(/\s/g, '').length, text.replace(/\s/g, '').length);
  const r = await documents.admitFile({ space: 'personal', buffer: Buffer.from(text), name: 'notes.txt' });
  assert.equal(r.sources.length, parts.length);
  assert.equal(r.sources[1].title, `notes.txt (part 2 of ${parts.length})`);
  const huge = await documents.admitFile({ space: 'personal', buffer: Buffer.from(para.repeat(400)), name: 'huge.txt' });
  assert.equal(huge.sources.length, documents.split(para.repeat(400).trim()).length);
  assert.equal(huge.unread, 0);
});

test('the forwarding inbox: space from Douglas\'s own address, strangers held, old mail and mail not involving Douglas left out', async () => {
  person('work', 'Ken Murray', 'ken.murray@beaconhospital.ie');
  const report = await pdf(['Quarterly licence report: 500 seats are in use across the organisation today.']);
  const iso = daysAgo => new Date((NOW - daysAgo * DAY) * 1000).toISOString();
  const store = {
    '<fwd1>': { message_id: '<fwd1>', labels: ['received'], timestamp: iso(1), from: 'Douglas McLellan <douglas@mclellan.scot>', to: ['mclellanhub@agentmail.to'], subject: 'Fwd: Car insurance renewal',
      text: 'Keep this one. The renewal is due on 14 November 2026.', attachments: [{ attachment_id: 'a1', filename: 'Licences.pdf', size: report.length }] },
    '<cc1>': { message_id: '<cc1>', labels: ['received'], timestamp: iso(2), from: 'Ken Murray <ken.murray@beaconhospital.ie>', to: ['Douglas McLellan <douglas.mclellan@beaconhospital.ie>'], cc: ['mclellanhub@agentmail.to'], subject: 'Infrastructure projects', text: 'The firewall change goes ahead on Friday.' },
    '<stranger>': { message_id: '<stranger>', labels: ['received'], timestamp: iso(2), from: 'Unknown <someone@elsewhere.example>', to: ['douglas@mclellan.scot', 'mclellanhub@agentmail.to'], subject: 'Hello', text: 'You do not know me yet but here is a proposal.', attachments: [{ attachment_id: 'a2', filename: 'x.pdf', size: 10 }] },
    '<spam>': { message_id: '<spam>', labels: ['received'], timestamp: iso(1), from: 'Spam <spam@elsewhere.example>', to: ['mclellanhub@agentmail.to'], subject: 'Buy now', text: 'Nothing to do with Douglas.' },
    '<sent>': { message_id: '<sent>', labels: ['sent'], timestamp: iso(1), from: 'mclellanhub@agentmail.to', to: ['douglas@mclellan.scot'], subject: 'Old Hub report', text: 'x' },
    '<old>': { message_id: '<old>', labels: ['received'], timestamp: iso(9), from: 'Douglas McLellan <douglas@mclellan.scot>', to: ['mclellanhub@agentmail.to'], subject: 'Too old', text: 'An old forward that must not create work.' },
  };
  const got = [];
  const api = { list: async () => ({ messages: Object.values(store).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)) }), get: async id => store[id],
    attachment: async (id, att) => { got.push(att); return report; } };
  const d = await agentmail.run({ api, t: NOW });
  assert.deepEqual(d, { seen: 4, captured: 3, files: 1, skipped: 1 });
  const rows = db.crm().prepare("SELECT space, kind, title, direction, atomise_status FROM sources WHERE origin = 'agentmail' ORDER BY title").all();
  assert.deepEqual(rows.map(r => Object.values(r).join('|')), [
    'personal|email|Fwd: Car insurance renewal|out|pending',
    'personal|email|Hello|in|held',
    'work|email|Infrastructure projects|in|pending',
    'personal|report|Licences.pdf|out|pending',
  ]);
  assert.deepEqual(got, ['a1']);
  assert.equal(sources.openProposal('email', 'someone@elsewhere.example').payload.includes('copied in your Hub address'), true);
  assert.deepEqual(await agentmail.run({ api, t: NOW + 900 }), { seen: 4, captured: 0, files: 0, skipped: 1 });
  assert.equal(db.crm().prepare("SELECT COUNT(*) AS n FROM sources WHERE origin = 'agentmail'").get().n, 4);
});

test('"Who do I know at X?" is answered from people and facts, and only lines that cite them are kept', () => {
  const jane = person('work', 'Jane Whelan', 'jane@stripe.example', 'Stripe');
  person('work', 'Alec Smith', 'alec@beacon.example', 'Beacon Hospital');
  person('personal', 'Private Friend', 'pf@stripe.example', 'Stripe');
  const s = sources.admitSource({ space: 'work', kind: 'email', origin: 'gmail', externalId: 'm1', title: 'Payments', occurredAt: NOW - DAY, direction: 'in',
    text: 'Jane Whelan leads the payments risk team at Stripe.', participants: [{ email: 'jane@stripe.example', role: 'from', name: 'Jane Whelan' }] }).source;
  atoms.applyAtoms(s.id, [{ statement: 'Jane Whelan leads the payments risk team at Stripe', kind: 'fact', quote: 'Jane Whelan leads the payments risk team at Stripe', people: ['Jane Whelan'], topics: ['payments'], confidence: 'high' }]);
  assert.equal(ask.looksLikeQuestion('Who do I know at Stripe?'), true);
  assert.equal(ask.looksLikeQuestion('Purview'), false);
  const c = ask.candidates('work', 'Who do I know at Stripe?');
  assert.deepEqual([c.people.map(p => p.name), c.facts.length], [['Jane Whelan'], 1]);

  let job = { status: 'pending' };
  const queued = [];
  const jobs = { enqueue: j => { queued.push(j); return { jobId: 'j1' }; }, getJob: () => job };
  const q = ask.ask('work', 'Who do I know at Stripe?', { jobs, t: NOW });
  assert.equal(q.status, 'waiting');
  assert.match(queued[0].payload.userPrompt, /\[P1\] Jane Whelan, Stripe\. Last in touch 2026-11-09\./);
  assert.match(queued[0].payload.userPrompt, /\[F1\] 2026-11-09 fact: Jane Whelan leads the payments risk team at Stripe/);
  assert.doesNotMatch(queued[0].payload.userPrompt, /Private Friend|Alec/);
  assert.equal(ask.ask('work', 'Who do I know at Stripe?', { jobs, t: NOW + 60 }).id, q.id);
  assert.equal(queued.length, 1);
  assert.equal(ask.collect(q, { jobs, t: NOW + 60 }).status, 'waiting');
  assert.equal(ask.collect(q, { jobs, t: NOW + 1500 }).slow, true);

  job = { status: 'completed', result: { output: 'Here you go: {"lines":[{"text":"Jane Whelan leads payments risk at Stripe.","people":["P1"],"facts":["F1"]},{"text":"Stripe is a large company.","people":[],"facts":[]},{"text":"Made up.","people":["P9"],"facts":["F9"]}]}' } };
  const done = ask.shown(ask.collect(q, { jobs, t: NOW + 90 }));
  assert.equal(done.status, 'done');
  assert.deepEqual(done.lines.map(l => [l.text, l.people.map(p => p.id), l.sources.map(x => x.id)]), [['Jane Whelan leads payments risk at Stripe.', [jane], [s.id]]]);

  const nothing = ask.ask('work', 'Who do I know at Zyxwvut?', { jobs, t: NOW });
  assert.deepEqual([nothing.status, nothing.answer, queued.length], ['done', '[]', 1]);
  job = { status: 'failed', error: 'usage_limit_reached' };
  const failed = ask.collect(ask.ask('work', 'What does Jane Whelan lead?', { jobs, t: NOW }), { jobs, t: NOW + 5 });
  assert.deepEqual([failed.status, failed.error], ['failed', 'usage_limit_reached']);
});

test('attachments use the signed download URL without leaking the API credential', async () => {
  const old = [process.env.AGENTMAIL_API_KEY, process.env.AGENTMAIL_INBOX_ID];
  process.env.AGENTMAIL_API_KEY = 'fake-key'; process.env.AGENTMAIL_INBOX_ID = 'test@agentmail.to';
  const calls = [];
  try {
    const api = agentmail.live(async (url, opts) => {
      calls.push({ url, opts });
      return url.startsWith('https://api.agentmail.to/')
        ? Response.json({ download_url: 'https://cdn.agentmail.to/test-file', size: 5 })
        : new Response('hello');
    });
    assert.equal((await api.attachment('<m>', 'a')).toString(), 'hello');
    assert.match(calls[0].opts.headers.Authorization, /fake-key/);
    assert.equal(calls[1].opts.headers, undefined);
  } finally {
    for (const [i, key] of ['AGENTMAIL_API_KEY', 'AGENTMAIL_INBOX_ID'].entries()) {
      if (old[i] == null) delete process.env[key]; else process.env[key] = old[i];
    }
  }
});

test('a failed attachment retries even when the mail is already saved; held mail releases its files after approval', async () => {
  const m = { message_id: '<retry>', labels: ['received'], timestamp: new Date((NOW - DAY) * 1000).toISOString(),
    from: 'Douglas <douglas@mclellan.scot>', to: ['mclellanhub@agentmail.to'], subject: 'Report', text: 'Please remember this report.',
    attachments: [{ attachment_id: 'one', filename: 'report.txt', size: 90 }] };
  let fails = true;
  const api = { list: async () => ({ messages: [m] }), get: async () => m, attachment: async () => {
    if (fails) throw new Error('temporary download failure');
    return Buffer.from('The security report recommends reviewing privileged accounts every quarter.');
  } };
  await assert.rejects(agentmail.run({ api, t: NOW }), /temporary/);
  fails = false;
  assert.equal((await agentmail.run({ api, t: NOW })).files, 1);
  assert.equal((await agentmail.run({ api, t: NOW })).files, 0);
  m.message_id = '<held>'; m.from = 'New Person <new@example.org>'; m.to = ['douglas@mclellan.scot'];
  assert.equal((await agentmail.run({ api, t: NOW })).files, 0);
  person('personal', 'New Person', 'new@example.org');
  sources.releaseHeld('new@example.org', 'linked');
  assert.equal((await agentmail.run({ api, t: NOW })).files, 1);
});

test('upload and answer pages enforce the owner and space, escape source text, and handle upload limits', async () => {
  const app = require('express')();
  let signedIn = true;
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, '..', 'views'));
  app.use(require('express').urlencoded({ extended: true }));
  app.use((req, res, next) => { req.portfolioUser = 'douglas'; req.session = { adminUser: signedIn ? 'douglas' : null }; next(); });
  app.use(require('../routes/crm'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = async (count, origin = base) => {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append('files', new Blob(['<script>alert(1)</script> The access review for this quarter is complete.']), `report${i}.txt`);
    return fetch(`${base}/crm/work/upload`, { method: 'POST', headers: { Origin: origin }, body: form, redirect: 'manual' });
  };
  try {
    const r = await upload(1);
    assert.equal(r.status, 302);
    const html = await (await fetch(base + r.headers.get('location'))).text();
    assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>alert/);
    assert.equal((await upload(6)).headers.get('location'), '/crm/work/note');
    assert.equal((await upload(1, 'https://elsewhere.example')).status, 403);
    const q = ask.ask('personal', 'Who do I know at Nowhere?');
    const search = await (await fetch(`${base}/crm/work/search?ask=${q.id}`)).text();
    assert.doesNotMatch(search, /Who do I know at Nowhere/);
    signedIn = false;
    assert.equal((await upload(1)).headers.get('location'), '/admin/login');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
