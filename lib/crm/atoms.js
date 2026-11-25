'use strict';

// Atomisation: each source becomes standalone, cited statements. The Mac
// worker (Claude, subscription) proposes atoms; this file checks them against
// the source and links names through the deterministic matcher. The model
// never assigns a person.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const identity = require('./identity');
const { normName, quoteChecker, emailParts, courtesyOnly } = require('./text');
const { sourcePeople } = require('./sources');
const promises = require('./promises');
const standings = require('./standings');
const taskLength = require('./task-length');
const taskHelp = require('./task-help');
const taskJobs = require('./task-jobs');
const claims = require('./claims');
const meetings = require('./meetings');
const connections = require('./connections');

const FEATURE = 'crm_atomise';
const KINDS = ['fact', 'decision', 'promise', 'risk', 'question', 'date'];
const CONFIDENCE = ['high', 'medium', 'low'];
const MAX_FRESH = 24000;
const MAX_QUOTED = 3000;

const SYSTEM_PROMPT = `You turn one captured source (an email, a note, a report, a WhatsApp chat) into atoms: single statements that make sense on their own, each backed by the exact words it came from.

Rules:
- A WhatsApp or iMessage source is a run of chat messages, one per line as "[time] Speaker: text". "Douglas" is Douglas himself. Quote only the message text, never the time or speaker. Messages under "Earlier in this chat" are context only.
- One statement per atom. Write it so it stands alone a year from now: use names, not "he", "she", "it", "they" or "this". Put dates in full where the source gives them.
- Only what the source says. Never add outside knowledge or guesses. The lists of related atoms, open promises, open tasks and earlier conversation in the packet are context only: never write an atom from them, and never quote them. Write atoms only from the source text, and quote only its words (an email's subject line counts as its words).
- kind is one of: fact, decision, promise, risk, question, date.
- A promise is a named person committing to do something ("I'll send it Friday"). Telling, asking or recommending that someone else does something is a fact, not a promise, with two exceptions: something Douglas himself is directly asked to do is a promise with direction mine and certainty unsure; a specific action or answer Douglas directly asks another person for in his outgoing message is tracked as kind promise, direction owed_to_me, is_request true and certainty unsure. State it as "Douglas asked [person] to ...", never as their commitment. Report recommendations and things Douglas has already done are never promises. A source of kind task or journal is never a promise. Journal entries never create tasks or close promises.
- promise: null unless kind is promise. Otherwise:
  is_request: true only for a request Douglas has made that the recipient has not yet accepted; false for commitments.
  direction: "mine" when Douglas owes it, "owed_to_me" when someone owes it to Douglas, "other" when it is between other people.
  who: the other party as written in the source: who Douglas owes, or who owes Douglas. null if nobody is named.
  action: what will be done, starting with a verb, 3 to 12 words, without the name of the person doing it ("send the Microsoft Project quote").
  due: YYYY-MM-DD only when the source states a date; otherwise null.
  certainty: "clear" when the person's own words commit them to a specific action. "unsure" when it is conditional, implied, vague ("I'll be in touch", "keep you posted"), said on someone's behalf, or asked of Douglas but not yet accepted.
- fulfilled: if this source bears on one of the open promises or open tasks you are given, list its id with the exact words. certainty is "clear" when those words plainly show it has been done or delivered, "likely" when they suggest it but don't show it. Match the specific deliverable and recipient, not merely the topic: sending a proposal completes sending it, never obtaining approval or the whole project. Restating a promise, asking for it, or thanking someone in advance doesn't count. Leave the list empty otherwise.
- quote: copy the exact words from the source that support the atom, 3 to 40 words, verbatim, with no ellipsis. A short reply such as "Paid." is quoted whole. The quote must be in the source, not in a list of existing atoms or tasks.
- people: the names of people the atom is about, exactly as written in the source. Never invent a surname. Leave out the author of a note to self.
- projects: only names from the project list you are given, and only when the atom is plainly about what that project covers. Being about the same family, the same person's other affairs, or money and paperwork in general is not enough. An empty list is right whenever you are unsure. If the source clearly belongs to a project that is not on the list, put its name in new_project.
- topics: 1 to 4 short subject phrases (e.g. "data protection", "licensing"). Reuse a topic from the existing list when it fits.
- valid_from / valid_until: YYYY-MM-DD only when the source states when something is true; otherwise null. For kind date, valid_from is the date itself.
- yearly: true only for a date that comes round every year (a birthday, an anniversary, an annual renewal). Give valid_from as the day stated, using the year of the source when none is given. Otherwise false.
- confidence: high when stated plainly, medium when implied, low when unclear.
- same_as: if an atom says the same thing as one of the related or earlier-conversation atoms, give that atom's id; otherwise null. A different amount, date, person, direction or outcome, or an event that has happened again, is a new atom, not the same.
- When a recipient accepts an open request, write their commitment with is_request false and supersedes pointing to that request. Repeated requests use same_as; asking again does not mean acceptance. A delivered answer can fulfil the request directly. Use only the new message, not quoted requests or commitments.
- supersedes: if an atom replaces an existing atom with newer information (a changed number, date or decision), give that atom's id; otherwise null.
- space: null, unless the packet has a "Space check". Then "work" or "personal": the space the whole source belongs to, judged from who is in it and what it is about. People and organisations Douglas already files in a space are the strongest clue.
- Signatures, disclaimers, greetings, scheduling noise, newsletters and automatic notifications (including out-of-office and automatic replies) produce no atoms. Returning zero atoms is correct when there is nothing worth remembering.

Reply with JSON only, no prose:
{"atoms":[{"statement":"","kind":"fact","quote":"","people":[],"projects":[],"new_project":null,"topics":[],"valid_from":null,"valid_until":null,"yearly":false,"confidence":"high","same_as":null,"supersedes":null,"promise":null}],"fulfilled":[{"id":"","quote":"","certainty":"clear"}],"space":null}`;

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
  const parts = source.kind === 'email' ? emailParts(source) : {
    fresh: source.text_fresh || source.text,
    quoted: source.text_fresh ? source.text.slice(source.text_fresh.length) : '',
  };
  const fresh = parts.fresh.slice(0, MAX_FRESH);
  const quoted = parts.quoted.slice(0, MAX_QUOTED);
  const related = relatedAtoms(source.space, `${source.title}\n${fresh}`);
  const lines = [
    `Space: ${source.space === 'work' ? 'Work' : 'Personal'}`,
    `Source: ${source.kind}${source.direction === 'out' ? ' sent by Douglas' : source.direction === 'in' ? ' received by Douglas' : ''}`,
    `Date: ${dublinDate(source.occurred_at)} (Dublin)`,
    `Title: ${source.title}`,
  ];
  if (people.length) lines.push(`Participants: ${people.map(p => `${p.role} ${p.name ? `${p.name} <${p.value}>` : p.value}`).join('; ')}`);
  if (source.space_by === 'ask') lines.push(...require('./spaces').checkLines(source));
  lines.push(...require('./project-check').describe(source.space));
  const channelProject = require('./channels').projectFor(source);
  if (channelProject) lines.push(`Channel project: Douglas files everything from this ${source.origin === 'whatsapp' ? 'chat' : 'mailbox'} under "${channelProject.name}". Put "${channelProject.name}" in projects for every atom, unless that atom is plainly about something else.`);
  lines.push(`Existing topics: ${topTopics(source.space).join('; ') || '(none yet)'}`);
  lines.push('Related existing atoms (context only):');
  if (related.length) for (const a of related) lines.push(`- [${a.id}] ${a.statement}`);
  else lines.push('- (none)');
  const thread = source.kind === 'email' ? claims.threadAtoms(source).filter(a => !related.some(r => r.id === a.id)) : [];
  if (thread.length) {
    lines.push('Earlier in this conversation (already recorded, context only; give the id as same_as if the new text restates one):');
    for (const a of thread) lines.push(`- [${a.id}] ${a.statement}`);
  }
  const open = promises.openForPacket(source.space);
  lines.push('Open promises (context only):');
  if (open.length) for (const p of open) lines.push(`- [${p.atom_id}] ${p.statement}`);
  else lines.push('- (none)');
  const taskEvidence = require('./task-email-evidence');
  const openTasks = taskEvidence.candidates(source);
  if (openTasks.length) {
    lines.push('Open tasks (context only: a task is closed only by the source text itself, and only the exact completed step, never the wider job):');
    for (const t of openTasks) lines.push(`- [${taskEvidence.ref(t)}] ${t.title}`);
  }
  lines.push('', '--- SOURCE TEXT (new content) ---', fresh);
  if (quoted) lines.push('', '--- EARLIER THREAD (context only; do not atomise it again) ---', quoted);
  return { userPrompt: lines.join('\n'), relatedIds: [...new Set([...related.map(a => a.id), ...thread.map(a => a.id), ...open.map(p => p.atom_id), ...openTasks.map(taskEvidence.ref)])] };
}

