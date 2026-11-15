'use strict';

// A released recording is cut into parts only because the reader takes one part
// per sitting. Once every part has been read, the parts become one source
// again: one transcript to open and one thing for facts and tasks to cite.
//
// The reader only reads the start of a long source, so a joined transcript that
// has to be read again (Douglas moved it to the other space) is cut back into
// parts first, read part by part, and joined again afterwards.

const { crm, now } = require('./db');

// The size speaker-review.js cuts a release into.
const PART = 20000;
const INTAKE_REF = /^krisp-intake:([a-f0-9]{64})$/;
// Columns that carry a source id inside JSON or a tagged value. The Google copy
// of a task, sent effects and saved reports are history and keep the old id;
// `source_merges` leads those to the joined transcript.
const HOLDERS = [['tasks', 'context'], ['promises', 'closed_by'], ['promises', 'not_done_sources'], ['deleted_facts', 'source_ids'],
  ['task_help', 'refs'], ['task_help', 'help'], ['job_steps', 'refs'], ['job_help', 'refs'], ['job_help', 'help']];

function reindex(id) {
  const db = crm();
  const s = db.prepare('SELECT id, space, title, text FROM sources WHERE id = ?').get(id);
  db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id);
  db.prepare('INSERT INTO sources_fts (source_id, space, title, body) VALUES (?, ?, ?, ?)').run(s.id, s.space, s.title, s.text);
}

