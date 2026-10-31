'use strict';

// The promise ledger: what Douglas owes, and what others owe him. Atoms hold
// what was said. This table holds who owes whom and what became of it. A clear
// promise of his from fresh mail becomes a Google Task once; a clear promise
// owed to him becomes a chase task if it is still open after a week.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const identity = require('./identity');
const runs = require('./runs');
const { normName } = require('./text');

const DAY = 86400;
const FRESH_DAYS = 7;
const CHASE_DAYS = 7;
const CLASSIFY_BATCH = 20;
const CLASSIFY_MAX_FAILS = 3;
const DIRECTIONS = ['mine', 'owed_to_me', 'other'];

const CLASSIFY_PROMPT = `You sort statements tagged as promises into who owes what. Douglas McLellan is the owner of this system.

For each item decide:
- not_a_promise: true when nobody committed to anything. Telling, asking or recommending that someone else does something is not a promise, and neither is something already done. The one exception is something Douglas himself is directly asked to do: that is a promise with direction mine and certainty unsure.
- direction: "mine" when Douglas owes it, "owed_to_me" when someone owes it to Douglas, "other" when it is between other people.
- who: the other party as written: who Douglas owes, or who owes Douglas. null if nobody is named.
- action: what will be done, starting with a verb, 3 to 12 words, without the name of the person doing it.
- due: YYYY-MM-DD only when a date is stated; otherwise null.
- certainty: "clear" when the person's own words commit them to a specific action. "unsure" when it is conditional, implied, vague ("I'll be in touch", "keep you posted"), said on someone's behalf, or asked of Douglas but not yet accepted.

Reply with JSON only:
{"promises":[{"id":"","not_a_promise":false,"direction":"mine","who":null,"action":"","due":null,"certainty":"clear"}]}`;

const get = atomId => crm().prepare('SELECT * FROM promises WHERE atom_id = ?').get(atomId) || null;

function isFresh(saidAt, isHistory) {
  return !isHistory && saidAt >= now() - FRESH_DAYS * DAY;
}

function isoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function squash(s) {
  return normName(s).replace(/\s+/g, ' ');
}

// The model's "clear" is only believed when the source itself bears it out:
// the words are really there, in the new part of the email, and the email came
// from the person who owes. Minutes saying "Douglas will..." stay unsure.
function certaintyFor(spec, source, { verified, quote }) {
  if (spec.certainty !== 'clear' || !verified) return 'unsure';
  const q = squash(quote);
  if (!q || !squash(source.text_fresh || source.text).includes(q)) return 'unsure';
  if (spec.direction === 'mine') return source.direction === 'out' || source.kind === 'note' ? 'clear' : 'unsure';
  if (spec.direction === 'owed_to_me') return source.direction === 'in' ? 'clear' : 'unsure';
  return 'unsure';
}

