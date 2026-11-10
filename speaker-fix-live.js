'use strict';

// One-off correction for the live Hub: the meeting recorded 10 Nov 2026 was read
// with "Speaker 1" still unresolved. Douglas has confirmed Speaker 1 is
// Margaret Callanan. This patches the compiled rows only; the original
// recording transcript and raw_json stay exactly as recorded.
//
// Run with --dry-run first: it prints the plan and touches nothing.

const Database = require(process.env.BETTER_SQLITE3 || '/app/node_modules/better-sqlite3');

const DB = process.env.CRM_DB_PATH || '/app/data/crm.db';
const INTAKE = '225467ef916f506df5cab96bac0d2402dfaf57a1305b90d9412557e48c2a14a0';
const SOURCES = [
  'b25fb7d3-f54b-4d77-8115-ff96d9d59354',
  '8d6b1521-a1d2-444e-a0bd-1c1e703440d8',
  'eb414dbb-e66e-4170-84d9-f65485c03423',
  'a3e22417-735c-422e-8ce4-be305ea5214f',
];
const TASK = '64d171cf-6290-4261-acf6-5a195988d066';
const LABEL = 'Speaker 1';
const NAME = 'Margaret Callanan';
const SPACE = 'work';

const DRY = process.argv.includes('--dry-run');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = `${DB}.bak-speaker-${STAMP}`;

const PROSE = new RegExp(`${LABEL}(?![0-9])`, 'g');
const prose = v => (typeof v === 'string' ? v.replace(PROSE, NAME) : v);
const label = v => (typeof v === 'string' ? v.replace(new RegExp(`^${LABEL}:(\\s?)`, 'gm'), (_, s) => `${NAME}:${s}`) : v);
const has = (v, needle = LABEL) => typeof v === 'string' && new RegExp(`${needle}(?![0-9])`).test(v);

const db = new Database(DB);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
const now = () => Math.floor(Date.now() / 1000);

function backup() {
  db.exec(`VACUUM INTO '${BACKUP}'`);
  const check = new Database(BACKUP, { readonly: true });
  const tables = check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
  const sources = check.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  check.close();
  return { path: BACKUP, tables, sources };
}

function person() {
  // people has no stored normalised name; the matcher normalises in code.
  const norm = v => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return db.prepare('SELECT id, name FROM people WHERE space = ?').all(SPACE)
    .filter(p => norm(p.name) === 'margaret callanan');
}

// ---------------------------------------------------------------- the plan

const sourceRows = db.prepare(`SELECT id, title, text, text_fresh FROM sources WHERE id IN (${SOURCES.map(() => '?').join(',')})`).all(...SOURCES);
if (sourceRows.length !== SOURCES.length) throw new Error(`expected ${SOURCES.length} sources, found ${sourceRows.length}`);

// An atom shared with evidence outside this delivery is left alone, exactly as
// the shipped correction module does.
const atomRows = db.prepare(`SELECT a.id, a.statement,
    (SELECT COUNT(*) FROM atom_sources x2 WHERE x2.atom_id = a.id AND x2.source_id NOT IN (${SOURCES.map(() => '?').join(',')})) AS outside
  FROM atoms a JOIN atom_sources x ON x.atom_id = a.id
  WHERE x.source_id IN (${SOURCES.map(() => '?').join(',')}) GROUP BY a.id`).all(...SOURCES, ...SOURCES);
const sharedAtoms = atomRows.filter(a => a.outside).map(a => a.id);
const atomIds = atomRows.filter(a => !a.outside).map(a => a.id);
const inAtoms = placeholders => (atomIds.length ? `(${atomIds.map(() => '?').join(',')})` : "(NULL)");
const mentionRows = atomIds.length
  ? db.prepare(`SELECT * FROM atom_mentions WHERE atom_id IN ${inAtoms()} AND name_norm = 'speaker 1'`).all(...atomIds)
  : [];
const promiseRows = atomIds.length
  ? db.prepare(`SELECT * FROM promises WHERE atom_id IN ${inAtoms()} AND (who LIKE '%${LABEL}%' OR action LIKE '%${LABEL}%')`).all(...atomIds)
  : [];
const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(TASK);
const snapshot = taskRow && taskRow.source_id
  ? db.prepare('SELECT id, text, text_fresh FROM sources WHERE id = ?').get(taskRow.source_id) : null;

const matches = person();
if (matches.length !== 1 || matches[0].id !== '7251df4d-2406-4b67-a153-b31bafe302d8') {
  throw new Error(`expected exactly one Margaret Callanan in ${SPACE}, found ${JSON.stringify(matches)}`);
}
const personId = matches[0].id;

