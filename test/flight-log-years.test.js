'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const {
  FLIGHT_LOG_YEARS,
  resolveFlightLogYear,
  flightsInYear,
  yearCounts,
  computeFlightStats,
} = require('../routes/hub-flights')._test;

test('the flight log is the four requested years', () => {
  assert.deepEqual(FLIGHT_LOG_YEARS, ['2026', '2025', '2024', '2023']);
});

test('year query picks a log year and otherwise uses the current Dublin year', () => {
  assert.equal(resolveFlightLogYear('2024'), '2024');
  assert.equal(resolveFlightLogYear('2019', new Date('2026-08-24T12:00:00Z')), '2026');
  assert.equal(resolveFlightLogYear('', new Date('2026-08-24T12:00:00Z')), '2026');
});

test('year counts cover every logged flight in 2023–2026', () => {
  const flights = [
    { flight_date: '2026-08-12', status: 'completed' },
    { flight_date: '2026-08-17', status: 'scheduled' },
    { flight_date: '2025-01-04', status: 'completed' },
    { flight_date: '2022-12-01', status: 'completed' },
  ];
  assert.deepEqual(yearCounts(flights), [
    { year: '2026', total: 2 },
    { year: '2025', total: 1 },
    { year: '2024', total: 0 },
    { year: '2023', total: 0 },
  ]);
  assert.equal(flightsInYear(flights, '2026').length, 2);
  assert.equal(computeFlightStats(flightsInYear(flights, '2026')).total, 1);
});

test('the flights page lists each year with its total under the title', async () => {
  const html = await ejs.renderFile(path.join(__dirname, '../views/hub/flights.ejs'), {
    user: 'douglas',
    selectedYear: '2026',
    years: [
      { year: '2026', total: 18 },
      { year: '2025', total: 22 },
      { year: '2024', total: 16 },
      { year: '2023', total: 14 },
    ],
    flights: [],
    stats: {
      total: 0, cancelled: 0, onTimePct: null, onTimeSample: 0,
      avgArrDelay: null, worstArrDelay: null,
      dubToEdi: 0, ediToDub: 0, dubToGla: 0, glaToDub: 0,
      ryanair: { count: 0, onTimePct: null, sample: 0 },
      aerLingus: { count: 0, onTimePct: null, sample: 0 },
      avgActualDuration: null, avgSchedDuration: null, bufferMinutes: null,
      depOnTimePct: null, depOnTimeSample: 0, realOnTimePct: null, realLateSample: 0,
    },
  });
  assert.match(html, /Dublin ↔ Edinburgh Flights/);
  assert.match(html, /Personal flight log — scheduled vs actual times, delay tracking/);
  assert.match(html, /href="\/flights\?year=2026"/);
  assert.match(html, /href="\/flights\?year=2025"/);
  assert.match(html, /href="\/flights\?year=2024"/);
  assert.match(html, /href="\/flights\?year=2023"/);
  assert.match(html, />2026<\/span>\s*<span class="count">18</);
  assert.match(html, />2023<\/span>\s*<span class="count">14</);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /No flights logged in 2026/);
});
