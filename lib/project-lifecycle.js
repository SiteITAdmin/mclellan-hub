'use strict';

// Lifecycle is compiled knowledge: an explicit close is the same manual status
// atom the CRM already uses, rather than another manually-maintained field.

const SLUG_REFERENCES = [
  'crm_facts', 'email_summaries', 'google_tasks', 'inbound_email_records',
  'meeting_intakes', 'request_logs', 'task_extraction_feedback', 'project_report_schedules',
];

// One vocabulary for "this project is dead". Any of these manual status values means
// the project has left active life — closed, completed, ended, whatever word was used.
// Every surface that hides or excludes projects keys off this single set, so the system
// can never again treat "completed" as different from "closed" (which once let live mail
// get filed into a project the user had very clearly ended).
const TERMINAL_PROJECT_STATUSES = new Set([
  'closed', 'complete', 'completed', 'done', 'finished', 'ended', 'end',
  'archived', 'cancelled', 'canceled', 'abandoned', 'dead', 'dormant', 'retired', 'shelved',
]);

function isTerminalProjectStatus(value) {
  return TERMINAL_PROJECT_STATUSES.has(String(value || '').trim().toLowerCase());
}

function hasColumn(hub, table, column) {
  try { return hub.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column); } catch (_) { return false; }
}

function closedProjectIds(hub, user) {
  try {
    const terminal = [...TERMINAL_PROJECT_STATUSES];
    return new Set(hub.prepare(`
      SELECT subject_id FROM knowledge_atoms
      WHERE user = ? AND subject_kind = 'project' AND predicate = 'status'
        AND derived_by = 'manual' AND status = 'active'
        AND lower(trim(value)) IN (${terminal.map(() => '?').join(',')})
    `).all(user, ...terminal).map(row => row.subject_id));
  } catch (_) { return new Set(); }
}

function listProjects(hub, user, { includeClosed = false, includeSnoozed = false, columns = '*' } = {}) {
  const projects = hub.prepare(`SELECT ${columns} FROM projects WHERE user = ? ORDER BY name`).all(user);
  if (includeClosed && includeSnoozed) return projects;
  const hidden = new Set();
  if (!includeClosed) for (const id of closedProjectIds(hub, user)) hidden.add(id);
  if (!includeSnoozed) for (const id of snoozedProjectIds(hub, user)) hidden.add(id);
  return projects.filter(project => !hidden.has(project.id));
}

function isProjectClosed(hub, user, projectId) {
  return closedProjectIds(hub, user).has(projectId);
}

// Snooze is deferral, not death. A snoozed project is expected to wake — it is a
// future or paused workspace, distinct from the terminal "closed/completed" set
// above. It lives as its own manual atom (predicate 'snooze'), so a project can
// be, say, status='active' and still snoozed. Every active project/task view
// hides snoozed workspaces the same way it hides closed ones, but they resurface
// intact on an explicit wake (no auto-wake — waking is always a manual action).
const SNOOZE_PREDICATE = 'snooze';

function snoozedProjectIds(hub, user) {
  try {
    return new Set(hub.prepare(`
      SELECT subject_id FROM knowledge_atoms
      WHERE user = ? AND subject_kind = 'project' AND predicate = ?
        AND derived_by = 'manual' AND status = 'active'
    `).all(user, SNOOZE_PREDICATE).map(row => row.subject_id));
  } catch (_) { return new Set(); }
}

function isProjectSnoozed(hub, user, projectId) {
  return snoozedProjectIds(hub, user).has(projectId);
}

function snoozedProjectSlugs(hub, user) {
  const snoozed = snoozedProjectIds(hub, user);
  if (!snoozed.size) return new Set();
  return new Set(hub.prepare('SELECT id, slug FROM projects WHERE user = ?').all(user)
    .filter(project => snoozed.has(project.id)).map(project => project.slug));
}

// Toggle the manual snooze atom. Snoozing records when it happened (for a
// "snoozed since" label); waking removes the atom entirely so the project is
// simply active again — there is no separate "was snoozed" state to carry.
function setProjectSnooze(hub, { user, projectId, projectName, snoozed }) {
  const existing = hub.prepare(`
    SELECT id FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ? AND predicate = ? AND derived_by = 'manual'
  `).get(user, projectId, SNOOZE_PREDICATE);
  if (!snoozed) {
    if (existing) hub.prepare('DELETE FROM knowledge_atoms WHERE id = ?').run(existing.id);
    return;
  }
  const value = new Date().toISOString();
  if (existing) {
    hub.prepare(`UPDATE knowledge_atoms SET value = ?, status = 'active', confidence = 1.0,
      last_confirmed = unixepoch(), updated_at = unixepoch() WHERE id = ?`).run(value, existing.id);
  } else {
    hub.prepare(`
      INSERT INTO knowledge_atoms (id, user, subject_kind, subject_id, subject_label, predicate, value, source_refs, confidence, status, derived_by)
      VALUES (lower(hex(randomblob(8))), ?, 'project', ?, ?, ?, ?, '[]', 1.0, 'active', 'manual')
    `).run(user, projectId, projectName || null, SNOOZE_PREDICATE, value);
  }
}

function closedProjectSlugs(hub, user) {
  const closed = closedProjectIds(hub, user);
  if (!closed.size) return new Set();
  return new Set(hub.prepare('SELECT id, slug FROM projects WHERE user = ?').all(user)
    .filter(project => closed.has(project.id)).map(project => project.slug));
}

function validateSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Slug must use lowercase letters, numbers, and hyphens only');
  return slug;
}

// A rename moves local identity projections atomically. Raw source provenance is
// retained; project atoms stay tied to the stable project id and get its new label.
function renameProject(hub, { user, projectId, name, slug }) {
  const project = hub.prepare('SELECT * FROM projects WHERE id = ? AND user = ?').get(projectId, user);
  if (!project) throw new Error('Project not found');
  const nextName = String(name || '').trim();
  if (!nextName) throw new Error('Project name is required');
  const nextSlug = validateSlug(slug);
  if (hub.prepare('SELECT 1 FROM projects WHERE user = ? AND slug = ? AND id != ?').get(user, nextSlug, project.id)) {
    throw new Error('Another project already uses that slug');
  }
  const run = hub.transaction(() => {
    let referencesUpdated = 0;
    for (const table of SLUG_REFERENCES) {
      if (!hasColumn(hub, table, 'project_slug')) continue;
      referencesUpdated += hub.prepare(`UPDATE ${table} SET project_slug = ? WHERE user = ? AND project_slug = ?`)
        .run(nextSlug, user, project.slug).changes;
    }
    hub.prepare('UPDATE projects SET name = ?, slug = ? WHERE id = ? AND user = ?')
      .run(nextName, nextSlug, project.id, user);
    if (hasColumn(hub, 'knowledge_atoms', 'subject_label')) {
      hub.prepare(`UPDATE knowledge_atoms SET subject_label = ?, updated_at = unixepoch()
                   WHERE user = ? AND subject_kind = 'project' AND subject_id = ?`)
        .run(nextName, user, project.id);
    }
    return referencesUpdated;
  });
  return { project: { ...project, name: nextName, slug: nextSlug }, referencesUpdated: run() };
}

module.exports = {
  closedProjectIds, closedProjectSlugs, listProjects, isProjectClosed, renameProject,
  TERMINAL_PROJECT_STATUSES, isTerminalProjectStatus,
  snoozedProjectIds, snoozedProjectSlugs, isProjectSnoozed, setProjectSnooze, SNOOZE_PREDICATE,
};
