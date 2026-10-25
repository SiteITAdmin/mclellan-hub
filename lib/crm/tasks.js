'use strict';

const { crm, now, SPACES } = require('./db');
const { uuid } = require('../id');
const { createHash } = require('crypto');
const sources = require('./sources');

const TABLES = { personId: 'people', orgId: 'organisations', projectId: 'projects', sourceId: 'sources' };
const baseUrl = () => (process.env.CRM_PUBLIC_URL || 'https://douglas.mclellan.scot').replace(/\/$/, '');
const url = t => `${baseUrl()}/crm/${t.space}/tasks/${t.id}`;
const get = id => crm().prepare('SELECT * FROM tasks WHERE id = ?').get(id) || null;

function validateContext(space, value = {}) {
  const context = {};
  for (const [key, table] of Object.entries(TABLES)) {
    if (!value[key]) continue;
    const row = crm().prepare(`SELECT id FROM ${table} WHERE id = ? AND space = ?`).get(String(value[key]), space);
    if (!row) throw new Error('Task context must belong to the same space');
    context[key] = row.id;
  }
  return context;
}

function fields(input, maxNotes = 7000) {
  const title = String(input.title || '').trim();
  const notes = String(input.notes || '').trim();
  if (!title || title.length > 1024) throw new Error('Use a task title between 1 and 1,024 characters');
  if (notes.length > maxNotes) throw new Error(`Keep task notes under ${maxNotes.toLocaleString()} characters`);
  const due = input.due || null;
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) throw new Error('Choose a valid due date');
  const status = input.status || 'needsAction';
  if (!['needsAction', 'completed', 'deleted'].includes(status)) throw new Error('Invalid task status');
  return { title, notes, due, status };
}

function snapshot(id) {
  const t = get(id);
  const context = JSON.parse(t.context);
  const lines = [t.title, t.notes, `Task state: ${t.status}`, t.due ? `Due date: ${t.due}` : ''];
  for (const [key, table] of Object.entries(TABLES)) {
    if (!context[key]) continue;
    const r = crm().prepare(`SELECT * FROM ${table} WHERE id = ? AND space = ?`).get(context[key], t.space);
    if (r) lines.push(`Context chosen by Douglas (${key}): ${r.name || r.title}`);
  }
  const text = lines.filter(Boolean).join('\n\n');
  const hash = createHash('sha256').update(JSON.stringify([text, context])).digest('hex');
  const s = sources.admitSource({ space: t.space, kind: 'task', origin: 'crm_task', externalId: `${id}:${hash}`,
    title: t.title, text, occurredAt: now(), rawRef: url(t), isHistory: t.status !== 'needsAction' }).source;
  crm().prepare('UPDATE tasks SET source_id = ? WHERE id = ?').run(s.id, id);
}

