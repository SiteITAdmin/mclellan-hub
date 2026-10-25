'use strict';

// Organisations, one space each, like people. A person belongs to at most one
// organisation. Email domains let the Hub suggest the organisation for a new
// person; the link itself is always Douglas's decision.

const { crm } = require('./db');
const { uuid } = require('../id');
const { normName, normEmail } = require('./text');
const identity = require('./identity');

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'live.ie', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.ie', 'eircom.net', 'protonmail.com', 'proton.me']);

function get(id) {
  return crm().prepare('SELECT * FROM organisations WHERE id = ?').get(id) || null;
}

function createOrg(space, name) {
  if (!['work', 'personal'].includes(space)) throw new Error(`bad space: ${space}`);
  const clean = String(name || '').trim();
  const n = normName(clean);
  if (!n) throw new Error('An organisation needs a name');
  const existing = crm().prepare('SELECT * FROM organisations WHERE space = ? AND name_norm = ?').get(space, n);
  if (existing) return existing;
  const id = uuid();
  crm().prepare('INSERT INTO organisations (id, space, name, name_norm) VALUES (?, ?, ?, ?)').run(id, space, clean, n);
  identity.log('add_org', null, { orgId: id, space, name: clean });
  return get(id);
}

function rename(id, name) {
  const org = get(id);
  if (!org) throw new Error('No such organisation');
  const clean = String(name || '').trim();
  const n = normName(clean);
  if (!n) throw new Error('An organisation needs a name');
  const clash = crm().prepare('SELECT name FROM organisations WHERE space = ? AND name_norm = ? AND id != ?').get(org.space, n, id);
  if (clash) throw new Error(`${clash.name} already exists in this space`);
  crm().prepare('UPDATE organisations SET name = ?, name_norm = ? WHERE id = ?').run(clean, n, id);
}

function cleanDomain(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^.*@/, '').replace(/^www\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

function addDomain(orgId, domain) {
  const org = get(orgId);
  if (!org) throw new Error('No such organisation');
  const d = cleanDomain(domain);
  if (!d) throw new Error(`Not a domain: ${domain}`);
  if (PUBLIC_DOMAINS.has(d)) throw new Error(`${d} is a public email service; anyone can have an address there`);
  const owner = crm().prepare('SELECT o.name FROM org_domains x JOIN organisations o ON o.id = x.org_id WHERE x.space = ? AND x.domain = ?').get(org.space, d);
  if (owner) {
    if (owner.name === org.name) return d;
    throw new Error(`${d} already belongs to ${owner.name}`);
  }
  crm().prepare('INSERT INTO org_domains (org_id, space, domain) VALUES (?, ?, ?)').run(orgId, org.space, d);
  return d;
}

function removeDomain(orgId, domain) {
  return crm().prepare('DELETE FROM org_domains WHERE org_id = ? AND domain = ?').run(orgId, cleanDomain(domain)).changes > 0;
}

function orgForEmail(space, email) {
  const d = normEmail(email).split('@')[1] || '';
  if (!d) return null;
  return crm().prepare('SELECT o.* FROM org_domains x JOIN organisations o ON o.id = x.org_id WHERE x.space = ? AND x.domain = ?').get(space, d) || null;
}

// The form sends either an existing organisation's id or a new name.
function resolveChoice(space, { orgId, orgName }) {
  if (orgId === 'none') return null;
  if (orgId) {
    const org = get(orgId);
    if (!org || org.space !== space) throw new Error('That organisation is in the other space');
    return org;
  }
  if (String(orgName || '').trim()) return createOrg(space, orgName);
  return undefined;
}

function setPersonOrg(personId, org) {
  const person = crm().prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error('No such person');
  if (org && org.space !== person.space) throw new Error('A person and their organisation must be in the same space');
  crm().prepare('UPDATE people SET org_id = ?, updated_at = unixepoch() WHERE id = ?').run(org ? org.id : null, personId);
  identity.log('set_org', personId, { orgId: org ? org.id : null });
}

function list(space) {
  return crm().prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM people p WHERE p.org_id = o.id) AS people,
      (SELECT group_concat(domain, ', ') FROM org_domains x WHERE x.org_id = o.id) AS domains
      FROM organisations o WHERE o.space = ? ORDER BY o.name COLLATE NOCASE
  `).all(space);
}

module.exports = { get, createOrg, rename, addDomain, removeDomain, orgForEmail, resolveChoice, setPersonOrg, list, cleanDomain, PUBLIC_DOMAINS };
