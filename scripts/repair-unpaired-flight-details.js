'use strict';

// Stamp the two documented one-way Scotland legs, and the August 2026 pairs
// whose notes say "Booking ref Number", with the booking refs from Ryanair
// receipts / itinerary emails. Does not invent opposite legs: AU9R5D and
// G374JA are one-ways in the Ryanair flight history workbook.
//
//   node scripts/repair-unpaired-flight-details.js            # dry run
//   node scripts/repair-unpaired-flight-details.js --apply
//   HUB_DB_PATH=<snapshot> node scripts/repair-unpaired-flight-details.js

const db = require('../lib/db');

const APPLY = process.argv.includes('--apply');
const USER = process.env.HUB_USER || 'douglas';

const REPAIRS = [
  {
    date: '2025-09-01',
    number: 'FR809',
    notes: 'Booking ref AU9R5D (one-way return); boarded EDI-DUB 23:35; booked 30 Aug 2025 in GBP',
  },
  {
    date: '2026-02-19',
    number: 'FR808',
    notes: 'Booking ref G374JA (one-way outbound); boarded DUB-EDI 06:10; booked 18 Feb 2026',
  },
  {
    date: '2026-08-05',
    number: 'FR808',
    replaceRef: 'FT4DHL',
  },
  {
    date: '2026-08-07',
    number: 'FR813',
    replaceRef: 'FT4DHL',
  },
  {
    date: '2026-08-12',
    number: 'FR812',
    replaceRef: 'U17Z4P',
  },
  {
    date: '2026-08-17',
    number: 'FR817',
    replaceRef: 'U17Z4P',
  },
];

function withBookingRef(notes, ref) {
  const current = String(notes || '');
  if (current.includes(`Booking ref ${ref}`)) return current;
  if (/Booking ref Number\b/.test(current)) {
    return current.replace(/Booking ref Number\b/, `Booking ref ${ref}`);
  }
  if (!current.trim()) return `Booking ref ${ref}`;
  return `Booking ref ${ref}\n${current}`;
}

function main() {
  const hub = db.hub();
  const find = hub.prepare(`
    SELECT id, flight_date, flight_number, direction, notes
      FROM flights
     WHERE user = ? AND flight_date = ? AND flight_number = ?
     LIMIT 1
  `);
  const planned = [];
  for (const spec of REPAIRS) {
    const row = find.get(USER, spec.date, spec.number);
    if (!row) {
      console.log(`• missing ${spec.date} ${spec.number}`);
      continue;
    }
    const nextNotes = spec.notes || withBookingRef(row.notes, spec.replaceRef);
    if (nextNotes === row.notes) {
      console.log(`• unchanged ${spec.date} ${spec.number} ${row.direction}`);
      continue;
    }
    planned.push({ id: row.id, date: spec.date, number: spec.number, from: row.notes, to: nextNotes });
    console.log(`• ${spec.date} ${spec.number} ${row.direction}`);
    console.log(`    was: ${String(row.notes).split('\n')[0]}`);
    console.log(`    now: ${nextNotes.split('\n')[0]}`);
  }

  if (!planned.length) {
    console.log('Nothing to repair.');
    return;
  }
  if (!APPLY) {
    console.log(`Dry run: ${planned.length} row(s). Re-run with --apply.`);
    return;
  }
  const update = hub.prepare('UPDATE flights SET notes = ? WHERE id = ? AND user = ?');
  hub.transaction(() => {
    for (const item of planned) update.run(item.to, item.id, USER);
  })();
  console.log(`Updated ${planned.length} flight note(s).`);
}

main();