const plan = {
  intake: INTAKE,
  label: LABEL,
  name: NAME,
  personId,
  backup: DRY ? '(dry run: no backup taken)' : null,
  sources: sourceRows.filter(s => has(s.text) || has(s.text_fresh)).map(s => ({
    id: s.id, title: s.title,
    labels: (s.text.match(new RegExp(`^${LABEL}:`, 'gm')) || []).length,
    elsewhere: (s.text.replace(new RegExp(`^${LABEL}:(\\s?)`, 'gm'), '') .match(PROSE) || []).length,
  })),
  atoms: atomRows.filter(a => !a.outside && has(a.statement)).map(a => ({ id: a.id, before: a.statement, after: prose(a.statement) })),
  atomsUnchanged: atomRows.filter(a => !a.outside && !has(a.statement)).length,
  atomsShared: sharedAtoms,
  mentions: mentionRows.map(m => ({ id: m.id, atomId: m.atom_id, status: m.status, personId: m.person_id, how: m.how })),
  promises: promiseRows.map(p => ({ atomId: p.atom_id, who: p.who, action: p.action, whoAfter: prose(p.who), actionAfter: prose(p.action) })),
  task: taskRow ? {
    id: taskRow.id, title: taskRow.title, titleAfter: prose(taskRow.title),
    revision: taskRow.revision, syncedRevision: taskRow.synced_revision,
    notesBefore: taskRow.notes, notesAfter: prose(taskRow.notes),
    snapshot: snapshot ? { id: snapshot.id, textBefore: snapshot.text, textAfter: prose(snapshot.text) } : null,
  } : null,
  quotesTouched: atomIds.length ? db.prepare(`SELECT quote FROM atom_sources WHERE atom_id IN ${inAtoms()}`).all(...atomIds).filter(r => has(r.quote)).length : 0,
  intakeTranscriptHasLabel: has(db.prepare('SELECT transcript FROM krisp_intake WHERE id = ?').get(INTAKE).transcript),
};

if (DRY) {
  console.log(JSON.stringify(plan, null, 2));
  console.log('dry run: nothing written');
  process.exit(0);
}

// ---------------------------------------------------------------- the write

plan.backup = backup();

const receipt = {
  at: now(), by: 'you', reason: 'Douglas confirmed Speaker 1 is Margaret Callanan',
  mapping: [{ label: LABEL, name: NAME }], personId,
  intake: INTAKE, sources: plan.sources.map(s => s.id), atoms: plan.atoms.map(a => a.id),
  mentions: plan.mentions.map(m => m.id), promises: plan.promises.map(p => p.atomId),
  tasks: plan.task ? [plan.task.id] : [], snapshot: plan.task && plan.task.snapshot ? plan.task.snapshot.id : null,
  backup: BACKUP,
};

const write = db.transaction(() => {
  for (const s of sourceRows) {
    const text = label(s.text), fresh = label(s.text_fresh);
    if (text === s.text && fresh === s.text_fresh) continue;
    db.prepare('UPDATE sources SET text = ?, text_fresh = ? WHERE id = ?').run(text, fresh, s.id);
    db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(s.id);
    const row = db.prepare('SELECT id, space, title, text FROM sources WHERE id = ?').get(s.id);
    db.prepare('INSERT INTO sources_fts (source_id, space, title, body) VALUES (?, ?, ?, ?)').run(row.id, row.space, row.title, row.text);
  }

  for (const a of atomRows) {
    if (a.outside || !has(a.statement)) continue;
    db.prepare('UPDATE atoms SET statement = ?, updated_at = ? WHERE id = ?').run(prose(a.statement), now(), a.id);
    db.prepare('DELETE FROM atoms_fts WHERE atom_id = ?').run(a.id);
    const row = db.prepare('SELECT id, space, statement FROM atoms WHERE id = ?').get(a.id);
    const topics = db.prepare('SELECT t.name FROM atom_topics at JOIN topics t ON t.id = at.topic_id WHERE at.atom_id = ?').all(a.id).map(t => t.name).join(' ');
    db.prepare('INSERT INTO atoms_fts (atom_id, space, statement, topics) VALUES (?, ?, ?, ?)').run(row.id, row.space, row.statement, topics);
  }

  for (const m of mentionRows) {
    if (m.how === 'you' || m.how === 'decided') continue;
    db.prepare("UPDATE atom_mentions SET name = ?, name_norm = 'margaret callanan', status = 'resolved', person_id = ?, how = 'name' WHERE id = ?")
      .run(NAME, personId, m.id);
    db.prepare("DELETE FROM review_items WHERE item_key = ? AND status = 'open'").run(`mention:${m.id}`);
  }

  for (const p of promiseRows) {
    db.prepare('UPDATE promises SET who = ?, action = ? WHERE atom_id = ?').run(prose(p.who), prose(p.action), p.atom_id);
  }

  if (taskRow && (prose(taskRow.title) !== taskRow.title || prose(taskRow.notes) !== taskRow.notes)) {
    const title = prose(taskRow.title), notes = prose(taskRow.notes);
    const taskCols = columns('tasks');
    const sets = ['title = ?', 'notes = ?'];
    const args = [title, notes];
    if (taskCols.has('revision')) sets.push('revision = revision + 1');
    if (taskCols.has('updated_at')) { sets.push('updated_at = ?'); args.push(now()); }
    if (taskCols.has('sync_error')) sets.push("sync_error = ''");
    if (taskCols.has('conflict')) sets.push("conflict = ''");
    db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, TASK);
    if (snapshot && (prose(snapshot.text) !== snapshot.text || prose(snapshot.text_fresh) !== snapshot.text_fresh)) {
      const text = prose(snapshot.text), fresh = prose(snapshot.text_fresh);
      db.prepare('UPDATE sources SET text = ?, text_fresh = ? WHERE id = ?').run(text, fresh, snapshot.id);
      db.prepare('DELETE FROM sources_fts WHERE source_id = ?').run(snapshot.id);
      const row = db.prepare('SELECT id, space, title, text FROM sources WHERE id = ?').get(snapshot.id);
      db.prepare('INSERT INTO sources_fts (source_id, space, title, body) VALUES (?, ?, ?, ?)').run(row.id, row.space, row.title, row.text);
    }
  }

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`speaker-correction:${INTAKE}:${receipt.at}`, JSON.stringify(receipt));

  // The intake row keeps the recording's own transcript; note the correction
  // beside it when the column exists.
  if (columns('krisp_intake').has('speaker_review')) {
    const row = db.prepare('SELECT speaker_review FROM krisp_intake WHERE id = ?').get(INTAKE);
    let saved = {};
    try { saved = JSON.parse(row.speaker_review || '{}'); } catch { saved = {}; }
    saved.corrections = [...(Array.isArray(saved.corrections) ? saved.corrections : []), { at: receipt.at, mapping: receipt.mapping }];
    db.prepare('UPDATE krisp_intake SET speaker_review = ? WHERE id = ?').run(JSON.stringify(saved), INTAKE);
  }
});
write();

