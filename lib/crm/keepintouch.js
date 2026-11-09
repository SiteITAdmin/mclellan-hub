'use strict';

// Keep-in-touch: an optional cadence per person. The cadence is Douglas's own
// choice; who has drifted past it, and what cadence to suggest, are worked out
// from the sources each time and never stored.

const { crm, now } = require('./db');

const DAY = 86400;
const STEPS = [14, 28, 42, 56, 84, 126, 182, 364];
const MIN_CONTACTS = 4;
const MIN_USUAL_DAYS = 10;

function contactTimes(personId, space, since = 0) {
  return crm().prepare(`
    SELECT DISTINCT s.occurred_at AS t FROM identifiers i
      JOIN source_addresses a ON a.kind = i.kind AND a.value = i.value
      JOIN sources s ON s.id = a.source_id
     WHERE i.person_id = ? AND i.status = 'linked' AND s.space = ? AND s.occurred_at >= ?
     ORDER BY s.occurred_at
  `).all(personId, space, since).map(r => r.t);
}

// How often Douglas and this person are really in touch: the median gap between
// days with contact over the last year. People in daily contact need no reminder.
function usualGap(personId, space, t = now()) {
  const days = [...new Set(contactTimes(personId, space, t - 365 * DAY).map(x => Math.floor(x / DAY)))];
  if (days.length < MIN_CONTACTS) return null;
  const gaps = days.slice(1).map((d, i) => d - days[i]).sort((a, b) => a - b);
  return { usual: gaps[Math.floor(gaps.length / 2)], contacts: days.length };
}

function suggestion(person, t = now()) {
  if (person.cadence_days !== null && person.cadence_days !== undefined) return null;
  const g = usualGap(person.id, person.space, t);
  if (!g || g.usual < MIN_USUAL_DAYS) return null;
  return { days: STEPS.find(s => s >= g.usual * 1.25) || STEPS[STEPS.length - 1], ...g };
}

// 0 means Douglas has said this person needs no cadence, so it is never suggested again.
function setCadence(personId, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 0 || n > 730) throw new Error('Choose a cadence between 1 week and 2 years, or none');
  const changed = crm().prepare('UPDATE people SET cadence_days = ?, updated_at = unixepoch() WHERE id = ?').run(n, personId).changes;
  if (!changed) throw new Error('Person not found');
  require('./identity').log('cadence', personId, { days: n });
}

function drifting(space, t = now()) {
  const out = [];
  for (const p of crm().prepare('SELECT * FROM people_v WHERE space = ? AND cadence_days > 0').all(space)) {
    const times = contactTimes(p.id, space);
    // Someone never yet in contact is counted from the day the cadence could first apply.
    const last = times.length ? times[times.length - 1] : p.created_at;
    const overDays = Math.floor((t - last) / DAY) - p.cadence_days;
    if (overDays > 0) out.push({ person: p, last, every: p.cadence_days, overDays, sinceDays: Math.floor((t - last) / DAY) });
  }
  return out.sort((a, b) => b.overDays - a.overDays);
}

function suggestions(space, limit = 3, t = now()) {
  return crm().prepare('SELECT * FROM people_v WHERE space = ? AND cadence_days IS NULL ORDER BY name COLLATE NOCASE').all(space)
    .map(p => ({ person: p, ...(suggestion(p, t) || {}) })).filter(s => s.days).slice(0, limit);
}

const weeks = days => (days % 7 === 0 ? `${days / 7} ${days === 7 ? 'week' : 'weeks'}` : `${days} days`);

module.exports = { suggestion, suggestions, setCadence, drifting, usualGap, weeks, STEPS };
