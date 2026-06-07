'use strict';

const { google } = require('googleapis');
const db = require('./db');
const { uuid } = require('./id');

// ── Auth ──────────────────────────────────────────────────────────────────────

function getTasksClient(user) {
  const tokenRow = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!tokenRow) throw new Error(`No Google refresh token for user "${user}"`);

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: tokenRow.value });
  return google.tasks({ version: 'v1', auth: client });
}

async function getDefaultTaskListId(tasks) {
  const resp = await tasks.tasklists.list({ maxResults: 10 });
  const lists = resp.data.items || [];
  const def = lists.find(l => l.id === '@default') || lists[0];
  return def ? def.id : '@default';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a task in Google Tasks and cache it locally.
 * @param {string} user
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.notes]
 * @param {string} [opts.due]      ISO date string
 * @param {string} [opts.source]   'crm-follow-up' | 'email' | 'meeting' | 'debrief' | 'manual'
 * @param {string} [opts.sourceId] dedup key
 * @param {string} [opts.contactId]
 * @param {string} [opts.companyId]
 * @param {string} [opts.projectSlug]
 */
async function createTask(user, {
  title, notes, due,
  source = 'manual', sourceId = null,
  contactId = null, companyId = null, projectSlug = null,
}) {
  const hub = db.hub();

  if (sourceId) {
    const existing = hub.prepare(
      'SELECT id FROM google_tasks WHERE user = ? AND source_id = ? AND source = ?'
    ).get(user, sourceId, source);
    if (existing) {
      console.log(`[tasks] skipping duplicate task for ${source}/${sourceId}`);
      return null;
    }
  }

  const tasks = getTasksClient(user);
  const listId = await getDefaultTaskListId(tasks);

  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = new Date(due).toISOString();

  const resp = await tasks.tasks.insert({ tasklist: listId, requestBody: body });
  const task = resp.data;

  hub.prepare(`
    INSERT OR IGNORE INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, status,
       source, source_id, contact_id, company_id, project_slug, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'needsAction', ?, ?, ?, ?, ?, unixepoch())
  `).run(uuid(), user, task.id, listId, title, notes || null, due || null,
    source, sourceId || null, contactId, companyId, projectSlug);

  console.log(`[tasks] created "${title}" for ${user} (${source})`);
  return task;
}

/**
 * Sync open tasks from Google into local cache.
 * Returns array of Google task objects.
 */
async function syncTasks(user) {
  const hub = db.hub();
  const tasks = getTasksClient(user);
  const listId = await getDefaultTaskListId(tasks);

  const resp = await tasks.tasks.list({
    tasklist: listId,
    showCompleted: false,
    showHidden: false,
    maxResults: 100,
  });
  const items = resp.data.items || [];
  const currentIds = items.map(t => t.id);

  // Mark locally-open tasks as completed if they've gone from Google
  hub.prepare(`
    UPDATE google_tasks SET status = 'completed'
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
    AND google_task_id NOT IN (SELECT value FROM json_each(?))
  `).run(user, JSON.stringify(currentIds));

  for (const t of items) {
    const existing = hub.prepare('SELECT id FROM google_tasks WHERE google_task_id = ?').get(t.id);
    if (existing) {
      hub.prepare(`
        UPDATE google_tasks SET title = ?, notes = ?, due = ?, status = 'needsAction', synced_at = unixepoch()
        WHERE google_task_id = ?
      `).run(t.title || '(untitled)', t.notes || null, t.due || null, t.id);
    } else {
      hub.prepare(`
        INSERT INTO google_tasks
          (id, user, google_task_id, task_list_id, title, notes, due, status, source, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'needsAction', 'google', unixepoch())
      `).run(uuid(), user, t.id, listId, t.title || '(untitled)', t.notes || null, t.due || null);
    }
  }

  console.log(`[tasks] synced ${items.length} open task(s) for ${user}`);
  return items;
}

/**
 * Mark a task complete in Google and update local cache.
 */
async function completeTask(user, googleTaskId) {
  const hub = db.hub();
  const row = hub.prepare('SELECT task_list_id FROM google_tasks WHERE user = ? AND google_task_id = ?').get(user, googleTaskId);
  const tasks = getTasksClient(user);
  const listId = row?.task_list_id || '@default';

  await tasks.tasks.patch({ tasklist: listId, task: googleTaskId, requestBody: { status: 'completed' } });
  hub.prepare("UPDATE google_tasks SET status = 'completed' WHERE google_task_id = ?").run(googleTaskId);
  console.log(`[tasks] completed ${googleTaskId} for ${user}`);
}

/**
 * Soft-delete a task locally (does not remove from Google Tasks).
 */
function deleteTask(user, localId) {
  const result = db.hub().prepare(
    'UPDATE google_tasks SET deleted_at = unixepoch() WHERE id = ? AND user = ?'
  ).run(localId, user);
  return result.changes > 0;
}

/**
 * Restore a soft-deleted task.
 */
function restoreTask(user, localId) {
  const result = db.hub().prepare(
    'UPDATE google_tasks SET deleted_at = NULL WHERE id = ? AND user = ?'
  ).run(localId, user);
  return result.changes > 0;
}

/**
 * Get open tasks from local cache (fast, no API call).
 * @param {string} user
 * @param {object} [filter] optional { contactId, companyId, projectSlug }
 * @param {boolean} [includeHistory] include completed + deleted
 */
function getCachedTasks(user, filter = {}, includeHistory = false) {
  const hub = db.hub();
  const conditions = ['t.user = ?'];
  const params = [user];

  if (!includeHistory) {
    conditions.push("t.status = 'needsAction'");
    conditions.push('t.deleted_at IS NULL');
  }

  if (filter.contactId) {
    conditions.push('t.contact_id = ?');
    params.push(filter.contactId);
  }
  if (filter.companyId) {
    // Company tasks: direct company_id OR via linked contacts
    conditions.push(`(t.company_id = ? OR t.contact_id IN (
      SELECT contact_id FROM contact_companies WHERE company_id = ?
    ))`);
    params.push(filter.companyId, filter.companyId);
  }
  if (filter.projectSlug) {
    conditions.push('t.project_slug = ?');
    params.push(filter.projectSlug);
  }

  const sql = `
    SELECT t.*,
      c.name AS contact_name,
      co.name AS company_name
    FROM google_tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN companies co ON co.id = t.company_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE t.status WHEN 'needsAction' THEN 0 ELSE 1 END,
      t.deleted_at IS NOT NULL,
      t.due ASC NULLS LAST,
      t.created_at DESC
  `;

  return hub.prepare(sql).all(...params);
}

module.exports = { createTask, syncTasks, completeTask, deleteTask, restoreTask, getCachedTasks };
