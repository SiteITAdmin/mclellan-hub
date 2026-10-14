'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../lib/email-processor');

test('Ryanair reservation parser skips the label Number and keeps the PNR', () => {
  const html = `
    Reservation Number
    Status Confirmed
    myRyanair Destination:: Edinburgh Reservation: FT4DHL
    Your flight information To Edinburgh FR 808 Dublin - Edinburgh
  `;
  assert.equal(_test.parseRyanairReservation(html), 'FT4DHL');
  assert.equal(_test.parseRyanairReservation('Reservation Number Status Confirmed'), null);
  assert.equal(_test.parseRyanairReservation('Reservation: U17Z4P'), 'U17Z4P');
});

test('Ryanair HTML itinerary yields times and booking ref for every leg', () => {
  const html = `<html><head><style>td{font-size:12px}</style></head><body><table>
    <tr><td>myRyanair</td><td>Destination::</td><td>Edinburgh</td></tr>
    <tr><td>Reservation:</td><td><b>F8V4SK</b></td></tr>
    <tr><td>To Edinburgh</td><td>FR 808</td><td /></tr>
    <tr><td>Dublin - Edinburgh</td></tr><tr><td>Thu, 15 Oct 26</td></tr>
    <tr><td>Departure time -&nbsp;</td><td>06:10</td><td>Arrival time -&nbsp;</td><td>07:20</td></tr>
    <tr><td>(DUB) - (EDI)</td></tr>
    <tr><td>To Dublin</td><td>FR 813</td><td /></tr>
    <tr><td>Edinburgh - Dublin</td></tr><tr><td>Sat, 17 Oct 26</td></tr>
    <tr><td>Departure time -&nbsp;</td><td>17:25</td><td>Arrival time -&nbsp;</td><td>18:30</td></tr>
    <tr><td>(EDI) - (DUB)</td></tr>
    <tr><td>● Flight out:</td><td>FR 808</td></tr><tr><td>● Flight back:</td><td>FR 813</td></tr>
  </table></body></html>`;
  const legs = _test.detectRyanairFlights({ fromEmail: 'Itinerary@ryanair.com', bodyText: html });
  assert.deepEqual(legs, [
    { flightNumber: 'FR808', date: '2026-10-15', scheduledDep: '06:10', scheduledArr: '07:20', direction: 'DUB-EDI', notes: 'Booking ref F8V4SK' },
    { flightNumber: 'FR813', date: '2026-10-17', scheduledDep: '17:25', scheduledArr: '18:30', direction: 'EDI-DUB', notes: 'Booking ref F8V4SK' },
  ]);
});
