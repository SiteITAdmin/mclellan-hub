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
const { uuid } = require('./id');
const { atomsForQuery } = require('./atoms');

// Auto-routing changes an operational task projection, so it needs materially
// stronger evidence than a merely plausible semantic hit.  We keep uncertain
// candidates observable as review receipts rather than mutating the task.
const MIN_SCORE = 0.55;
const MIN_MARGIN = 0.12;

function now() {
  return Math.floor(Date.now() / 1000);
}

function writeRoutingReceipt(user, task, {
  status = 'review',
  summary = '',
  payload = {},
} = {}) {
  try {
    const id = uuid();
    db.hub().prepare(`
      INSERT INTO knowledge_receipts
        (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
      VALUES (?, ?, 'google_task', ?, 'task_router', ?, ?, ?, ?)
    `).run(
      id,
      user,
      String(task?.id || 'unknown-task'),
      status,
      summary || null,
      JSON.stringify(payload || {}),
      now(),
    );
    return id;
  } catch (err) {
    // A routing result must never be hidden because an audit row could not be
    // written.  Surface the receipt failure to the caller's error details.
    return { error: err?.message || String(err) };
  }
}

function rankEntities(hits) {
  // Tally by subject: each entity scored by its best matching atom.
  const byEntity = new Map();
  for (const h of hits || []) {
    if (!h.subject_id) continue;
    const score = Number(h.score);
    if (!Number.isFinite(score)) continue;
    const key = `${h.subject_kind}:${h.subject_id}`;
    const prev = byEntity.get(key);
    if (!prev || score > prev.score) {
      byEntity.set(key, {
        kind: h.subject_kind,
        id: h.subject_id,
        label: h.subject_label,
        score,
      });
    }
  }
  return [...byEntity.values()].sort((a, b) => b.score - a.score);
}

function routingDecision(ranked) {
  if (!ranked.length) return { entity: null, reason: 'no_entity_evidence', ranked };
  const top = ranked[0];
  const second = ranked[1];
  const margin = second ? top.score - second.score : top.score;
  if (top.score < MIN_SCORE) {
    return { entity: null, reason: 'score_below_auto_route_floor', ranked, margin };
  }
  if (second && margin < MIN_MARGIN) {
    return { entity: null, reason: 'top_entity_margin_too_narrow', ranked, margin };
  }
  return { entity: top, reason: 'strong_evidence', ranked, margin };
}

async function rankTask(user, task, { queryAtoms = atomsForQuery } = {}) {
  const query = `${task.title || ''}. ${task.notes || ''}`.trim();
  if (!query) return { query, hits: [], ranked: [], entity: null, reason: 'empty_query' };
  const hits = await queryAtoms(user, query, 8);
  const ranked = rankEntities(hits);
  return { query, hits, ...routingDecision(ranked) };
}

async function routeTask(user, task, options = {}) {
  const decision = await rankTask(user, task, options);
  return decision.entity;
}

// Attach the resolved entity to the task row. contact/company by id; project by
// mapping the project entity id to its slug (google_tasks stores project_slug).
function attach(user, taskId, entity) {
  const hub = db.hub();
  if (entity.kind === 'contact') {
    const result = hub.prepare('UPDATE google_tasks SET contact_id = ? WHERE user = ? AND id = ? AND COALESCE(status, \'\') != \'completed\' AND deleted_at IS NULL AND contact_id IS NULL AND company_id IS NULL AND COALESCE(project_slug, \'\') = \'\'')
      .run(entity.id, user, taskId);
    return result.changes ? { field: 'contact_id', value: entity.id } : null;
  }
  if (entity.kind === 'company') {
    const result = hub.prepare('UPDATE google_tasks SET company_id = ? WHERE user = ? AND id = ? AND COALESCE(status, \'\') != \'completed\' AND deleted_at IS NULL AND contact_id IS NULL AND company_id IS NULL AND COALESCE(project_slug, \'\') = \'\'')
      .run(entity.id, user, taskId);
    return result.changes ? { field: 'company_id', value: entity.id } : null;
  }
  if (entity.kind === 'project') {
    const proj = hub.prepare('SELECT slug FROM projects WHERE user = ? AND id = ?').get(user, entity.id);
    if (proj?.slug) {
      const result = hub.prepare('UPDATE google_tasks SET project_slug = ? WHERE user = ? AND id = ? AND COALESCE(status, \'\') != \'completed\' AND deleted_at IS NULL AND contact_id IS NULL AND company_id IS NULL AND COALESCE(project_slug, \'\') = \'\'')
        .run(proj.slug, user, taskId);
      return result.changes ? { field: 'project_slug', value: proj.slug } : null;
    }
  }
  return null;
}

