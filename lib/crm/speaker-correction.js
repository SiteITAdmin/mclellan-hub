'use strict';

// A confirmed speaker name is raw attribution, not a relationship: Douglas
// tells the Hub who spoke, and the placeholder in evidence that has already
// been released is corrected in place. Quotes and the original delivery are
// never rewritten, and no source is read again, so no fact or task is repeated.
//
// This is containment: it patches the compiled rows that carry the placeholder
// rather than re-synthesising the meeting. Anything shared with another source,
// or decided by Douglas himself, is left alone and reported.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const { normName } = require('./text');

const PLACEHOLDER = /^(speaker|unknown|unidentified)(\s*\d+)?$/i;
// The reader only ever writes "Speaker N". Other labels may be corrected in the
// transcript, but their name is too ordinary to rewrite inside prose safely.
const REWRITABLE = /^speaker\s*\d+$/i;
const MAX_NAME = 80;
const LABEL = "[\\p{L}\\p{N}][\\p{L}\\p{N} ._'’-]{0,79}";
const LABEL_LINE = new RegExp(`^(${LABEL}):[ \\t]+\\S`, 'u');
// A saved name must still read as a label afterwards, or the panel could no
// longer offer it and a typo in it could never be corrected.
const NAME = new RegExp(`^${LABEL}$`, 'u');

function intakeIdOf(source) {
  const match = /^krisp-intake:([a-f0-9]{64})$/.exec(String((source && source.raw_ref) || ''));
  return match ? match[1] : null;
}

function labelsIn(text) {
  const counts = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = LABEL_LINE.exec(line);
    if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return counts;
}

// What can be corrected on this page: the speaker labels actually present in
// the released parts of the same delivery. A label the reader never saw is not
// offered, and a label already named is shown as it stands.
function review(sourceId) {
  const db = crm();
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  const intakeId = intakeIdOf(source);
  if (!source || source.origin !== 'krisp' || !intakeId) return null;
  const intake = db.prepare('SELECT * FROM krisp_intake WHERE id = ?').get(intakeId);
  if (!intake || intake.status !== 'classified') return null;
  const ids = JSON.parse(intake.source_ids || '[]');
  const parts = ids.map(id => db.prepare('SELECT * FROM sources WHERE id = ?').get(id)).filter(Boolean);
  // A part Douglas moved to the other space belongs there now; a correction
  // made from this space must not reach into it.
  const sources = parts.filter(s => s.space === source.space);
  const otherSpace = parts.length - sources.length;
  const labels = new Map();
  for (const s of sources) for (const [label, count] of labelsIn(s.text)) labels.set(label, (labels.get(label) || 0) + count);
  return {
    intakeId, sources, otherSpace,
    labels: [...labels.entries()].map(([label, count]) => ({ label, count, placeholder: PLACEHOLDER.test(label) })),
  };
}

