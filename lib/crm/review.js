'use strict';

// "Who is this?" — the one screen shared by both spaces. Nothing is linked to
// a person, and no new project exists, until Douglas decides here.

const { crm, now } = require('./db');
const identity = require('./identity');
const sources = require('./sources');
const atoms = require('./atoms');
const { normName } = require('./text');
const { uuid } = require('../id');

function openItems() {
  return crm().prepare(`
    SELECT * FROM review_items
     WHERE status = 'open' AND (snooze_until IS NULL OR snooze_until <= ?)
     ORDER BY created_at DESC
  `).all(now()).map(hydrate);
}

function openCount(space = null) {
  const rows = crm().prepare(`
    SELECT space, COUNT(*) AS n FROM review_items
     WHERE status = 'open' AND (snooze_until IS NULL OR snooze_until <= ?) GROUP BY space
  `).all(now());
  return rows.filter(r => !space || r.space === space).reduce((n, r) => n + r.n, 0);
}

function hydrate(row) {
  const payload = JSON.parse(row.payload || '{}');
  return { ...row, payload };
}

function getItem(id) {
  const row = crm().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

// Evidence for a proposed person: where their address appeared.
function evidenceFor(item, limit = 4) {
  if (item.kind !== 'person') return [];
  return crm().prepare(`
    SELECT s.id, s.title, s.occurred_at, s.space, s.direction, substr(s.text_fresh, 1, 280) AS snippet, a.role
      FROM source_addresses a JOIN sources s ON s.id = a.source_id
     WHERE a.kind = ? AND a.value = ? ORDER BY s.occurred_at DESC LIMIT ?
  `).all(item.payload.kind, item.payload.value, limit);
}

function evidenceCount(item) {
  if (item.kind !== 'person') return 0;
  return crm().prepare('SELECT COUNT(DISTINCT source_id) AS n FROM source_addresses WHERE kind = ? AND value = ?')
    .get(item.payload.kind, item.payload.value).n;
}

function close(item, decision) {
  crm().prepare("UPDATE review_items SET status = 'decided', decision = ?, decided_at = ? WHERE id = ?")
    .run(JSON.stringify(decision), now(), item.id);
}

function decidePerson(item, { action, name, space, orgId, orgName, personId, shownIds = [] }) {
  const { kind, value } = item.payload;
  if (action === 'new') {
    const sp = space === 'work' || space === 'personal' ? space : item.space;
    const org = require('./orgs').resolveChoice(sp, { orgId, orgName });
    const person = identity.createPerson({ space: sp, name: name || item.payload.name || value, orgId: org ? org.id : null });
    identity.linkIdentifier(person.id, kind, value, item.payload.name);
    identity.markDistinct(person.id, shownIds);
    sources.releaseHeld(value, 'linked');
    atoms.reresolveMentions(sp);
    close(item, { action, personId: person.id });
    return { personId: person.id };
  }
  if (action === 'same') {
    const person = crm().prepare('SELECT * FROM people WHERE id = ?').get(personId);
    if (!person) throw new Error('Choose who this is');
    identity.linkIdentifier(person.id, kind, value, item.payload.name);
    identity.log('merge', person.id, { kind, value, from_review: item.id });
    sources.releaseHeld(value, 'linked');
    atoms.reresolveMentions(person.space);
    close(item, { action, personId: person.id });
    return { personId: person.id };
  }
  if (action === 'ignore') {
    identity.ignoreIdentifier(kind, value, item.payload.name);
    sources.releaseHeld(value, 'ignored');
    close(item, { action });
    return {};
  }
  if (action === 'later') {
    crm().prepare('UPDATE review_items SET snooze_until = ? WHERE id = ?').run(now() + 7 * 86400, item.id);
    return {};
  }
  throw new Error(`Unknown action: ${action}`);
}

function decideMention(item, { action, personId }) {
  const m = crm().prepare('SELECT * FROM atom_mentions WHERE id = ?').get(item.payload.mentionId);
  if (!m) { close(item, { action: 'gone' }); return {}; }
  if (action === 'choose') {
    if (!item.payload.candidateIds.includes(personId)) throw new Error('Choose one of the people shown');
    crm().prepare("UPDATE atom_mentions SET status = 'resolved', person_id = ?, how = 'decided' WHERE id = ?").run(personId, m.id);
    close(item, { action, personId });
    return { personId };
  }
  if (action === 'none') {
    crm().prepare("UPDATE atom_mentions SET status = 'none', person_id = NULL, how = 'decided' WHERE id = ?").run(m.id);
    close(item, { action });
    return {};
  }
  if (action === 'later') {
    crm().prepare('UPDATE review_items SET snooze_until = ? WHERE id = ?').run(now() + 7 * 86400, item.id);
    return {};
  }
  throw new Error(`Unknown action: ${action}`);
}

function createProject(space, name) {
  const n = normName(name);
  if (!n) throw new Error('A project needs a name');
  const db = crm();
  const existing = db.prepare('SELECT * FROM projects WHERE space = ? AND name_norm = ?').get(space, n);
  if (existing) return existing;
  const id = uuid();
  db.prepare('INSERT INTO projects (id, space, name, name_norm) VALUES (?, ?, ?, ?)').run(id, space, String(name).trim(), n);
  db.prepare("DELETE FROM review_items WHERE item_key = ? AND status = 'open'").run(`project:${space}:${n}`);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

function decideProject(item, { action, name }) {
  if (action === 'add') {
    const project = createProject(item.space, name || item.payload.name);
    const stmt = crm().prepare('INSERT OR IGNORE INTO atom_projects (atom_id, project_id) VALUES (?, ?)');
    for (const aid of item.payload.atomIds || []) stmt.run(aid, project.id);
    close(item, { action, projectId: project.id });
    return { projectId: project.id };
  }
  if (action === 'ignore') { close(item, { action }); return {}; }
  if (action === 'later') {
    crm().prepare('UPDATE review_items SET snooze_until = ? WHERE id = ?').run(now() + 7 * 86400, item.id);
    return {};
  }
  throw new Error(`Unknown action: ${action}`);
}

function decide(id, body) {
  const item = getItem(id);
  if (!item || item.status !== 'open') throw new Error('That item has already been decided');
  if (item.kind === 'person') return decidePerson(item, body);
  if (item.kind === 'mention') return decideMention(item, body);
  if (item.kind === 'project') return decideProject(item, body);
  throw new Error('Unknown item');
}

module.exports = { openItems, openCount, getItem, evidenceFor, evidenceCount, decide, createProject };