/** Record who owes what for a promise atom. Without a usable spec the atom waits for the sorter. */
function register(atomId, spec, source, evidence) {
  if (!spec || !DIRECTIONS.includes(spec.direction) || !String(spec.action || '').trim()) return null;
  const db = crm();
  const atom = db.prepare('SELECT said_at, is_history, confidence FROM atoms WHERE id = ?').get(atomId);
  const tracked = spec.direction !== 'other' && isFresh(atom.said_at, atom.is_history);
  const certainty = atom.confidence === 'high' ? certaintyFor(spec, source, evidence) : 'unsure';
  db.prepare(`
    INSERT OR IGNORE INTO promises (atom_id, space, direction, who, action, due, certainty, state, said_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(atomId, source.space, spec.direction, String(spec.who || '').trim().slice(0, 120), String(spec.action).trim().slice(0, 240),
    isoDate(spec.due), certainty, tracked ? 'open' : 'untracked', atom.said_at);
  return get(atomId);
}

// Still open: not closed here, and any linked task has not been ticked or deleted.
const OPEN_SQL = `p.state = 'open' AND EXISTS (SELECT 1 FROM atoms a WHERE a.id = p.atom_id AND a.status = 'active') AND (p.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id = p.task_id AND t.status = 'needsAction'))`;

function openForPacket(space, limit = 30) {
  return crm().prepare(`
    SELECT p.atom_id, a.statement FROM promises p JOIN atoms a ON a.id = p.atom_id
     WHERE p.space = ? AND p.direction != 'other' AND ${OPEN_SQL} ORDER BY p.said_at DESC LIMIT ?
  `).all(space, limit);
}

// A changed promise ("Friday" becomes "Monday") keeps its one task, on the new date.
function supersede(oldAtomId, newAtomId) {
  const old = get(oldAtomId);
  if (!old) return;
  const db = crm();
  db.prepare("UPDATE promises SET state = 'untracked', task_id = NULL, closed_at = ?, closed_by = 'superseded' WHERE atom_id = ?").run(now(), oldAtomId);
  const fresh = get(newAtomId);
  if (!old.task_id || !fresh) return;
  db.prepare('UPDATE promises SET task_id = ? WHERE atom_id = ?').run(old.task_id, newAtomId);
  const t = db.prepare('SELECT status FROM tasks WHERE id = ?').get(old.task_id);
  if (t?.status === 'needsAction' && fresh.direction === 'mine' && fresh.due) require('./tasks').edit(old.task_id, { due: fresh.due });
}

function close(atomId, state, by) {
  const p = get(atomId);
  if (!p) throw new Error('No such promise');
  crm().transaction(() => {
    crm().prepare('UPDATE promises SET state = ?, closed_at = ?, closed_by = ? WHERE atom_id = ?').run(state, now(), by, atomId);
    if (!p.task_id) return;
    const t = crm().prepare('SELECT status FROM tasks WHERE id = ?').get(p.task_id);
    if (t?.status === 'needsAction') require('./tasks').edit(p.task_id, { status: state === 'kept' ? 'completed' : 'deleted' });
  })();
}

function reopen(atomId) {
  const p = get(atomId);
  if (!p) throw new Error('No such promise');
  crm().transaction(() => {
    crm().prepare("UPDATE promises SET state = 'open', closed_at = NULL, closed_by = '' WHERE atom_id = ?").run(atomId);
    if (!p.task_id) return;
    const t = crm().prepare('SELECT status FROM tasks WHERE id = ?').get(p.task_id);
    if (t?.status === 'completed') require('./tasks').edit(p.task_id, { status: 'needsAction' });
    if (t?.status === 'deleted') throw new Error('Its task was deleted. Add a new task if this still needs doing.');
  })();
}

// A later email can show a promise was kept. The ids are limited to those shown
// to the model, the words must be in this email, and the email must be newer.
function applyFulfilled(source, fulfilled, allowed) {
  if (source.kind === 'task') return 0;
  const { quoteVerified } = require('./atoms');
  let closed = 0;
  for (const f of Array.isArray(fulfilled) ? fulfilled : []) {
    if (!f?.id || !allowed.has(f.id) || !quoteVerified(f.quote, source.text_fresh || source.text)) continue;
    const p = crm().prepare(`SELECT p.* FROM promises p WHERE p.atom_id = ? AND p.space = ? AND ${OPEN_SQL}`).get(f.id, source.space);
    if (!p || source.occurred_at < p.said_at) continue;
    close(p.atom_id, 'kept', `source:${source.id}`);
    closed += 1;
  }
  return closed;
}

function atomEvidence(atomId) {
  return crm().prepare(`
    SELECT s.id AS source_id, s.title AS source_title, s.kind AS source_kind, x.quote, x.quote_verified
      FROM atom_sources x JOIN sources s ON s.id = x.source_id
     WHERE x.atom_id = ? ORDER BY x.quote_verified DESC, s.occurred_at LIMIT 1
  `).get(atomId) || {};
}

// The model only ever supplies a name. The matcher decides whether it is someone.
function personFor(p) {
  if (!p.who) return null;
  const db = crm();
  const sourceIds = db.prepare('SELECT source_id FROM atom_sources WHERE atom_id = ?').all(p.atom_id).map(r => r.source_id);
  const participantIds = [...new Set(sourceIds.flatMap(id => require('./sources').sourcePeople(id).map(x => x.id)))];
  const projectIds = db.prepare('SELECT project_id FROM atom_projects WHERE atom_id = ?').all(p.atom_id).map(r => r.project_id);
  const r = identity.resolveName(p.space, p.who, { participantIds, projectIds });
  return r.status === 'resolved' ? r.personId : null;
}

function chaseAt(p) {
  const afterDue = p.due ? Math.floor(Date.parse(`${p.due}T23:59:59Z`) / 1000) + 1 : 0;
  return Math.max(p.said_at + CHASE_DAYS * DAY, afterDue);
}

function dublinDate(ts = now()) {
  return new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function makeTask(atomId) {
  const db = crm();
  const tasks = require('./tasks');
  return db.transaction(() => {
    const p = get(atomId);
    if (!p) throw new Error('No such promise');
    // A promise makes one task, ever. Deleting it in Google doesn't invite another.
    if (p.task_id) return tasks.get(p.task_id);
    if (p.state !== 'open') throw new Error('This promise is closed');
    if (p.direction === 'other') throw new Error('This promise is between other people');
    const atom = db.prepare('SELECT statement FROM atoms WHERE id = ?').get(atomId);
    const ev = atomEvidence(atomId);
    const chase = p.direction === 'owed_to_me';
    const title = chase ? `Chase ${p.who || 'them'}: ${p.action}` : capitalise(p.action);
    const quote = ev.quote && ev.quote_verified ? `\n\n“${ev.quote}”` : '';
    const project = db.prepare('SELECT project_id FROM atom_projects WHERE atom_id = ? LIMIT 1').get(atomId);
    const t = tasks.create(p.space, {
      title: title.slice(0, 1024),
      notes: `${atom.statement}${quote}`.slice(0, 6000),
      due: chase ? dublinDate() : p.due,
      context: { personId: personFor(p), projectId: project?.project_id, sourceId: ev.source_id },
    }, 'promise');
    db.prepare('UPDATE promises SET task_id = ? WHERE atom_id = ?').run(t.id, atomId);
    db.prepare("INSERT INTO effects (id, module, entity_id, operation, request, status, finished_at) VALUES (?, 'crm_promises', ?, 'task.create', ?, 'done', ?)")
      .run(uuid(), t.id, JSON.stringify({ atomId, direction: p.direction }), now());
    return t;
  })();
}

// Runs every 15 minutes, just ahead of the Google sync. A week-old promise with
// nothing done retires rather than appearing out of nowhere after an outage.
function run() {
  return runs.track('promises', async () => {
    const db = crm();
    const open = db.prepare(`SELECT p.* FROM promises p WHERE ${OPEN_SQL} AND p.task_id IS NULL AND p.direction != 'other'`).all();
    const t = now();
    const counts = { tasks: 0, chases: 0, retired: 0 };
    const errors = [];
    for (const p of open) {
      const chaseTime = chaseAt(p);
      try {
        if (t >= chaseTime + CHASE_DAYS * DAY) {
          db.prepare("UPDATE promises SET state = 'stale', closed_at = ?, closed_by = 'time' WHERE atom_id = ?").run(t, p.atom_id);
          counts.retired += 1;
        } else if (p.certainty === 'clear' && p.direction === 'mine' && p.said_at >= t - FRESH_DAYS * DAY) {
          makeTask(p.atom_id);
          counts.tasks += 1;
        } else if (p.certainty === 'clear' && p.direction === 'owed_to_me' && t >= chaseTime) {
          makeTask(p.atom_id);
          counts.chases += 1;
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
    if (errors.length) throw new Error(`${errors.length} promise(s) couldn't become tasks. ${errors[0]}`);
    return counts;
  });
}

