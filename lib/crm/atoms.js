'use strict';

// Atomisation: each source becomes standalone, cited statements. The Mac
// worker (Claude, subscription) proposes atoms; this file checks them against
// the source and links names through the deterministic matcher. The model
// never assigns a person.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const identity = require('./identity');
const { normName } = require('./text');
const { sourcePeople } = require('./sources');

const FEATURE = 'crm_atomise';
const KINDS = ['fact', 'decision', 'promise', 'risk', 'question', 'date'];
const CONFIDENCE = ['high', 'medium', 'low'];
const MAX_FRESH = 24000;
const MAX_QUOTED = 3000;

const SYSTEM_PROMPT = `You turn one captured source (an email, a note, a report) into atoms: single statements that make sense on their own, each backed by the exact words it came from.

Rules:
- One statement per atom. Write it so it stands alone a year from now: use names, not "he", "she", "it", "they" or "this". Put dates in full where the source gives them.
- Only what the source says. Never add outside knowledge or guesses.
- kind is one of: fact, decision, promise, risk, question, date. A promise is someone committing to do something ("I'll send it Friday").
- quote: copy the exact words from the source that support the atom, 3 to 40 words, verbatim.
- people: the names of people the atom is about, exactly as written in the source. Never invent a surname. Leave out the author of a note to self.
- projects: only names from the project list you are given. If the source clearly belongs to a project that is not on the list, put its name in new_project.
- topics: 1 to 4 short subject phrases (e.g. "data protection", "licensing"). Reuse a topic from the existing list when it fits.
- valid_from / valid_until: YYYY-MM-DD only when the source states when something is true; otherwise null.
- confidence: high when stated plainly, medium when implied, low when unclear.
- same_as: if an atom says the same thing as one of the related existing atoms, give that atom's id; otherwise null.
- supersedes: if an atom replaces an existing atom with newer information (a changed number, date or decision), give that atom's id; otherwise null.
- Signatures, disclaimers, greetings, scheduling noise, newsletters and automatic notifications produce no atoms. Returning zero atoms is correct when there is nothing worth remembering.

Reply with JSON only, no prose:
{"atoms":[{"statement":"","kind":"fact","quote":"","people":[],"projects":[],"new_project":null,"topics":[],"valid_from":null,"valid_until":null,"confidence":"high","same_as":null,"supersedes":null}]}`;

function projectsIn(space) {
  return crm().prepare('SELECT * FROM projects WHERE space = ? ORDER BY name').all(space);
}

function topTopics(space, limit = 60) {
  return crm().prepare(`
    SELECT t.name, COUNT(at.atom_id) AS n FROM topics t LEFT JOIN atom_topics at ON at.topic_id = t.id
     WHERE t.space = ? GROUP BY t.id ORDER BY n DESC, t.name LIMIT ?
  `).all(space, limit).map(r => r.name);
}

function ftsQuery(text, maxTerms = 12) {
  const stop = new Set('the and for with that this from have will your you are was were been has had not but our out can all any about into they them their there what when which who would could should also just than then some more very here only over such please thanks thank regards hello dear kind best'.split(' '));
  const counts = new Map();
  for (const w of String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z][a-z0-9]{3,}/g) || []) {
    if (stop.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxTerms).map(([w]) => `"${w}"`);
  return terms.join(' OR ');
}

function relatedAtoms(space, text, limit = 12) {
  const q = ftsQuery(text);
  if (!q) return [];
  return crm().prepare(`
    SELECT a.id, a.statement, a.said_at FROM atoms_fts f JOIN atoms a ON a.id = f.atom_id
     WHERE atoms_fts MATCH ? AND f.space = ? AND a.status = 'active'
     ORDER BY bm25(atoms_fts) LIMIT ?
  `).all(q, space, limit);
}

function dublinDate(ts) {
  return new Date(ts * 1000).toLocaleString('en-IE', { timeZone: 'Europe/Dublin', dateStyle: 'medium', timeStyle: 'short' });
}

