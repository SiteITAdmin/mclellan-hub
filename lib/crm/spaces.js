'use strict';

// Which space a source belongs to, when where it came from doesn't say. Most
// channels do say (Outlook is Work, Gmail is Personal, a WhatsApp chat was
// approved into one), but the Google calendar holds copies of Outlook meetings
// alongside family plans. People and organisations Douglas has already put in a
// space decide first: Work people rarely turn up in Personal. Only when they
// say nothing, or disagree, does the reader decide while it reads.

const { crm, now } = require('./db');
const config = require('./config');
const { normEmail, normName } = require('./text');

const SPACES = ['work', 'personal'];
const label = s => (s === 'work' ? 'Work' : 'Personal');
const other = s => (s === 'work' ? 'personal' : 'work');

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Names Douglas has filed in exactly one space. A name filed in both says nothing.
function namesBySpace() {
  const db = crm();
  const seen = new Map();
  const add = (space, name, what) => {
    const n = normName(name);
    // One word ("Anthony", "Kai") is too loose to place a whole source.
    if (!n || n.length < 4 || (what === 'person' && !n.includes(' '))) return;
    if (config.selfNames().includes(n)) return;
    const was = seen.get(n);
    if (was && was.space !== space) { was.space = null; return; }
    if (!was) seen.set(n, { name: String(name).trim(), space, what });
  };
  for (const p of db.prepare('SELECT name, space FROM people').all()) add(p.space, p.name, 'person');
  for (const a of db.prepare('SELECT a.alias, p.space FROM aliases a JOIN people p ON p.id = a.person_id').all()) add(a.space, a.alias, 'person');
  for (const o of db.prepare('SELECT name, space FROM organisations').all()) add(o.space, o.name, 'organisation');
  for (const p of db.prepare('SELECT name, space FROM projects').all()) add(p.space, p.name, 'project');
  return [...seen.values()].filter(x => x.space);
}

function addressClue(email) {
  const v = normEmail(email);
  if (!v) return null;
  if (config.workAddresses().includes(v)) return { space: 'work', why: 'it went to your work address' };
  const person = require('./identity').personForAddress('email', v);
  if (person) return { space: person.space, why: `${person.name} is one of your ${label(person.space)} people`, who: normName(person.name) };
  const domain = v.split('@')[1];
  const orgs = crm().prepare('SELECT DISTINCT x.space, o.name FROM org_domains x JOIN organisations o ON o.id = x.org_id WHERE x.domain = ?').all(domain);
  if (orgs.length === 1) return { space: orgs[0].space, why: `${v} is at ${orgs[0].name}, a ${label(orgs[0].space)} organisation` };
  const ownWork = config.workAddresses().map(a => a.split('@')[1]);
  if (ownWork.includes(domain)) return { space: 'work', why: `${v} is at your work` };
  return null;
}

/** Every reason the text and addresses give for one space or the other. */
function clues({ text = '', emails = [] }) {
  const out = { work: [], personal: [] };
  const named = new Set();
  const push = c => {
    if (!c || out[c.space].includes(c.why) || (c.who && named.has(c.who))) return;
    if (c.who) named.add(c.who);
    out[c.space].push(c.why);
  };
  const found = String(text).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
  for (const e of new Set([...emails, ...found].map(normEmail).filter(Boolean))) push(addressClue(e));
  const plain = ` ${normName(text)} `;
  for (const n of namesBySpace()) {
    if (new RegExp(`(^|\\s)${escape(normName(n.name))}(\\s|$)`).test(plain)) push({ space: n.space, why: `${n.name} is a ${label(n.space)} ${n.what}`, who: normName(n.name) });
  }
  return out;
}

/** The space the clues agree on, or null when they say nothing or disagree. */
function decide(c) {
  if (c.work.length && !c.personal.length) return { space: 'work', why: c.work.slice(0, 3).join('; ') };
  if (c.personal.length && !c.work.length) return { space: 'personal', why: c.personal.slice(0, 3).join('; ') };
  return null;
}

/**
 * Where a calendar entry's copy goes. Douglas's own move of the entry wins;
 * then the clues; then what the reader decided for an earlier copy of the same
 * entry. Otherwise it waits in the calendar's own space and the reader is asked.
 */
function forEvent(e, text, emails) {
  if (e.space_by === 'you') return { space: e.space, by: 'you', why: 'You moved this calendar entry' };
  const d = decide(clues({ text, emails }));
  if (d) return { space: d.space, by: 'clues', why: d.why };
  const earlier = crm().prepare(`SELECT space, space_by, space_why FROM sources WHERE origin = 'calendar' AND substr(external_id, 1, ?) = ?
    AND space_by IN ('reader','you') ORDER BY created_at DESC LIMIT 1`).get(eventKey(e).length, eventKey(e));
  if (earlier) return { space: earlier.space, by: earlier.space_by, why: earlier.space_why };
  return { space: e.space, by: 'ask', why: '' };
}

const eventKey = e => `${e.calendar_id}:${e.id}:`;

