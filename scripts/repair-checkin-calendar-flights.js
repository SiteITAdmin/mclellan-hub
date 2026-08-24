'use strict';

// Remove ghost flight-tracker rows created from Hub check-in/prep planner
// blocks. Those calendar events mention a flight number, so calendar import
// treated them as the flight itself, then AeroDataBox filled another day's
// times (FR812 13 Aug 2026 showing 09:14 against a 19:30 check-in block).
//
//   node scripts/repair-checkin-calendar-flights.js            # dry run
//   node scripts/repair-checkin-calendar-flights.js --apply
//   HUB_DB_PATH=<snapshot> node scripts/repair-checkin-calendar-flights.js

const db = require('../lib/db');

const APPLY = process.argv.includes('--apply');
const USER = process.env.HUB_USER || 'douglas';

function main() {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT id, flight_number, direction, flight_date, scheduled_dep, scheduled_arr,
           actual_dep, actual_arr, status, notes
      FROM flights
     WHERE user = ?
       AND notes LIKE 'Calendar event%'
       AND (notes LIKE '%Check in online:%' OR notes LIKE '%Pre-flight:%')
     ORDER BY flight_date, flight_number
  `).all(USER);

  if (!rows.length) {
    console.log('No check-in calendar ghost flights found.');
    return;
  }

  for (const row of rows) {
    console.log(`• ${row.flight_date} ${row.flight_number} ${row.direction} ${row.scheduled_dep}→${row.actual_dep || '?'} (${row.id})`);
  }

  if (!APPLY) {
    console.log(`Dry run: ${rows.length} row(s) would be deleted. Re-run with --apply.`);
    return;
  }

  const del = hub.prepare('DELETE FROM flights WHERE id = ? AND user = ?');
  hub.transaction(() => {
    for (const row of rows) del.run(row.id, USER);
  })();
  console.log(`Deleted ${rows.length} ghost flight row(s).`);
}

main();
