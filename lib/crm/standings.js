'use strict';

// "Where things stand": a short current summary of a person, project or
// organisation, written from its facts. It is a view over atoms and can be
// thrown away and rewritten at any time. Every line must cite facts it was given.

const { crm, now, setting, setSetting } = require('./db');
const { createHash } = require('crypto');

const DAY = 86400;
const MIN_FACTS = 3;
const MAX_FACTS = 80;
const MAX_LINES = 5;
const MAX_STRIKES = 12;
const TYPES = ['project', 'organisation', 'person'];

const SYSTEM_PROMPT = `You write "where things stand" for one person, project or organisation in Douglas McLellan's personal CRM, using only the numbered facts you are given. Douglas has ADHD and reads this to get back up to speed in seconds.

Rules:
- At most 5 lines, each one short plain sentence. Fewer is better. Lead with what matters now: the current state, open decisions, risks and what is waited on. Leave out trivia.
- Only what the facts say. No outside knowledge, advice, guesses or next steps of your own.
- Facts are newest first. Where a newer fact changes an older one, use the newer. Where they conflict and neither replaces the other, say so.
- Say when something is dated, using the date in the fact. A fact can be old: don't describe it as happening now unless the facts support that.
- Use full names as written in the facts. Don't work out how people are related unless a fact states it.
- facts: the ids of the facts that support the line. Every line needs at least one.

Reply with JSON only:
{"lines":[{"text":"","facts":[""]}]}`;

function entity(type, id) {
  const db = crm();
  if (type === 'person') return db.prepare('SELECT * FROM people_v WHERE id = ?').get(id) || null;
  if (type === 'project') return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  if (type === 'organisation') return db.prepare('SELECT * FROM organisations WHERE id = ?').get(id) || null;
  return null;
}

// An organisation's facts: what its people are named in, and facts naming it.
function orgFactIds(org) {
  const db = crm();
  const ids = new Set(db.prepare(`
    SELECT DISTINCT m.atom_id FROM atom_mentions m JOIN people p ON p.id = m.person_id WHERE p.org_id = ?
  `).all(org.id).map(r => r.atom_id));
  try {
    for (const r of db.prepare('SELECT atom_id FROM atoms_fts WHERE atoms_fts MATCH ? AND space = ? LIMIT 60').all(`"${org.name.replace(/"/g, '')}"`, org.space)) ids.add(r.atom_id);
  } catch (_) { /* a name FTS can't parse just adds nothing */ }
  return ids;
}

