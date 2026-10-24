'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-flights-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');

const db = require('../lib/db');
const flights = require('../lib/flights');

// Layout of a real Ryanair HTML itinerary (from the Version Old regression test).
const ITINERARY_HTML = `<html><head><style>td{font-size:12px}</style></head><body><table>
  <tr><td>Reservation Number</td></tr>
  <tr><td>myRyanair</td><td>Destination::</td><td>Edinburgh</td></tr>
  <tr><td>Reservation:</td><td><b>K7Q2ZX</b></td></tr>
  <tr><td>To Edinburgh</td><td>FR 812</td><td /></tr>
  <tr><td>Dublin - Edinburgh</td></tr><tr><td>Sat, 14 Nov 26</td></tr>
  <tr><td>Departure time -&nbsp;</td><td>07:05</td><td>Arrival time -&nbsp;</td><td>08:15</td></tr>
  <tr><td>(DUB) - (EDI)</td></tr>
  <tr><td>To Dublin</td><td>FR 815</td><td /></tr>
  <tr><td>Edinburgh - Dublin</td></tr><tr><td>Mon, 16 Nov 26</td></tr>
  <tr><td>Departure time -&nbsp;</td><td>21:40</td><td>Arrival time -&nbsp;</td><td>22:50</td></tr>
  <tr><td>(EDI) - (DUB)</td></tr>
  <tr><td>● Flight out:</td><td>FR 812</td></tr><tr><td>● Flight back:</td><td>FR 815</td></tr>
</table></body></html>`;

function fakeGmail(messages) {
  return {
    users: {
      messages: {
        list: async ({ q }) => {
          assert.match(q, /^from:itinerary@ryanair\.com after:\d+$/);
          return { data: { messages: messages.map(m => ({ id: m.id })) } };
        },
        get: async ({ id }) => {
          const m = messages.find(x => x.id === id);
          return { data: { payload: {
            headers: [{ name: 'From', value: 'Ryanair <itinerary@ryanair.com>' }],
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/html', body: { data: Buffer.from(m.html).toString('base64url') } }],
          } } };
        },
        attachments: { get: async () => ({ data: {} }) },
      },
    },
  };
}

test('parses both legs, times and booking ref from an HTML itinerary', () => {
  const legs = flights.detectRyanairFlights({ fromEmail: 'itinerary@ryanair.com', bodyText: ITINERARY_HTML });
  assert.deepStrictEqual(legs, [
    { flightNumber: 'FR812', date: '2026-11-14', scheduledDep: '07:05', scheduledArr: '08:15', direction: 'DUB-EDI', notes: 'Booking ref K7Q2ZX' },
    { flightNumber: 'FR815', date: '2026-11-16', scheduledDep: '21:40', scheduledArr: '22:50', direction: 'EDI-DUB', notes: 'Booking ref K7Q2ZX' },
  ]);
});

test('ignores mail that is not from the Ryanair itinerary sender', () => {
  assert.deepStrictEqual(flights.detectRyanairFlights({ fromEmail: 'offers@ryanair.com', bodyText: ITINERARY_HTML }), []);
});

test('Gmail import inserts scheduled flights, schedules tracking, and is idempotent', async () => {
  const gmail = fakeGmail([{ id: 'm1', html: ITINERARY_HTML }]);
  const first = await flights.importRyanairBookings('douglas', { gmail });
  assert.deepStrictEqual(first, { emails: 1, legs: 2, inserted: 2 });

  const rows = db.hub().prepare("SELECT flight_number, flight_date, status, scheduled_dep, notes FROM flights ORDER BY flight_date").all();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].status, 'scheduled');
  assert.strictEqual(rows[0].scheduled_dep, '07:05');

  const tracking = db.hub().prepare("SELECT payload, run_at FROM system_jobs WHERE type = 'flight_refresh'").all();
  assert.strictEqual(tracking.length, 2);
  const fr812 = tracking.map(t => ({ ...JSON.parse(t.payload), run_at: t.run_at })).find(t => t.flightNumber === 'FR812');
  // 07:05 GMT on 14 Nov minus two hours
  assert.strictEqual(fr812.run_at, Date.UTC(2026, 10, 14, 5, 5) / 1000);

  const second = await flights.importRyanairBookings('douglas', { gmail });
  assert.strictEqual(second.inserted, 0);
  assert.strictEqual(db.hub().prepare('SELECT COUNT(*) AS n FROM flights').get().n, 2);
  assert.ok(db.hub().prepare("SELECT value FROM crm_context WHERE key = '_ryanair_import_last_ts'").get());
});

test('fills blanks on an existing leg without overwriting', () => {
  db.hub().prepare(`INSERT INTO flights (id, user, flight_number, direction, flight_date, scheduled_dep, notes)
    VALUES ('x1', 'douglas', 'FR900', 'DUB-EDI', '2020-01-01', '', 'kept note')`).run();
  const out = flights.upsertRyanairLeg('douglas', {
    flightNumber: 'FR900', date: '2020-01-01', scheduledDep: '06:00', scheduledArr: '07:10', direction: 'DUB-EDI', notes: 'Booking ref NEW123',
  });
  assert.strictEqual(out.inserted, false);
  const row = db.hub().prepare("SELECT scheduled_dep, notes FROM flights WHERE id = 'x1'").get();
  assert.strictEqual(row.scheduled_dep, '06:00');
  assert.strictEqual(row.notes, 'kept note');
});

test('Dublin wall time converts correctly in summer and winter', () => {
  assert.strictEqual(flights.dublinWallToEpoch('2026-07-01', '10:00'), Date.UTC(2026, 6, 1, 9, 0) / 1000);
  assert.strictEqual(flights.dublinWallToEpoch('2026-12-01', '10:00'), Date.UTC(2026, 11, 1, 10, 0) / 1000);
});

test('picks the AeroDataBox record matching the route', () => {
  const records = [
    { departure: { airport: { iata: 'STN' } }, arrival: { airport: { iata: 'DUB' } } },
    { departure: { airport: { iata: 'EDI' } }, arrival: { airport: { iata: 'DUB' } } },
  ];
  assert.strictEqual(flights.pickRecord(records, 'EDI-DUB'), records[1]);
});
