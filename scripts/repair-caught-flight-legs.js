'use strict';

// Keep the tracker to flights actually caught:
//   2026: drop Wed 18 Feb FR808 (booked, not flown); trip is Thu 19 Feb → Sat 21 Feb
//   2025: drop Sat 30 Aug FR817 (booked, not flown); return is Mon 1 Sep FR809
//
//   node scripts/repair-caught-flight-legs.js            # dry run
//   node scripts/repair-caught-flight-legs.js --apply

const db = require('../lib/db');

const APPLY = process.argv.includes('--apply');
const USER = process.env.HUB_USER || 'douglas';

const DROP = [
  { date: '2026-02-18', number: 'FR808', reason: 'Wednesday outbound booked, not flown' },
  { date: '2025-08-30', number: 'FR817', reason: 'Saturday return booked, stayed until Monday' },
];

const RETIE = [
  {
    date: '2026-02-19',
    number: 'FR808',
    notes: 'Booking ref G374JA; Thu 19 Feb out, Sat 21 Feb FR819 back (Wed 18 Feb FR808 booked, not flown)',
  },
  {
    date: '2026-02-21',
    number: 'FR819',
    notes: 'Booking ref BR8R4C; Thu 19 Feb FR808 (G374JA) out, Sat 21 Feb back (Wed 18 Feb outbound not flown)',
  },
  {
    date: '2025-08-28',
    number: 'FR814',
    notes: 'Booking ref UP6BGV; Thu 28 Aug out, Mon 1 Sep FR809 back (Sat 30 Aug FR817 booked, not flown)',
  },
  {
    date: '2025-09-01',
    number: 'FR809',
    notes: 'Booking ref AU9R5D; stayed until Monday — FR814 28 Aug out, FR809 23:35 back',
  },
];

function main() {
  const hub = db.hub();
  const find = hub.prepare(`
    SELECT id, flight_date, flight_number, direction, notes
      FROM flights WHERE user = ? AND flight_date = ? AND flight_number = ? LIMIT 1
  `);

  const drops = [];
  for (const spec of DROP) {
    const row = find.get(USER, spec.date, spec.number);
    if (!row) {
      console.log(`• already absent ${spec.date} ${spec.number}`);
      continue;
    }
    drops.push(row);
    console.log(`• drop ${spec.date} ${spec.number} ${row.direction} — ${spec.reason}`);
  }

  const updates = [];
  for (const spec of RETIE) {
    const row = find.get(USER, spec.date, spec.number);
    if (!row) {
      console.log(`• missing pair leg ${spec.date} ${spec.number}`);
      continue;
    }
    if (row.notes === spec.notes) {
      console.log(`• notes already current ${spec.date} ${spec.number}`);
      continue;
    }
    updates.push({ id: row.id, ...spec, from: row.notes });
    console.log(`• retie ${spec.date} ${spec.number} ${row.direction}`);
    console.log(`    now: ${spec.notes}`);
  }

  if (!APPLY) {
    console.log(`Dry run: would drop ${drops.length}, update ${updates.length}. Re-run with --apply.`);
    return;
  }

  const del = hub.prepare('DELETE FROM flights WHERE id = ? AND user = ?');
  const upd = hub.prepare('UPDATE flights SET notes = ? WHERE id = ? AND user = ?');
  hub.transaction(() => {
    for (const row of drops) del.run(row.id, USER);
    for (const item of updates) upd.run(item.notes, item.id, USER);
  })();
  console.log(`Dropped ${drops.length} unflown leg(s), updated ${updates.length} pair note(s).`);
}

main();