function create(space, input, origin = 'hub') {
  if (!SPACES.includes(space)) throw new Error('Invalid space');
  const f = fields(input), context = validateContext(space, input.context || input);
  const id = uuid();
  crm().transaction(() => {
    crm().prepare('INSERT INTO tasks (id, space, title, notes, due, status, context, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, space, f.title, f.notes, f.due, f.status, JSON.stringify(context), origin);
    snapshot(id);
  })();
  return get(id);
}

function edit(id, input) {
  const t = get(id);
  if (!t) throw new Error('Task not found');
  if (t.status === 'deleted') throw new Error('This task was deleted');
  if (input.revision != null && Number(input.revision) !== t.revision) throw new Error('This task changed. Reload it before saving.');
  const f = fields({ ...t, ...input }, t.google_id ? 8192 : 7000);
  const context = input.context ? validateContext(t.space, input.context) : JSON.parse(t.context);
  crm().transaction(() => {
    crm().prepare(`UPDATE tasks SET title = ?, notes = ?, due = ?, status = ?, context = ?, revision = revision + 1,
      updated_at = ?, sync_error = '', conflict = '' WHERE id = ?`)
      .run(f.title, f.notes, f.due, f.status, JSON.stringify(context), now(), id);
    snapshot(id);
  })();
  return get(id);
}

function detail(t) {
  if (!t) return null;
  const context = JSON.parse(t.context);
  const people = new Map(), projects = new Map(), organisations = new Map();
  const add = (table, id, map, via) => {
    const r = id && crm().prepare(`SELECT * FROM ${table} WHERE id = ? AND space = ?`).get(id, t.space);
    if (r) map.set(id, { ...r, via });
  };
  const linked = crm().prepare(`SELECT DISTINCT a.id FROM atom_sources x JOIN atoms a ON a.id = x.atom_id
    WHERE x.source_id = ? AND x.quote_verified = 1 AND a.status = 'active' AND a.space = ?`).all(t.source_id, t.space);
  for (const a of linked) {
    for (const m of crm().prepare("SELECT person_id FROM atom_mentions WHERE atom_id = ? AND status = 'resolved'").all(a.id)) add('people', m.person_id, people, 'From task text');
    for (const p of crm().prepare('SELECT project_id FROM atom_projects WHERE atom_id = ?').all(a.id)) add('projects', p.project_id, projects, 'From task text');
  }
  add('people', context.personId, people, 'Chosen by you');
  add('projects', context.projectId, projects, 'Chosen by you');
  for (const p of people.values()) add('organisations', p.org_id, organisations, `Through ${p.name}`);
  add('organisations', context.orgId, organisations, 'Chosen by you');
  const evidence = context.sourceId && crm().prepare('SELECT id, title, kind, origin, external_id, raw_ref FROM sources WHERE id = ? AND space = ?').get(context.sourceId, t.space);
  const source = crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(t.source_id);
  return { ...t, context, people: [...people.values()], projects: [...projects.values()], organisations: [...organisations.values()], evidence,
    reading: source?.atomise_status, pending: t.revision !== t.synced_revision || !!t.sync_error };
}

function list(space, { status = 'needsAction', personId, orgId, projectId, unitId } = {}) {
  const unitMembers = unitId ? new Set(require('./orgs').unitMemberIds(unitId)) : null;
  return crm().prepare(`SELECT * FROM tasks WHERE space = ? AND status = ? ORDER BY due IS NULL, due, created_at DESC`).all(space, status)
    .map(detail).filter(t => (!personId || t.people.some(p => p.id === personId)) && (!orgId || t.organisations.some(o => o.id === orgId))
      && (!projectId || t.projects.some(p => p.id === projectId)) && (!unitId || t.people.some(p => unitMembers.has(p.id))));
}

function choices(space) {
  return Object.fromEntries(Object.entries(TABLES).filter(([key]) => key !== 'sourceId').map(([key, table]) =>
    [key, crm().prepare(`SELECT id, name FROM ${table} WHERE space = ? ORDER BY name`).all(space)]));
}

function remoteFields(r, t) {
  let notes = r.notes || '';
  if (t) notes = notes.replace(new RegExp(`\\n?\\n?\\[Hub task ${t.id}\\][\\s\\S]*?\\[/Hub task\\]`, 'g'), '').trim();
  return { title: r.title || '(Untitled task)', notes, due: r.due ? r.due.slice(0, 10) : null,
    status: r.deleted ? 'deleted' : r.status === 'completed' ? 'completed' : 'needsAction' };
}

function payload(t) {
  const d = detail(t);
  const links = [`Hub: ${url(t)}`];
  if (d.evidence) {
    links.push(`Source: ${baseUrl()}/crm/${t.space}/sources/${d.evidence.id}`);
    if (d.evidence.origin === 'gmail') links.push(`Email: https://mail.google.com/mail/u/0/#all/${encodeURIComponent(d.evidence.external_id)}`);
  }
  const block = `[Hub task ${t.id}]\n${links.join('\n')}\n[/Hub task]`;
  let notes = `${t.notes}${t.notes ? '\n\n' : ''}${block}`;
  // Existing Google notes must survive even when there is no room for our link.
  if (notes.length > 8192 && t.google_id) notes = t.notes;
  if (notes.length > 8192) throw new Error('Task notes are too long for Google Tasks');
  return { title: t.title, notes, status: t.status === 'deleted' ? 'needsAction' : t.status,
    due: t.due ? `${t.due}T00:00:00.000Z` : null, ...(t.status === 'needsAction' ? { completed: null } : {}) };
}

module.exports = { get, create, edit, list, detail, choices, snapshot, fields, remoteFields, payload, url };
