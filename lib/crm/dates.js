'use strict';

// Key dates: birthdays, anniversaries, renewals, deadlines. A view over date
// atoms, so every one of them traces back to the source that stated it.

const { crm, now } = require('./db');
const planner = require('./planner');

function upcoming(space, days = 7, t = now()) {
  const db = crm();
  const today = planner.local(t).date;
  const until = planner.addDays(today, days);
  const out = [];
  const rows = db.prepare(`SELECT * FROM atoms WHERE space = ? AND kind = 'date' AND status = 'active' AND COALESCE(valid_from, valid_until) IS NOT NULL`).all(space);
  for (const a of rows) {
    const stated = a.valid_from || a.valid_until;
    let on = stated;
    if (a.yearly) {
      // The next time this month and day comes round, whatever year was written down.
      on = `${today.slice(0, 4)}${stated.slice(4)}`;
      if (on < today) on = `${Number(today.slice(0, 4)) + 1}${stated.slice(4)}`;
    }
    if (on < today || on > until) continue;
    out.push({
      atom_id: a.id, statement: a.statement, on, yearly: !!a.yearly,
      inDays: Math.round((planner.epoch(on) - planner.epoch(today)) / 86400),
      people: db.prepare("SELECT p.id, p.name FROM atom_mentions m JOIN people p ON p.id = m.person_id WHERE m.atom_id = ? AND m.status = 'resolved'").all(a.id),
      source_id: db.prepare('SELECT source_id FROM atom_sources WHERE atom_id = ? LIMIT 1').get(a.id)?.source_id || null,
    });
  }
  return out.sort((x, y) => (x.on < y.on ? -1 : x.on > y.on ? 1 : 0));
}

const label = d => (d.inDays === 0 ? 'Today' : d.inDays === 1 ? 'Tomorrow'
  : new Date(`${d.on}T12:00:00Z`).toLocaleDateString('en-IE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }));

module.exports = { upcoming, label };
