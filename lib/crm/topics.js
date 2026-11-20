'use strict';

// Deterministic topic tidy: finds near-duplicate topics in one space (plurals,
// punctuation/hyphen differences, spelling variants like licence/license) and
// merges them cleanly, updating FTS indexes.

const { crm } = require('./db');
const { indexAtom } = require('./atoms');

function canonicalKey(name) {
  let s = String(name || '').toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // UK/US spelling normalisations common in IT/healthcare work.
  s = s.replace(/\blicenses?\b/g, 'licence').replace(/\blicences?\b/g, 'licence')
    .replace(/\borganizations?\b/g, 'organisation').replace(/\borganisations?\b/g, 'organisation')
    .replace(/\bm365\b/g, 'microsoft 365');
  // Light singularisation for trailing 's' on longer words (avoiding 'ss', 'is', 'us').
  s = s.split(' ').map(w => (w.length > 4 && w.endsWith('s') && !/(ss|is|us|ics)$/.test(w) ? w.slice(0, -1) : w)).join(' ');
  return s;
}

function duplicates(space) {
  const rows = crm().prepare(`
    SELECT t.id, t.name, t.name_norm, COUNT(at.atom_id) AS n
      FROM topics t LEFT JOIN atom_topics at ON at.topic_id = t.id
     WHERE t.space = ? GROUP BY t.id ORDER BY n DESC, t.name COLLATE NOCASE
  `).all(space);
  const groups = new Map();
  for (const r of rows) {
    const key = canonicalKey(r.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].filter(g => g.length >= 2).map(g => ({ keep: g[0], merge: g.slice(1) }));
}

function mergeTopic(fromId, intoId, space) {
  const db = crm();
  if (fromId === intoId) throw new Error('Choose two different topics');
  const from = db.prepare('SELECT * FROM topics WHERE id = ? AND space = ?').get(fromId, space);
  const into = db.prepare('SELECT * FROM topics WHERE id = ? AND space = ?').get(intoId, space);
  if (!from || !into) throw new Error('Topic not found');
  const atomIds = db.prepare('SELECT atom_id FROM atom_topics WHERE topic_id = ?').all(fromId).map(r => r.atom_id);
  db.transaction(() => {
    for (const aid of atomIds) db.prepare('INSERT OR IGNORE INTO atom_topics (atom_id, topic_id) VALUES (?, ?)').run(aid, intoId);
    db.prepare('DELETE FROM atom_topics WHERE topic_id = ?').run(fromId);
    db.prepare('DELETE FROM topics WHERE id = ?').run(fromId);
  })();
  for (const aid of atomIds) indexAtom(aid);
  return { from: from.name, into: into.name, moved: atomIds.length };
}

function tidyAll(space) {
  const groups = duplicates(space);
  let merged = 0;
  for (const g of groups) {
    for (const m of g.merge) {
      mergeTopic(m.id, g.keep.id, space);
      merged += 1;
    }
  }
  return { groups: groups.length, merged };
}

module.exports = { canonicalKey, duplicates, mergeTopic, tidyAll };
