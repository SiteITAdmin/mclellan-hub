'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-vendors-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db'); process.env.HUB_DB_PATH = path.join(tmp, 'hub.db'); process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const review = require('../lib/crm/review');
const sources = require('../lib/crm/sources');
const identity = require('../lib/crm/identity');
const vendors = require('../lib/crm/vendors');
let n = 0;
beforeEach(() => { db._reset(); fs.rmSync(process.env.CRM_DB_PATH, { force: true }); n = 0; });
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });

function mail(from, name, title = 'Webinar follow-up') {
  return sources.admitSource({ space: 'work', kind: 'email', origin: 'outlook', externalId: `m${++n}`, title, occurredAt: db.now() - n,
    text: 'Hi Douglas, I noticed you declined the webinar invite.', participants: [{ role: 'from', email: from, name }, { role: 'to', email: 'douglas.mclellan@example.ie' }],
    proposeFrom: 'from', holdUnknownSender: true }).source;
}
const itemFor = v => db.crm().prepare("SELECT * FROM review_items WHERE item_key = ? AND status = 'open'").get(sources.proposalKey('email', v));
const status = id => db.crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(id).atomise_status;

test('Vendor takes someone out of Who is this?, sets their mail aside, and lists them', () => {
  const s = mail('hannah.colley@flowforma.com', 'Hannah Colley');
  assert.equal(status(s.id), 'held');
  const item = itemFor('hannah.colley@flowforma.com');
  const r = review.decide(item.id, { action: 'vendor' });
  assert.deepEqual(r, { vendors: 1, domain: '' });
  assert.equal(itemFor('hannah.colley@flowforma.com'), undefined);
  assert.equal(status(s.id), 'ignored');
  assert.equal(identity.isIgnored('email', 'hannah.colley@flowforma.com'), true);
  const s2 = mail('hannah.colley@flowforma.com', 'Hannah Colley', 'Second chase');
  assert.equal(status(s2.id), 'ignored');
  assert.equal(itemFor('hannah.colley@flowforma.com'), undefined, 'never asked about again');
  const { people } = vendors.list();
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'Hannah Colley');
  assert.equal(people[0].space, 'work');
  assert.equal(people[0].sources, 2);
  assert.equal(identity.isIgnored('email', 'someone.else@flowforma.com'), false, 'only her, unless the whole company is marked');
});

test('the whole company goes in, with everyone already waiting there, and nobody new is asked about', () => {
  mail('hannah.colley@flowforma.com', 'Hannah Colley');
  const other = mail('sam.ryan@flowforma.com', 'Sam Ryan');
  mail('real.person@client.ie', 'Real Person');
  const r = review.decide(itemFor('hannah.colley@flowforma.com').id, { action: 'vendor', wholeCompany: true });
  assert.deepEqual(r, { vendors: 2, domain: 'flowforma.com' });
  assert.equal(itemFor('sam.ryan@flowforma.com'), undefined);
  assert.equal(status(other.id), 'ignored');
  assert.ok(itemFor('real.person@client.ie'), 'other companies untouched');
  const later = mail('new.rep@flowforma.com', 'New Rep');
  assert.equal(status(later.id), 'ignored');
  assert.equal(itemFor('new.rep@flowforma.com'), undefined);
  assert.deepEqual(vendors.list().domains.map(d => d.domain), ['flowforma.com']);
});

test('someone already known at a vendor company is not affected', () => {
  const p = identity.createPerson({ space: 'work', name: 'Known Contact' });
  identity.linkIdentifier(p.id, 'email', 'known@flowforma.com');
  mail('hannah.colley@flowforma.com', 'Hannah Colley');
  review.decide(itemFor('hannah.colley@flowforma.com').id, { action: 'vendor', wholeCompany: true });
  assert.equal(identity.isIgnored('email', 'known@flowforma.com'), false);
  assert.equal(status(mail('known@flowforma.com', 'Known Contact').id), 'pending');
});

test('a public mail service or Douglas’s own domain cannot be marked as a whole company', () => {
  mail('salesperson@gmail.com', 'Salesperson');
  assert.throws(() => review.decide(itemFor('salesperson@gmail.com').id, { action: 'vendor', wholeCompany: true }), /public or own/);
  assert.ok(itemFor('salesperson@gmail.com'), 'nothing changed when it is refused');
  assert.equal(vendors.list().people.length, 0);
  assert.equal(vendors.companyDomain('a@gmail.com'), '');
  assert.equal(vendors.companyDomain('a@mclellan.scot'), '');
  assert.equal(vendors.companyDomain('a@flowforma.com'), 'flowforma.com');
});

test('Not a vendor puts them back in Who is this? with their mail held, and lifts the company rule', () => {
  const s = mail('hannah.colley@flowforma.com', 'Hannah Colley');
  review.decide(itemFor('hannah.colley@flowforma.com').id, { action: 'vendor', wholeCompany: true });
  const r = vendors.unmark('email', 'Hannah.Colley@flowforma.com');
  assert.equal(r.lifted, 'flowforma.com');
  assert.equal(status(s.id), 'held');
  const item = itemFor('hannah.colley@flowforma.com');
  assert.ok(item);
  assert.equal(item.space, 'work');
  assert.equal(JSON.parse(item.payload).name, 'Hannah Colley');
  assert.equal(identity.isIgnored('email', 'hannah.colley@flowforma.com'), false);
  assert.equal(vendors.list().people.length, 0);
  assert.equal(vendors.list().domains.length, 0);
  review.decide(item.id, { action: 'new', name: 'Hannah Colley', space: 'work' });
  assert.equal(status(s.id), 'pending', 'deciding releases the held mail for reading');
  assert.throws(() => vendors.unmark('email', 'hannah.colley@flowforma.com'), /not in Vendors/);
});