function decorate(p) {
  const db = crm();
  const person = personFor(p);
  const ev = atomEvidence(p.atom_id);
  const todayDate = dublinDate();
  return {
    ...p, ...ev,
    quote: ev.quote_verified ? ev.quote : '',
    person_id: person,
    person_name: person ? db.prepare('SELECT name FROM people WHERE id = ?').get(person)?.name : null,
    days: Math.max(0, Math.floor((now() - p.said_at) / DAY)),
    overdue: !!p.due && p.due < todayDate,
    due_label: p.due ? new Date(`${p.due}T12:00:00Z`).toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' }) : '',
    chase_on: new Date(chaseAt(p) * 1000).toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short' }),
  };
}

function ledger(space) {
  const rows = crm().prepare(`
    SELECT p.* FROM promises p WHERE p.space = ? AND p.direction != 'other' AND ${OPEN_SQL}
     ORDER BY p.due IS NULL, p.due, p.said_at
  `).all(space).map(decorate);
  return { mine: rows.filter(p => p.direction === 'mine'), owed: rows.filter(p => p.direction === 'owed_to_me') };
}

function closed(space, limit = 50) {
  const rows = crm().prepare(`
    SELECT p.*, t.status AS task_status FROM promises p LEFT JOIN tasks t ON t.id = p.task_id
     WHERE p.space = ? AND p.direction != 'other' AND p.state != 'untracked' AND NOT (${OPEN_SQL})
     ORDER BY COALESCE(p.closed_at, p.said_at) DESC LIMIT ?
  `).all(space, limit);
  const words = { kept: 'Done', dismissed: 'Taken off the list', stale: 'Retired after two weeks with no task' };
  return rows.map(p => {
    const byTask = p.state === 'open';
    const closing = String(p.closed_by).startsWith('source:') ? p.closed_by.slice(7) : null;
    return { ...p, ...atomEvidence(p.atom_id),
      why: byTask ? (p.task_status === 'completed' ? 'Task ticked off' : 'Task deleted') : closing ? 'An email showed it was done' : words[p.state],
      closing_source_id: closing,
      reopenable: !byTask && p.task_status !== 'deleted' };
  });
}