function buildPacket(source) {
  const people = crm().prepare('SELECT role, name, value FROM source_addresses WHERE source_id = ?').all(source.id);
  const fresh = String(source.text_fresh || source.text).slice(0, MAX_FRESH);
  const quoted = source.text_fresh && source.text.length > source.text_fresh.length
    ? source.text.slice(source.text_fresh.length).slice(0, MAX_QUOTED) : '';
  const related = relatedAtoms(source.space, `${source.title}\n${fresh}`);
  const lines = [
    `Space: ${source.space === 'work' ? 'Work' : 'Personal'}`,
    `Source: ${source.kind}${source.direction === 'out' ? ' sent by Douglas' : source.direction === 'in' ? ' received by Douglas' : ''}`,
    `Date: ${dublinDate(source.occurred_at)} (Dublin)`,
    `Title: ${source.title}`,
  ];
  if (people.length) lines.push(`Participants: ${people.map(p => `${p.role} ${p.name ? `${p.name} <${p.value}>` : p.value}`).join('; ')}`);
  lines.push(`Projects in this space: ${projectsIn(source.space).map(p => p.name).join('; ') || '(none yet)'}`);
  lines.push(`Existing topics: ${topTopics(source.space).join('; ') || '(none yet)'}`);
  lines.push('Related existing atoms:');
  if (related.length) for (const a of related) lines.push(`- [${a.id}] ${a.statement}`);
  else lines.push('- (none)');
  lines.push('', '--- SOURCE TEXT (new content) ---', fresh);
  if (quoted) lines.push('', '--- EARLIER THREAD (context only; do not atomise it again) ---', quoted);
  return { userPrompt: lines.join('\n'), relatedIds: related.map(a => a.id) };
}

function parseModelJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model reply had no JSON object');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(obj.atoms)) throw new Error('model reply had no atoms array');
  return obj.atoms;
}

function squash(s) {
  return normName(s).replace(/\s+/g, ' ');
}

function quoteVerified(quote, sourceText) {
  const q = squash(quote);
  return q.length >= 6 && squash(sourceText).includes(q);
}

function topicId(space, name) {
  const n = normName(name);
  if (!n || n.length > 60) return null;
  const db = crm();
  const row = db.prepare('SELECT id FROM topics WHERE space = ? AND name_norm = ?').get(space, n);
  if (row) return row.id;
  const id = uuid();
  db.prepare('INSERT INTO topics (id, space, name, name_norm) VALUES (?, ?, ?, ?)').run(id, space, String(name).trim().toLowerCase(), n);
  return id;
}

function indexAtom(atomId) {
  const db = crm();
  const a = db.prepare('SELECT id, space, statement FROM atoms WHERE id = ?').get(atomId);
  if (!a) return;
  const topics = db.prepare('SELECT t.name FROM atom_topics at JOIN topics t ON t.id = at.topic_id WHERE at.atom_id = ?').all(atomId).map(t => t.name).join(' ');
  db.prepare('DELETE FROM atoms_fts WHERE atom_id = ?').run(atomId);
  db.prepare('INSERT INTO atoms_fts (atom_id, space, statement, topics) VALUES (?, ?, ?, ?)').run(a.id, a.space, a.statement, topics);
}

function proposeProject(space, name, atomId) {
  const n = normName(name);
  if (!n) return;
  const db = crm();
  if (db.prepare('SELECT 1 FROM projects WHERE space = ? AND name_norm = ?').get(space, n)) return;
  const key = `project:${space}:${n}`;
  const open = db.prepare("SELECT * FROM review_items WHERE item_key = ? AND status = 'open'").get(key);
  if (open) {
    const p = JSON.parse(open.payload);
    if (!p.atomIds.includes(atomId)) p.atomIds.push(atomId);
    db.prepare('UPDATE review_items SET payload = ? WHERE id = ?').run(JSON.stringify(p), open.id);
    return;
  }
  db.prepare("INSERT INTO review_items (id, kind, item_key, space, payload) VALUES (?, 'project', ?, ?, ?)")
    .run(uuid(), key, space, JSON.stringify({ name: String(name).trim(), atomIds: [atomId] }));
}

function resolveMention(mentionId) {
  const db = crm();
  const m = db.prepare(`
    SELECT m.*, a.space, a.id AS aid FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id WHERE m.id = ?
  `).get(mentionId);
  if (!m) return null;
  const sourceIds = db.prepare('SELECT source_id FROM atom_sources WHERE atom_id = ?').all(m.aid).map(r => r.source_id);
  const participantIds = [...new Set(sourceIds.flatMap(id => sourcePeople(id).map(p => p.id)))];
  const projectIds = db.prepare('SELECT project_id FROM atom_projects WHERE atom_id = ?').all(m.aid).map(r => r.project_id);
  const r = identity.resolveName(m.space, m.name, { participantIds, projectIds });
  db.prepare('UPDATE atom_mentions SET status = ?, person_id = ?, how = ? WHERE id = ?')
    .run(r.status, r.personId || null, r.how || '', m.id);
  const key = `mention:${m.id}`;
  if (r.status === 'ambiguous') {
    db.prepare(`INSERT OR IGNORE INTO review_items (id, kind, item_key, space, payload) VALUES (?, 'mention', ?, ?, ?)`)
      .run(uuid(), key, m.space, JSON.stringify({ mentionId: m.id, name: m.name, atomId: m.aid, candidateIds: r.candidateIds }));
  } else {
    db.prepare("DELETE FROM review_items WHERE item_key = ? AND status = 'open'").run(key);
  }
  return r;
}

