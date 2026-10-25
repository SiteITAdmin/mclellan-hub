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
  const newId = org ? org.id : null;
  // A department belongs to one organisation, so moving organisation clears it.
  const unit = newId === person.org_id ? person.unit_id : null;
  crm().prepare('UPDATE people SET org_id = ?, unit_id = ?, updated_at = unixepoch() WHERE id = ?').run(newId, unit, personId);
  identity.log('set_org', personId, { orgId: org ? org.id : null });
}

// ── Departments and teams ──────────────────────────────────────────────────

function getUnit(id) {
  return crm().prepare('SELECT * FROM org_units WHERE id = ?').get(id) || null;
}

function addUnit(orgId, { name, parentId = null }) {
  const org = get(orgId);
  if (!org) throw new Error('No such organisation');
  const clean = String(name || '').trim();
  const n = normName(clean);
  if (!n) throw new Error('A department or team needs a name');
  let kind = 'department';
  if (parentId) {
    const parent = getUnit(parentId);
    if (!parent || parent.org_id !== orgId) throw new Error('That department is in another organisation');
    if (parent.kind !== 'department') throw new Error('A team goes under a department');
    kind = 'team';
  }
  const clash = crm().prepare("SELECT 1 FROM org_units WHERE org_id = ? AND COALESCE(parent_id, '') = ? AND name_norm = ?").get(orgId, parentId || '', n);
  if (clash) throw new Error(`${clean} already exists there`);
  const id = uuid();
  crm().prepare('INSERT INTO org_units (id, org_id, parent_id, kind, name, name_norm) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, parentId || null, kind, clean, n);
  identity.log('add_unit', null, { orgId, unitId: id, kind, name: clean });
  return getUnit(id);
}

function renameUnit(id, name) {
  const u = getUnit(id);
  if (!u) throw new Error('No such department or team');
  const clean = String(name || '').trim();
  const n = normName(clean);
  if (!n) throw new Error('A department or team needs a name');
  const clash = crm().prepare("SELECT 1 FROM org_units WHERE org_id = ? AND COALESCE(parent_id, '') = ? AND name_norm = ? AND id != ?").get(u.org_id, u.parent_id || '', n, id);
  if (clash) throw new Error(`${clean} already exists there`);
  crm().prepare('UPDATE org_units SET name = ?, name_norm = ? WHERE id = ?').run(clean, n, id);
}

// Removing a team moves its people up to the department; removing a
// department moves its people (and its teams' people) up to the organisation.
function removeUnit(id) {
  const u = getUnit(id);
  if (!u) return 0;
  const db = crm();
  let moved = 0;
  db.transaction(() => {
    if (u.kind === 'team') {
      moved = db.prepare('UPDATE people SET unit_id = ? WHERE unit_id = ?').run(u.parent_id, id).changes;
    } else {
      moved = db.prepare('UPDATE people SET unit_id = NULL WHERE unit_id = ? OR unit_id IN (SELECT id FROM org_units WHERE parent_id = ?)').run(id, id).changes;
    }
    db.prepare('DELETE FROM org_units WHERE id = ?').run(id);
  })();
  identity.log('remove_unit', null, { orgId: u.org_id, unitId: id, name: u.name, moved });
  return moved;
}

function units(orgId) {
  const rows = crm().prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM people p WHERE p.unit_id = u.id) AS direct
      FROM org_units u WHERE u.org_id = ? ORDER BY u.name COLLATE NOCASE
  `).all(orgId);
  return rows.filter(r => r.kind === 'department').map(d => {
    const teams = rows.filter(t => t.parent_id === d.id);
    return { ...d, teams, people: d.direct + teams.reduce((n, t) => n + t.direct, 0) };
  });
}

// Every unit as one flat list for a picker: "IT", "IT › Help Desk".
function unitChoices(orgId) {
  const out = [];
  for (const d of units(orgId)) {
    out.push({ id: d.id, label: d.name });
    for (const t of d.teams) out.push({ id: t.id, label: `${d.name} › ${t.name}` });
  }
  return out;
}

function setPersonUnit(personId, unitId) {
  const person = crm().prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error('No such person');
  if (unitId) {
    const u = getUnit(unitId);
    if (!u || u.org_id !== person.org_id) throw new Error("That department isn't in this person's organisation");
  }
  crm().prepare('UPDATE people SET unit_id = ?, updated_at = unixepoch() WHERE id = ?').run(unitId || null, personId);
  identity.log('set_unit', personId, { unitId: unitId || null });
}

// The people in a unit: a department includes its teams.
function unitMemberIds(unitId) {
  return crm().prepare('SELECT id FROM people WHERE unit_id = ? OR unit_id IN (SELECT id FROM org_units WHERE parent_id = ?)')
    .all(unitId, unitId).map(r => r.id);
}

function list(space) {
  return crm().prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM people p WHERE p.org_id = o.id) AS people,
      (SELECT group_concat(domain, ', ') FROM org_domains x WHERE x.org_id = o.id) AS domains
      FROM organisations o WHERE o.space = ? ORDER BY o.name COLLATE NOCASE
  `).all(space);
}

module.exports = { getUnit, addUnit, renameUnit, removeUnit, units, unitChoices, setPersonUnit, unitMemberIds, get, createOrg, rename, addDomain, removeDomain, orgForEmail, resolveChoice, setPersonOrg, list, cleanDomain, PUBLIC_DOMAINS };
