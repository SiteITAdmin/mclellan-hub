'use strict';

// Identity before models. People are matched on exact identifiers (email,
// phone) or on an exact written name that only one person in the space has.
// There is no similarity matching anywhere in this file.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const { normEmail, normPhone, normName } = require('./text');
const config = require('./config');

function log(action, personId, detail = {}) {
  crm().prepare('INSERT INTO identity_log (id, action, person_id, detail) VALUES (?, ?, ?, ?)')
    .run(uuid(), action, personId || null, JSON.stringify(detail));
}

function normIdentifier(kind, value) {
  return kind === 'phone' ? normPhone(value) : normEmail(value);
}

function identifierRow(kind, value) {
  const v = normIdentifier(kind, value);
  if (!v) return null;
  return crm().prepare('SELECT * FROM identifiers WHERE kind = ? AND value = ?').get(kind, v) || null;
}

function personForAddress(kind, value) {
  const row = identifierRow(kind, value);
  if (!row || row.status !== 'linked' || !row.person_id) return null;
  return crm().prepare('SELECT * FROM people WHERE id = ?').get(row.person_id) || null;
}

function isIgnored(kind, value) {
  const row = identifierRow(kind, value);
  return !!row && row.status === 'ignored';
}

function isSelf(email) {
  const e = normEmail(email);
  return config.workAddresses().includes(e) || config.personalAddresses().includes(e);
}

// Neighbouring people get hues far apart: the golden angle walks the circle.
function nextHue() {
  const n = crm().prepare('SELECT COUNT(*) AS n FROM people').get().n;
  return Math.round((n * 137.508) % 360);
}