// What the reader is told when it must choose. Both spaces are described from
// what Douglas has filed in them, never from a fixed list.
function checkLines(source) {
  const db = crm();
  const orgs = s => db.prepare(`SELECT o.name FROM organisations o LEFT JOIN people p ON p.org_id = o.id WHERE o.space = ?
    GROUP BY o.id ORDER BY COUNT(p.id) DESC, o.name LIMIT 15`).all(s).map(r => r.name);
  const projects = s => db.prepare('SELECT name FROM projects WHERE space = ? ORDER BY name LIMIT 25').all(s).map(r => r.name);
  const workDomains = [...new Set(config.workAddresses().map(a => a.split('@')[1]).filter(Boolean))];
  const c = clues({ text: `${source.title}\n${source.text}` });
  const found = [...c.work.map(w => `Work: ${w}`), ...c.personal.map(p => `Personal: ${p}`)];
  return [
    `Space check: this came from a calendar that holds both Work and Personal entries, so its space isn't known. It is under ${label(source.space)} for now.`,
    `Work is Douglas's job${workDomains.length ? ` (his work email is at ${workDomains.join(', ')})` : ''}. Work organisations: ${orgs('work').join(', ') || '(none yet)'}. Work projects: ${projects('work').join(', ') || '(none yet)'}.`,
    `Personal is the rest of his life: family, home, health, money, friends, volunteering. Personal organisations: ${orgs('personal').join(', ') || '(none yet)'}. Personal projects: ${projects('personal').join(', ') || '(none yet)'}.`,
    `Clues found: ${found.join('; ') || '(none)'}.`,
    'Set "space" to "work" or "personal". If you really cannot tell, choose the space it is under now.',
  ];
}

/**
 * Moves a source to the other space and reads it afresh there: its facts are
 * taken back (deleted facts stay deleted), and a calendar entry's later copies
 * follow it.
 */
function moveSource(sourceId, space, by, why, { reading = false } = {}) {
  if (!SPACES.includes(space)) throw new Error(`bad space: ${space}`);
  const db = crm();
  const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!s) throw new Error('Source not found');
  if (s.space === space) throw new Error(`It is already in ${label(space)}`);
  if (s.atomise_status === 'queued' && !reading) throw new Error('It is being read right now. Try again in a minute.');
  db.transaction(() => {
    require('./facts').unreadSource(s.id);
    db.prepare("UPDATE deleted_facts SET space = ? WHERE space = ? AND source_ids LIKE ?").run(space, s.space, `%"${s.id}"%`);
    const status = ['done', 'failed', 'pending', 'queued'].includes(s.atomise_status) && s.readable ? 'pending' : s.atomise_status;
    db.prepare(`UPDATE sources SET space = ?, space_by = ?, space_why = ?, atomise_status = ?, atomise_error = '', atomise_job_id = NULL, atomise_attempts = 0 WHERE id = ?`)
      .run(space, by, why || '', status, s.id);
    db.prepare('UPDATE sources_fts SET space = ? WHERE source_id = ?').run(space, s.id);
    if (s.origin === 'calendar') {
      const [calendarId, eventId] = String(s.external_id).split(':');
      db.prepare('UPDATE calendar_events SET space = ?, space_by = ? WHERE id = ? AND calendar_id = ?').run(space, by === 'you' ? 'you' : '', eventId, calendarId);
    }
  })();
  return { from: s.space, to: space };
}

// A changed calendar entry is copied again; the facts from its earlier copies
// (an old time, an old agenda) are taken back so only the latest stands.
function retireEarlierCopies(e, keepId) {
  const db = crm();
  const key = eventKey(e);
  const old = db.prepare(`SELECT id FROM sources WHERE origin = 'calendar' AND substr(external_id, 1, ?) = ? AND id != ? AND atomise_status != 'ignored'`)
    .all(key.length, key, keepId);
  for (const s of old) {
    require('./facts').unreadSource(s.id);
    db.prepare("UPDATE sources SET atomise_status = 'ignored', atomise_error = 'Replaced by a newer copy of this calendar entry' WHERE id = ?").run(s.id);
  }
  return old.length;
}

// Once, for calendar copies read before spaces were decided per entry: keep the
// latest copy of each entry, place it by its clues, and have the reader decide
// the rest by reading it again.
function recheckCalendar() {
  const db = crm();
  if (db.prepare("SELECT 1 FROM settings WHERE key = 'calendar_spaces_v1'").get()) return null;
  const latest = new Map();
  for (const s of db.prepare("SELECT * FROM sources WHERE origin = 'calendar' AND atomise_status != 'ignored' ORDER BY created_at").all()) {
    const [calendarId, id] = String(s.external_id).split(':');
    latest.set(`${calendarId}:${id}`, { s, e: { calendar_id: calendarId, id } });
  }
  const done = { retired: 0, moved: 0, kept: 0, asked: 0 };
  for (const { s, e } of latest.values()) {
    done.retired += retireEarlierCopies(e, s.id);
    if (s.space_by || s.atomise_status === 'queued') continue;
    const d = decide(clues({ text: `${s.title}\n${s.text}` }));
    if (d && d.space !== s.space) { moveSource(s.id, d.space, 'clues', d.why); done.moved += 1; continue; }
    if (d) { db.prepare("UPDATE sources SET space_by = 'clues', space_why = ? WHERE id = ?").run(d.why, s.id); done.kept += 1; continue; }
    require('./facts').unreadSource(s.id);
    db.prepare("UPDATE sources SET space_by = 'ask', atomise_status = CASE WHEN readable = 1 THEN 'pending' ELSE atomise_status END WHERE id = ?").run(s.id);
    done.asked += 1;
  }
  require('./db').setSetting('calendar_spaces_v1', JSON.stringify({ at: now(), ...done }));
  return done;
}

module.exports = { clues, decide, forEvent, checkLines, moveSource, retireEarlierCopies, recheckCalendar, label, other };