function join(intake, t = now()) {
  const db = crm();
  const ids = JSON.parse(intake.source_ids || '[]');
  if (ids.length < 2) return false;
  const parts = ids.map(id => db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
  // Parts Douglas filed in different spaces are two transcripts now, and a part
  // that is unread or failed still needs a sitting of its own.
  if (parts.some(p => !p || p.kind !== 'meeting' || p.raw_ref !== `krisp-intake:${intake.id}` || p.space !== parts[0].space || p.atomise_status !== 'done')) return false;
  const [keep, ...rest] = parts;
  db.transaction(() => {
    for (const p of rest) {
      for (const x of db.prepare('SELECT * FROM atom_sources WHERE source_id = ?').all(p.id)) {
        const mine = db.prepare('SELECT * FROM atom_sources WHERE atom_id = ? AND source_id = ?').get(x.atom_id, keep.id);
        if (!mine) { db.prepare('UPDATE atom_sources SET source_id = ? WHERE atom_id = ? AND source_id = ?').run(keep.id, x.atom_id, p.id); continue; }
        // The same fact heard in two parts keeps its checked quote.
        if (x.quote_verified > mine.quote_verified) db.prepare('UPDATE atom_sources SET quote = ?, quote_verified = ? WHERE atom_id = ? AND source_id = ?').run(x.quote, x.quote_verified, x.atom_id, keep.id);
        db.prepare('DELETE FROM atom_sources WHERE atom_id = ? AND source_id = ?').run(x.atom_id, p.id);
      }
      db.prepare('UPDATE tasks SET source_id = ? WHERE source_id = ?').run(keep.id, p.id);
      db.prepare('UPDATE promises SET looks_done_source_id = ? WHERE looks_done_source_id = ?').run(keep.id, p.id);
      for (const [table, column] of HOLDERS) db.prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE instr(${column}, ?) > 0`).run(p.id, keep.id, p.id);
      db.prepare('INSERT OR IGNORE INTO source_addresses (source_id, kind, value, role, name) SELECT ?, kind, value, role, name FROM source_addresses WHERE source_id = ?').run(keep.id, p.id);
      db.prepare('DELETE FROM settings WHERE key = ?').run(`related:${p.id}`);
      db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(p.id);
      db.prepare('DELETE FROM sources WHERE id = ?').run(p.id);
      db.prepare('UPDATE source_merges SET into_id = ? WHERE into_id = ?').run(keep.id, p.id);
      db.prepare('INSERT INTO source_merges (old_id, into_id, at) VALUES (?, ?, ?)').run(p.id, keep.id, t);
    }
    db.prepare(`UPDATE sources SET title = ?, text = ?, text_fresh = ?, atomised_at = ?,
        atom_count = (SELECT COUNT(*) FROM atom_sources WHERE source_id = ?) WHERE id = ?`)
      .run(intake.title, parts.map(p => p.text).join('\n\n'), parts.map(p => p.text_fresh).join('\n\n'),
        Math.max(...parts.map(p => p.atomised_at || 0)) || null, keep.id, keep.id);
    reindex(keep.id);
    db.prepare('UPDATE krisp_intake SET source_ids = ? WHERE id = ?').run(JSON.stringify([keep.id]), intake.id);
  })();
  return true;
}

const waiting = () => crm().prepare("SELECT * FROM krisp_intake WHERE status = 'classified' AND json_array_length(source_ids) > 1").all();

// Joins every recording whose parts have all been read. Call only when no model
// job is in flight: a job carries the ids it was given.
function run(t = now()) {
  let joined = 0;
  for (const intake of waiting()) if (join(intake, t)) joined += 1;
  return { joined };
}

function pieces(text) {
  const out = [];
  for (const para of String(text).split('\n\n')) {
    if (!para) continue;
    // One turn longer than a part cannot happen in a released transcript, but nothing may be dropped if it does.
    if (para.length > PART) { for (let i = 0; i < para.length; i += PART) out.push(para.slice(i, i + PART)); continue; }
    if (out.length && out[out.length - 1].length + 2 + para.length <= PART) out[out.length - 1] += `\n\n${para}`;
    else out.push(para);
  }
  return out;
}

// Before the reader picks its next source: a joined transcript waiting to be
// read is cut back into parts, so all of it is read and not just its start.
function cutForReading() {
  const db = crm();
  const limit = require('./atoms').MAX_FRESH;
  let cut = 0;
  for (const s of db.prepare(`SELECT * FROM sources WHERE kind = 'meeting' AND atomise_status = 'pending' AND readable = 1
      AND raw_ref LIKE 'krisp-intake:%' AND length(text) > ?`).all(limit)) {
    const key = INTAKE_REF.exec(s.raw_ref)?.[1];
    const intake = key && db.prepare("SELECT * FROM krisp_intake WHERE id = ? AND status = 'classified'").get(key);
    if (!intake || JSON.parse(intake.source_ids).join() !== s.id) continue;
    const parts = pieces(s.text);
    if (parts.length < 2) continue;
    db.transaction(() => {
      const title = i => `${intake.title} (part ${i + 1} of ${parts.length})`;
      db.prepare('UPDATE sources SET title = ?, text = ?, text_fresh = ? WHERE id = ?').run(title(0), parts[0], parts[0], s.id);
      reindex(s.id);
      const ids = [s.id];
      parts.slice(1).forEach((part, i) => {
        const r = require('./sources').admitSource({ space: s.space, kind: 'meeting', origin: s.origin, externalId: `${intake.id}:${i + 2}`,
          title: title(i + 1), text: part, fresh: part, occurredAt: s.occurred_at, rawRef: s.raw_ref, readable: true, isHistory: !!s.is_history });
        if (!r.created) throw new Error(`Part ${i + 2} of “${intake.title}” already exists, so the transcript was not cut for reading`);
        db.prepare('UPDATE sources SET space_by = ?, space_why = ? WHERE id = ?').run(s.space_by, s.space_why, r.source.id);
        ids.push(r.source.id);
      });
      db.prepare('UPDATE krisp_intake SET source_ids = ? WHERE id = ?').run(JSON.stringify(ids), intake.id);
    })();
    cut += 1;
  }
  return cut;
}

// Where a link to a part that has since been joined should go.
function joinedInto(id) {
  return crm().prepare('SELECT s.id, s.space FROM source_merges m JOIN sources s ON s.id = m.into_id WHERE m.old_id = ?').get(id) || null;
}

module.exports = { run, join, waiting, cutForReading, joinedInto, pieces, PART };
