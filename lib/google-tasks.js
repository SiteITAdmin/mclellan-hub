'use strict';

const { google } = require('googleapis');
const db = require('./db');
const { uuid } = require('./id');
const { recordEffect, detectFlood } = require('./effect-gate');

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
  const resp = await tasks.tasklists.list({ maxResults: 100 });
  const lists = resp.data.items || [];
  const def = lists.find(l => l.id === '@default') || lists[0];
  return def ? def.id : '@default';
}

// Normalise a title to a slug for matching against project slugs.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Fetch all Google task lists and return [{id, title, slug}].
async function getAllTaskLists(tasks) {
  const resp = await tasks.tasklists.list({ maxResults: 100 });
  return (resp.data.items || []).map(l => ({ id: l.id, title: l.title, slug: slugify(l.title) }));
}

// Get or create a Google Tasks list for a CRM project.
// Stores the list ID on projects.google_task_list_id so subsequent calls are instant.
async function ensureProjectList(user, projectSlug) {
  const hub = db.hub();
  const proj = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?').get(user, projectSlug);
  if (!proj) return null;

  if (proj.google_task_list_id) return proj.google_task_list_id;

  const tasks = getTasksClient(user);
  const allLists = await getAllTaskLists(tasks);

  // Match by slug first, then by stored ID
  const match = allLists.find(l => l.slug === projectSlug) || allLists.find(l => l.slug === slugify(proj.name));
  if (match) {
    hub.prepare('UPDATE projects SET google_task_list_id = ? WHERE user = ? AND slug = ?').run(match.id, user, projectSlug);
    console.log(`[tasks] matched list "${match.title}" → project "${projectSlug}"`);
    return match.id;
  }

  // Create a new Google Tasks list named after the project
  const created = await tasks.tasklists.insert({ requestBody: { title: proj.name } });
  const newId = created.data.id;
  hub.prepare('UPDATE projects SET google_task_list_id = ? WHERE user = ? AND slug = ?').run(newId, user, projectSlug);
  console.log(`[tasks] created Google Tasks list "${proj.name}" → project "${projectSlug}"`);
  return newId;
}

