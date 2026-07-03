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
const { uuid } = require('./id');

const SINGLE_VALUED = ['lives_at', 'date_of_birth', 'email', 'phone'];
const DECAY_AFTER_DAYS = 180;
const STALE_DAYS = 365;
const LINT_CONTEXT_KEY = 'knowledge_lint_last';

// Facts that cannot go out of date. A date of birth learned once from one
// care plan is true forever — it must never decay or go stale just because
// nobody restates it in new sources.
const IMMUTABLE_PREDICATES = ['date_of_birth', 'born_on', 'died_on', 'maiden_name', 'birthplace'];
const IMMUTABLE_PREDICATE_RE = /^(father|mother|parent|son|daughter|child|brother|sister|sibling|spouse|wife|husband|grandfather|grandmother|grandparent|grandchild|grandson|granddaughter)(_of)?$/;

function isImmutablePredicate(predicate) {
  const p = String(predicate || '').toLowerCase().trim();
  return IMMUTABLE_PREDICATES.includes(p) || IMMUTABLE_PREDICATE_RE.test(p);
}

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

// Atoms past a last_confirmed cutoff whose predicate is allowed to age.
function ageableAtomIds(hub, user, cutoff) {
  return hub.prepare(`
    SELECT id, predicate, subject_label, value FROM knowledge_atoms
     WHERE user = ? AND status = 'active' AND last_confirmed < ?
  `).all(user, cutoff).filter(a => !isImmutablePredicate(a.predicate));
}

function updateByIds(hub, ids, setSql, now) {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  return hub.prepare(
    `UPDATE knowledge_atoms SET ${setSql}, updated_at = ? WHERE id IN (${placeholders})`
  ).run(now, ...ids).changes;
}

// Safe maintenance mutations + a summary of what needs review. Stale atoms are
// never deleted and stay retrievable through Ask the Hub and history views —
// stale only means "out of the default line of sight".
function runLint(user) {
  const hub = db.hub();
  const now = Math.floor(Date.now() / 1000);

  const decayCandidates = ageableAtomIds(hub, user, now - DECAY_AFTER_DAYS * 86400);
  const decayed = updateByIds(hub, decayCandidates.map(a => a.id), 'confidence = MAX(0.2, confidence - 0.05)', now);

  const staleCandidates = ageableAtomIds(hub, user, now - STALE_DAYS * 86400);
  const staled = updateByIds(hub, staleCandidates.map(a => a.id), `status = 'stale'`, now);

  const summary = {
    ranAt: now,
    decayed,
    staled,
    newlyStale: staleCandidates.slice(0, 20).map(a => ({
      subjectLabel: a.subject_label, predicate: a.predicate, value: String(a.value).slice(0, 120),
    })),
    contradictions: contradictions(user).length,
    duplicateContacts: duplicateContacts(user).length,
    proposed: atomsByStatus(user, 'proposed').length,
  };
  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, LINT_CONTEXT_KEY, JSON.stringify(summary));

  const { ranAt, newlyStale, ...counts } = summary;
  return counts;
}

function reviewQueue(user) {
  return {
    contradictions: contradictions(user),
    duplicateContacts: duplicateContacts(user),
    proposed: atomsByStatus(user, 'proposed'),
    stale: atomsByStatus(user, 'stale'),
  };
}

module.exports = {
  runLint, reviewQueue, contradictions, duplicateContacts, atomsByStatus,
  isImmutablePredicate, LINT_CONTEXT_KEY,
};
