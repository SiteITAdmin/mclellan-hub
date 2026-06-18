'use strict';

/**
 * Knowledge layer — task routing (Stage 3).
 *
 * A free-text task like "get dad's medicine" may not connect to any entity at
 * the moment it is typed. This pass embeds open, unrouted tasks and finds the
 * entity their knowledge points to — so the task attaches to Alister McLellan
 * even though his name never appears in it. Routing is conservative: a task is
 * only attached when one entity clearly wins; otherwise it is left for a later
 * run (more knowledge may exist by then) or for the human.
 */

const db = require('./db');
const { atomsForQuery } = require('./atoms');

const MIN_SCORE = 0.28;   // cosine floor for a believable match
const MIN_MARGIN = 0.02;  // top entity must beat the runner-up by this

async function routeTask(user, task) {
  const query = `${task.title || ''}. ${task.notes || ''}`.trim();
  if (!query) return null;
  const hits = await atomsForQuery(user, query, 8);
  if (!hits.length) return null;

  // Tally by subject: each entity scored by its best matching atom.
  const byEntity = new Map();
  for (const h of hits) {
    if (!h.subject_id) continue;
    const key = `${h.subject_kind}:${h.subject_id}`;
    const prev = byEntity.get(key);
    if (!prev || h.score > prev.score) {
      byEntity.set(key, { kind: h.subject_kind, id: h.subject_id, label: h.subject_label, score: h.score });
    }
  }
  const ranked = [...byEntity.values()].sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const top = ranked[0];
  const second = ranked[1];
  if (top.score < MIN_SCORE) return null;
  if (second && top.score - second.score < MIN_MARGIN) return null;
  return top;
}

// Attach the resolved entity to the task row. contact/company by id; project by
// mapping the project entity id to its slug (google_tasks stores project_slug).
function attach(user, taskId, entity) {
  const hub = db.hub();
  if (entity.kind === 'contact') {
    hub.prepare('UPDATE google_tasks SET contact_id = ? WHERE id = ?').run(entity.id, taskId);
    return { field: 'contact_id', value: entity.id };
  }
  if (entity.kind === 'company') {
    hub.prepare('UPDATE google_tasks SET company_id = ? WHERE id = ?').run(entity.id, taskId);
    return { field: 'company_id', value: entity.id };
  }
  if (entity.kind === 'project') {
    const proj = hub.prepare('SELECT slug FROM projects WHERE id = ?').get(entity.id);
    if (proj?.slug) {
      hub.prepare('UPDATE google_tasks SET project_slug = ? WHERE id = ?').run(proj.slug, taskId);
      return { field: 'project_slug', value: proj.slug };
    }
  }
  return null;
}

async function routeTasks(user, { limit = 40 } = {}) {
  const hub = db.hub();
  const tasks = hub.prepare(`
    SELECT id, title, notes FROM google_tasks
     WHERE user = ?
       AND COALESCE(status,'') != 'completed'
       AND deleted_at IS NULL
       AND contact_id IS NULL AND company_id IS NULL AND COALESCE(project_slug,'') = ''
     ORDER BY created_at DESC
     LIMIT ?
  `).all(user, limit);

  let routed = 0;
  for (const task of tasks) {
    try {
      const entity = await routeTask(user, task);
      if (!entity) continue;
      const res = attach(user, task.id, entity);
      if (res) {
        routed++;
        console.log(`[task-router] "${(task.title || '').slice(0, 40)}" → ${entity.label} (${res.field}, ${entity.score.toFixed(3)})`);
      }
    } catch (err) {
      console.warn(`[task-router] ${task.id}:`, err.message);
    }
  }
  return { considered: tasks.length, routed };
}

module.exports = { routeTasks, routeTask };