// Returns the next Mon–Fri date after today, in Europe/Dublin timezone, as YYYY-MM-DD.
function nextWorkingDay() {
  const dublinToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin' }).format(new Date());
  const [y, m, d] = dublinToday.split('-').map(Number);
  const next = new Date(y, m - 1, d + 1);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

// Extract the date-only portion to send to Google (API ignores time on due field)
function toGoogleDueDate(isoString) {
  if (!isoString) return undefined;
  // Accept "2026-06-10" or "2026-06-10T14:30" — always send midnight UTC
  const d = isoString.slice(0, 10);
  return `${d}T00:00:00.000Z`;
}

function isNotFoundError(err) {
  return err?.code === 404 || err?.response?.status === 404
    || /not\s*found/i.test(String(err?.message || ''));
}

/**
 * Resolve the Google list a task currently lives on. Preferred list first, then
 * scan all lists — task_list_id can go stale when a task was moved or project
 * reassignment only updated the local cache.
 */
async function resolveTaskListId(tasks, googleTaskId, preferredListId = null) {
  if (preferredListId && preferredListId !== '@default') {
    try {
      await tasks.tasks.get({ tasklist: preferredListId, task: googleTaskId });
      return preferredListId;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }

  const allLists = await getAllTaskLists(tasks);
  for (const list of allLists) {
    if (list.id === preferredListId) continue;
    try {
      await tasks.tasks.get({ tasklist: list.id, task: googleTaskId });
      return list.id;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
    }
  }
  return null;
}

/**
 * Desired Google list for a CRM project assignment. Null project → default list.
 */
async function listIdForProject(user, tasks, projectSlug) {
  if (projectSlug) {
    return (await ensureProjectList(user, projectSlug)) || await getDefaultTaskListId(tasks);
  }
  return getDefaultTaskListId(tasks);
}

/**
 * Move a Google task onto the list that matches its CRM project (or the default
 * list when unassigned). Updates local task_list_id. No-op if already correct.
 */
async function moveTaskToList(user, row, destinationListId, tasks = null) {
  const client = tasks || getTasksClient(user);
  const currentListId = row.task_list_id || await getDefaultTaskListId(client);
  if (!destinationListId || destinationListId === currentListId) {
    return { moved: false, listId: currentListId };
  }

  let fromListId = currentListId;
  try {
    await client.tasks.move({
      tasklist: fromListId,
      task: row.google_task_id,
      destinationTasklist: destinationListId,
    });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    // Stale task_list_id — find the real list then retry the move.
    fromListId = await resolveTaskListId(client, row.google_task_id, null);
    if (!fromListId) throw new Error(`Google task ${row.google_task_id} not found in any list`);
    if (fromListId === destinationListId) {
      db.hub().prepare(
        'UPDATE google_tasks SET task_list_id = ?, synced_at = unixepoch() WHERE id = ?'
      ).run(destinationListId, row.id);
      return { moved: false, listId: destinationListId };
    }
    await client.tasks.move({
      tasklist: fromListId,
      task: row.google_task_id,
      destinationTasklist: destinationListId,
    });
  }

  db.hub().prepare(
    'UPDATE google_tasks SET task_list_id = ?, synced_at = unixepoch() WHERE id = ?'
  ).run(destinationListId, row.id);
  console.log(`[tasks] moved "${row.title}" → list ${destinationListId}`);
  return { moved: true, listId: destinationListId };
}

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a top-level task in Google Tasks and cache it locally.
 */
async function createTask(user, {
  title, notes, due,
  source = 'manual', sourceId = null,
  contactId = null, companyId = null, projectSlug = null,
  // Who is asking for this task, in module terms. Every external effect is
  // recorded against its origin so "why did this task appear?" has exactly one
  // place to look — see lib/effect-gate.js. Undeclared callers fall back to
  // `source` and are counted as unattributed rather than silently absorbed.
  origin = null,
}) {
  const hub = db.hub();
  if (sourceId) {
    const existing = hub.prepare(
      'SELECT id FROM google_tasks WHERE user = ? AND source_id = ? AND source = ?'
    ).get(user, sourceId, source);
    if (existing) {
      console.log(`[tasks] skipping duplicate for ${source}/${sourceId}`);
      recordEffect(user, {
        origin, source, sourceId, title, outcome: 'refused', reason: 'duplicate_source_id',
      });
      return null;
    }
  }

  const tasks = getTasksClient(user);
  const listId = projectSlug
    ? (await ensureProjectList(user, projectSlug) || await getDefaultTaskListId(tasks))
    : await getDefaultTaskListId(tasks);
  // Default to next working day only when no due date is provided at all.
  // An explicit due date — even a past one — is left exactly as supplied.
  const finalDue = due || nextWorkingDay();
  // Every task created through the effect gate is calendar-ready. Existing
  // explicit estimates win; otherwise a visible 30 minute tag is written back
  // to Google Tasks so the default survives sync and is not Hub-only state.
  const finalNotes = withDefaultTaskEffort(notes);
  const body = { title };
  if (finalNotes) body.notes = finalNotes;
  if (finalDue) body.due = toGoogleDueDate(finalDue);

  const resp = await tasks.tasks.insert({ tasklist: listId, requestBody: body });
  const task = resp.data;

  const localId = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, due, deadline, status,
       source, source_id, contact_id, company_id, project_slug, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needsAction', ?, ?, ?, ?, ?, unixepoch())
  `).run(localId, user, task.id, listId, title, finalNotes || null,
    finalDue.slice(0, 10), finalDue,
    source, sourceId || null, contactId, companyId, projectSlug);

  console.log(`[tasks] created "${title}" for ${user} (${source})`);
  recordEffect(user, {
    origin, source, sourceId, title, outcome: 'created', externalId: task.id,
  });
  const flood = detectFlood(user, origin || source || 'unknown');
  if (flood) {
    // Not blocked: a wrong refusal costs Douglas a task he needed, which is
    // worse than one he has to delete. But a burst from one origin is the
    // 3 August signature and must never again be something only he notices.
    console.warn(`[tasks] FLOOD — ${flood.origin} created ${flood.count} tasks in ${flood.windowSeconds}s`);
  }
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
    requestBody: { title, notes: withDefaultTaskEffort('') },
  });
  const task = resp.data;

  const localId = uuid();
  // Subtasks inherit the parent's deadline (local-only column) so they stay
  // synchronised without re-entry; editable per-subtask afterwards.
  hub.prepare(`
    INSERT INTO google_tasks
      (id, user, google_task_id, task_list_id, title, notes, status,
       source, contact_id, company_id, project_slug, parent_id, deadline, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, 'needsAction', 'manual', ?, ?, ?, ?, ?, unixepoch())
  `).run(localId, user, task.id, listId, title, withDefaultTaskEffort(''),
    parent.contact_id, parent.company_id, parent.project_slug, parentLocalId, parent.deadline || null);

  console.log(`[tasks] created subtask "${title}" under ${parent.title}`);
  return { ...task, localId };
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Update a task's fields both in Google Tasks and locally.
 * Only fields present in `fields` are changed.
 *
 * Google Tasks only stores title/notes/due/status. CRM project is represented as
 * which task list the item lives on — changing project_slug moves the task.
 * contact/company/deadline stay Hub-local.
 */
async function updateTask(user, localId, fields) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(localId, user);
  if (!row) throw new Error('Task not found');

  const tasks = getTasksClient(user);
  let listId = row.task_list_id || await getDefaultTaskListId(tasks);

  // Build Google patch body — only send fields that changed
  const patch = {};
  if ('title' in fields) patch.title = fields.title;
  if ('notes' in fields) patch.notes = fields.notes || '';
  if ('due' in fields) patch.due = fields.due ? toGoogleDueDate(fields.due) : null;

  if (Object.keys(patch).length) {
    try {
      await tasks.tasks.patch({ tasklist: listId, task: row.google_task_id, requestBody: patch });
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const resolved = await resolveTaskListId(tasks, row.google_task_id, null);
      if (!resolved) throw err;
      listId = resolved;
      await tasks.tasks.patch({ tasklist: listId, task: row.google_task_id, requestBody: patch });
      hub.prepare(
        'UPDATE google_tasks SET task_list_id = ? WHERE id = ?'
      ).run(listId, localId);
    }
  }

  // Project ↔ Google list. Reconcile when the project field is edited, or when
  // a CRM project is already set but the task still sits on the wrong list.
  // Do not yank unassigned tasks off a project list on an unrelated edit.
  const effectiveSlug = 'projectSlug' in fields ? (fields.projectSlug || null) : (row.project_slug || null);
  const shouldReconcileList = 'projectSlug' in fields || Boolean(effectiveSlug);
  if (shouldReconcileList) {
    const desiredListId = await listIdForProject(user, tasks, effectiveSlug);
    if (desiredListId && desiredListId !== listId) {
      const moved = await moveTaskToList(user, { ...row, task_list_id: listId }, desiredListId, tasks);
      listId = moved.listId;
    }
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
  if (listId !== row.task_list_id) {
    setClauses.push('task_list_id = ?');
    params.push(listId);
  }

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

  // Fetch all lists and build a slug → listId mapping from CRM projects
  const allLists = await getAllTaskLists(tasks);

  // Build listId → project_slug map: prefer stored mapping, fall back to slug match
  const projects = hub.prepare('SELECT slug, name, google_task_list_id FROM projects WHERE user = ?').all(user);
  const listToProject = {};
  for (const p of projects) {
    if (p.google_task_list_id) {
      listToProject[p.google_task_list_id] = p.slug;
    }
  }
  for (const l of allLists) {
    if (!listToProject[l.id]) {
      const match = projects.find(p => p.slug === l.slug || slugify(p.name) === l.slug);
      if (match) {
        listToProject[l.id] = match.slug;
        // Persist the mapping for next time
        hub.prepare('UPDATE projects SET google_task_list_id = ? WHERE user = ? AND slug = ?')
          .run(l.id, user, match.slug);
      }
    }
  }

  // Sync every list; track all Google IDs seen across lists for completion detection
  const allSeenIds = [];
  const allParentRefs = {}; // googleTaskId → parentGoogleTaskId (for second-pass resolution)
  let totalItems = 0;

  // Build a map of googleTaskId → local row for parent resolution (shared across lists)
  const localByGoogleId = {};
  for (const row of hub.prepare('SELECT id, google_task_id FROM google_tasks WHERE user = ?').all(user)) {
    localByGoogleId[row.google_task_id] = row.id;
  }

  for (const list of allLists) {
    const resp = await tasks.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      showHidden: false,
      maxResults: 100,
    });
    const items = resp.data.items || [];
    const projectSlug = listToProject[list.id] || null;

    for (const id of items.map(t => t.id)) allSeenIds.push(id);
    totalItems += items.length;

    for (const t of items) {
      if (t.parent) allParentRefs[t.id] = t.parent;
      const parentLocalId = t.parent ? (localByGoogleId[t.parent] || null) : null;
      const existing = hub.prepare('SELECT id, project_slug FROM google_tasks WHERE google_task_id = ?').get(t.id);

      if (existing) {
        hub.prepare(`
          UPDATE google_tasks
          SET title = ?, notes = ?, due = ?,
              status = CASE WHEN status = 'wrong' THEN 'wrong' ELSE 'needsAction' END,
              completed_at = CASE WHEN status = 'wrong' THEN completed_at ELSE NULL END,
              task_list_id = ?,
              project_slug = COALESCE(project_slug, ?),
              parent_id = COALESCE(parent_id, ?), position = ?, synced_at = unixepoch()
          WHERE google_task_id = ?
        `).run(t.title || '(untitled)', t.notes || null, t.due ? t.due.slice(0, 10) : null,
          list.id, projectSlug, parentLocalId, t.position || null, t.id);
      } else {
        const localId = uuid();
        hub.prepare(`
          INSERT INTO google_tasks
            (id, user, google_task_id, task_list_id, title, notes, due, status, source,
             project_slug, parent_id, position, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'needsAction', 'google', ?, ?, ?, unixepoch())
        `).run(localId, user, t.id, list.id,
          t.title || '(untitled)', t.notes || null, t.due ? t.due.slice(0, 10) : null,
          projectSlug, parentLocalId, t.position || null);
        localByGoogleId[t.id] = localId;
      }
    }
  }

  // Mark locally-open tasks as completed if absent from all Google lists
  hub.prepare(`
    UPDATE google_tasks
       SET status = 'completed',
           completed_at = COALESCE(completed_at, unixepoch())
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
      AND google_task_id NOT IN (SELECT value FROM json_each(?))
  `).run(user, JSON.stringify(allSeenIds));

  // Second pass: resolve parents for tasks whose parent was first seen in the same sync
  const setParent = hub.prepare('UPDATE google_tasks SET parent_id = ? WHERE user = ? AND google_task_id = ?');
  for (const [googleId, parentGoogleId] of Object.entries(allParentRefs)) {
    const parentLocalId = localByGoogleId[parentGoogleId] || null;
    setParent.run(parentLocalId, user, googleId);
  }

  console.log(`[tasks] synced ${totalItems} task(s) across ${allLists.length} list(s) for ${user}`);
  return allSeenIds.map(id => ({ id }));
}

// ── Complete / Delete / Restore ───────────────────────────────────────────────

async function completeTask(user, googleTaskId) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT id, task_list_id, title FROM google_tasks WHERE user = ? AND google_task_id = ?'
  ).get(user, googleTaskId);
  const tasks = getTasksClient(user);
  let listId = row?.task_list_id || await getDefaultTaskListId(tasks);

  try {
    await tasks.tasks.patch({
      tasklist: listId,
      task: googleTaskId,
      requestBody: { status: 'completed' },
    });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    const resolved = await resolveTaskListId(tasks, googleTaskId, null);
    if (!resolved) throw err;
    listId = resolved;
    await tasks.tasks.patch({
      tasklist: listId,
      task: googleTaskId,
      requestBody: { status: 'completed' },
    });
    if (row?.id) {
      hub.prepare('UPDATE google_tasks SET task_list_id = ? WHERE id = ?').run(listId, row.id);
    }
  }

  hub.prepare(`
    UPDATE google_tasks
       SET status = 'completed', completed_at = COALESCE(completed_at, unixepoch())
     WHERE google_task_id = ?
  `).run(googleTaskId);
  console.log(`[tasks] completed ${googleTaskId} for ${user}`);
}

/**
 * Soft-delete in the Hub AND remove the open item from Google Tasks.
 * Restore re-creates the remote task so undo still works.
 */
async function deleteTask(user, localId) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(localId, user);
  if (!row) return false;

  let remoteDeleted = false;
  let remoteError = null;
  if (row.google_task_id && row.status === 'needsAction') {
    try {
      const tasks = getTasksClient(user);
      let listId = row.task_list_id || await getDefaultTaskListId(tasks);
      try {
        await tasks.tasks.delete({ tasklist: listId, task: row.google_task_id });
        remoteDeleted = true;
      } catch (err) {
        if (!isNotFoundError(err)) throw err;
        const resolved = await resolveTaskListId(tasks, row.google_task_id, null);
        if (!resolved) {
          // Already gone remotely — treat as success.
          remoteDeleted = true;
        } else {
          await tasks.tasks.delete({ tasklist: resolved, task: row.google_task_id });
          remoteDeleted = true;
        }
      }
    } catch (err) {
      remoteError = err.message;
      console.warn(`[tasks] remote delete failed for ${localId}:`, err.message);
    }
  } else {
    remoteDeleted = true;
  }

  hub.prepare(
    'UPDATE google_tasks SET deleted_at = unixepoch() WHERE id = ? AND user = ?'
  ).run(localId, user);

  if (remoteError) {
    console.warn(`[tasks] soft-deleted ${localId} locally; Google still open: ${remoteError}`);
  } else {
    console.log(`[tasks] deleted "${row.title}" for ${user} (remote=${remoteDeleted})`);
  }
  return true;
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
    let listId = row.task_list_id || await getDefaultTaskListId(tasks);
    try {
      await tasks.tasks.delete({
        tasklist: listId,
        task: row.google_task_id,
      });
      remoteDeleted = true;
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      const resolved = await resolveTaskListId(tasks, row.google_task_id, null);
      if (!resolved) {
        remoteDeleted = true;
      } else {
        await tasks.tasks.delete({ tasklist: resolved, task: row.google_task_id });
        remoteDeleted = true;
      }
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      remoteDeleted = true;
    } else {
      remoteError = err.message;
    }
  }

  hub.prepare(`
    UPDATE google_tasks
       SET deleted_at = unixepoch(),
           status = ?,
           completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, unixepoch()) ELSE completed_at END
     WHERE id = ? AND user = ?
  `).run(status, status, localId, user);
  return { ok: true, remoteDeleted, remoteError };
}

/**
 * Restore a soft-deleted task. Re-inserts into Google Tasks when the remote
 * copy was removed by deleteTask, then rewrites google_task_id / task_list_id.
 */
async function restoreTask(user, localId) {
  const hub = db.hub();
  const row = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(localId, user);
  if (!row) return false;

  const tasks = getTasksClient(user);
  const listId = row.project_slug
    ? (await ensureProjectList(user, row.project_slug) || await getDefaultTaskListId(tasks))
    : await getDefaultTaskListId(tasks);

  // Prefer reusing the existing Google task if it still exists (e.g. remote
  // delete failed earlier). Otherwise insert a fresh one.
  let googleTaskId = row.google_task_id;
  let resolvedList = await resolveTaskListId(tasks, googleTaskId, listId);
  if (!resolvedList) {
    const body = { title: row.title, status: row.status === 'completed' ? 'completed' : 'needsAction' };
    if (row.notes) body.notes = row.notes;
    if (row.due) body.due = toGoogleDueDate(row.due);
    const resp = await tasks.tasks.insert({ tasklist: listId, requestBody: body });
    googleTaskId = resp.data.id;
    resolvedList = listId;
    console.log(`[tasks] re-created remote task for restore "${row.title}" → ${googleTaskId}`);
  } else if (resolvedList !== listId && row.project_slug) {
    // Still on an old list — put it where the project says it belongs.
    await tasks.tasks.move({
      tasklist: resolvedList,
      task: googleTaskId,
      destinationTasklist: listId,
    });
    resolvedList = listId;
  }

  hub.prepare(`
    UPDATE google_tasks
       SET deleted_at = NULL,
           google_task_id = ?,
           task_list_id = ?,
           synced_at = unixepoch()
     WHERE id = ? AND user = ?
  `).run(googleTaskId, resolvedList, localId, user);
  console.log(`[tasks] restored "${row.title}" for ${user}`);
  return true;
}

/**
 * One-shot repair: move open tasks onto the Google list that matches their CRM
 * project, and remove remotely any tasks the Hub has soft-deleted.
 * Returns counts for logging / admin use.
 */
async function repairTaskGoogleSync(user) {
  const hub = db.hub();
  const tasks = getTasksClient(user);
  const summary = { moved: 0, alreadyOk: 0, moveErrors: 0, purged: 0, purgeErrors: 0, purgeSkipped: 0 };

  const open = hub.prepare(`
    SELECT t.*, p.google_task_list_id AS project_list_id
    FROM google_tasks t
    LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
    WHERE t.user = ? AND t.status = 'needsAction' AND t.deleted_at IS NULL AND t.parent_id IS NULL
  `).all(user);

  for (const row of open) {
    try {
      const desired = row.project_slug
        ? (row.project_list_id || await ensureProjectList(user, row.project_slug) || await getDefaultTaskListId(tasks))
        : await getDefaultTaskListId(tasks);
      if (!desired || desired === row.task_list_id) {
        summary.alreadyOk++;
        continue;
      }
      await moveTaskToList(user, row, desired, tasks);
      summary.moved++;
    } catch (err) {
      summary.moveErrors++;
      console.warn(`[tasks] repair move failed for ${row.id}:`, err.message);
    }
  }

  // Soft-deleted open tasks should not still sit on Google. Prefer a bulk list
  // index; fall back to per-task resolve because list() can miss items that
  // get() still returns (hidden/parent edge cases).
  const softDeleted = hub.prepare(`
    SELECT * FROM google_tasks
    WHERE user = ? AND deleted_at IS NOT NULL AND status = 'needsAction'
      AND google_task_id IS NOT NULL
  `).all(user);

  const openRemote = new Map(); // googleTaskId → listId
  const allLists = await getAllTaskLists(tasks);
  for (const list of allLists) {
    for (const showHidden of [false, true]) {
      let pageToken;
      do {
        const resp = await tasks.tasks.list({
          tasklist: list.id,
          showCompleted: false,
          showHidden,
          maxResults: 100,
          pageToken,
        });
        for (const t of resp.data.items || []) {
          if ((t.status || 'needsAction') === 'needsAction') openRemote.set(t.id, list.id);
        }
        pageToken = resp.data.nextPageToken;
      } while (pageToken);
    }
  }

  for (const row of softDeleted) {
    let listId = openRemote.get(row.google_task_id) || null;
    if (!listId) {
      try {
        listId = await resolveTaskListId(tasks, row.google_task_id, row.task_list_id);
      } catch (err) {
        summary.purgeErrors++;
        console.warn(`[tasks] purge resolve failed for ${row.id}:`, err.message);
        continue;
      }
    }
    if (!listId) {
      summary.purgeSkipped++;
      continue;
    }
    try {
      await tasks.tasks.delete({ tasklist: listId, task: row.google_task_id });
      summary.purged++;
    } catch (err) {
      if (isNotFoundError(err)) {
        summary.purgeSkipped++;
      } else {
        summary.purgeErrors++;
        console.warn(`[tasks] purge failed for ${row.id}:`, err.message);
      }
    }
  }

  console.log(`[tasks] repair for ${user}:`, summary);
  return summary;
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
// Priority/effort/planner lane live as structured tags inside the task's notes
// field ("[priority: high] [effort: 30m] [planner: work]") rather than columns: tags round-trip
// through the Google Tasks API, survive sync, and stay visible in any Google
// client — agreed knowledge-over-tables approach, 6 Jul 2026.
// `after` carries a planner dependency: a task may only start after a linked
// calendar event finishes ("[after: cal:<eventId>]") or after a fixed local
// time ("[after: 2026-08-11T15:00]"). Its value is kept raw (case + 'T'), not
// lowercased like the others, because event IDs and datetimes are case/format
// sensitive.
const TASK_TAG_RE = /\[\s*(priority|effort|planner|after)\s*:\s*([^\]]+)\]/gi;

function parseTaskTags(notes) {
  const tags = { priority: null, effort_minutes: null, planner_lane: null, after: null };
  String(notes || '').replace(TASK_TAG_RE, (_, key, value) => {
    const raw = String(value).trim();
    const v = raw.toLowerCase();
    const k = key.toLowerCase();
    if (k === 'priority' && ['low', 'medium', 'high'].includes(v)) tags.priority = v;
    else if (k === 'effort') {
      const m = v.match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)?$/);
      if (m) tags.effort_minutes = m[2] && m[2].startsWith('h') ? parseInt(m[1], 10) * 60 : parseInt(m[1], 10);
    }
    else if (k === 'planner' && ['work', 'personal'].includes(v)) tags.planner_lane = v;
    else if (k === 'after' && raw) tags.after = raw;
    return '';
  });
  return tags;
}

function stripTaskTags(notes) {
  return String(notes || '').replace(TASK_TAG_RE, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function withTaskTags(notes, { priority, effortMinutes, plannerLane, after } = {}) {
  const existing = parseTaskTags(notes);
  const base = stripTaskTags(notes);
  const tags = [];
  if (priority && ['low', 'medium', 'high'].includes(priority)) tags.push(`[priority: ${priority}]`);
  const effort = parseInt(effortMinutes, 10);
  if (Number.isFinite(effort) && effort > 0) tags.push(`[effort: ${effort}m]`);
  // Most existing callers edit only priority/effort. Preserve planner lane and
  // the after-dependency unless the caller explicitly supplies them.
  const lane = plannerLane === undefined ? existing.planner_lane : String(plannerLane || '').toLowerCase();
  if (['work', 'personal'].includes(lane)) tags.push(`[planner: ${lane}]`);
  const dependency = after === undefined ? existing.after : (after ? String(after).trim() : null);
  if (dependency) tags.push(`[after: ${dependency}]`);
  return [base, tags.join(' ')].filter(Boolean).join('\n\n');
}

function withPlannerTag(notes, plannerLane = null) {
  const current = parseTaskTags(notes);
  return withTaskTags(notes, {
    priority: current.priority,
    effortMinutes: current.effort_minutes,
    plannerLane,
  });
}

function withDefaultTaskEffort(notes) {
  const current = parseTaskTags(notes);
  if (current.effort_minutes) return String(notes || '');
  return withTaskTags(notes, {
    priority: current.priority,
    effortMinutes: 30,
    plannerLane: current.planner_lane,
  });
}

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

  const rows = hub.prepare(`
    SELECT t.*,
      c.name AS contact_name,
      co.name AS company_name,
      p.name AS project_name
    FROM google_tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE t.status WHEN 'needsAction' THEN 0 ELSE 1 END,
      t.deleted_at IS NOT NULL,
      t.due ASC NULLS LAST,
      t.created_at DESC
  `).all(...params);

  const subCounts = new Map(hub.prepare(`
    SELECT parent_id,
      SUM(CASE WHEN status = 'needsAction' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS open,
      COUNT(*) AS total
    FROM google_tasks WHERE user = ? AND parent_id IS NOT NULL GROUP BY parent_id
  `).all(user).map(r => [r.parent_id, r]));

  return rows.map(row => {
    const sub = subCounts.get(row.id);
    return {
      ...row,
      ...parseTaskTags(row.notes),
      notes_preview: stripTaskTags(row.notes).split('\n')[0].slice(0, 120),
      subtask_open: sub?.open || 0,
      subtask_total: sub?.total || 0,
    };
  });
}

// Set a due date on every open task that currently has none.
// Updates both Google Tasks API and the local cache so sync doesn't overwrite.
// Returns { updated, skipped, errors }.
async function backfillDueDates(user, dueDate) {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id FROM google_tasks
     WHERE user = ? AND status = 'needsAction'
       AND due IS NULL AND deleted_at IS NULL
  `).all(user);

  let updated = 0, skipped = 0, errors = 0;
  for (const row of rows) {
    try {
      await updateTask(user, row.id, { due: dueDate });
      updated++;
    } catch (err) {
      console.warn(`[tasks] backfill failed for ${row.id}:`, err.message);
      errors++;
    }
  }
  return { updated, skipped, errors };
}

module.exports = {
  createTask, createSubtask, updateTask,
  syncTasks, completeTask, deleteTask, deleteTaskEverywhere, restoreTask,
  getTask, getCachedTasks, backfillDueDates, nextWorkingDay,
  ensureProjectList, getAllTaskLists, repairTaskGoogleSync,
  parseTaskTags, stripTaskTags, withTaskTags, withPlannerTag, withDefaultTaskEffort,
  // test hooks
  _test: { isNotFoundError, toGoogleDueDate, slugify },
};
