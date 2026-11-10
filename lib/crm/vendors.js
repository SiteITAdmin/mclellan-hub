'use strict';

// The Vendor bucket: salespeople and suppliers who write to Douglas but are not
// people he keeps up with. Like "Not a person", nothing they send is read and
// they are never offered for review again; unlike it, they are listed and can be
// taken back out.

const { crm, now } = require('./db');
const identity = require('./identity');
const config = require('./config');
const { normEmail } = require('./text');
const { PUBLIC_DOMAINS } = require('./orgs');

function domainOf(value) {
  return normEmail(value).split('@')[1] || '';
}

// A company domain that can be marked as a whole: not a public mail service, and not Douglas's own.
function companyDomain(value) {
  const d = domainOf(value);
  if (!d || PUBLIC_DOMAINS.has(d)) return '';
  const own = [...config.workAddresses(), ...config.personalAddresses()].map(domainOf);
  return own.includes(d) ? '' : d;
}

function markOne(kind, value, name, space) {
  const sources = require('./sources');
  const v = identity.ignoreIdentifier(kind, value, name);
  if (!v) throw new Error(`Not a valid ${kind}: ${value}`);
  crm().prepare(`INSERT INTO vendors (kind, value, name, space, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, value) DO UPDATE SET name = excluded.name, space = excluded.space`).run(kind, v, name || '', space || null, now());
  if (kind === 'email') sources.releaseHeld(v, 'ignored');
  crm().prepare("UPDATE review_items SET status = 'decided', decision = ?, decided_at = ? WHERE item_key = ? AND status = 'open'")
    .run(JSON.stringify({ action: 'vendor' }), now(), sources.proposalKey(kind, v));
  return v;
}

// From the review screen. With wholeCompany, everyone else waiting at the same
// domain goes in too, and nobody new from it is asked about.
function mark({ kind = 'email', value, name = '', space = null, wholeCompany = false }) {
  const db = crm();
  let count = 0;
  let domain = '';
  db.transaction(() => {
    markOne(kind, value, name, space);
    count = 1;
    if (!wholeCompany || kind !== 'email') return;
    domain = companyDomain(value);
    if (!domain) throw new Error(`${domainOf(value) || 'That address'} is a public or own mail service, so it can't be marked as a whole company`);
    db.prepare('INSERT OR IGNORE INTO vendor_domains (domain, at) VALUES (?, ?)').run(domain, now());
    const waiting = db.prepare("SELECT * FROM review_items WHERE kind = 'person' AND status = 'open'").all()
      .map(r => ({ ...r, payload: JSON.parse(r.payload || '{}') }))
      .filter(r => r.payload.kind === 'email' && domainOf(r.payload.value) === domain);
    for (const r of waiting) { markOne('email', r.payload.value, r.payload.name, r.space); count += 1; }
  })();
  return { count, domain };
}

// Back out of the bucket: the address is unknown again and is offered for review
// straight away, with anything they sent held until Douglas decides.
function unmark(kind, value) {
  const sources = require('./sources');
  const db = crm();
  const v = kind === 'email' ? normEmail(value) : value;
  const row = db.prepare('SELECT * FROM vendors WHERE kind = ? AND value = ?').get(kind, v);
  if (!row) throw new Error('They are not in Vendors');
  let lifted = '';
  db.transaction(() => {
    db.prepare('DELETE FROM vendors WHERE kind = ? AND value = ?').run(kind, v);
    db.prepare("DELETE FROM identifiers WHERE kind = ? AND value = ? AND status = 'ignored'").run(kind, v);
    if (kind === 'email') {
      // While their company is marked they would never be offered again, so the company rule goes too.
      const d = domainOf(v);
      if (db.prepare('DELETE FROM vendor_domains WHERE domain = ?').run(d).changes) lifted = d;
      db.prepare(`UPDATE sources SET atomise_status = 'held' WHERE atomise_status = 'ignored' AND id IN (
        SELECT source_id FROM source_addresses WHERE kind = 'email' AND value = ? AND role = 'from')`).run(v);
    }
    sources.proposePerson({ kind, value: v, name: row.name, space: row.space || 'work', reason: 'You took them out of Vendors' });
  })();
  return { ...row, lifted };
}

function removeDomain(domain) {
  return crm().prepare('DELETE FROM vendor_domains WHERE domain = ?').run(String(domain || '').toLowerCase()).changes > 0;
}

function list() {
  const db = crm();
  const people = db.prepare(`
    SELECT v.*, (SELECT COUNT(DISTINCT source_id) FROM source_addresses a WHERE a.kind = v.kind AND a.value = v.value) AS sources
      FROM vendors v ORDER BY v.at DESC`).all()
    .map(v => ({ ...v, domain: v.kind === 'email' ? domainOf(v.value) : '' }));
  const domains = db.prepare('SELECT * FROM vendor_domains ORDER BY domain').all();
  return { people, domains };
}

function count() {
  return crm().prepare('SELECT COUNT(*) AS n FROM vendors').get().n;
}

module.exports = { mark, unmark, removeDomain, list, count, companyDomain };
