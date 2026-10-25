'use strict';

// The one door in. Every capture lands here with its space, its participants
// and a readability verdict. Unknown people are proposed for review; mail
// from someone still waiting in review is held, not read, until Douglas
// decides who they are.

const { crm, now } = require('./db');
const { uuid } = require('../id');
const identity = require('./identity');
const { normEmail, nameFromEmail, looksAutomated, splitFresh } = require('./text');
const config = require('./config');

function proposalKey(kind, value) {
  return `addr:${kind}:${value}`;
}

function openProposal(kind, value) {
  return crm().prepare("SELECT * FROM review_items WHERE item_key = ? AND status = 'open'").get(proposalKey(kind, value)) || null;
}

// Offer an unknown address for review once; later sightings only add evidence.
function proposePerson({ kind = 'email', value, name, space, reason }) {
  const v = kind === 'email' ? normEmail(value) : value;
  if (!v || identity.isSelf(v)) return null;
  const known = identity.identifierRow(kind, v);
  if (known) return null;
  const existing = openProposal(kind, v);
  if (existing) return existing;
  const id = uuid();
  const payload = {
    kind, value: v,
    name: name || nameFromEmail(v) || '',
    reason,
    automated: kind === 'email' && looksAutomated(v),
  };
  crm().prepare("INSERT INTO review_items (id, kind, item_key, space, payload) VALUES (?, 'person', ?, ?, ?)")
    .run(id, proposalKey(kind, v), space, JSON.stringify(payload));
  return crm().prepare('SELECT * FROM review_items WHERE id = ?').get(id);
}

function sourceByExternal(origin, externalId) {
  return crm().prepare('SELECT * FROM sources WHERE origin = ? AND external_id = ?').get(origin, String(externalId)) || null;
}

function indexSource(id) {
  const s = crm().prepare('SELECT id, space, title, text FROM sources WHERE id = ?').get(id);
  if (!s) return;
  crm().prepare('DELETE FROM sources_fts WHERE source_id = ?').run(id);
  crm().prepare('INSERT INTO sources_fts (source_id, space, title, body) VALUES (?, ?, ?, ?)').run(s.id, s.space, s.title, s.text);
}

/**
 * Store one source. participants: [{ role: 'from'|'to'|'cc', email, name }].
 * proposeFrom: which unknown participants to offer for review ('from', 'to', 'all', 'none').
 * holdUnknownSender: incoming mail from someone not yet known is held, not read.
 */
function admitSource({
  space, kind, origin, externalId, title = '', occurredAt, direction = null,
  text = '', rawRef = '', participants = [], readable = true, unreadableReason = '',
  proposeFrom = 'none', holdUnknownSender = false, isHistory = null,
}) {
  if (!['work', 'personal'].includes(space)) throw new Error(`bad space: ${space}`);
  const existing = sourceByExternal(origin, externalId);
  if (existing) return { source: existing, created: false };

  const occurred = Math.floor(occurredAt || now());
  const history = isHistory !== null ? !!isHistory
    : occurred < now() - config.captureWindowDays * 86400;
  const { fresh } = splitFresh(text);

  const others = participants.filter(p => p.email && !identity.isSelf(p.email));
  const sender = participants.find(p => p.role === 'from');
  const senderEmail = sender ? normEmail(sender.email) : '';

  let status = readable ? 'pending' : 'skipped';
  if (readable && holdUnknownSender && senderEmail && !identity.isSelf(senderEmail)
      && !identity.personForAddress('email', senderEmail)) {
    status = identity.isIgnored('email', senderEmail) ? 'ignored' : 'held';
  }

  const id = uuid();
  const db = crm();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO sources (id, space, kind, origin, external_id, title, occurred_at, direction, text, text_fresh,
                           raw_ref, readable, unreadable_reason, is_history, atomise_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, space, kind, origin, String(externalId), String(title).slice(0, 500), occurred, direction,
      text, fresh || text, rawRef, readable ? 1 : 0, unreadableReason, history ? 1 : 0, status);
    const addr = db.prepare('INSERT OR IGNORE INTO source_addresses (source_id, kind, value, role, name) VALUES (?, ?, ?, ?, ?)');
    for (const p of participants) {
      const v = normEmail(p.email);
      if (v) addr.run(id, 'email', v, p.role, p.name || '');
    }
    for (const p of others) {
      const wanted = proposeFrom === 'all' || proposeFrom === p.role || (proposeFrom === 'to' && p.role === 'cc');
      if (!wanted) continue;
      if (identity.personForAddress('email', p.email) || identity.isIgnored('email', p.email)) continue;
      proposePerson({ value: p.email, name: p.name, space, reason: direction === 'out' ? 'You emailed them' : 'They emailed you' });
    }
  })();
  indexSource(id);
  return { source: db.prepare('SELECT * FROM sources WHERE id = ?').get(id), created: true };
}

// Called when Douglas decides who an address is: held mail from them is
// released for reading, or set aside for good if they're not a person.
function releaseHeld(email, decision) {
  const v = normEmail(email);
  const rows = crm().prepare(`
    SELECT DISTINCT s.id FROM sources s JOIN source_addresses a ON a.source_id = s.id
     WHERE s.atomise_status = 'held' AND a.kind = 'email' AND a.value = ? AND a.role = 'from'
  `).all(v);
  const status = decision === 'ignored' ? 'ignored' : 'pending';
  const stmt = crm().prepare("UPDATE sources SET atomise_status = ? WHERE id = ? AND atomise_status = 'held'");
  for (const r of rows) stmt.run(status, r.id);
  return rows.length;
}

// People on a source, derived from its addresses.
function sourcePeople(sourceId) {
  return crm().prepare(`
    SELECT DISTINCT p.*, a.role FROM source_addresses a
      JOIN identifiers i ON i.kind = a.kind AND i.value = a.value AND i.status = 'linked'
      JOIN people p ON p.id = i.person_id
     WHERE a.source_id = ?
  `).all(sourceId);
}

function addNote({ space, text }) {
  const body = String(text || '').trim();
  if (!body) throw new Error('The note is empty');
  const firstLine = body.split('\n')[0].slice(0, 120);
  return admitSource({
    space, kind: 'note', origin: 'note', externalId: uuid(), title: firstLine,
    occurredAt: now(), text: body, isHistory: false,
  }).source;
}

module.exports = { admitSource, proposePerson, releaseHeld, sourcePeople, sourceByExternal, addNote, indexSource, openProposal, proposalKey };
