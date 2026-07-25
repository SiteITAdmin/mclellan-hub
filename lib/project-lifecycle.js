'use strict';

// Lifecycle is compiled knowledge: an explicit close is the same manual status
// atom the CRM already uses, rather than another manually-maintained field.

const SLUG_REFERENCES = [
  'crm_facts', 'email_summaries', 'google_tasks', 'inbound_email_records',
  'meeting_intakes', 'request_logs', 'task_extraction_feedback', 'project_report_schedules',
];

function hasColumn(hub, table, column) {
  try { return hub.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column); } catch (_) { return false; }
}

function closedProjectIds(hub, user) {
  try {
    return new Set(hub.prepare(`
      SELECT subject_id FROM knowledge_atoms
      WHERE user = ? AND subject_kind = 'project' AND predicate = 'status'
        AND derived_by = 'manual' AND status = 'active' AND lower(trim(value)) = 'closed'
    `).all(user).map(row => row.subject_id));
  } catch (_) { return new Set(); }
}

function listProjects(hub, user, { includeClosed = false, columns = '*' } = {}) {
  const projects = hub.prepare(`SELECT ${columns} FROM projects WHERE user = ? ORDER BY name`).all(user);
  if (includeClosed) return projects;
  const closed = closedProjectIds(hub, user);
  return projects.filter(project => !closed.has(project.id));
}

function isProjectClosed(hub, user, projectId) {
  return closedProjectIds(hub, user).has(projectId);
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

module.exports = { closedProjectIds, closedProjectSlugs, listProjects, isProjectClosed, renameProject };