// ── Sorting promises that have no ledger entry yet ─────────────────────────
// Covers everything read before the ledger existed, and any reply that left
// the promise details out. One batch at a time, in the same queue as reading.

function unsorted(limit = CLASSIFY_BATCH, space = null) {
  return crm().prepare(`
    SELECT a.* FROM atoms a LEFT JOIN promises p ON p.atom_id = a.id
     WHERE a.kind = 'promise' AND a.status = 'active' AND p.atom_id IS NULL ${space ? 'AND a.space = ?' : ''}
     ORDER BY a.said_at DESC LIMIT ?
  `).all(...(space ? [space, limit] : [limit]));
}

function classifying() {
  return !!require('./db').setting('promise_classify_job');
}

function classifyFails() {
  return Number(require('./db').setting('promise_classify_fails') || 0);
}

function classifyStuck(space) {
  return classifyFails() >= CLASSIFY_MAX_FAILS ? unsorted(1000, space).length : 0;
}

function primarySource(atomId) {
  return crm().prepare(`
    SELECT s.*, x.quote, x.quote_verified FROM atom_sources x JOIN sources s ON s.id = x.source_id
     WHERE x.atom_id = ? ORDER BY x.quote_verified DESC, s.occurred_at LIMIT 1
  `).get(atomId) || null;
}

