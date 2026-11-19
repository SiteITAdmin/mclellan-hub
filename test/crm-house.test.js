'use strict';

const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-house-'));
process.env.CRM_DB_PATH = path.join(dir, 'crm.db');
process.env.HUB_DB_PATH = path.join(dir, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';

const db = require('../lib/crm/db');
const house = require('../lib/crm/house');
const mail = require('../lib/crm/house/mail');
const queue = require('../lib/subscription-agent-jobs');
const BASE = '/crm/personal/house';
const T = Date.parse('2026-11-18T10:00:00Z') / 1000;
const ROWAN = 'https://www.daft.ie/for-sale/house-6-rowan-grove-bray/5100001';
const ELM = 'https://www.daft.ie/for-sale/house-8-elm-place-delgany/5100002';

beforeEach(() => {
  db._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
});

after(() => {
  db._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function capture(id, { body, links = [], thread = id, subject = 'House search', direction = 'received', at = T } = {}) {
  db.crm().prepare(`INSERT INTO house_mail
    (gmail_id, thread_id, subject, sender, occurred_at, body, links, direction, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, thread, subject, 'Property alerts <alerts@example.ie>', at, body, JSON.stringify(links), direction, at);
}

function fakeJobs() {
  const queue = new Map();
  return {
    enqueue(job) {
      const id = `job${queue.size + 1}`;
      queue.set(id, { ...job, id, status: 'pending' });
      return { jobId: id };
    },
    getJob(id) { return queue.get(id); },
    last() { return Array.from(queue.values()).at(-1); },
    finish(findings) {
      Object.assign(this.last(), { status: 'completed', result: { output: JSON.stringify({ findings }) } });
    },
    fail() {
      Object.assign(this.last(), { status: 'failed', error: 'Synthetic provider failure' });
    },
  };
}

function listing(title, url, askingPrice, quote) {
  return {
    kind: 'listing', title, status: 'received', quote,
    listing: { title, address: title, url, asking_price: askingPrice, beds: 3 },
  };
}

test('the purchase record keeps mortgage and solicitor milestones alongside property viewings and offers', () => {
  house.saveProperty({ title: '6 Rowan Grove', address: '6 Rowan Grove, Bray', url: ROWAN, asking_price: '410000', beds: '3', status: 'shortlisted' });
  const [property] = house.dashboard().properties;
  assert.equal(property.asking_price, 410000);
  house.saveEvent({ kind: 'mortgage', title: 'Approval in principle', status: 'approved', day: '2026-11-18', amount: '375000', person: 'Example Bank' });
  house.saveEvent({ kind: 'legal', title: 'Solicitor instructed', status: 'appointed', person: 'Example Solicitors' });
  house.saveEvent({ kind: 'viewing', title: 'Saturday viewing', status: 'confirmed', property_id: property.id, day: '2026-11-21', time: '14:30' });
  house.saveEvent({ kind: 'offer', title: 'First offer', status: 'submitted', property_id: property.id, amount: '405000' });

  const events = Object.fromEntries(house.dashboard().events.map(event => [event.kind, event]));
  assert.equal(events.mortgage.amount, 375000);
  assert.equal(events.legal.status, 'appointed');
  assert.equal(events.viewing.day, '2026-11-21');
  assert.equal(events.viewing.time, '14:30');
  assert.equal(events.offer.property_id, property.id);
  house.saveEvent({ ...events.offer, status: 'declined' }, events.offer.id);
  house.saveEvent({ kind: 'offer', title: 'Second offer', status: 'submitted', property_id: property.id, amount: '412000' });
  const offers = house.dashboard().events.filter(event => event.kind === 'offer');
  assert.equal(offers.length, 2);
  assert.equal(offers.find(event => event.id === events.offer.id).status, 'declined');
  assert.equal(offers.find(event => event.title === 'Second offer').amount, 412000);
});

test('one alert can suggest multiple houses, with source verification and an explicit review decision', async () => {
  const rowan = listing('6 Rowan Grove, Bray', ROWAN, 410000, '6 Rowan Grove, Bray — 3 beds — €410,000');
  const elm = listing('8 Elm Place, Delgany', ELM, 465000, '8 Elm Place, Delgany — 3 beds — €465,000');
  const body = `${rowan.quote}\n${ROWAN}\n\n${elm.quote}\n${ELM}`;
  const message = { id: 'alert1', threadId: 'alert-thread' };
  const gmail = { users: { messages: {
    async list() { return { data: { messages: [message] } }; },
    async get() {
      return { data: {
        ...message, internalDate: String(T * 1000), labelIds: ['INBOX'],
        payload: {
          headers: [{ name: 'From', value: 'Property alerts <alerts@daft.ie>' }, { name: 'Subject', value: 'Two new property alerts' }],
          mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') },
        },
      } };
    },
  } } };
  const receipt = await mail.scan({ gmail, t: T });
  assert.equal(receipt.captured, 1);
  await house.readTick({ t: T + 60 });
  const [job] = queue.claim({ workerId: 'synthetic-house-reader' }).jobs;
  assert.equal(job.feature, 'crm_house_mail');
  assert.match(job.payload.userPrompt, /5100001/);
  assert.match(job.payload.userPrompt, /5100002/);
  const findings = [rowan, elm, { ...elm, title: 'Fabricated evidence', quote: 'No such quote in the email' },
    listing('Unverified listing', 'https://www.daft.ie/for-sale/house-other/5100003', 465000, elm.quote)];
  const completed = await queue.complete({ jobId: job.id, claimToken: job.claim_token, output: JSON.stringify({ findings }) });
  assert.equal(completed.ok, true);
  await house.readTick({ t: T + 120 });

  const review = house.dashboard();
  assert.equal(review.properties.length, 0);
  assert.equal(review.events.length, 0);
  assert.equal(review.suggestions.length, 2);
  const pendingRowan = review.suggestions.find(item => item.listing.url === ROWAN);
  const pendingElm = review.suggestions.find(item => item.listing.url === ELM);
  assert.equal(pendingRowan.gmail_id, 'alert1');
  assert.equal(pendingRowan.quote, rowan.quote);
  house.accept(pendingRowan.id);
  house.dismiss(pendingElm.id);

  const confirmed = house.dashboard();
  assert.equal(confirmed.suggestions.length, 0);
  assert.deepEqual(confirmed.properties.map(p => [p.url, p.asking_price]), [[ROWAN, 410000]]);
  assert.equal(confirmed.events.find(event => event.gmail_id === 'alert1').property_id, confirmed.properties[0].id);
  assert.equal(db.crm().prepare('SELECT body FROM house_mail WHERE gmail_id = ?').get('alert1').body, null);
  assert.equal(queue.getJob(job.id).result, null);
});

test('outbound solicitor outreach is found as a request and a later reply sees the pending thread context', async () => {
  const contact = 'Avery Quinn <avery@example.ie>';
  const owner = 'Douglas <douglas@mclellan.scot>';
  const request = 'We’re buying an apartment and would like a quote for handling the legal work.';
  const confirmation = 'We confirm that we have been instructed and will act for you.';
  const threadId = 'legal-thread';
  const intro = { id: 'outreach', threadId };
  const reply = { id: 'engagement', threadId };
  const unrelated = { id: 'unrelated', threadId: 'unrelated-thread' };
  const messages = [intro];
  const fetched = [];
  const gmail = { users: { messages: {
    async list({ q }) {
      if (!q.includes('from:daft.ie')) return { data: { messages } };
      const findsOutreach = /\(in:sent \{[^}]*"buying an apartment"/.test(q) && !q.includes('-in:sent');
      return { data: { messages: findsOutreach ? [intro] : [] } };
    },
    async get({ id }) {
      fetched.push(id);
      const sent = id === intro.id;
      const body = sent ? request : `${confirmation}\n\nOn Wednesday, Douglas wrote:\n${request}`;
      return { data: {
        id, threadId, internalDate: String((sent ? T : T + 900) * 1000), labelIds: [sent ? 'SENT' : 'INBOX'],
        payload: {
          headers: [
            { name: 'From', value: sent ? owner : contact }, { name: 'To', value: sent ? contact : owner },
            { name: 'Subject', value: sent ? 'Could you send me a quote?' : 'Re: Could you send me a quote?' },
          ],
          mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') },
        },
      } };
    },
  } } };
  assert.equal((await mail.scan({ gmail, t: T })).captured, 1);
  const jobs = fakeJobs();
  await house.readTick({ jobs, t: T + 60 });
  const prompt = jobs.last().payload;
  const packet = JSON.parse(prompt.userPrompt);
  assert.equal(packet.message.direction, 'sent');
  assert.equal(packet.message.recipients, contact);
  assert.match(prompt.systemPrompt, /first outreach[^.]*status requested/i);
  assert.match(prompt.systemPrompt, /appointed only when engagement is confirmed/i);
  jobs.finish([{ kind: 'legal', title: 'Solicitor quote requested', status: 'requested', person: 'Avery Quinn', quote: request }]);
  await house.readTick({ jobs, t: T + 120 });
  assert.deepEqual(house.dashboard().suggestions.map(item => [item.status, item.source_direction]), [['requested', 'sent']]);

  messages.push(reply, unrelated);
  assert.equal((await mail.scan({ gmail, t: T + 900 })).captured, 1);
  assert.deepEqual(fetched, [intro.id, reply.id]);
  await house.readTick({ jobs, t: T + 960 });
  const followup = JSON.parse(jobs.last().payload.userPrompt);
  assert.equal(followup.message.body, confirmation);
  assert.deepEqual(followup.earlier_thread_findings.map(item => [item.state, item.status, item.quote]), [['suggested', 'requested', request]]);
  jobs.finish([{ kind: 'legal', title: 'Solicitor engagement confirmed', status: 'appointed', person: 'Avery Quinn', quote: confirmation }]);
  await house.readTick({ jobs, t: T + 1020 });
  assert.deepEqual(house.dashboard().suggestions.map(item => [item.gmail_id, item.status]), [[reply.id, 'appointed'], [intro.id, 'requested']]);
});

test('an alert seen again leaves one property while a changed asking price remains reviewable', async () => {
  house.saveProperty({ title: '6 Rowan Grove, Bray', url: ROWAN, asking_price: '410000', status: 'shortlisted' });
  const jobs = fakeJobs();
  const expected = listing('6 Rowan Grove, Bray', ROWAN, 395000, '6 Rowan Grove, Bray — 3 beds — now €395,000');
  capture('price-change', { body: expected.quote, links: [ROWAN] });
  await house.readTick({ jobs, t: T + 60 });
  jobs.finish([expected]);
  await house.readTick({ jobs, t: T + 120 });
  const before = house.dashboard();
  assert.equal(before.suggestions.length, 1);
  assert.equal(before.properties[0].asking_price, 410000);
  assert.equal(before.suggestions[0].property_id, before.properties[0].id);
  house.accept(before.suggestions[0].id);
  const accepted = house.dashboard();
  assert.equal(accepted.properties.length, 1);
  assert.equal(accepted.properties[0].asking_price, 395000);
  assert.equal(accepted.properties[0].status, 'shortlisted');

  capture('repeat-alert', { body: expected.quote, links: [ROWAN], at: T + 180 });
  await house.readTick({ jobs, t: T + 240 });
  jobs.finish([expected]);
  await house.readTick({ jobs, t: T + 300 });
  assert.equal(house.dashboard().suggestions.length, 0);
});

test('listing figures belong to their own quoted property and Daft can supply addresses without direct links', async () => {
  const jobs = fakeJobs();
  const quote = '6 Rowan Grove, Bray — 3 beds — €410,000';
  db.crm().prepare(`INSERT INTO house_mail
    (gmail_id, subject, sender, occurred_at, body, captured_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('opaque', 'Daft sale alert', 'Daft <alerts@daft.ie>', T, `${quote}\n8 Elm Place, Delgany — €465,000`, T);
  await house.readTick({ jobs, t: T + 60 });
  jobs.finish([listing('6 Rowan Grove, Bray', '', 465000, quote)]);
  await house.readTick({ jobs, t: T + 120 });
  const [suggestion] = house.dashboard().suggestions;
  assert.equal(suggestion.listing.asking_price, null);
  assert.equal(suggestion.listing.beds, 3);
  house.accept(suggestion.id);
  assert.equal(house.dashboard().properties[0].address, '6 Rowan Grove, Bray');
});

test('confirming a rescheduled viewing keeps the previous date in property history', async () => {
  house.saveProperty({ title: '6 Rowan Grove, Bray', address: '6 Rowan Grove', url: ROWAN });
  const [property] = house.dashboard().properties;
  house.saveEvent({ kind: 'viewing', title: 'Viewing at Rowan Grove', status: 'confirmed', property_id: property.id, day: '2026-11-21', time: '14:30' });
  const [original] = house.dashboard().events;
  const jobs = fakeJobs();
  const quote = 'Your viewing at 6 Rowan Grove has moved to 15:00 on 22 November 2026.';
  const received = original.occurred_at + 60;
  capture('viewing-moved', { body: quote, subject: 'Updated viewing time', at: received });
  await house.readTick({ jobs, t: received + 60 });
  jobs.finish([{
    kind: 'viewing', title: 'Viewing at Rowan Grove', status: 'confirmed', property_id: property.id,
    day: '2026-11-22', time: '15:00', replaces_id: original.id, quote,
  }]);
  await house.readTick({ jobs, t: received + 120 });
  const [suggestion] = house.dashboard().suggestions;
  assert.ok(suggestion);
  house.accept(suggestion.id, { property_id: property.id, replace_id: original.id });

  const current = house.dashboard();
  assert.deepEqual(current.events.map(event => [event.day, event.time, event.gmail_id]), [['2026-11-22', '15:00', 'viewing-moved']]);
  assert.ok(current.history.some(event => event.id === original.id && event.day === '2026-11-21' && event.superseded_at));
});

test('reader failures are visible and retry the original evidence', async () => {
  const jobs = fakeJobs();
  const at = Math.floor(Date.now() / 1000);
  const quote = 'Please arrange a call to discuss your mortgage application.';
  capture('mortgage-mail', { body: quote, at });
  for (let n = 0; n < 6 && !house.dashboard().mail.failed; n++) {
    await house.readTick({ jobs, t: at + n * 60 });
    if (jobs.last()?.status === 'pending') jobs.fail();
  }
  const stopped = house.dashboard();
  assert.equal(stopped.mail.failed, 1);
  assert.ok(stopped.mail.error);
  assert.equal(stopped.suggestions.length, 0);
  house.retryMail();
  assert.equal(house.dashboard().mail.waiting, 1);
  await house.readTick({ jobs, t: at + 400 });
  assert.match(jobs.last().payload.userPrompt, /discuss your mortgage application/);
  jobs.finish([{ kind: 'mortgage', title: 'Arrange a mortgage application call', status: 'requested', quote }]);
  await house.readTick({ jobs, t: at + 460 });
  assert.equal(house.dashboard().mail.failed, 0);
  assert.equal(house.dashboard().suggestions[0].gmail_id, 'mortgage-mail');
});

function serve({ signedIn = true } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  const session = signedIn ? { adminUser: 'douglas' } : {};
  app.use((req, res, next) => {
    req.portfolioUser = 'douglas';
    req.session = session;
    next();
  });
  app.use(require('../routes/crm'));
  const server = app.listen(0);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('house pages and write forms require the signed-in Personal workspace and same-origin posts', async () => {
  const denied = serve({ signedIn: false });
  const owner = serve();
  try {
    const anonymous = await fetch(denied.origin + BASE, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.get('location'), '/admin/login');
    const work = await fetch(owner.origin + '/crm/work/house');
    assert.equal(work.status, 404);

    const property = new URLSearchParams({ title: '6 Rowan Grove', url: ROWAN, asking_price: '410000', status: 'shortlisted' });
    const rejected = await fetch(owner.origin + `${BASE}/properties`, {
      method: 'POST', headers: { origin: 'https://elsewhere.example' }, body: property, redirect: 'manual',
    });
    assert.equal(rejected.status, 403);
    assert.equal(house.dashboard().properties.length, 0);

    const submit = async (endpoint, fields) => {
      const res = await fetch(owner.origin + BASE + endpoint, {
        method: 'POST', headers: { origin: owner.origin }, body: new URLSearchParams(fields), redirect: 'manual',
      });
      assert.ok([302, 303].includes(res.status), await res.text());
    };
    await submit('/properties', property);
    const [saved] = house.dashboard().properties;
    assert.equal(saved.title, '6 Rowan Grove');
    await submit('/entry', {
      title: 'Saturday viewing', property_id: saved.id, kind: 'viewing', status: 'confirmed', day: '2026-11-21', time: '14:30',
    });
    const page = await fetch(owner.origin + `${BASE}/properties/${saved.id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /6 Rowan Grove/);
    assert.match(html, /Saturday viewing/);
    assert.match(html, /14:30/);

    await submit('/properties', { title: '8 Elm Place', url: ELM, asking_price: '465000', status: 'researching' });
    const second = house.dashboard().properties.find(p => p.url === ELM);
    const comparison = new URL(`${BASE}/properties`, owner.origin);
    comparison.searchParams.append('compare', saved.id);
    comparison.searchParams.append('compare', second.id);
    const compared = await fetch(comparison);
    assert.equal(compared.status, 200);
    const comparisonHtml = await compared.text();
    assert.match(comparisonHtml, /Property comparison/);
    assert.match(comparisonHtml, /410,000/);
    assert.match(comparisonHtml, /465,000/);

    const jobs = fakeJobs();
    const quote = 'We confirm that we are instructed as your solicitor on the purchase.';
    capture('solicitor-mail', { body: quote, subject: 'Conveyancing for your purchase' });
    await house.readTick({ jobs, t: T + 60 });
    jobs.finish([{ kind: 'legal', title: 'Solicitor instructed', status: 'appointed', quote }]);
    await house.readTick({ jobs, t: T + 120 });
    const [suggestion] = house.dashboard().suggestions;
    const mailPage = await fetch(owner.origin + `${BASE}/mail`);
    assert.equal(mailPage.status, 200);
    const mailHtml = await mailPage.text();
    assert.match(mailHtml, /Solicitor instructed/);
    assert.match(mailHtml, /mail\.google\.com[^" ]*\/solicitor-mail/);
    await submit(`/mail/${suggestion.id}/accept`, { property_id: saved.id });
    assert.equal(house.dashboard().events.find(event => event.gmail_id === 'solicitor-mail').property_id, saved.id);

    for (const link of ['', '/properties', '/viewings-offers', '/purchase', '/mail', '/entry/new']) {
      const section = await fetch(owner.origin + BASE + link);
      assert.equal(section.status, 200, link || BASE);
    }
  } finally {
    denied.server.close();
    owner.server.close();
  }
});
