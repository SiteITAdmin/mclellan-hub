'use strict';

const { actionText, courtesyOnly } = require('./text');
const { bind } = require('./action-binding');
const { crm, now } = require('./db');
const ref = t => `task:${t.id}:${t.revision}`;

// Open tasks the reader may see for an email: only ones whose own source matches
// the email's words, and only when the email has words of its own (a subject
// alone, or an empty forward, can close nothing).
function candidates(source) {
  const text = String(actionText(source) || '').trim();
  if (source.kind !== 'email' || !text) return [];
  const query = require('./atoms').ftsQuery(`${source.title} ${text}`);
  if (!query) return [];
  return crm().prepare(`SELECT t.* FROM sources_fts f JOIN tasks t ON t.source_id = f.source_id
    WHERE sources_fts MATCH ? AND t.space = ? AND t.status = 'needsAction'
      AND NOT EXISTS (SELECT 1 FROM promises p WHERE p.task_id = t.id)
    ORDER BY bm25(sources_fts) LIMIT 8`).all(query, source.space);
}

function apply(source, fulfilled, allowed) {
  if (source.kind !== 'email' || ['held', 'ignored', 'skipped'].includes(source.atomise_status)) return;
  const tasks = require('./tasks');
  // A result queued under an older packet is bound to what the email would be shown now.
  const shown = new Set(candidates(source).map(ref));
  for (const f of Array.isArray(fulfilled) ? fulfilled : []) {
    if (!allowed.has(f?.id) || !shown.has(f.id) || !String(f.id).startsWith('task:') || !['clear', 'likely'].includes(f.certainty)) continue;
    const [, id] = f.id.split(':');
    const t = tasks.get(id);
    if (!t || t.space !== source.space || t.status !== 'needsAction' || ref(t) !== f.id || source.occurred_at < t.created_at) continue;
    if (courtesyOnly(f.quote) || !require('./atoms').quoteVerified(f.quote, actionText(source))) continue;
    if (crm().prepare('SELECT 1 FROM task_email_evidence WHERE task_id = ? AND source_id = ?').get(id, source.id)) continue;
    // The quote must be about this task; one only loosely about it asks instead of closing.
    const bound = bind(f.quote, t.title, source.title);
    if (bound === 'unrelated') continue;
    const clear = f.certainty === 'clear' && bound === 'supported';
    crm().transaction(() => {
      crm().prepare('INSERT INTO task_email_evidence (task_id, source_id, quote, verdict, checked_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, source.id, String(f.quote).slice(0, 600), clear ? 'done' : 'likely', now());
      if (clear) tasks.edit(id, { status: 'completed', revision: t.revision });
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