function bad(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cleanName(value, label) {
  const name = String(value == null ? '' : value).trim();
  if (!name || PLACEHOLDER.test(name)) throw bad(`Use a real name for ${label}`);
  if (name.length > MAX_NAME || !NAME.test(name)) {
    throw bad(`Use only letters, numbers, spaces, full stops, apostrophes and hyphens for ${label} (up to ${MAX_NAME} characters)`);
  }
  if (normName(name) === normName(label)) throw bad(`${label} needs a name, not the same label`);
  return name;
}

// Only column-zero lines are attribution. An indented "Speaker 1:" is speech
// the transcript quoted, and must stay exactly as it was said.
function renameLabels(text, byLabel) {
  return String(text || '').split('\n').map(line => {
    for (const [label, name] of byLabel) {
      const head = `${label}:`;
      if (line === head) return name + ':';
      if (line.startsWith(`${head} `) || line.startsWith(`${head}\t`)) return name + line.slice(label.length);
    }
    return line;
  }).join('\n');
}

// In a statement or a task title the placeholder is a name inside a sentence.
// One pass, whole phrase only, and only the reader's own "Speaker N" form:
// Speaker 1 never eats Speaker 10, and a person's first name is never treated
// as a placeholder in prose.
function renameMentions(text, pairs) {
  const usable = pairs.filter(p => REWRITABLE.test(p.label));
  if (!usable.length) return String(text || '');
  const names = new Map(usable.map(p => [p.label, p.name]));
  const alternation = usable.map(p => p.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${alternation})(?![\\p{L}\\p{N}])`, 'giu');
  return String(text || '').replace(pattern, (_, before, label) => before + (names.get(label) || label));
}

function reindexSource(id) {
  const s = crm().prepare('SELECT id, space, title, text FROM sources WHERE id = ?').get(id);
  if (!s) return;
  crm().prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id);
  crm().prepare('INSERT INTO sources_fts (source_id, space, title, body) VALUES (?, ?, ?, ?)').run(s.id, s.space, s.title, s.text);
}

function placeholders(sql, values) {
  return `${sql} IN (${values.map(() => '?').join(',')})`;
}

/**
 * Apply Douglas's confirmed names to one processed Krisp meeting. Every part of
 * the delivery is corrected together, existing task IDs are kept, and the
 * original raw delivery plus each quote stay untouched.
 */
function correct(sourceId, mapping) {
  const db = crm();
  const found = review(sourceId);
  if (!found) throw bad('Only a processed Krisp meeting can have its speaker names corrected');
  if (!Array.isArray(mapping) || !mapping.length) throw bad('Choose a speaker and type the confirmed name');
  // A reply already on its way back was asked with the old text, so it would
  // bring the placeholder back after the correction.
  if (found.sources.some(s => s.atomise_status === 'queued')) throw bad('Part of this meeting is being read right now. Try again in a minute.');

  const known = new Map(found.labels.map(x => [x.label, x]));
  const seen = new Set();
  const pairs = mapping.map(entry => {
    const label = String((entry && entry.label) || '');
    if (!known.has(label)) throw bad(`There is no speaker called ${label} in this meeting`);
    if (seen.has(label)) throw bad(`${label} is listed twice`);
    seen.add(label);
    return { label, name: cleanName(entry && entry.name, label) };
  });
  const byLabel = new Map(pairs.map(p => [p.label, p.name]));
  const byNorm = new Map(pairs.filter(p => REWRITABLE.test(p.label)).map(p => [normName(p.label), p.name]));
  const ids = found.sources.map(s => s.id);

  const receipt = { at: now(), by: 'you', mapping: pairs, sourceIds: ids, otherSpaceParts: found.otherSpace,
    atoms: [], skippedAtoms: [], mentions: [], promises: [], tasks: [] };
  db.transaction(() => {
    const sorting = JSON.parse(require('./db').setting('promise_classify_job') || 'null');
    if (sorting && Array.isArray(sorting.ids) && sorting.ids.length) {
      const busy = db.prepare(`SELECT 1 FROM atom_sources WHERE ${placeholders('source_id', ids)} AND ${placeholders('atom_id', sorting.ids)} LIMIT 1`)
        .get(...ids, ...sorting.ids);
      if (busy) throw bad('A promise from this meeting is being sorted right now. Try again in a minute.');
    }

    for (const s of found.sources) {
      const text = renameLabels(s.text, byLabel);
      const fresh = renameLabels(s.text_fresh, byLabel);
      if (text === s.text && fresh === s.text_fresh) continue;
      db.prepare('UPDATE sources SET text = ?, text_fresh = ? WHERE id = ?').run(text, fresh, s.id);
      reindexSource(s.id);
    }

    // An atom can be shared with evidence outside this delivery (the reader
    // merges the same statement). Rewriting it would change another meeting's
    // facts, so those atoms are reported and left alone.
    const atomRows = db.prepare(`SELECT a.id, a.statement,
        (SELECT COUNT(*) FROM atom_sources x2 WHERE x2.atom_id = a.id AND x2.source_id NOT IN (${ids.map(() => '?').join(',')})) AS outside
      FROM atoms a JOIN atom_sources x ON x.atom_id = a.id
      WHERE ${placeholders('x.source_id', ids)} GROUP BY a.id`).all(...ids, ...ids);
    const statements = new Map();
    for (const a of atomRows) {
      if (a.outside) { receipt.skippedAtoms.push(a.id); continue; }
      const statement = renameMentions(a.statement, pairs);
      statements.set(a.id, { before: a.statement, after: statement });
      if (statement === a.statement) continue;
      db.prepare('UPDATE atoms SET statement = ?, updated_at = ? WHERE id = ?').run(statement, now(), a.id);
      require('./atoms').indexAtom(a.id);
      receipt.atoms.push(a.id);
    }

    const atomIds = [...statements.keys()];
    if (atomIds.length) {
      const normLabels = [...byNorm.keys()];
      if (normLabels.length) {
        const mentions = db.prepare(`SELECT * FROM atom_mentions WHERE ${placeholders('atom_id', atomIds)}
          AND ${placeholders('name_norm', normLabels)} AND how NOT IN ('you','decided')`).all(...atomIds, ...normLabels);
        for (const m of mentions) {
          const name = byNorm.get(m.name_norm);
          db.prepare("UPDATE atom_mentions SET name = ?, name_norm = ?, status = 'unresolved', person_id = NULL, how = '' WHERE id = ?")
            .run(name, normName(name), m.id);
          const open = db.prepare("SELECT id, payload FROM review_items WHERE kind = 'mention' AND status = 'open' AND item_key = ?").get(`mention:${m.id}`);
          if (open) {
            const payload = { ...JSON.parse(open.payload || '{}'), name };
            db.prepare('UPDATE review_items SET payload = ? WHERE id = ?').run(JSON.stringify(payload), open.id);
          }
          receipt.mentions.push(m.id);
        }
        // The existing matcher decides whether that name is one known person.
        for (const id of receipt.mentions) require('./atoms').resolveMention(id);
      }

      const promiseRows = db.prepare(`SELECT * FROM promises WHERE ${placeholders('atom_id', atomIds)}`).all(...atomIds);
      for (const p of promiseRows) {
        const who = renameMentions(p.who, pairs);
        const action = renameMentions(p.action, pairs);
        if (who === p.who && action === p.action) continue;
        db.prepare('UPDATE promises SET who = ?, action = ? WHERE atom_id = ?').run(who, action, p.atom_id);
        receipt.promises.push(p.atom_id);
      }

      // Promise tasks are the real ones: their own snapshot source means a
      // source_id lookup would miss them. Their notes start with the atom
      // statement followed by the exact quote, so only that prefix is replaced.
      const taskIds = new Map();
      for (const p of promiseRows) if (p.task_id) taskIds.set(p.task_id, p.atom_id);
      // A task derived from a promise whose atom was skipped (shared with
      // another delivery) belongs to that other evidence too. Leave it alone.
      const foreign = new Set(db.prepare(`SELECT task_id FROM promises
        WHERE task_id IS NOT NULL AND atom_id IS NOT NULL AND atom_id NOT IN (${atomIds.map(() => '?').join(',')})`)
        .all(...atomIds).map(r => r.task_id));
      const linked = db.prepare(`SELECT id, json_extract(context, '$.sourceId') AS context_source FROM tasks
        WHERE ${placeholders('source_id', ids)} OR json_extract(context, '$.sourceId') IN (${ids.map(() => '?').join(',')})`).all(...ids, ...ids);
      for (const t of linked) if (!taskIds.has(t.id) && !foreign.has(t.id)) taskIds.set(t.id, null);
      for (const [id, atomId] of taskIds) {
        if (foreign.has(id)) continue;
        const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        if (!t || t.status === 'deleted') continue;
        const title = renameMentions(t.title, pairs);
        let notes = t.notes;
        const change = atomId && statements.get(atomId);
        if (change && notes.startsWith(change.before)) notes = change.after + notes.slice(change.before.length);
        const changed = title !== t.title || notes !== t.notes;
        if (changed) {
          db.prepare(`UPDATE tasks SET title = ?, notes = ?, revision = revision + 1, updated_at = ?, sync_error = '', conflict = ''
            WHERE id = ?`).run(title, notes, now(), id);
          receipt.tasks.push(id);
        }
        // The task's own snapshot sources start with its title then its notes,
        // the same shape tasks.snapshot() writes. Each keeps its id; only the
        // title line and the statement prefix of the notes follow the correction.
        if (changed) {
          const snaps = db.prepare(`SELECT id, title, text, text_fresh FROM sources
            WHERE origin = 'crm_task' AND substr(external_id, 1, ?) = ?`).all(id.length + 1, `${id}:`);
          for (const snap of snaps) {
            const fix = body => {
              const cut = body.indexOf('\n\n');
              const head = cut === -1 ? body : body.slice(0, cut);
              let rest = cut === -1 ? '' : body.slice(cut);
              if (change && rest.startsWith(`\n\n${change.before}`)) rest = `\n\n${change.after}${rest.slice(change.before.length + 2)}`;
              return renameMentions(head, pairs) + rest;
            };
            const next = { title: renameMentions(snap.title, pairs), text: fix(snap.text), fresh: fix(snap.text_fresh) };
            if (next.title === snap.title && next.text === snap.text && next.fresh === snap.text_fresh) continue;
            db.prepare('UPDATE sources SET title = ?, text = ?, text_fresh = ? WHERE id = ?').run(next.title, next.text, next.fresh, snap.id);
            reindexSource(snap.id);
          }
        }
      }
    }

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`speaker-correction:${found.intakeId}:${receipt.at}:${uuid()}`, JSON.stringify(receipt));
    const intake = db.prepare('SELECT speaker_review FROM krisp_intake WHERE id = ?').get(found.intakeId);
    let saved = {};
    try { saved = JSON.parse(intake.speaker_review || '{}'); } catch { saved = {}; }
    saved.corrections = [...(Array.isArray(saved.corrections) ? saved.corrections : []), { at: receipt.at, mapping: pairs }];
    db.prepare('UPDATE krisp_intake SET speaker_review = ? WHERE id = ?').run(JSON.stringify(saved), found.intakeId);
  })();
  return receipt;
}

module.exports = { review, correct, intakeIdOf, labelsIn, renameLabels, renameMentions, PLACEHOLDER, REWRITABLE };
