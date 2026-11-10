'use strict';

// Douglas's own corrections to where a fact is filed: which projects and which
// people it is about. The reader and the name matcher make the first guess;
// these override it and are never undone by them. Who belongs to a project is
// also his to say, and is kept apart from the facts: being on a project never
// files a person's facts there (a person on a project isn't proof a fact is
// about that project).

const { crm, now } = require('./db');
const { uuid } = require('../id');
const { normName } = require('./text');
const check = require('./project-check');

function atom(id, space) {
  const a = crm().prepare("SELECT * FROM atoms WHERE id = ? AND space = ?").get(String(id), space);
  if (!a) throw new Error('Fact not found');
  return a;
}
function inSpace(table, id, space, what) {
  const row = crm().prepare(`SELECT * FROM ${table} WHERE id = ? AND space = ?`).get(String(id || ''), space);
  if (!row) throw new Error(`Choose a ${what} in the same space`);
  return row;
}
function refresh(type, id) {
  crm().prepare('UPDATE standings SET tried_at = 0 WHERE entity_type = ? AND entity_id = ?').run(type, id);
}

function addProject(atomId, projectId, space) {
  atom(atomId, space);
  const p = inSpace('projects', projectId, space, 'project');
  crm().transaction(() => {
    crm().prepare('DELETE FROM project_removals WHERE atom_id = ? AND project_id = ?').run(atomId, p.id);
    crm().prepare('INSERT OR REPLACE INTO atom_projects (atom_id, project_id, checked, kept_by_you) VALUES (?, ?, ?, 1)').run(atomId, p.id, check.hashFor(p.id));
  })();
  refresh('project', p.id);
  return p;
}

function removeProject(atomId, projectId, space) {
  atom(atomId, space);
  const p = inSpace('projects', projectId, space, 'project');
  check.remove(atomId, p.id, 'you', 'You took it off');
  return p;
}

function addPerson(atomId, personId, space) {
  atom(atomId, space);
  const p = inSpace('people', personId, space, 'person');
  const db = crm();
  if (!db.prepare("SELECT 1 FROM atom_mentions WHERE atom_id = ? AND person_id = ? AND status = 'resolved'").get(atomId, p.id)) {
    db.prepare("INSERT INTO atom_mentions (id, atom_id, name, name_norm, status, person_id, how) VALUES (?, ?, ?, ?, 'resolved', ?, 'you')")
      .run(uuid(), atomId, p.name, normName(p.name), p.id);
  }
  refresh('person', p.id);
  return p;
}

// The mention row is kept, marked "not a person", so the matcher never links the name again.
function removePerson(atomId, personId, space) {
  atom(atomId, space);
  const p = inSpace('people', personId, space, 'person');
  const db = crm();
  for (const m of db.prepare("SELECT id FROM atom_mentions WHERE atom_id = ? AND person_id = ?").all(atomId, p.id)) {
    db.prepare("UPDATE atom_mentions SET status = 'none', person_id = NULL, how = 'you' WHERE id = ?").run(m.id);
    db.prepare("DELETE FROM review_items WHERE item_key = ? AND status = 'open'").run(`mention:${m.id}`);
  }
  refresh('person', p.id);
  return p;
}

