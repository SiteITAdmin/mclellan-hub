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