function enqueueClassify(jobs) {
  const { setSetting } = require('./db');
  if (classifying() || classifyFails() >= CLASSIFY_MAX_FAILS) return false;
  const db = crm();
  const batch = [];
  for (const a of unsorted(CLASSIFY_BATCH * 3)) {
    const s = primarySource(a.id);
    // A task's own text is already tracked as a task, so needs no opinion.
    if (!s || s.kind === 'task') {
      db.prepare("UPDATE atoms SET kind = 'fact', updated_at = ? WHERE id = ?").run(now(), a.id);
      continue;
    }
    if (batch.length < CLASSIFY_BATCH) batch.push({ a, s });
  }
  if (!batch.length) return false;
  const lines = batch.map(({ a, s }) => JSON.stringify({
    id: a.id, statement: a.statement, quote: s.quote, source_title: s.title, source_date: dublinDate(a.said_at),
    source: s.kind === 'note' ? 'Note by Douglas' : s.direction === 'out' ? 'Email sent by Douglas' : 'Email received by Douglas',
  }));
  const { resolveFeatureRunner } = require('../feature-runners');
  const runner = resolveFeatureRunner(require('./atoms').FEATURE);
  const res = jobs.enqueue({
    feature: require('./atoms').FEATURE,
    dedupeKey: `crm:promises:${batch[0].a.id}:${classifyFails()}`,
    payload: { systemPrompt: CLASSIFY_PROMPT, userPrompt: lines.join('\n'), runner: runner.runner, model: runner.model, effort: runner.effort, meta: { batch: batch.length } },
    mode: 'raw_output',
  });
  setSetting('promise_classify_job', JSON.stringify({ jobId: res.jobId, ids: batch.map(b => b.a.id) }));
  return true;
}

function applyClassified(ids, replies) {
  const db = crm();
  const byId = new Map(replies.filter(r => r && r.id).map(r => [r.id, r]));
  const { quoteVerified } = require('./atoms');
  let sorted = 0;
  db.transaction(() => {
    for (const id of ids) {
      const r = byId.get(id);
      if (!r) continue;
      const s = primarySource(id);
      if (r.not_a_promise || !s) {
        db.prepare("UPDATE atoms SET kind = 'fact', updated_at = ? WHERE id = ?").run(now(), id);
      } else {
        const done = register(id, r, s, { verified: !!s.quote_verified && quoteVerified(s.quote, s.text), quote: s.quote });
        if (!done) continue;
      }
      sorted += 1;
    }
  })();
  return sorted;
}

function collectClassified(jobs, parse) {
  const { setting, setSetting } = require('./db');
  const db = crm();
  const raw = setting('promise_classify_job');
  if (!raw) return null;
  const { jobId, ids } = JSON.parse(raw);
  const job = jobs.getJob(jobId);
  const finish = () => db.prepare("DELETE FROM settings WHERE key = 'promise_classify_job'").run();
  if (!job) { finish(); return null; }
  if (job.status === 'completed') {
    finish();
    try {
      const reply = parse(job.result?.output);
      const sorted = applyClassified(ids, Array.isArray(reply.promises) ? reply.promises : []);
      setSetting('promise_classify_fails', sorted ? 0 : classifyFails() + 1);
      return { sorted };
    } catch (err) {
      setSetting('promise_classify_fails', classifyFails() + 1);
      return { error: err.message };
    }
  }
  if (job.status === 'failed') {
    finish();
    // The lane being busy says nothing about the batch; ask again next tick.
    if (!/usage_limit_reached|rate limit|\b429\b|at capacity|overloaded|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network error|api_error/i.test(String(job.error))) {
      setSetting('promise_classify_fails', classifyFails() + 1);
    }
    return { error: job.error };
  }
  return null;
}

module.exports = {
  get, register, supersede, openForPacket, applyFulfilled, close, reopen, makeTask, run, ledger, closed, chaseAt,
  classifying, classifyStuck, enqueueClassify, collectClassified, applyClassified, unsorted, CLASSIFY_PROMPT,
};
