'use strict';

const { crm, now, setting, setSetting, SPACES } = require('./db');
const { uuid } = require('../id');
const tasks = require('./tasks');
const runs = require('./runs');
const FIELDS = ['title', 'notes', 'due', 'status'];
const options = { timeout: 30000, retry: false };
const code = e => Number(e.response?.status || e.code);

async function pages(fn, params, renew = () => {}) {
  let pageToken;
  const items = [];
  do {
    renew();
    const { data } = await fn({ ...params, maxResults: 100, pageToken }, options);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

async function effect(entityId, operation, request, fn) {
  const id = uuid();
  crm().prepare("INSERT INTO effects (id, module, entity_id, operation, request, status) VALUES (?, 'crm_tasks_sync', ?, ?, ?, 'started')")
    .run(id, entityId, operation, JSON.stringify(request));
  try {
    const result = await fn();
    crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify(result?.data || {}), now(), id);
    return result?.data || {};
  } catch (err) {
    const definite = code(err) >= 400 && code(err) < 500 && code(err) !== 408;
    crm().prepare('UPDATE effects SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(definite ? 'failed' : 'uncertain', String(err.message).slice(0, 500), now(), id);
    throw err;
  }
}

function unresolvedInsert(entityId, operation) {
  return crm().prepare("SELECT * FROM effects WHERE entity_id = ? AND operation = ? AND status IN ('started','uncertain','done') ORDER BY created_at DESC LIMIT 1")
    .get(entityId, operation);
}

async function ensureLists(api, renew) {
  const all = await pages(api.tasklists.list.bind(api.tasklists), {}, renew);
  const lists = {};
  for (const space of SPACES) {
    const key = `tasks_list:${space}`, saved = setting(key);
    if (saved) {
      if (!all.some(x => x.id === saved)) throw new Error(`${space} Google Tasks list is missing. Restore the list or choose a replacement; tasks will not be recreated automatically.`);
      lists[space] = saved;
      continue;
    }
    const title = space === 'work' ? 'Work' : 'Personal';
    const found = all.filter(x => x.title === title);
    if (found.length > 1) throw new Error(`More than one Google Tasks list is named ${title}. Rename the extra list before syncing.`);
    let list = found[0];
    if (!list) {
      if (unresolvedInsert(space, 'list.insert')) throw new Error(`Creation of the ${title} list needs checking after an interrupted request; no duplicate was created.`);
      renew();
      list = await effect(space, 'list.insert', { title }, () => api.tasklists.insert({ requestBody: { title } }, options));
    }
    setSetting(key, list.id);
    lists[space] = list.id;
  }
  return lists;
}

function reconcile(t, remote) {
  const incoming = tasks.remoteFields(remote, t);
  const base = t.remote_json ? tasks.remoteFields(JSON.parse(t.remote_json), t) : incoming;
  const merged = {}, conflicts = JSON.parse(t.conflict || '{}');
  for (const key of FIELDS) {
    const localChanged = t[key] !== base[key], remoteChanged = incoming[key] !== base[key];
    merged[key] = remoteChanged ? incoming[key] : t[key];
    if (localChanged && remoteChanged && t[key] !== incoming[key]) conflicts[key] = { hub: t[key], google: incoming[key] };
  }
  // A deletion is terminal, including when a stale local edit is waiting.
  if (t.status === 'deleted' || incoming.status === 'deleted') merged.status = 'deleted';
  const changed = FIELDS.some(k => merged[k] !== t[k]);
  const revision = t.revision + (changed ? 1 : 0);
  const clean = t.revision === t.synced_revision || incoming.status === 'deleted';
  crm().transaction(() => {
    crm().prepare(`UPDATE tasks SET title = ?, notes = ?, due = ?, status = ?, remote_json = ?, revision = ?,
      synced_revision = ?, synced_at = ?, conflict = ?, sync_error = '' WHERE id = ?`)
      .run(merged.title, merged.notes, merged.due, merged.status, JSON.stringify(remote), revision,
        clean ? revision : t.synced_revision, now(), Object.keys(conflicts).length ? JSON.stringify(conflicts) : t.conflict, t.id);
    if (changed) tasks.snapshot(t.id);
  })();
  return tasks.get(t.id);
}

function acknowledge(sent, remote, listId) {
  crm().prepare(`UPDATE tasks SET google_list_id = ?, google_id = ?, remote_json = ?, synced_revision = ?, synced_at = ?, sync_error = '' WHERE id = ?`)
    .run(listId, remote.id || sent.google_id, JSON.stringify(remote), sent.revision, now(), sent.id);
}

function importTask(space, listId, remote) {
  if (remote.deleted) return null;
  // Google permits longer notes than the Hub editor's reserved-link allowance.
  const f = tasks.remoteFields(remote);
  const id = uuid();
  crm().transaction(() => {
    crm().prepare(`INSERT INTO tasks (id, space, title, notes, due, status, origin, google_list_id, google_id, remote_json, synced_revision, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, 'google', ?, ?, ?, 1, ?)`)
      .run(id, space, f.title, f.notes, f.due, f.status, listId, remote.id, JSON.stringify(remote), now());
    tasks.snapshot(id);
  })();
  return tasks.get(id);
}

async function syncList(api, space, listId, renew) {
  const remotes = await pages(api.tasks.list.bind(api.tasks), { tasklist: listId, showCompleted: true, showHidden: true, showDeleted: true }, renew);
  const seen = new Set();
  for (const remote of remotes) {
    seen.add(remote.id);
    let t = crm().prepare('SELECT * FROM tasks WHERE google_list_id = ? AND google_id = ?').get(listId, remote.id);
    if (!t) {
      const match = (remote.notes || '').match(/\[Hub task ([a-zA-Z0-9-]+)\]/);
      const candidate = match && tasks.get(match[1]);
      if (candidate && candidate.space === space && !candidate.google_id && unresolvedInsert(candidate.id, 'task.insert')) {
        const insertion = unresolvedInsert(candidate.id, 'task.insert');
        const request = JSON.parse(insertion.request);
        // The request snapshot, not today's edit, is the common ancestor.
        acknowledge({ ...candidate, revision: request.revision }, remote, listId);
        t = tasks.get(candidate.id);
        crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?")
          .run(JSON.stringify(remote), now(), insertion.id);
      }
    }
    if (t) reconcile(t, remote);
    else importTask(space, listId, remote);
  }

  const ids = crm().prepare('SELECT id FROM tasks WHERE space = ?').all(space);
  const errors = [];
  for (const { id } of ids) {
    try {
      let t = tasks.get(id);
      // A full scan can omit old tombstones. Confirm individually, never infer
      // deletion from an incomplete page or a failed list request.
      if (t.google_id && !seen.has(t.google_id) && t.status !== 'deleted') {
        renew();
        try {
          const r = await api.tasks.get({ tasklist: listId, task: t.google_id }, options);
          t = reconcile(tasks.get(id), r.data);
        } catch (err) {
          if (![404, 410].includes(code(err))) throw err;
          t = reconcile(tasks.get(id), { ...JSON.parse(t.remote_json || '{}'), id: t.google_id, deleted: true });
        }
      }
      if (t.revision === t.synced_revision) continue;
      renew();
      if (!t.google_id) {
        if (t.status === 'deleted' && !unresolvedInsert(id, 'task.insert')) {
          crm().prepare('UPDATE tasks SET synced_revision = revision, synced_at = ? WHERE id = ?').run(now(), id);
          continue;
        }
        if (unresolvedInsert(id, 'task.insert')) throw new Error('An interrupted Google create needs checking. Automatic recreation is paused to avoid a duplicate.');
        const body = tasks.payload(t);
        const remote = await effect(id, 'task.insert', { tasklist: listId, requestBody: body, revision: t.revision },
          () => api.tasks.insert({ tasklist: listId, requestBody: body }, options));
        acknowledge(t, remote, listId);
      } else if (t.status === 'deleted') {
        await effect(id, 'task.delete', { tasklist: listId, task: t.google_id }, async () => {
          try { return await api.tasks.delete({ tasklist: listId, task: t.google_id }, { ...options, headers: { 'If-Match': JSON.parse(t.remote_json).etag } }); }
          catch (err) { if (![404, 410].includes(code(err))) throw err; return { data: {} }; }
        });
        acknowledge(t, { ...JSON.parse(t.remote_json), deleted: true }, listId);
      } else {
        const body = tasks.payload(t);
        const remote = await effect(id, 'task.patch', { tasklist: listId, task: t.google_id, requestBody: body },
          () => api.tasks.patch({ tasklist: listId, task: t.google_id, requestBody: body },
            { ...options, headers: { 'If-Match': JSON.parse(t.remote_json).etag } }));
        acknowledge(t, remote, listId);
      }
    } catch (err) {
      const message = code(err) === 412 ? 'Google changed during sync; both versions will be checked on the next pass.' : String(err.message).slice(0, 400);
      crm().prepare('UPDATE tasks SET sync_error = ? WHERE id = ?').run(message, id);
      errors.push(message);
    }
  }
  if (errors.length) throw new Error(`${space}: ${errors.length} task(s) need sync attention. ${errors[0]}`);
  return { read: remotes.length, tasks: ids.length };
}

async function run({ api } = {}) {
  const token = uuid();
  const acquired = crm().transaction(() => {
    const old = JSON.parse(setting('tasks_sync_lock', '{}'));
    if (old.until > now()) return false;
    setSetting('tasks_sync_lock', JSON.stringify({ token, until: now() + 120 }));
    return true;
  })();
  if (!acquired) return { busy: true };
  const renew = () => {
    const lock = JSON.parse(setting('tasks_sync_lock', '{}'));
    if (lock.token !== token) throw new Error('Task sync lock was lost');
    setSetting('tasks_sync_lock', JSON.stringify({ token, until: now() + 120 }));
  };
  try {
    return await runs.track('tasks_sync', async () => {
      api ||= require('./google').tasks();
      const lists = await ensureLists(api, renew), detail = {}, errors = [];
      for (const space of SPACES) {
        try { detail[space] = await syncList(api, space, lists[space], renew); }
        catch (err) { errors.push(err.message); }
      }
      if (errors.length) throw new Error(errors.join('; '));
      return detail;
    });
  } finally {
    if (JSON.parse(setting('tasks_sync_lock', '{}')).token === token) crm().prepare("DELETE FROM settings WHERE key = 'tasks_sync_lock'").run();
  }
}

module.exports = { run, reconcile, pages };
