'use strict';

// How long each task takes, estimated from its text so the calendar can set
// time aside without Douglas filling in a form. A guess is only ever a default:
// a length he sets himself is never overwritten.

const { crm, setting, setSetting } = require('./db');
const { createHash } = require('crypto');

const BATCH = 20;
const MAX_TRIES = 6;
const ALLOWED = [15, 30, 45, 60, 90, 120, 180, 240];

const SYSTEM_PROMPT = `You estimate how long tasks will take Douglas McLellan, so his calendar can set time aside for each one. Douglas has ADHD; a realistic length matters more than an optimistic one.

Rules:
- minutes: the focused time for one person to do the task as written. Use one of 15, 30, 45, 60, 90, 120, 180, 240.
- A quick reply, a call, a chase, a check or a booking is 15. Sending something that already exists is 15. Writing, preparing or reviewing a document is usually 60 to 120. When the text doesn't say enough to tell, use 30.
- Judge only from the task text. Use only the ids you are given, each once.

Reply with JSON only:
{"tasks":[{"id":"","minutes":30}]}`;

function nextBatch() {
  return crm().prepare(`SELECT id, space, title, notes FROM tasks
    WHERE status = 'needsAction' AND minutes IS NULL AND minutes_tries < ? ORDER BY created_at LIMIT ?`).all(MAX_TRIES, BATCH);
}

function guessing() { return !!setting('task_length_job'); }

function enqueueNext(jobs) {
  if (guessing()) return false;
  const batch = nextBatch();
  if (!batch.length) return false;
  const atoms = require('./atoms');
  const runner = require('../feature-runners').resolveFeatureRunner(atoms.FEATURE);
  const userPrompt = ['Tasks:', ...batch.map(t => `[${t.id}] (${t.space}) ${t.title}${t.notes ? ` — ${t.notes.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`)].join('\n');
  const tries = crm().prepare(`SELECT COALESCE(SUM(minutes_tries), 0) AS n FROM tasks WHERE id IN (${batch.map(() => '?').join(',')})`).get(...batch.map(t => t.id)).n;
  const key = createHash('sha256').update(batch.map(t => t.id).join('|')).digest('hex').slice(0, 12);
  const res = jobs.enqueue({
    feature: atoms.FEATURE,
    dedupeKey: `crm:task-length:${key}:${tries}`,
    payload: { systemPrompt: SYSTEM_PROMPT, userPrompt, runner: runner.runner, model: runner.model, effort: runner.effort, meta: { taskLength: batch.length } },
    mode: 'raw_output',
  });
  setSetting('task_length_job', JSON.stringify({ jobId: res.jobId, ids: batch.map(t => t.id) }));
  return true;
}

function collect(jobs, parse) {
  const raw = setting('task_length_job');
  if (!raw) return null;
  const job = JSON.parse(raw);
  const result = jobs.getJob(job.jobId);
  if (result && !['completed', 'failed'].includes(result.status)) return null;
  const db = crm();
  db.prepare("DELETE FROM settings WHERE key = 'task_length_job'").run();
  if (!result) return null;
  // Every task in the batch uses up a try, so a reply that never comes good
  // ends with the 30-minute default rather than a loop.
  const strike = n => { for (const id of job.ids) db.prepare('UPDATE tasks SET minutes_tries = minutes_tries + ? WHERE id = ? AND minutes IS NULL').run(n, id); };
  if (result.status === 'failed') {
    const transient = require('./atoms').transientError(result.error);
    strike(transient ? 1 : 3);
    return { error: String(result.error), retrying: transient };
  }
  let saved = 0;
  try {
    const allowed = new Set(job.ids);
    const reply = parse(result.result?.output).tasks;
    for (const r of Array.isArray(reply) ? reply : []) {
      if (!allowed.has(r?.id) || !ALLOWED.includes(Number(r.minutes))) continue;
      saved += db.prepare("UPDATE tasks SET minutes = ?, minutes_by = 'guess' WHERE id = ? AND minutes IS NULL").run(Number(r.minutes), r.id).changes;
    }
  } catch (_) { /* an unreadable reply saves nothing and is counted below */ }
  strike(3);
  if (saved) require('./calendar').replan();
  return { saved };
}

// Tasks the model could not size, which stay on the default.
function failedCount(space) {
  return crm().prepare("SELECT COUNT(*) AS n FROM tasks WHERE space = ? AND status = 'needsAction' AND minutes IS NULL AND minutes_tries >= ?").get(space, MAX_TRIES).n;
}

module.exports = { enqueueNext, collect, guessing, nextBatch, failedCount, SYSTEM_PROMPT, ALLOWED };
