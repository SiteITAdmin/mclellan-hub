'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  extractFlightFromCalendarEvent,
  importCalendarFlights,
} = require('../lib/flight-calendar-import');

function flightDb() {
  const hub = new Database(':memory:');
  hub.exec(`
    CREATE TABLE flights (
      id TEXT PRIMARY KEY, user TEXT, flight_number TEXT, airline TEXT,
      direction TEXT, flight_date TEXT, scheduled_dep TEXT, scheduled_arr TEXT,
      status TEXT, notes TEXT
    )
  `);
  return hub;
}

test('calendar flight parser requires explicit number and route, retaining schedule details', () => {
  const flight = extractFlightFromCalendarEvent({
    id: 'calendar-event-1',
    summary: 'Ryanair FR 1114 — Dublin to Reus',
    date: '2026-09-14',
    time: '10:20',
    durationMins: 155,
    isAllDay: false,
    location: '',
    notes: '',
  });

  assert.deepEqual(flight, {
    flightNumber: 'FR1114', airline: 'Ryanair', direction: 'DUB-REU',
    date: '2026-09-14', scheduledDep: '10:20', scheduledArr: '12:55',
    eventId: 'calendar-event-1', eventSummary: 'Ryanair FR 1114 — Dublin to Reus',
  });
  assert.equal(extractFlightFromCalendarEvent({
    summary: 'September holiday in Reus', date: '2026-09-14', isAllDay: true,
  }), null, 'a generic trip is not enough evidence to create a tracked flight');
});

test('calendar flight import writes a scheduled tracker row once with provenance', () => {
  const hub = flightDb();
  const event = {
    id: 'calendar-event-1', summary: 'FR1114 DUB-REU', date: '2026-09-14',
    time: '10:20', durationMins: 155, isAllDay: false, location: '', notes: '',
  };
  const first = importCalendarFlights({ user: 'douglas', hub, events: [event], report: [] });
  const row = hub.prepare('SELECT * FROM flights').get();

  assert.equal(first.importedRows.length, 1);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.flight_number, 'FR1114');
  assert.equal(row.direction, 'DUB-REU');
  assert.equal(row.scheduled_arr, '12:55');
  assert.match(row.notes, /Calendar event calendar-event-1/);
  assert.equal(importCalendarFlights({ user: 'douglas', hub, events: [event] }).importedRows.length, 0);
});

test('check-in and planner task blocks are not imported as flights', () => {
  assert.equal(extractFlightFromCalendarEvent({
    id: '0dkg07m1i227j2odiinbffpkdc',
    summary: 'Check in online: FR812 DUB-EDI (2026-08-12)',
    date: '2026-08-13',
    time: '19:30',
    durationMins: 30,
    isAllDay: false,
    location: '',
    notes: 'Scheduled from McLellan Hub task task-checkin.',
    hubSource: 'task_planner',
    hubTaskId: 'task-checkin',
  }), null);
  assert.equal(extractFlightFromCalendarEvent({
    summary: 'Pre-flight: FR817 EDI-DUB on 2026-08-17',
    date: '2026-08-16',
    time: '16:15',
    durationMins: 30,
    isAllDay: false,
  }), null);
  assert.equal(extractFlightFromCalendarEvent({
    summary: 'FR812 DUB-EDI',
    date: '2026-08-13',
    time: '19:30',
    durationMins: 70,
    isAllDay: false,
    isTask: true,
    hubSource: 'task_planner',
  }), null);

  const hub = flightDb();
  const imported = importCalendarFlights({
    user: 'douglas',
    hub,
    events: [{
      id: 'checkin-block',
      summary: 'Check in online: FR812 DUB-EDI (2026-08-12)',
      date: '2026-08-13',
      time: '19:30',
      durationMins: 30,
      isAllDay: false,
      location: '',
      notes: '',
    }],
    report: [],
  });
  assert.equal(imported.importedRows.length, 0);
  assert.equal(hub.prepare('SELECT COUNT(*) AS n FROM flights').get().n, 0);
});

test('calendar parser reads compact all-day airline itinerary titles', () => {
  const outbound = extractFlightFromCalendarEvent({
    summary: '27 SEPT 15:45 Dublin 3h 45m FR7235 20:30 Malta',
    date: '2026-09-27', time: null, durationMins: 1440, isAllDay: true,
    location: '', notes: '',
  });
  const returnFlight = extractFlightFromCalendarEvent({
    summary: '02 OCT 21:50 Malta 3h 55m FR7236 00:45 Dublin',
    date: '2026-10-02', time: null, durationMins: 1440, isAllDay: true,
    location: '', notes: '',
  });

  assert.deepEqual(outbound && {
    number: outbound.flightNumber, route: outbound.direction,
    departure: outbound.scheduledDep, arrival: outbound.scheduledArr,
  }, { number: 'FR7235', route: 'DUB-MLA', departure: '15:45', arrival: '20:30' });
  assert.deepEqual(returnFlight && {
    number: returnFlight.flightNumber, route: returnFlight.direction,
    departure: returnFlight.scheduledDep, arrival: returnFlight.scheduledArr,
  }, { number: 'FR7236', route: 'MLA-DUB', departure: '21:50', arrival: '00:45' });
});