// Deletes a fact and everything hanging off it (its people, projects, topics
// and any promise). The email or note it came from stays. Anything summarised
// from it is rewritten. A task already made from it is left alone: that is
// Douglas's to keep or delete.
function deleteFact(atomId, space) {
  const db = crm();
  const a = atom(atomId, space);
  const sources = db.prepare('SELECT source_id, quote FROM atom_sources WHERE atom_id = ?').all(a.id);
  const people = db.prepare("SELECT DISTINCT person_id FROM atom_mentions WHERE atom_id = ? AND person_id IS NOT NULL").all(a.id).map(r => r.person_id);
  const projectIds = db.prepare('SELECT project_id FROM atom_projects WHERE atom_id = ?').all(a.id).map(r => r.project_id);
  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO deleted_facts (atom_id, space, statement, source_ids, quotes, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.id, space, a.statement, JSON.stringify(sources.map(s => s.source_id)), JSON.stringify(sources.map(s => s.quote).filter(Boolean)), now());
    // A fact it replaced is current again: otherwise deleting a wrong update would lose the original too.
    db.prepare("UPDATE atoms SET status = 'active', superseded_by = NULL, updated_at = ? WHERE superseded_by = ? AND space = ?").run(now(), a.id, space);
    for (const m of db.prepare('SELECT id FROM atom_mentions WHERE atom_id = ?').all(a.id)) db.prepare("DELETE FROM review_items WHERE item_key = ? AND status = 'open'").run(`mention:${m.id}`);
    for (const r of db.prepare("SELECT id, payload FROM review_items WHERE kind = 'project' AND status = 'open'").all()) {
      const p = JSON.parse(r.payload);
      if (!(p.atomIds || []).includes(a.id)) continue;
      p.atomIds = p.atomIds.filter(x => x !== a.id);
      if (p.atomIds.length) db.prepare('UPDATE review_items SET payload = ? WHERE id = ?').run(JSON.stringify(p), r.id);
      else db.prepare('DELETE FROM review_items WHERE id = ?').run(r.id);
    }
    db.prepare('DELETE FROM atoms_fts WHERE atom_id = ?').run(a.id);
    db.prepare('DELETE FROM atoms WHERE id = ?').run(a.id);
    for (const s of sources) db.prepare('UPDATE sources SET atom_count = MAX(0, atom_count - 1) WHERE id = ?').run(s.source_id);
  })();
  for (const id of people) refresh('person', id);
  for (const id of projectIds) refresh('project', id);
  return a;
}

// True when the reader offers again a fact Douglas deleted from this same source.
function wasDeleted(space, sourceId, statement, quote) {
  const q = String(quote || '').trim().toLowerCase();
  return crm().prepare('SELECT statement, source_ids, quotes FROM deleted_facts WHERE space = ?').all(space).some(d =>
    JSON.parse(d.source_ids).includes(sourceId)
    && (d.statement === statement || (q && JSON.parse(d.quotes).some(x => String(x).trim().toLowerCase() === q))));
}

// Files several facts under one project at once. Moving out of a project
// takes each off it too; projectId 'none' only takes them off. All or nothing.
function moveMany(atomIds, projectId, space, { from = null } = {}) {
  const ids = [...new Set((Array.isArray(atomIds) ? atomIds : [atomIds]).filter(Boolean).map(String))];
  if (!ids.length) throw new Error('Tick at least one fact first');
  if (ids.length > 500) throw new Error('Move at most 500 facts at a time');
  const to = projectId === 'none' ? null : inSpace('projects', projectId, space, 'project');
  const out = from ? inSpace('projects', from, space, 'project') : null;
  if (!to && !out) throw new Error('Choose a project');
  if (to && out && to.id === out.id) throw new Error('They are already in that project');
  crm().transaction(() => {
    for (const id of ids) {
      if (to) addProject(id, to.id, space);
      if (out) check.remove(atom(id, space).id, out.id, 'you', to ? `You moved it to ${to.name}` : 'You took it off');
    }
  })();
  return { count: ids.length, to, from: out };
}

function detail(id, space) {
  const db = crm();
  const a = atom(id, space);
  return {
    ...a,
    sources: db.prepare(`SELECT s.id, s.title, s.kind, s.occurred_at, x.quote, x.quote_verified FROM atom_sources x JOIN sources s ON s.id = x.source_id
      WHERE x.atom_id = ? ORDER BY s.occurred_at DESC`).all(id),
    projects: db.prepare(`SELECT p.id, p.name, x.kept_by_you FROM atom_projects x JOIN projects p ON p.id = x.project_id WHERE x.atom_id = ? ORDER BY p.name`).all(id),
    removedFrom: db.prepare(`SELECT p.id, p.name, r.by, r.reason FROM project_removals r JOIN projects p ON p.id = r.project_id WHERE r.atom_id = ? ORDER BY p.name`).all(id),
    people: db.prepare(`SELECT DISTINCT p.id, p.name, m.how FROM atom_mentions m JOIN people p ON p.id = m.person_id WHERE m.atom_id = ? AND m.status = 'resolved' ORDER BY p.name`).all(id),
    unclear: db.prepare(`SELECT name, status FROM atom_mentions WHERE atom_id = ? AND status IN ('unresolved','ambiguous')`).all(id),
    projectChoices: db.prepare('SELECT id, name FROM projects WHERE space = ? ORDER BY name COLLATE NOCASE').all(space),
    peopleChoices: db.prepare('SELECT id, name FROM people WHERE space = ? ORDER BY name COLLATE NOCASE').all(space),
  };
}