// ---------------------------------------------------------------- read back

const left = {};
// LIKE '%Speaker 1%' would also match Speaker 10, so scan the values and test
// the same whole-label rule the rewrite uses.
const countLeft = (table, cols, where, args) => db.prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE ${where}`).all(...args)
  .filter(row => cols.some(c => has(row[c]))).length;
left.sourcesText = countLeft('sources', ['text'], `id IN (${SOURCES.map(() => '?').join(',')})`, SOURCES);
left.sourcesFresh = countLeft('sources', ['text_fresh'], `id IN (${SOURCES.map(() => '?').join(',')})`, SOURCES);
left.atoms = atomIds.length ? countLeft('atoms', ['statement'], `id IN ${inAtoms()}`, atomIds) : 0;
left.atomsShared = sharedAtoms.length ? countLeft('atoms', ['statement'], `id IN (${sharedAtoms.map(() => '?').join(',')})`, sharedAtoms) : 0;
left.mentions = atomIds.length ? db.prepare(`SELECT name, name_norm FROM atom_mentions WHERE atom_id IN ${inAtoms()}`).all(...atomIds)
  .filter(m => has(m.name) || m.name_norm === 'speaker 1').length : 0;
left.promises = atomIds.length ? countLeft('promises', ['who', 'action'], `atom_id IN ${inAtoms()}`, atomIds) : 0;
left.tasks = countLeft('tasks', ['title', 'notes'], 'id = ?', [TASK]);
left.quotes = atomIds.length ? countLeft('atom_sources', ['quote'], `atom_id IN ${inAtoms()}`, atomIds) : 0;
left.snapshot = snapshot ? countLeft('sources', ['text', 'text_fresh'], 'id = ?', [snapshot.id]) : 0;
left.intakeTranscript = has(db.prepare('SELECT transcript FROM krisp_intake WHERE id = ?').get(INTAKE).transcript) ? 'kept (original recording)' : 'none';

const after = {
  source: db.prepare('SELECT id, substr(text, 1, 300) AS text FROM sources WHERE id = ?').get(SOURCES[0]),
  atom: db.prepare('SELECT id, statement FROM atoms WHERE id = ?').get(atomIds[0]),
  mention: db.prepare('SELECT id, name, name_norm, status, person_id, how FROM atom_mentions WHERE id = ?').get(mentionRows[0] && mentionRows[0].id),
  promise: db.prepare('SELECT atom_id, who, action FROM promises WHERE atom_id = ?').get(promiseRows[0] && promiseRows[0].atom_id),
  task: db.prepare('SELECT id, title, notes, revision, synced_revision, sync_error, conflict FROM tasks WHERE id = ?').get(TASK),
  snapshot: snapshot ? db.prepare('SELECT id, substr(text, 1, 300) AS text FROM sources WHERE id = ?').get(snapshot.id) : null,
};

console.log(JSON.stringify({ plan, left, after }, null, 2));
const bad = ['sourcesText', 'sourcesFresh', 'atoms', 'mentions', 'promises', 'tasks', 'snapshot'].filter(k => left[k] !== 0);
if (bad.length) { console.error('NOT CLEAN:', bad.join(', ')); process.exit(1); }
console.log('done: no Speaker 1 label left in the compiled rows');