function factsFor(type, id, ent = entity(type, id)) {
  if (!ent) return [];
  const db = crm();
  if (type === 'person') {
    return db.prepare(`SELECT DISTINCT a.* FROM atom_mentions m JOIN atoms a ON a.id = m.atom_id
      WHERE m.person_id = ? AND a.space = ? AND a.status = 'active' ORDER BY a.said_at DESC`).all(id, ent.space);
  }
  if (type === 'project') {
    return db.prepare(`SELECT a.* FROM atom_projects x JOIN atoms a ON a.id = x.atom_id
      WHERE x.project_id = ? AND a.space = ? AND a.status = 'active' ORDER BY a.said_at DESC`).all(id, ent.space);
  }
  const ids = [...orgFactIds(ent)];
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM atoms WHERE id IN (${ids.map(() => '?').join(',')}) AND space = ? AND status = 'active' ORDER BY said_at DESC`).all(...ids, ent.space);
}

function fingerprint(facts) {
  return createHash('sha256').update(facts.map(f => f.id).sort().join('|')).digest('hex');
}

// New facts trigger a rewrite, at most once a day. Nothing queues up behind an
// outage: the next pass writes only the current state.
function nextDue(t = now()) {
  const db = crm();
  for (const type of TYPES) {
    const table = { person: 'people', project: 'projects', organisation: 'organisations' }[type];
    for (const { id } of db.prepare(`SELECT id FROM ${table} ORDER BY created_at`).all()) {
      const row = db.prepare('SELECT fingerprint, tried_at FROM standings WHERE entity_type = ? AND entity_id = ?').get(type, id);
      if (row && row.tried_at > t - DAY) continue;
      const facts = factsFor(type, id);
      if (facts.length < MIN_FACTS || row?.fingerprint === fingerprint(facts)) continue;
      return { type, id, facts };
    }
  }
  return null;
}

function writing() {
  return !!setting('standing_job');
}

function label(type, ent) {
  if (type === 'person') return `Person: ${[ent.name, ent.role, ent.dept, ent.team, ent.org].filter(Boolean).join(', ')}`;
  return `${type === 'project' ? 'Project' : 'Organisation'}: ${ent.name}`;
}

function enqueueNext(jobs) {
  if (writing()) return false;
  const due = nextDue();
  if (!due) return false;
  const facts = due.facts.slice(0, MAX_FACTS);
  const ent = entity(due.type, due.id);
  const dublin = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/Dublin' });
  const userPrompt = [
    label(due.type, ent),
    `Space: ${ent.space === 'work' ? 'Work' : 'Personal'}`,
    `Today: ${dublin(now())}`,
    `Facts (${facts.length}${due.facts.length > facts.length ? ` newest of ${due.facts.length}` : ''}):`,
    ...facts.map(f => `[${f.id}] ${dublin(f.said_at)} ${f.kind}: ${f.statement}`),
  ].join('\n');
  const atoms = require('./atoms');
  const runner = require('../feature-runners').resolveFeatureRunner(atoms.FEATURE);
  const attempts = crm().prepare('SELECT attempts FROM standings WHERE entity_type = ? AND entity_id = ?').get(due.type, due.id)?.attempts || 0;
  const res = jobs.enqueue({
    feature: atoms.FEATURE,
    dedupeKey: `crm:standing:${due.id}:${fingerprint(due.facts).slice(0, 12)}:${attempts}`,
    payload: { systemPrompt: SYSTEM_PROMPT, userPrompt, runner: runner.runner, model: runner.model, effort: runner.effort, meta: { standing: due.id } },
    mode: 'raw_output',
  });
  setSetting('standing_job', JSON.stringify({ jobId: res.jobId, type: due.type, id: due.id, space: ent.space, fingerprint: fingerprint(due.facts), factIds: facts.map(f => f.id), count: due.facts.length }));
  return true;
}

function saveLines(job, replyLines) {
  const allowed = new Set(job.factIds);
  const lines = (Array.isArray(replyLines) ? replyLines : []).map(l => ({
    text: String(l?.text || '').trim().slice(0, 400),
    facts: [...new Set(Array.isArray(l?.facts) ? l.facts : [])].filter(id => allowed.has(id)),
  })).filter(l => l.text && l.facts.length).slice(0, MAX_LINES);
  if (!lines.length) throw new Error('no line cited a fact it was given');
  crm().prepare(`
    INSERT INTO standings (entity_type, entity_id, space, lines, fingerprint, fact_count, written_at, tried_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(entity_type, entity_id) DO UPDATE SET lines = excluded.lines, fingerprint = excluded.fingerprint,
      fact_count = excluded.fact_count, written_at = excluded.written_at, tried_at = excluded.tried_at, attempts = 0, error = ''
  `).run(job.type, job.id, job.space, JSON.stringify(lines), job.fingerprint, job.count, now(), now());
  return lines.length;
}

function collect(jobs, parse) {
  const raw = setting('standing_job');
  if (!raw) return null;
  const job = JSON.parse(raw);
  const result = jobs.getJob(job.jobId);
  if (result && !['completed', 'failed'].includes(result.status)) return null;
  const db = crm();
  db.prepare("DELETE FROM settings WHERE key = 'standing_job'").run();
  if (!result) return null;
  // A busy lane earns one strike and a tick's rest. An unusable reply uses up
  // the allowance faster. Either way it rests for a day rather than loop.
  const strike = (n, error) => {
    db.prepare(`
      INSERT INTO standings (entity_type, entity_id, space, attempts, error) VALUES (?, ?, ?, ?, '')
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET attempts = attempts + excluded.attempts
    `).run(job.type, job.id, job.space, n);
    const { attempts } = db.prepare('SELECT attempts FROM standings WHERE entity_type = ? AND entity_id = ?').get(job.type, job.id);
    if (attempts >= MAX_STRIKES) {
      db.prepare('UPDATE standings SET attempts = 0, tried_at = ?, error = ? WHERE entity_type = ? AND entity_id = ?')
        .run(now(), String(error).slice(0, 300), job.type, job.id);
    }
    return { error };
  };
  if (result.status === 'failed') {
    const transient = require('./atoms').transientError(result.error);
    return { ...strike(transient ? 1 : 4, result.error), retrying: transient };
  }
  try {
    return { lines: saveLines(job, parse(result.result?.output).lines) };
  } catch (err) {
    return strike(4, err.message);
  }
}

// The page's copy of the summary, with each line's sources resolved. A line
// resting on a fact that has since changed says so rather than looking current.
function forEntity(type, id) {
  const ent = entity(type, id);
  if (!ent) return null;
  const db = crm();
  const row = db.prepare('SELECT * FROM standings WHERE entity_type = ? AND entity_id = ?').get(type, id);
  const facts = factsFor(type, id, ent);
  const out = {
    tooFew: facts.length < MIN_FACTS, minFacts: MIN_FACTS, lines: [],
    writtenAt: row?.written_at || null, error: row?.error || '',
    behind: Math.max(0, facts.length - (row?.fact_count || 0)),
    waiting: facts.length >= MIN_FACTS && !row?.written_at,
  };
  if (!row?.written_at) return out;
  const source = db.prepare(`
    SELECT s.id, s.kind, s.occurred_at, x.quote FROM atom_sources x JOIN sources s ON s.id = x.source_id
     WHERE x.atom_id = ? ORDER BY x.quote_verified DESC, s.occurred_at DESC LIMIT 1
  `);
  const active = db.prepare("SELECT 1 FROM atoms WHERE id = ? AND status = 'active'");
  out.lines = JSON.parse(row.lines).map(l => {
    const sources = new Map();
    for (const f of l.facts) {
      const s = source.get(f);
      if (s && !sources.has(s.id)) sources.set(s.id, s);
    }
    return { text: l.text, sources: [...sources.values()].slice(0, 3), changed: l.facts.some(f => !active.get(f)) };
  });
  return out;
}

function failedCount(space) {
  return crm().prepare("SELECT COUNT(*) AS n FROM standings WHERE space = ? AND error != ''").get(space).n;
}

module.exports = { factsFor, fingerprint, nextDue, writing, enqueueNext, collect, forEntity, failedCount, orgFactIds, SYSTEM_PROMPT, MIN_FACTS };
