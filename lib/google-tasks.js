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

// Extract the date-only portion to send to Google (API ignores time on due field)
function toGoogleDueDate(isoString) {
  if (!isoString) return undefined;
  // Accept "2026-06-10" or "2026-06-10T14:30" — always send midnight UTC
  const d = isoString.slice(0, 10);
  return `${d}T00:00:00.000Z`;
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a top-level task in Google Tasks and cache it locally.
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
      console.log(`[tasks] skipping duplicate for ${source}/${sourceId}`);
      return null;
    }
  }

  const tasks = getTasksClient(user);
  const listId = await getDefaultTaskListId(tasks);
  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = toGoogleDueDate(due);

  const resp = await tasks.tasks.insert({ tasklist: listId, requestBody: body });
  const task = resp.data;

  const localId = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, deadline, status,
       source, source_id, contact_id, company_id, project_slug, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needsAction', ?, ?, ?, ?, ?, unixepoch())
  `).run(localId, user, task.id, listId, title, notes || null,
    due ? due.slice(0, 10) : null, due || null,
    source, sourceId || null, contactId, companyId, projectSlug);

  console.log(`[tasks] created "${title}" for ${user} (${source})`);
  return { ...task, localId };
}

/**
 * Create a subtask under a parent task.
 */
async function createSubtask(user, parentLocalId, title) {
  const hub = db.hub();
  const parent = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(parentLocalId, user);
  if (!parent) throw new Error('Parent task not found');

  const tasks = getTasksClient(user);
  const listId = parent.task_list_id || await getDefaultTaskListId(tasks);

  const resp = await tasks.tasks.insert({
    tasklist: listId,
    parent: parent.google_task_id,
    requestBody: { title },
  });
  const task = resp.data;

  const localId = uuid();
  hub.prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, status,
       source, contact_id, company_id, project_slug, parent_id, synced_at)
    VALUES (?, ?, ?, ?, ?, 'needsAction', 'manual', ?, ?, ?, ?, unixepoch())
  `).run(localId, user, task.id, listId, title,
    parent.contact_id, parent.company_id, parent.project_slug, parentLocalId);

  console.log(`[tasks] created subtask "${title}" under ${parent.title}`);
  return { ...task, localId };
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Update a task's fields both in Google Tasks and locally.
 * Only fields present in `fields` are changed.
 */
