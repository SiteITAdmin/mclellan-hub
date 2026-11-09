'use strict';

// "Who do I know at X?" and other questions asked on the Search screen. Text
// search finds the candidates; the model writes a short answer in which every
// line must cite a person or fact it was given. Lines that cite nothing are
// dropped, and an answer with no lines says so rather than guessing.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const { createHash } = require('crypto');

const MAX_PEOPLE = 25;
const MAX_FACTS = 60;
const REUSE_SECONDS = 3600;
const GIVE_UP_SECONDS = 20 * 60;

const SYSTEM_PROMPT = `You answer one question from Douglas McLellan about what his personal CRM knows. You are given numbered people and numbered facts from the CRM. Douglas has ADHD and wants the answer in seconds.

Rules:
- Use only the people and facts given. No outside knowledge, no guesses, no advice.
- At most 8 lines, each one short plain sentence. Lead with the direct answer.
- For "who do I know at X": one line per person given who belongs to X, saying their role and the most useful thing the facts say about them or when Douglas was last in touch.
- Use full names as written. Never work out that two names are the same person.
- people / facts: the ids (like "P2", "F7") that support the line. Every line needs at least one.
- If what you are given doesn't answer the question, return no lines.

Reply with JSON only:
{"lines":[{"text":"","people":[""],"facts":[""]}]}`;

function looksLikeQuestion(q) {
  const s = String(q || '').trim().toLowerCase();
  return s.length > 8 && (s.endsWith('?') || /^(who|what|when|where|which|why|how|does|did|do|is|are|was|were|has|have|can|should)\b/.test(s));
}

function terms(q) {
  const stop = new Set('who what when where which why how does did the and for with that this from have know about there their they them are was were has had can should would could any all know knows work works working people person someone anyone tell show list give'.split(' '));
  return [...new Set((String(q).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9][a-z0-9&'-]{2,}/g) || []).filter(w => !stop.has(w)))];
}

function candidates(space, q) {
  const db = crm();
  const words = terms(q);
  const people = db.prepare('SELECT * FROM people_v WHERE space = ? ORDER BY name COLLATE NOCASE').all(space)
    .filter(p => words.some(w => `${p.name} ${p.org} ${p.dept} ${p.team} ${p.role}`.toLowerCase().includes(w))).slice(0, MAX_PEOPLE);
  const facts = new Map();
  const fts = words.slice(0, 12).map(w => `"${w.replace(/"/g, '')}"`).join(' OR ');
  if (fts) {
    try {
      for (const a of db.prepare(`SELECT a.* FROM atoms_fts f JOIN atoms a ON a.id = f.atom_id
        WHERE atoms_fts MATCH ? AND f.space = ? AND a.status = 'active' ORDER BY bm25(atoms_fts) LIMIT 30`).all(fts, space)) facts.set(a.id, a);
    } catch (_) { /* a query FTS can't parse adds nothing */ }
  }
  for (const p of people) {
    for (const a of db.prepare(`SELECT DISTINCT a.* FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id
      WHERE m.person_id = ? AND a.space = ? AND a.status = 'active' ORDER BY a.said_at DESC LIMIT 4`).all(p.id, space)) {
      if (facts.size < MAX_FACTS) facts.set(a.id, a);
    }
  }
  return { people, facts: [...facts.values()].slice(0, MAX_FACTS) };
}

const dublin = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });

function ask(space, question, { jobs = require('../subscription-agent-jobs'), t = now() } = {}) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) throw new Error('Ask a question');
  const db = crm();
  const recent = db.prepare("SELECT * FROM questions WHERE space = ? AND question = ? AND created_at > ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1").get(space, q, t - REUSE_SECONDS);
  if (recent) return recent;
  const { people, facts } = candidates(space, q);
  const id = uuid();
  if (!people.length && !facts.length) {
    db.prepare("INSERT INTO questions (id, space, question, status, answer, answered_at, created_at) VALUES (?, ?, ?, 'done', '[]', ?, ?)").run(id, space, q, t, t);
    return get(id);
  }
  const views = require('./views');
  const refs = { people: Object.fromEntries(people.map((p, i) => [`P${i + 1}`, p.id])), facts: Object.fromEntries(facts.map((a, i) => [`F${i + 1}`, a.id])) };
  const userPrompt = [
    `Space: ${space === 'work' ? 'Work' : 'Personal'}`, `Today: ${dublin(t)}`, `Question: ${q}`, '',
    `People (${people.length}):`,
    ...(people.length ? people.map((p, i) => { const last = views.lastContact(p.id, space); return `[P${i + 1}] ${[p.name, p.role, p.team, p.dept, p.org].filter(Boolean).join(', ')}. ${last ? `Last in touch ${dublin(last)}` : 'No contact captured yet'}.`; }) : ['(none match)']),
    '', `Facts (${facts.length}), newest first:`,
    ...(facts.length ? facts.sort((a, b) => b.said_at - a.said_at).map(a => `[${Object.keys(refs.facts).find(k => refs.facts[k] === a.id)}] ${dublin(a.said_at)} ${a.kind}: ${a.statement}`) : ['(none match)']),
  ].join('\n');
  const atoms = require('./atoms');
  const runner = require('../feature-runners').resolveFeatureRunner(atoms.FEATURE);
  const res = jobs.enqueue({
    feature: atoms.FEATURE,
    dedupeKey: `crm:ask:${createHash('sha256').update(`${space}|${q}|${Math.floor(t / REUSE_SECONDS)}`).digest('hex').slice(0, 16)}`,
    payload: { systemPrompt: SYSTEM_PROMPT, userPrompt, runner: runner.runner, model: runner.model, effort: runner.effort, meta: { ask: id } },
    mode: 'raw_output',
  });
  db.prepare("INSERT INTO questions (id, space, question, status, job_id, refs, created_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?)").run(id, space, q, res.jobId, JSON.stringify(refs), t);
  return get(id);
}

