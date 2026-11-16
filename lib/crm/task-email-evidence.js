'use strict';

const { crm, now } = require('./db');
const ref = t => `task:${t.id}:${t.revision}`;

function candidates(source) {
  if (source.kind !== 'email') return [];
  const db = crm();
  const query = require('./atoms').ftsQuery(`${source.title} ${source.text_fresh || source.text}`);
  const relevant = query ? db.prepare(`SELECT t.* FROM sources_fts f JOIN tasks t ON t.source_id = f.source_id
    WHERE sources_fts MATCH ? AND t.space = ? AND t.status = 'needsAction'
      AND NOT EXISTS (SELECT 1 FROM promises p WHERE p.task_id = t.id)
    ORDER BY bm25(sources_fts) LIMIT 30`).all(query, source.space) : [];
  const recent = db.prepare(`SELECT t.* FROM tasks t WHERE t.space = ? AND t.status = 'needsAction'
    AND NOT EXISTS (SELECT 1 FROM promises p WHERE p.task_id = t.id)
    ORDER BY t.updated_at DESC LIMIT 10`).all(source.space);
  return [...new Map([...relevant, ...recent].map(t => [t.id, t])).values()];
}

function apply(source, fulfilled, allowed) {
  if (source.kind !== 'email' || ['held', 'ignored', 'skipped'].includes(source.atomise_status)) return;
  const tasks = require('./tasks');
  for (const f of Array.isArray(fulfilled) ? fulfilled : []) {
    if (!allowed.has(f?.id) || !String(f.id).startsWith('task:') || !['clear', 'likely'].includes(f.certainty)) continue;
    const [, id] = f.id.split(':');
    const t = tasks.get(id);
    if (!t || t.space !== source.space || t.status !== 'needsAction' || ref(t) !== f.id || source.occurred_at < t.created_at) continue;
    if (!require('./atoms').quoteVerified(f.quote, source.text_fresh || source.text)) continue;
    if (crm().prepare('SELECT 1 FROM task_email_evidence WHERE task_id = ? AND source_id = ?').get(id, source.id)) continue;
    crm().transaction(() => {
      crm().prepare('INSERT INTO task_email_evidence (task_id, source_id, quote, verdict, checked_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, source.id, String(f.quote).slice(0, 600), f.certainty === 'clear' ? 'done' : 'likely', now());
      if (f.certainty === 'clear') tasks.edit(id, { status: 'completed', revision: t.revision });
    })();
  }
}

function forTask(id) {
  return crm().prepare(`SELECT e.*, s.title FROM task_email_evidence e JOIN sources s ON s.id = e.source_id
    WHERE e.task_id = ? AND e.verdict != 'rejected' ORDER BY e.checked_at DESC`).all(id);
}

function reject(id, sourceId) {
  crm().prepare("UPDATE task_email_evidence SET verdict = 'rejected' WHERE task_id = ? AND source_id = ? AND verdict = 'likely'").run(id, sourceId);
}

module.exports = { candidates, ref, apply, forTask, reject };