async function updateTask(user, localId, fields) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(localId, user);
  if (!row) throw new Error('Task not found');

  const tasks = getTasksClient(user);
  const listId = row.task_list_id || await getDefaultTaskListId(tasks);

  // Build Google patch body — only send fields that changed
  const patch = {};
  if ('title' in fields) patch.title = fields.title;
  if ('notes' in fields) patch.notes = fields.notes || '';
  if ('due' in fields) patch.due = fields.due ? toGoogleDueDate(fields.due) : null;

  if (Object.keys(patch).length) {
    await tasks.tasks.patch({ tasklist: listId, task: row.google_task_id, requestBody: patch });
  }

  // Update local cache
  const setClauses = [];
  const params = [];

  if ('title' in fields) { setClauses.push('title = ?'); params.push(fields.title); }
  if ('notes' in fields) { setClauses.push('notes = ?'); params.push(fields.notes || null); }
  if ('due' in fields) {
    setClauses.push('due = ?');
    params.push(fields.due ? fields.due.slice(0, 10) : null);
  }
  if ('deadline' in fields) { setClauses.push('deadline = ?'); params.push(fields.deadline || null); }
  if ('contactId' in fields) { setClauses.push('contact_id = ?'); params.push(fields.contactId || null); }
  if ('companyId' in fields) { setClauses.push('company_id = ?'); params.push(fields.companyId || null); }
  if ('projectSlug' in fields) { setClauses.push('project_slug = ?'); params.push(fields.projectSlug || null); }

  if (setClauses.length) {
    setClauses.push('synced_at = unixepoch()');
    params.push(localId);
    hub.prepare(`UPDATE google_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
  }

  console.log(`[tasks] updated "${fields.title || row.title}" for ${user}`);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Full pull from Google Tasks. Updates local cache, detects subtasks via `parent` field.
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

  // Mark locally-open tasks as completed if they've left Google
  hub.prepare(`
    UPDATE google_tasks SET status = 'completed'
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
    AND google_task_id NOT IN (SELECT value FROM json_each(?))
  `).run(user, JSON.stringify(currentIds));

  // Build a map of googleTaskId → local row for parent resolution
  const localByGoogleId = {};
  for (const row of hub.prepare('SELECT id, google_task_id FROM google_tasks WHERE user = ?').all(user)) {
    localByGoogleId[row.google_task_id] = row.id;
  }

  for (const t of items) {
    const parentLocalId = t.parent ? (localByGoogleId[t.parent] || null) : null;
    const existing = hub.prepare('SELECT id FROM google_tasks WHERE google_task_id = ?').get(t.id);

    if (existing) {
      hub.prepare(`
        UPDATE google_tasks
        SET title = ?, notes = ?, due = ?,
            status = CASE WHEN status = 'wrong' THEN 'wrong' ELSE 'needsAction' END,
            parent_id = COALESCE(parent_id, ?), position = ?, synced_at = unixepoch()
        WHERE google_task_id = ?
      `).run(t.title || '(untitled)', t.notes || null, t.due ? t.due.slice(0, 10) : null,
        parentLocalId, t.position || null, t.id);
    } else {
      hub.prepare(`
        INSERT INTO google_tasks
          (id, user, google_task_id, task_list_id, title, notes, due, status, source, parent_id, position, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'needsAction', 'google', ?, ?, unixepoch())
      `).run(uuid(), user, t.id, listId,
        t.title || '(untitled)', t.notes || null, t.due ? t.due.slice(0, 10) : null,
        parentLocalId, t.position || null);
    }
  }

  // Resolve hierarchy again after inserts so a newly imported child can find
  // a parent that was also first seen during this sync.
  const refreshedByGoogleId = {};
  for (const row of hub.prepare('SELECT id, google_task_id FROM google_tasks WHERE user = ?').all(user)) {
    refreshedByGoogleId[row.google_task_id] = row.id;
  }
  const setParent = hub.prepare(
    'UPDATE google_tasks SET parent_id = ? WHERE user = ? AND google_task_id = ?'
  );
  for (const t of items) {
    setParent.run(t.parent ? (refreshedByGoogleId[t.parent] || null) : null, user, t.id);
  }

  console.log(`[tasks] synced ${items.length} task(s) for ${user}`);
  return items;
}

// ── Complete / Delete / Restore ───────────────────────────────────────────────

async function completeTask(user, googleTaskId) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT task_list_id FROM google_tasks WHERE user = ? AND google_task_id = ?'
  ).get(user, googleTaskId);
  const tasks = getTasksClient(user);
  const listId = row?.task_list_id || '@default';
  await tasks.tasks.patch({ tasklist: listId, task: googleTaskId, requestBody: { status: 'completed' } });
  hub.prepare("UPDATE google_tasks SET status = 'completed' WHERE google_task_id = ?").run(googleTaskId);
  console.log(`[tasks] completed ${googleTaskId} for ${user}`);
}

function deleteTask(user, localId) {
  const result = db.hub().prepare(
    'UPDATE google_tasks SET deleted_at = unixepoch() WHERE id = ? AND user = ?'
  ).run(localId, user);
  return result.changes > 0;
}

async function deleteTaskEverywhere(user, localId, { status = 'completed' } = {}) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(localId, user);
  if (!row) return { ok: false, notFound: true };

  let remoteDeleted = false;
  let remoteError = null;
  try {
    const tasks = getTasksClient(user);
    await tasks.tasks.delete({
      tasklist: row.task_list_id || '@default',
      task: row.google_task_id,
    });
    remoteDeleted = true;
  } catch (err) {
    if (err.code === 404 || err.response?.status === 404) {
      remoteDeleted = true;
    } else {
      remoteError = err.message;
    }
  }

  hub.prepare(`
    UPDATE google_tasks
       SET deleted_at = unixepoch(), status = ?
     WHERE id = ? AND user = ?
  `).run(status, localId, user);
  return { ok: true, remoteDeleted, remoteError };
}

function restoreTask(user, localId) {
  const result = db.hub().prepare(
    'UPDATE google_tasks SET deleted_at = NULL WHERE id = ? AND user = ?'
  ).run(localId, user);
  return result.changes > 0;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Get a single task with its subtasks and associated CRM objects.
 */
function getTask(user, localId) {
  const hub = db.hub();
  const task = hub.prepare(`
    SELECT t.*,
      c.name AS contact_name,
      co.name AS company_name
    FROM google_tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN companies co ON co.id = t.company_id
    WHERE t.id = ? AND t.user = ?
  `).get(localId, user);
  if (!task) return null;

  task.subtasks = hub.prepare(`
    SELECT * FROM google_tasks
    WHERE parent_id = ? AND user = ?
    ORDER BY
      CASE status WHEN 'needsAction' THEN 0 ELSE 1 END,
      deleted_at IS NOT NULL,
      position ASC,
      created_at ASC
  `).all(localId, user);

  return task;
}

/**
 * Get open (and optionally historical) tasks from local cache.
 */
function getCachedTasks(user, filter = {}, includeHistory = false) {
  const hub = db.hub();
  const conditions = ['t.user = ?', 't.parent_id IS NULL']; // top-level only
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
    conditions.push(`(t.company_id = ? OR t.contact_id IN (
      SELECT contact_id FROM contact_companies WHERE company_id = ?
    ))`);
    params.push(filter.companyId, filter.companyId);
  }
  if (filter.projectSlug) {
    conditions.push('t.project_slug = ?');
    params.push(filter.projectSlug);
  }

  return hub.prepare(`
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
  `).all(...params);
}

module.exports = {
  createTask, createSubtask, updateTask,
  syncTasks, completeTask, deleteTask, deleteTaskEverywhere, restoreTask,
  getTask, getCachedTasks,
};