function parseObject(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model reply had no JSON object');
  return JSON.parse(s.slice(start, end + 1));
}

function parseModelReply(text) {
  const obj = parseObject(text);
  if (!Array.isArray(obj.atoms)) throw new Error('model reply had no atoms array');
  return { atoms: obj.atoms, fulfilled: Array.isArray(obj.fulfilled) ? obj.fulfilled : [], space: ['work', 'personal'].includes(obj.space) ? obj.space : null };
}

function parseModelJson(text) {
  return parseModelReply(text).atoms;
}

function quoteVerified(quote, sourceText) {
  return quoteChecker(sourceText)(quote);
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
function applyAtoms(sourceId, rawAtoms, relatedIds = [], fulfilled = []) {
  const db = crm();
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`source ${sourceId} not found`);
  const allowedRefs = new Set(relatedIds);
  const projects = projectsIn(source.space);
  const mentionIds = [];
  // An email's claims must quote words of that email (its subject or its text);
  // a claim that quotes anything else is never stored and never cited.
  const strict = source.kind === 'email';
  const parts = strict ? emailParts(source) : null;
  const ownWords = parts?.fresh || '';
  const inBody = strict && quoteChecker(ownWords);
  const inSubject = strict && quoteChecker(source.title);
  const calendarReply = /^(?:accepted|declined|tentative):/i.test(source.title);

  const sourceAddresses = strict ? new Set(claims.shape(`${source.title}\n${source.text}`).emails) : null;
  if (strict) {
    for (const row of db.prepare("SELECT value FROM source_addresses WHERE source_id=? AND kind='email'").all(source.id)) {
      sourceAddresses.add(row.value.toLowerCase());
    }
  }
  const forwarded = strict && parts.authored !== parts.fresh;
  const inAuthored = forwarded && quoteChecker(parts.authored);
  const knownForward = forwarded
    ? db.prepare(`SELECT a.id FROM atom_sources x JOIN atoms a ON a.id=x.atom_id
        WHERE a.id=? AND a.space=? AND x.source_id<>? AND x.quote_verified=1 AND x.quote=? AND a.kind=?
          AND abs(a.said_at-?) <= 86400 AND a.status='active' LIMIT 20`) : null;
  let rejected = 0;
  let count = 0;

  db.transaction(() => {
    for (const raw of rawAtoms.slice(0, 40)) {
      const statement = String(raw?.statement || '').trim();
      if (statement.length < 8) continue;
      // A task is already something Douglas tracks. Reading its own text back
      // as a promise would make a task from a task.
      const kind = !KINDS.includes(raw.kind) || (raw.kind === 'promise' && ['task', 'journal'].includes(source.kind)) ? 'fact' : raw.kind;
      const verified = strict ? (inBody(raw.quote) || (!calendarReply && inSubject(raw.quote))) && !courtesyOnly(raw.quote) && [...claims.shape(statement).emails].every(addr => sourceAddresses.has(addr)) : quoteVerified(raw.quote, source.text);
      const confidence = CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'medium';
      const quote = String(raw.quote || '').slice(0, 600);
      if (require('./facts').wasDeleted(source.space, source.id, statement.slice(0, 1000), quote)) continue;
      if (strict && !verified) { rejected += 1; continue; }

      if (strict && db.prepare('SELECT 1 FROM atoms a JOIN atom_sources x ON a.id=x.atom_id WHERE x.source_id=? AND a.statement=? AND a.kind=? AND x.quote=?').get(source.id, statement, kind, quote)) continue;
      const supersedes = raw.supersedes && allowedRefs.has(raw.supersedes) ? raw.supersedes : null;
      const sameAs = strict
        ? claims.mergeTarget(source, {
          statement, kind, supersedes, promise: kind === 'promise' ? raw.promise : null,
          sameAs: raw.same_as && allowedRefs.has(raw.same_as) ? raw.same_as : null,
          validFrom: isoDate(raw.valid_from), validUntil: isoDate(raw.valid_until),
          forwarded: forwarded && !inAuthored(raw.quote),
          projectIds: arr(raw.projects).map(n => projects.find(x => x.name_norm === normName(n))?.id).filter(Boolean),
        })
        : raw.same_as && allowedRefs.has(raw.same_as)
          ? db.prepare("SELECT id FROM atoms WHERE id = ? AND space = ?").get(raw.same_as, source.space)
          // The same words twice in a thread are one fact, and one task, even
          // when the model missed the link.
          : db.prepare("SELECT id FROM atoms WHERE space = ? AND statement = ? AND status = 'active' LIMIT 1").get(source.space, statement.slice(0, 1000));
      if (sameAs && knownForward && !inAuthored(raw.quote) &&
          knownForward.get(sameAs.id, source.space, source.id, quote, kind, source.occurred_at)) continue;
      if (sameAs) {
        db.prepare('INSERT OR IGNORE INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, ?)')
          .run(sameAs.id, source.id, quote, verified ? 1 : 0);
        db.prepare('UPDATE atoms SET updated_at = ? WHERE id = ?').run(now(), sameAs.id);
        if (kind === 'promise' && confidence === 'high') promises.confirmRequest(sameAs.id, raw.promise, source, { verified, quote });
        continue;
      }

      const id = uuid();
      db.prepare(`
        INSERT INTO atoms (id, space, statement, kind, confidence, said_at, valid_from, valid_until, yearly, is_history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, source.space, statement.slice(0, 1000), kind, verified ? confidence : 'low', source.occurred_at,
        isoDate(raw.valid_from), isoDate(raw.valid_until), kind === 'date' && raw.yearly === true ? 1 : 0, source.is_history);
      db.prepare('INSERT INTO atom_sources (atom_id, source_id, quote, quote_verified) VALUES (?, ?, ?, ?)')
        .run(id, source.id, quote, verified ? 1 : 0);

      if (supersedes) {
        db.prepare("UPDATE atoms SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ? AND space = ?")
          .run(id, now(), supersedes, source.space);
      }
      for (const pname of arr(raw.projects)) {
        const p = projects.find(x => x.name_norm === normName(pname));
        // Filed knowing the project's current description, so it needs no re-check.
        if (p) db.prepare('INSERT OR IGNORE INTO atom_projects (atom_id, project_id, checked) VALUES (?, ?, ?)').run(id, p.id, require('./project-check').hashFor(p.id));
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
      if (kind === 'promise') promises.register(id, raw.promise, source, { verified, quote });
      if (supersedes) promises.supersede(supersedes, id);
      indexAtom(id);
    }
    if (source.kind !== 'journal') promises.applyFulfilled(source, fulfilled, new Set(relatedIds));
    require('./task-email-evidence').apply(source, fulfilled, new Set(relatedIds));
    // What is actually cited, so a source read twice is not counted twice.
    count = db.prepare('SELECT COUNT(*) AS n FROM atom_sources WHERE source_id = ?').get(source.id).n;
    if (!rejected) {
      db.prepare("UPDATE sources SET atomise_status = 'done', atomised_at = ?, atom_count = ?, atomise_error = '', atomise_attempts = 0 WHERE id = ?")
        .run(now(), count, source.id);
    } else if ((source.atomise_attempts || 0) < MAX_QUOTE_RETRIES) {
      // The good claims are kept; the email is read again, a bounded number of times.
      db.prepare("UPDATE sources SET atomise_status = 'pending', atomise_job_id = NULL, atom_count = ?, atomise_attempts = atomise_attempts + 1, atomise_error = ? WHERE id = ?")
        .run(count, `Waiting to read again: ${rejected} ${rejected === 1 ? 'claim quoted' : 'claims quoted'} words that are not in this email`, source.id);
    } else {
      db.prepare("UPDATE sources SET atomise_status = 'failed', atom_count = ?, atomise_error = ? WHERE id = ?")
        .run(count, `Kept ${count} ${count === 1 ? 'fact' : 'facts'}, but ${rejected} ${rejected === 1 ? 'claim quoted' : 'claims quoted'} words that are not in this email, even after reading it again. Retry reads it once more`, source.id);
    }
  })();
  for (const mid of mentionIds) resolveMention(mid);
  return count;
}

// The model quoted words the email does not contain: read it again this many times, then show it as failed.
const MAX_QUOTE_RETRIES = 2;

function arr(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : []; }

function isoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// The lane, not the source, was at fault. Keep trying for a working day's worth
// of ticks, then show it to Douglas rather than loop forever.
const MAX_TRANSIENT_ATTEMPTS = 12;

function transientError(error) {
  return /usage_limit_reached|usage limit|rate limit|\b429\b|at capacity|overloaded|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|network error|api_error/i
    .test(String(error));
}

// ── Queue: one source at a time, newest first ──────────────────────────────
// Only one CRM job sits in the Mac worker's queue at once, so the public
// sites' chat never waits behind a backlog of mail.

function nextSource({ freshOnly = false } = {}) {
  // Sources never tried come first, newest first. A source the lane refused
  // waits behind them, so one bad source can't hold up the rest.
  return crm().prepare(`
    SELECT * FROM sources WHERE atomise_status = 'pending'${freshOnly ? ' AND is_history = 0' : ''}
     ORDER BY is_history ASC, atomise_attempts ASC, occurred_at DESC LIMIT 1
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
        const reply = parseModelReply(job.result?.output);
        db.prepare('DELETE FROM settings WHERE key = ?').run(`related:${s.id}`);
        const src = db.prepare('SELECT space, space_by FROM sources WHERE id = ?').get(s.id);
        if (src.space_by === 'ask') {
          const spaces = require('./spaces');
          // Read as the other space: its facts were written with this space's projects and people, so it is read again there.
          if (reply.space && reply.space !== src.space) { spaces.moveSource(s.id, reply.space, 'reader', `Claude read it as ${spaces.label(reply.space)}`, { reading: true }); continue; }
          db.prepare('UPDATE sources SET space_by = ?, space_why = ? WHERE id = ?')
            .run(reply.space ? 'reader' : 'kept', reply.space ? `Claude read it as ${spaces.label(reply.space)}` : 'Claude couldn’t tell, so it stayed where it was', s.id);
        }
        applyAtoms(s.id, reply.atoms, relatedIds, reply.fulfilled);
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
    const transcripts = require('./transcript-merge');
    transcripts.cutForReading();
    promises.collectClassified(jobs, parseObject);
    const checked = promises.collectCheck(jobs, parseObject);
    const wrote = standings.collect(jobs, parseObject);
    const sized = taskLength.collect(jobs, parseObject);
    const rechecked = require('./project-check').collect(jobs, parseObject);
    meetings.collect(jobs);
    const helped = taskHelp.collect(jobs, parseObject);
    const jobRead = taskJobs.collect(jobs, parseObject);
    const followed = require('./task-followups').collect(jobs, parseObject);
    taskJobs.groupBySource();
    connections.collect(jobs);
    const inFlight = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE atomise_status = 'queued'").get().n
      + (promises.classifying() ? 1 : 0) + (promises.checking() ? 1 : 0) + (standings.writing() ? 1 : 0) + (taskLength.guessing() ? 1 : 0) + (require('./project-check').checking() ? 1 : 0) + (meetings.writing() ? 1 : 0) + (connections.writing() ? 1 : 0) + (taskHelp.writing() ? 1 : 0) + (taskJobs.writing() ? 1 : 0) + (require('./task-followups').writing() ? 1 : 0);
    // A job carries the source ids it was given, so parts are joined only between jobs.
    if (!inFlight && transcripts.waiting().length) await runs.track('transcript_merge', async () => transcripts.run()).catch(() => {});
    // Only interactive/morning high-priority jobs (chat, search ask, reports,
    // digests) pause fresh CRM capture; background Money/Briefing/House work
    // should not starve incoming email and meeting reading.
    const othersWaiting = typeof jobs.hasHighPriorityPending === 'function'
      ? (jobs.hasHighPriorityPending(29) ? 1 : 0)
      : jobs.queueStats().pending;
    let queued = null;
    // Give a lane that just said no a whole tick before asking again.
    if (!inFlight && !othersWaiting && !retrying && !checked?.retrying && !wrote?.retrying && !sized?.retrying && !rechecked?.retrying && !helped?.retrying && !jobRead?.retrying && !followed?.retrying) {
      // Immediate tier: today's meeting prep, follow-ups from just-finished tasks,
      // promise sorting/checks, task sizing, and fresh incoming sources go ahead of
      // slower Opus task/job essays and background enrichment.
      const immediate = meetings.enqueueNext(jobs) || require('./task-followups').enqueueNext(jobs) || promises.enqueueClassify(jobs) || promises.enqueueCheck(jobs) || taskLength.enqueueNext(jobs);
      let source = immediate ? null : nextSource({ freshOnly: true });
      const enrichment = immediate || source ? false : (require('./project-check').enqueueNext(jobs) || taskHelp.enqueueNext(jobs) || taskJobs.enqueueNext(jobs));
      if (!immediate && !source && !enrichment) source = nextSource();
      // Summaries wait until every source has been read, so they include it.
      if (!immediate && !source && !enrichment) taskHelp.enqueueNext(jobs, { refresh: true }) || taskJobs.enqueueNext(jobs, { refresh: true }) || standings.enqueueNext(jobs) || connections.enqueueNext(jobs);
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
  FEATURE, SYSTEM_PROMPT, MAX_FRESH, buildPacket, parseModelJson, parseModelReply, transientError, applyAtoms, quoteVerified, ftsQuery,
  resolveMention, reresolveMentions, runAtomiseTick, nextSource, retrySource, indexAtom, collectFinished,
};