async function routeTasks(user, {
  limit = 40,
  queryAtoms = atomsForQuery,
  receiptWriter = writeRoutingReceipt,
} = {}) {
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
  let review = 0;
  const errors = [];
  const receipts = [];
  for (const task of tasks) {
    try {
      const decision = await rankTask(user, task, { queryAtoms });
      if (!decision.entity) {
        review++;
        const receipt = receiptWriter(user, task, {
          status: 'review',
          summary: `Task routing deferred: ${decision.reason}`,
          payload: {
            query: decision.query,
            reason: decision.reason,
            thresholds: { minScore: MIN_SCORE, minMargin: MIN_MARGIN },
            candidates: decision.ranked.slice(0, 5),
            evidence: (decision.hits || []).slice(0, 8),
            mutation: null,
          },
        });
        if (receipt?.error) errors.push({ taskId: task.id, stage: 'receipt', error: receipt.error });
        else if (receipt) receipts.push(receipt);
        continue;
      }
      const res = attach(user, task.id, decision.entity);
      if (res) {
        routed++;
        const receipt = receiptWriter(user, task, {
          status: 'routed',
          summary: `Task auto-routed to ${decision.entity.label || decision.entity.id}`,
          payload: {
            query: decision.query,
            entity: decision.entity,
            margin: decision.margin,
            thresholds: { minScore: MIN_SCORE, minMargin: MIN_MARGIN },
            evidence: (decision.hits || []).slice(0, 8),
            mutation: res,
          },
        });
        if (receipt?.error) errors.push({ taskId: task.id, stage: 'receipt', error: receipt.error });
        else if (receipt) receipts.push(receipt);
        console.log(`[task-router] "${(task.title || '').slice(0, 40)}" → ${decision.entity.label} (${res.field}, ${decision.entity.score.toFixed(3)})`);
      } else {
        // Another idempotent worker may have attached the task between the
        // query and this update.  Treat it as a review/no-op and record why.
        review++;
        const receipt = receiptWriter(user, task, {
          status: 'review',
          summary: 'Task routing candidate was not attached because task state changed',
          payload: { query: decision.query, entity: decision.entity, mutation: null },
        });
        if (receipt?.error) errors.push({ taskId: task.id, stage: 'receipt', error: receipt.error });
        else if (receipt) receipts.push(receipt);
      }
    } catch (err) {
      const detail = { taskId: task.id, error: err?.message || String(err) };
      errors.push(detail);
      const receipt = receiptWriter(user, task, {
        status: 'error',
        summary: `Task routing failed: ${detail.error}`,
        payload: { mutation: null, error: detail.error },
      });
      if (receipt?.error) errors.push({ taskId: task.id, stage: 'receipt', error: receipt.error });
      else if (receipt) receipts.push(receipt);
      console.warn(`[task-router] ${task.id}:`, detail.error);
    }
  }
  return { considered: tasks.length, routed, review, errors, receipts };
}

module.exports = {
  routeTasks,
  routeTask,
  rankTask,
  rankEntities,
  routingDecision,
  attach,
  MIN_SCORE,
  MIN_MARGIN,
};