function createPerson({ space, name, orgId = null, role = '' }) {
  if (!['work', 'personal'].includes(space)) throw new Error(`bad space: ${space}`);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('A person needs a name');
  const id = uuid();
  crm().prepare('INSERT INTO people (id, space, name, org_id, role, hue) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, space, clean, orgId || null, String(role || '').trim(), nextHue());
  log('add_person', id, { space, name: clean });
  return crm().prepare('SELECT * FROM people_v WHERE id = ?').get(id);
}

function linkIdentifier(personId, kind, value, label = '') {
  const v = normIdentifier(kind, value);
  if (!v) throw new Error(`Not a valid ${kind}: ${value}`);
  const db = crm();
  const existing = db.prepare('SELECT * FROM identifiers WHERE kind = ? AND value = ?').get(kind, v);
  if (existing && existing.person_id && existing.person_id !== personId && existing.status === 'linked') {
    const owner = db.prepare('SELECT name FROM people WHERE id = ?').get(existing.person_id);
    throw new Error(`${v} already belongs to ${owner ? owner.name : 'someone else'}`);
  }
  if (existing) {
    db.prepare("UPDATE identifiers SET person_id = ?, status = 'linked', label = COALESCE(NULLIF(?, ''), label) WHERE id = ?")
      .run(personId, label, existing.id);
  } else {
    db.prepare("INSERT INTO identifiers (id, kind, value, person_id, status, label) VALUES (?, ?, ?, ?, 'linked', ?)")
      .run(uuid(), kind, v, personId, label);
  }
  log('link_identifier', personId, { kind, value: v });
  return v;
}

function ignoreIdentifier(kind, value, label = '') {
  const v = normIdentifier(kind, value);
  if (!v) return null;
  crm().prepare(`
    INSERT INTO identifiers (id, kind, value, person_id, status, label) VALUES (?, ?, ?, NULL, 'ignored', ?)
    ON CONFLICT(kind, value) DO UPDATE SET person_id = NULL, status = 'ignored'
  `).run(uuid(), kind, v, label);
  log('ignore_identifier', null, { kind, value: v });
  return v;
}

// Undo a wrong link: the address goes back to "unknown" and is offered for
// review again.
function detachIdentifier(personId, kind, value) {
  const v = normIdentifier(kind, value);
  const changed = crm().prepare('DELETE FROM identifiers WHERE kind = ? AND value = ? AND person_id = ?').run(kind, v, personId).changes;
  if (changed) log('detach_identifier', personId, { kind, value: v });
  return changed > 0;
}

function namesFor(person) {
  const names = [normName(person.name)];
  for (const a of crm().prepare('SELECT alias_norm FROM aliases WHERE person_id = ?').all(person.id)) names.push(a.alias_norm);
  return names;
}

function addAlias(personId, alias) {
  const db = crm();
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error('No such person');
  const n = normName(alias);
  if (!n) throw new Error('Empty alias');
  const clash = db.prepare(`
    SELECT p.name FROM people p
     WHERE p.space = ? AND p.id != ?
       AND (EXISTS (SELECT 1 FROM aliases a WHERE a.person_id = p.id AND a.alias_norm = ?))
  `).get(person.space, personId, n)
    || db.prepare('SELECT name FROM people WHERE space = ? AND id != ?').all(person.space, personId)
      .find(p => normName(p.name) === n);
  if (clash) throw new Error(`"${alias}" is already ${clash.name}'s name or alias in this space`);
  db.prepare('INSERT OR IGNORE INTO aliases (id, person_id, alias, alias_norm) VALUES (?, ?, ?, ?)')
    .run(uuid(), personId, String(alias).trim(), n);
  log('alias_add', personId, { alias: String(alias).trim() });
}

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'live.ie', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.ie', 'eircom.net', 'protonmail.com', 'proton.me']);

function firstName(norm) {
  return norm.split(' ')[0];
}

// Every person in the space whose exact name, first name (for a one-word
// mention) or alias equals the mention.
function nameCandidates(space, mention) {
  const m = normName(mention);
  if (!m) return [];
  const single = !m.includes(' ');
  const people = crm().prepare('SELECT * FROM people WHERE space = ?').all(space);
  return people.filter(p => {
    const full = normName(p.name);
    if (full === m) return true;
    if (single && firstName(full) === m) return true;
    return namesFor(p).slice(1).includes(m);
  });
}

function isSelfName(mention) {
  const m = normName(mention);
  return ['i', 'me', 'myself'].includes(m) || config.selfNames().includes(m);
}

// Resolve one name the model saw. participantIds: people on the source by
// address. projectIds: projects the atom belongs to.
function resolveName(space, mention, { participantIds = [], projectIds = [] } = {}) {
  if (isSelfName(mention)) return { status: 'self' };
  const candidates = nameCandidates(space, mention);
  if (candidates.length === 1) return { status: 'resolved', personId: candidates[0].id, how: 'name' };
  if (candidates.length === 0) return { status: 'unresolved' };

  const onSource = candidates.filter(c => participantIds.includes(c.id));
  if (onSource.length === 1) return { status: 'resolved', personId: onSource[0].id, how: 'participant' };

  if (projectIds.length) {
    const inProject = candidates.filter(c => crm().prepare(`
      SELECT 1 FROM atom_mentions m JOIN atom_projects ap ON ap.atom_id = m.atom_id
       WHERE m.person_id = ? AND ap.project_id IN (${projectIds.map(() => '?').join(',')}) LIMIT 1
    `).get(c.id, ...projectIds));
    if (inProject.length === 1) return { status: 'resolved', personId: inProject[0].id, how: 'project' };
  }
  return { status: 'ambiguous', candidateIds: candidates.map(c => c.id) };
}

// People shown beside a proposal so Douglas can tell them apart. Display only:
// nothing is ever linked from this list without his decision.
function lookalikes(name, email) {
  const n = normName(name);
  const tokens = n.split(' ').filter(t => t.length > 1);
  const rawDomain = normEmail(email).split('@')[1] || '';
  // A shared Gmail or Outlook.com domain says nothing about who someone is.
  const domain = PUBLIC_DOMAINS.has(rawDomain) ? '' : rawDomain;
  const all = crm().prepare('SELECT * FROM people_v').all();
  const scored = [];
  for (const p of all) {
    const pn = normName(p.name);
    const ptokens = pn.split(' ');
    let score = 0;
    if (tokens.some(t => ptokens.includes(t))) score += 2;
    if (tokens.length && ptokens.length && editDistance(tokens[0], ptokens[0]) === 1) score += 2;
    if (tokens.length > 1 && ptokens.length > 1 && tokens[tokens.length - 1] === ptokens[ptokens.length - 1]) score += 1;
    if (domain && crm().prepare("SELECT 1 FROM identifiers WHERE person_id = ? AND kind = 'email' AND value LIKE ? LIMIT 1").get(p.id, `%@${domain}`)) score += 1;
    if (score) scored.push({ person: p, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(s => s.person);
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function markDistinct(personId, otherIds) {
  const stmt = crm().prepare('INSERT OR IGNORE INTO distinct_pairs (person_id, other_id, decided_at) VALUES (?, ?, ?)');
  for (const other of otherIds) {
    if (!other || other === personId) continue;
    stmt.run(personId, other, now());
    stmt.run(other, personId, now());
  }
}

module.exports = {
  createPerson, linkIdentifier, ignoreIdentifier, detachIdentifier, addAlias,
  personForAddress, isIgnored, isSelf, identifierRow,
  resolveName, nameCandidates, lookalikes, markDistinct, isSelfName, log,
};