// Re-run the matcher over names that were unknown or ambiguous, e.g. after a
// new person is approved.
function reresolveMentions(space) {
  const rows = crm().prepare(`
    SELECT m.id FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id
     WHERE a.space = ? AND m.status IN ('unresolved','ambiguous')
  `).all(space);
  for (const r of rows) resolveMention(r.id);
  return rows.length;
}

/**
 * Apply the model's atoms for one source. Returns the number of atoms that
 * reference the source (new or merged into an existing one).
 */
function applyAtoms(sourceId, rawAtoms, relatedIds = []) {
  const db = crm();
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`source ${sourceId} not found`);
  const allowedRefs = new Set(relatedIds);
  const projects = projectsIn(source.space);
  const mentionIds = [];
  let count = 0;

  db.transaction(() => {
    for (const raw of rawAtoms.slice(0, 40)) {
      const statement = String(raw?.statement || '').trim();
      if (statement.length < 8) continue;
      const kind = KINDS.includes(raw.kind) ? raw.kind : 'fact';
      const verified = quoteVerified(raw.quote, source.text);
      const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'medium';
      const quote = String(raw.quote || '').slice(0, 600);

      const sameAs = raw.same_as && allowedRefs.has(raw.same_as)
        ? db.prepare("SELECT id FROM atoms WHERE id = ? AND space = ?").get(raw.same_as, source.space) : null;
      if (sameAs) {
        db.prepare('INSERT OR IGNORE INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, ?)')
          .run(sameAs.id, source.id, quote, verified ? 1 : 0);
        db.prepare('UPDATE atoms SET updated_at = ? WHERE id = ?').run(now(), sameAs.id);
        count += 1;
        continue;
      }

      const id = uuid();
      db.prepare(`
        INSERT INTO atoms (id, space, statement, kind, confidence, said_at, valid_from, valid_until, is_history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, source.space, statement.slice(0, 1000), kind, verified ? confidence : 'low', source.occurred_at,
        isoDate(raw.valid_from), isoDate(raw.valid_until), source.is_history);
      db.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, ?)')
        .run(id, source.id, quote, verified ? 1 : 0);

      if (raw.supersedes && allowedRefs.has(raw.supersedes)) {
        db.prepare("UPDATE atoms SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND space = ?")
          .run(id, now(), raw.supersedes, source.space);
      }
      for (const pname of arr(raw.projects)) {
        const p = projects.find(x => x.name_norm === normName(pname));
        if (p) db.prepare('INSERT OR IGNORE INTO atom_projects (atom_id, project_id) VALUES (?, ?)').run(id, p.id);
        else proposeProject(source.space, pname, id);
      }
      if (raw.new_project) proposeProject(source.space, raw.new_project, id);
      for (const t of arr(raw.topics).slice(0, 4)) {
        const tid = topicId(source.space, t);
        if (tid) db.prepare('INSERT OR IGNORE INTO atom_topics (atom_id, topic_id) VALUES (?, ?)').run(id, tid);
      }
      for (const name of [...new Set(arr(raw.people).map(String))].slice(0, 12)) {
        const n = normName(name);
        if (!n) continue;
        const mid = uuid();
        db.prepare("INSERT INTO atom_mentions (id, atom_id, name, name_norm, status) VALUES (?, ?, ?, ?, 'unresolved')")
          .run(mid, id, name.slice(0, 120), n);
        mentionIds.push(mid);
      }
      count += 1;
      indexAtom(id);
    }
    db.prepare("UPDATE sources SET atomise_status = 'done', atomised_at = ?, atom_count = ?, atomise_error = '', atomise_attempts = 0 WHERE id = ?")
      .run(now(), count, source.id);
  })();
  for (const mid of mentionIds) resolveMention(mid);
  return count;
}

function arr(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []; }

function isoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// The lane, not the source, was at fault. Five tries is enough to ride out a
// session limit that clears, then it is shown to Douglas rather than looped.
const MAX_TRANSIENT_ATTEMPTS = 5;

function transientError(error) {
  return /usage_limit_reached|rate limit|\b429\b|at capacity|overloaded|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network error|api_error/i
    .test(String(error));
}

// ── Queue: one source at a time, newest first ──────────────────────────────
// Only one CRM job sits in the Mac worker's queue at once, so the public
// sites' chat never waits behind a backlog of mail.

function nextSource() {
  return crm().prepare(`
    SELECT * FROM sources WHERE atomise_status = 'pending'
     ORDER BY is_history ASC, occurred_at DESC LIMIT 1
  `).get() || null;
}

function collectFinished(jobs) {
  const db = crm();
  const queued = db.prepare("SELECT id, atomise_job_id, atomise_attempts FROM sources WHERE atomise_status = 'queued'").all();
  let applied = 0;
  let retrying = 0;
  for (const s of queued) {
    const job = jobs.getJob(s.atomise_job_id);
    if (!job) {
      db.prepare("UPDATE sources SET atomise_status = 'pending', atomise_job_id = NULL WHERE id = ?").run(s.id);
      continue;
    }
    if (job.status === 'completed') {
      try {
        const relatedIds = JSON.parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(`related:${s.id}`)?.value || '[]');
        applyAtoms(s.id, parseModelJson(job.result?.output), relatedIds);
        db.prepare('DELETE FROM settings WHERE key = ?').run(`related:${s.id}`);
        applied += 1;
      } catch (err) {
        db.prepare("UPDATE sources SET atomise_status = 'failed', atomise_error = ? WHERE id = ?")
          .run(`Couldn't use the model's reply: ${String(err.message).slice(0, 300)}`, s.id);
      }
    } else if (job.status === 'failed') {
      const error = String(job.error || 'Mac worker failed').slice(0, 400);
      // The model lane being busy (a usage limit, a timeout, a dropped
      // connection) says nothing about the source. Put it back in the queue so
      // it reads itself when the lane returns; only a reply the Hub can't use
      // needs Douglas to look at it.
      if (transientError(error) && (s.atomise_attempts || 0) < MAX_TRANSIENT_ATTEMPTS) {
        db.prepare("UPDATE sources SET atomise_status = 'pending', atomise_job_id = NULL, atomise_attempts = atomise_attempts + 1, atomise_error = ? WHERE id = ?")
          .run(`Waiting to try again: ${error}`, s.id);
        retrying += 1;
      } else {
        db.prepare("UPDATE sources SET atomise_status = 'failed', atomise_error = ? WHERE id = ?")
          .run(error, s.id);
      }
    }
  }
  return { applied, retrying };
}

async function runAtomiseTick({ jobs = require('../subscription-agent-jobs') } = {}) {
  const runs = require('./runs');
  return runs.track('atomise', async () => {
    const { applied, retrying } = collectFinished(jobs);
    const db = crm();
    const inFlight = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE atomise_status = 'queued'").get().n;
    const othersWaiting = jobs.queueStats().pending;
    let queued = null;
    // Give a lane that just said no a whole tick before asking again.
    if (!inFlight && !othersWaiting && !retrying) {
      const source = nextSource();
      if (source) {
        const { userPrompt, relatedIds } = buildPacket(source);
        const { resolveFeatureRunner } = require('../feature-runners');
        const runner = resolveFeatureRunner(FEATURE);
        const res = jobs.enqueue({
          feature: FEATURE,
          dedupeKey: `crm:${source.id}`,
          payload: {
            systemPrompt: SYSTEM_PROMPT, userPrompt,
            runner: runner.runner, model: runner.model, effort: runner.effort,
            meta: { sourceId: source.id },
          },
          mode: 'raw_output',
        });
        db.prepare("UPDATE sources SET atomise_status = 'queued', atomise_job_id = ? WHERE id = ?").run(res.jobId, source.id);
        require('./db').setSetting(`related:${source.id}`, JSON.stringify(relatedIds));
        queued = source.id;
      }
    }
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE atomise_status IN ('pending','queued')").get().n;
    return { applied, retrying, queued: !!queued, waiting, othersWaiting };
  });
}

function retrySource(sourceId) {
  return crm().prepare("UPDATE sources SET atomise_status = 'pending', atomise_error = '', atomise_job_id = NULL, atomise_attempts = 0 WHERE id = ? AND atomise_status IN ('failed','skipped')").run(sourceId).changes;
}

module.exports = {
  FEATURE, SYSTEM_PROMPT, buildPacket, parseModelJson, applyAtoms, quoteVerified, ftsQuery,
  resolveMention, reresolveMentions, runAtomiseTick, nextSource, retrySource, indexAtom, collectFinished,
};
