'use strict';

/**
 * Knowledge layer — reconciliation / lint (Stage 4).
 *
 * Keeps the substrate honest over time: decays confidence on claims that stop
 * being reconfirmed, marks long-dead claims stale, and surfaces three things a
 * human should look at — contradictions (two addresses for one person),
 * duplicate contacts (the "BenCtax" mailbox-alias vs a real person), and
 * proposed atoms the synthesis linker was not confident enough to auto-apply.
 *
 * The lint JOB performs the safe mutations (decay/stale). The analysis functions
 * are read-only and back the /admin/knowledge review queue.
 */

const db = require('./db');

const SINGLE_VALUED = ['lives_at', 'date_of_birth', 'email', 'phone'];
const DECAY_AFTER_DAYS = 180;
const STALE_DAYS = 365;

function parseAliases(j) {
  try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

// Single-valued predicates with more than one distinct active value per subject.
function contradictions(user) {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id, subject_id, subject_label, predicate, value, confidence, source_refs
      FROM knowledge_atoms
     WHERE user = ? AND status = 'active' AND subject_id IS NOT NULL
       AND predicate IN (${SINGLE_VALUED.map(() => '?').join(',')})
  `).all(user, ...SINGLE_VALUED);
  const groups = {};
  for (const r of rows) (groups[`${r.subject_id}|${r.predicate}`] ||= []).push(r);
  const out = [];
  for (const k of Object.keys(groups)) {
    const arr = groups[k];
    const distinct = new Set(arr.map(a => String(a.value).toLowerCase().trim()));
    if (distinct.size > 1) out.push({ subjectLabel: arr[0].subject_label, predicate: arr[0].predicate, values: arr });
  }
  return out;
}

// Contact pairs that look like the same person/mailbox.
function duplicateContacts(user) {
  const contacts = db.hub().prepare('SELECT id, name, email, aliases FROM contacts WHERE user = ?').all(user);
  const pairs = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i], b = contacts[j];
      const reasons = [];
      if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) reasons.push('same email');
      if (a.name.trim().toLowerCase() === b.name.trim().toLowerCase()) reasons.push('same name');
      const aAl = parseAliases(a.aliases).map(x => String(x).toLowerCase());
      const bAl = parseAliases(b.aliases).map(x => String(x).toLowerCase());
      if (aAl.includes(b.name.toLowerCase()) || bAl.includes(a.name.toLowerCase())) reasons.push('name is an alias of the other');
      if (reasons.length) pairs.push({ a, b, reasons });
    }
  }
  return pairs;
}

function atomsByStatus(user, status) {
  return db.hub().prepare(
    'SELECT * FROM knowledge_atoms WHERE user = ? AND status = ? ORDER BY updated_at DESC'
  ).all(user, status);
}

// Safe maintenance mutations + a summary of what needs review.
function runLint(user) {
  const hub = db.hub();
  const now = Math.floor(Date.now() / 1000);
  const decayed = hub.prepare(`
    UPDATE knowledge_atoms SET confidence = MAX(0.2, confidence - 0.05), updated_at = ?
     WHERE user = ? AND status = 'active' AND last_confirmed < ?
  `).run(now, user, now - DECAY_AFTER_DAYS * 86400);
  const staled = hub.prepare(`
    UPDATE knowledge_atoms SET status = 'stale', updated_at = ?
     WHERE user = ? AND status = 'active' AND last_confirmed < ?
  `).run(now, user, now - STALE_DAYS * 86400);
  return {
    decayed: decayed.changes,
    staled: staled.changes,
    contradictions: contradictions(user).length,
    duplicateContacts: duplicateContacts(user).length,
    proposed: atomsByStatus(user, 'proposed').length,
  };
}

function reviewQueue(user) {
  return {
    contradictions: contradictions(user),
    duplicateContacts: duplicateContacts(user),
    proposed: atomsByStatus(user, 'proposed'),
    stale: atomsByStatus(user, 'stale'),
  };
}

module.exports = { runLint, reviewQueue, contradictions, duplicateContacts, atomsByStatus };