// Facts in no project. Nothing is lost by being here: they still show on
// people, topics, sources and search.
function unfiled(space, { limit = 100, offset = 0 } = {}) {
  const db = crm();
  const where = `a.space = ? AND a.status = 'active' AND NOT EXISTS (SELECT 1 FROM atom_projects x WHERE x.atom_id = a.id)`;
  return {
    total: db.prepare(`SELECT COUNT(*) n FROM atoms a WHERE ${where}`).get(space).n,
    rows: db.prepare(`SELECT a.* FROM atoms a WHERE ${where} ORDER BY a.said_at DESC LIMIT ? OFFSET ?`).all(space, limit, offset),
  };
}

function addMember(projectId, personId, space) {
  const project = inSpace('projects', projectId, space, 'project');
  const person = inSpace('people', personId, space, 'person');
  crm().prepare('INSERT OR IGNORE INTO project_people (project_id, person_id, added_at) VALUES (?, ?, ?)').run(project.id, person.id, now());
  return { project, person };
}

function removeMember(projectId, personId, space) {
  const project = inSpace('projects', projectId, space, 'project');
  const person = inSpace('people', personId, space, 'person');
  crm().prepare('DELETE FROM project_people WHERE project_id = ? AND person_id = ?').run(project.id, person.id);
  return { project, person };
}

// A project's people: those Douglas added, then those its facts name, with how many facts each.
function projectPeople(projectId) {
  const db = crm();
  const facts = new Map(db.prepare(`SELECT pe.id, COUNT(DISTINCT m.atom_id) n FROM atom_projects ap JOIN atom_mentions m ON m.atom_id = ap.atom_id
    JOIN people pe ON pe.id = m.person_id WHERE ap.project_id = ? AND m.status = 'resolved' GROUP BY pe.id`).all(projectId).map(r => [r.id, r.n]));
  const added = db.prepare(`SELECT pe.id, pe.name, pe.hue FROM project_people x JOIN people pe ON pe.id = x.person_id WHERE x.project_id = ? ORDER BY pe.name COLLATE NOCASE`).all(projectId);
  const addedIds = new Set(added.map(p => p.id));
  const fromFacts = facts.size ? db.prepare(`SELECT id, name, hue FROM people WHERE id IN (${[...facts.keys()].map(() => '?').join(',')})`).all(...facts.keys())
    .filter(p => !addedIds.has(p.id)).map(p => ({ ...p, n: facts.get(p.id) })).sort((a, b) => b.n - a.n) : [];
  return { added: added.map(p => ({ ...p, n: facts.get(p.id) || 0 })), fromFacts };
}

function personProjects(personId) {
  const db = crm();
  const facts = new Map(db.prepare(`SELECT ap.project_id id, COUNT(DISTINCT m.atom_id) n FROM atom_mentions m JOIN atom_projects ap ON ap.atom_id = m.atom_id
    WHERE m.person_id = ? AND m.status = 'resolved' GROUP BY ap.project_id`).all(personId).map(r => [r.id, r.n]));
  const added = db.prepare(`SELECT pr.id, pr.name FROM project_people x JOIN projects pr ON pr.id = x.project_id WHERE x.person_id = ? ORDER BY pr.name COLLATE NOCASE`).all(personId);
  const addedIds = new Set(added.map(p => p.id));
  const fromFacts = facts.size ? db.prepare(`SELECT id, name FROM projects WHERE id IN (${[...facts.keys()].map(() => '?').join(',')})`).all(...facts.keys())
    .filter(p => !addedIds.has(p.id)).map(p => ({ ...p, n: facts.get(p.id) })).sort((a, b) => b.n - a.n) : [];
  return { added: added.map(p => ({ ...p, n: facts.get(p.id) || 0 })), fromFacts };
}

function memberIds(projectIds) {
  if (!projectIds.length) return [];
  return crm().prepare(`SELECT DISTINCT person_id FROM project_people WHERE project_id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds).map(r => r.person_id);
}

module.exports = { moveMany, deleteFact, wasDeleted, addProject, removeProject, addPerson, removePerson, detail, unfiled, addMember, removeMember, projectPeople, personProjects, memberIds };
