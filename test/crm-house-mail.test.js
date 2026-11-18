'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-house-mail-'));
process.env.CRM_DB_PATH = path.join(dir, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const mail = require('../lib/crm/house/mail');
const T = Date.parse('2026-11-18T11:00:00Z') / 1000;

beforeEach(() => {
  db._reset();
  fs.rmSync(process.env.CRM_DB_PATH, { force: true });
});
after(() => {
  db._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function part(mimeType, text) {
  return { mimeType, body: { data: Buffer.from(text).toString('base64url') } };
}

function message(id, { threadId = id, text = '', html = '', from = 'Agent <sales@example.ie>', to = 'douglas@mclellan.scot', label = 'INBOX', subject = 'Viewing', t = T } = {}) {
  return {
    id, threadId, internalDate: String(t * 1000), labelIds: [label],
    payload: {
      mimeType: 'multipart/alternative',
      headers: Object.entries({ From: from, To: to, Subject: subject }).map(([name, value]) => ({ name, value })),
      parts: [text && part('text/plain', text), html && part('text/html', html)].filter(Boolean),
    },
  };
}

function fakeGmail({ messages = [], match, next = '', errors = {} } = {}) {
  const queries = [];
  const gets = [];
  const summaries = list => list.map(({ id, threadId }) => ({ id, threadId }));
  return {
    queries,
    gets,
    users: { messages: {
      list: async ({ q, pageToken }) => {
        queries.push({ q, pageToken });
        const target = q.includes('from:daft.ie');
        return { data: { messages: summaries(target ? match || messages : messages), nextPageToken: target ? next : '' } };
      },
      get: async ({ id }) => {
        gets.push(id);
        if (errors[id]) throw errors[id];
        return { data: messages.find(message => message.id === id) };
      },
    } },
  };
}

const rows = () => db.crm().prepare('SELECT * FROM house_mail ORDER BY gmail_id').all();

test('a multipart Daft alert retains distinct listing links, including direct targets from tracking wrappers', async () => {
  const first = 'https://www.daft.ie/for-sale/tall-trees-wicklow/1234567';
  const second = 'https://www.daft.ie/for-sale/apartment/the-square/2345678';
  const redirect = `https://notify.example.ie/click?utm=mail&amp;url=${encodeURIComponent(second + '?utm_source=alert')}`;
  const alert = message('alert', {
    from: 'Daft <alerts@daft.ie>',
    subject: 'Two new properties',
    text: `Tall Trees, Wicklow €420,000\n${first}?utm=alert\nApartment, The Square €390,000`,
    html: `<a href="${first}#listing">Tall Trees, Wicklow</a><a href='${redirect}'>Apartment, The Square</a><a href="https://daft.ie/for-sale/tall-trees/1234567">See it</a><a href="https://daft.ie.evil.invalid/for-sale/not-a-listing/3456789">Unrelated</a>`,
  });
  const gmail = fakeGmail({ messages: [alert] });
  const r = await mail.scan({ gmail, t: T });
  assert.equal(r.captured, 1);
  const [saved] = rows();
  assert.deepEqual(JSON.parse(saved.links), [first, second]);
  assert.match(saved.body, /Apartment, The Square — https/);
  assert.equal(saved.status, 'waiting');
  assert.equal(mail.canonicalDaftUrl('https://example.ie/for-sale/tall-trees/1'), '');
  assert.equal(mail.canonicalDaftUrl('http://daft.ie/for-sale/tall-trees/1/?utm=x'), 'https://www.daft.ie/for-sale/tall-trees/1');
});

test('keywordless agent replies and sent offers in known threads are picked up without reading unrelated mail', async () => {
  const sent = message('sent', { threadId: 'sale', from: 'Douglas <douglas@mclellan.scot>', to: 'Agent <sales@example.ie>', label: 'SENT', text: 'I would like to make an offer on the property of €410,000.' });
  const unrelatedRoot = message('old', { threadId: 'other', text: 'What is the asking price for the car?' });
  await mail.scan({ gmail: fakeGmail({ messages: [sent, unrelatedRoot] }), t: T });
  db.crm().prepare(`INSERT INTO house_events (id, state, kind, title, gmail_id, occurred_at, updated_at)
    VALUES ('suggestion', 'suggested', 'offer', 'Offer sent', 'sent', ?, ?)`).run(T, T);
  db.crm().prepare("UPDATE house_mail SET status = 'read' WHERE gmail_id = 'old'").run();
  const reply = message('reply', { threadId: 'sale', text: 'Wednesday at 11 works.\n\nOn Tuesday, Douglas wrote:\nOlder offer text.' });
  const unrelated = message('unrelated', { threadId: 'other', text: 'Coffee at noon?' });
  const work = message('work', { to: 'douglas.mclellan@beaconhospital.ie', text: 'An unrelated work thread.' });
  const gmail = fakeGmail({ messages: [sent, reply, unrelated, work], match: [sent, work] });
  const r = await mail.tickScan({ gmail, t: T + 900 });
  assert.equal(r.captured, 1);
  assert.deepEqual(gmail.gets.sort(), ['reply', 'work']);
  assert.equal(rows()[1].body, 'Wednesday at 11 works.');
  assert.equal(rows()[2].direction, 'sent');
  assert.equal(rows()[2].recipients, 'Agent <sales@example.ie>');
  assert.equal(rows()[1].direction, 'received');
  assert.ok(gmail.queries.every(({ q }) => !q.includes('-in:sent')));
});

test('active addresses and Eircodes can make a terse new agent thread a search candidate', async () => {
  const save = db.crm().prepare('INSERT INTO house_properties (id, title, address, status, updated_at) VALUES (?, ?, ?, ?, ?)');
  save.run('one', 'Oak Road', '12 Oak Road, Wicklow, A67 F2K2', 'shortlisted', T);
  save.run('two', 'Old listing', '13 Pine Road, Wicklow', 'passed', T);
  const gmail = fakeGmail();
  await mail.scan({ gmail, t: T });
  assert.match(gmail.queries[0].q, /subject:"12 Oak Road"/);
  assert.match(gmail.queries[0].q, /"A67 F2K2"/);
  assert.doesNotMatch(gmail.queries[0].q, /Pine Road/);
});

test('Gmail page token is saved with its time window and transient fetch failures retry without refetching good mail', async () => {
  const one = message('one', { text: 'Mortgage application accepted.' });
  const two = message('two', { text: 'Mortgage valuation received.' });
  const three = message('three', { text: 'Mortgage drawdown confirmed.' });
  const first = fakeGmail({ messages: [one, two], next: 'page-two', errors: { two: new Error('Temporary Gmail error') } });
  const r = await mail.scan({ gmail: first, t: T });
  assert.equal(r.failed, 1);
  assert.match(mail.status().error, /could not be fetched/);
  const again = fakeGmail({ messages: [one, two], next: 'page-two' });
  await mail.tickScan({ gmail: again, t: T + 300 });
  assert.deepEqual(again.gets, ['two']);
  assert.deepEqual(again.queries[0], first.queries[0]);
  const continuation = fakeGmail({ messages: [three] });
  await mail.tickScan({ gmail: continuation, t: T + 600 });
  assert.deepEqual(continuation.queries[0], { q: first.queries[0].q, pageToken: 'page-two' });
  assert.equal(mail.status().lastSuccessAt, T + 600);
  assert.deepEqual(rows().map(row => row.gmail_id), ['one', 'three', 'two']);
});

test('failed list calls remain visible and requested scans respect a five-minute cooldown', async () => {
  const broken = fakeGmail();
  broken.users.messages.list = async () => { throw new Error('invalid_grant'); };
  await assert.rejects(mail.tickScan({ gmail: broken, t: T }), /Google connection/);
  assert.match(mail.status().error, /Google connection/);
  mail.requestScan(T + 1);
  const gmail = fakeGmail({ messages: [message('image-only')] });
  assert.equal(await mail.tickScan({ gmail, t: T + 299 }), null);
  assert.equal(gmail.queries.length, 0);
  assert.equal(mail.status().requestedAt, T + 1);
  const r = await mail.tickScan({ gmail, t: T + 300 });
  assert.equal(r.unreadable, 1);
  assert.equal(rows()[0].status, 'unreadable');
  assert.equal(mail.status().requestedAt, 0);
  assert.equal(mail.status().error, '');
});