function parse(output) {
  const text = String(output || '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
}

// Picks up a finished answer. Called when the page is shown, so nothing has to poll.
function collect(row, { jobs = require('../subscription-agent-jobs'), t = now() } = {}) {
  if (!row || row.status !== 'waiting') return row;
  const db = crm();
  const job = jobs.getJob(row.job_id);
  const fail = error => { db.prepare("UPDATE questions SET status = 'failed', error = ?, answered_at = ? WHERE id = ?").run(String(error).slice(0, 300), t, row.id); return get(row.id); };
  if (!job) return fail('The question was lost before the Mac could answer it');
  if (job.status === 'failed') return fail(job.error || 'The Mac could not answer');
  if (job.status !== 'completed') return t - row.created_at > GIVE_UP_SECONDS && job.status === 'pending' ? { ...row, slow: true } : row;
  try {
    const refs = JSON.parse(row.refs);
    const lines = (parse(job.result?.output).lines || []).map(l => ({
      text: String(l?.text || '').trim().slice(0, 400),
      people: [...new Set(Array.isArray(l?.people) ? l.people : [])].map(k => refs.people[k]).filter(Boolean),
      facts: [...new Set(Array.isArray(l?.facts) ? l.facts : [])].map(k => refs.facts[k]).filter(Boolean),
    })).filter(l => l.text && (l.people.length || l.facts.length)).slice(0, 8);
    db.prepare("UPDATE questions SET status = 'done', answer = ?, answered_at = ? WHERE id = ?").run(JSON.stringify(lines), t, row.id);
    return get(row.id);
  } catch (err) { return fail(`Couldn't use the model's reply: ${err.message}`); }
}

function get(id) { return crm().prepare('SELECT * FROM questions WHERE id = ?').get(id) || null; }

// The answer as the page shows it, with each line's people and sources resolved.
function shown(row) {
  if (!row) return null;
  const db = crm();
  const lines = row.status === 'done' ? JSON.parse(row.answer || '[]').map(l => ({
    text: l.text,
    people: l.people.map(id => db.prepare('SELECT id, name FROM people WHERE id = ?').get(id)).filter(Boolean),
    sources: [...new Map(l.facts.map(f => db.prepare(`SELECT s.id, s.title, s.kind, s.occurred_at FROM atom_sources x JOIN sources s ON s.id = x.source_id
      WHERE x.atom_id = ? ORDER BY x.quote_verified DESC LIMIT 1`).get(f)).filter(Boolean).map(s => [s.id, s])).values()].slice(0, 3),
  })) : [];
  return { ...row, lines };
}

function recent(space, limit = 5) {
  return crm().prepare("SELECT id, question, status, created_at FROM questions WHERE space = ? ORDER BY created_at DESC LIMIT ?").all(space, limit);
}

module.exports = { ask, collect, get, shown, recent, looksLikeQuestion, candidates, terms, SYSTEM_PROMPT };
