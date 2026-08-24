'use strict';

/**
 * Calendar is a source of booking evidence as well as a source of travel
 * context.  Only import an event when it explicitly names both a flight and
 * its route: a generic holiday event must never be turned into a tracker row.
 */

const { uuid } = require('./id');
const { isTaskPlannerCalendarEvent } = require('./meeting-kind');

const CITY_IATA = {
  dublin: 'DUB', edinburgh: 'EDI', glasgow: 'GLA', reus: 'REU',
  manchester: 'MAN', malta: 'MLA', 'london stansted': 'STN', london: 'STN',
};

function cityNamePattern() {
  return Object.keys(CITY_IATA)
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const AIRLINES = {
  FR: 'Ryanair',
  EI: 'Aer Lingus',
  BA: 'British Airways',
  U2: 'easyJet',
  EZY: 'easyJet',
  VY: 'Vueling',
  LS: 'Jet2',
};

function routeFromText(text) {
  const route = String(text || '').match(/\b([A-Z]{3})\s*(?:-|–|—|→|to)\s*([A-Z]{3})\b/i);
  if (route) return `${route[1].toUpperCase()}-${route[2].toUpperCase()}`;

  const cityRoute = String(text || '').match(new RegExp(
    `\\b(${cityNamePattern()})\\s*(?:-|–|—|→|to)\\s*(${cityNamePattern()})\\b`, 'i'
  ));
  if (!cityRoute) return null;
  return `${CITY_IATA[cityRoute[1].toLowerCase()]}-${CITY_IATA[cityRoute[2].toLowerCase()]}`;
}

function addMinutes(time, minutes) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match || !Number.isFinite(minutes)) return '';
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function routeFromItinerarySummary(summary) {
  // Google often imports airline itineraries as an all-day event titled e.g.
  // "27 SEPT 15:45 Dublin 3h 45m FR7235 20:30 Malta".  The two named
  // airports either side of the flight number are explicit route evidence,
  // even though they are not written as "DUB-MLA".
  const names = [];
  const cityRe = new RegExp(`\\b(${cityNamePattern()})\\b`, 'gi');
  let match;
  while ((match = cityRe.exec(String(summary || ''))) !== null) {
    const code = CITY_IATA[match[1].toLowerCase()];
    if (!names.length || names[names.length - 1].code !== code) names.push({ code, index: match.index });
  }
  if (names.length < 2 || names[0].code === names[names.length - 1].code) return null;
  return `${names[0].code}-${names[names.length - 1].code}`;
}

function itineraryTimes(text, flightNumberIndex) {
  const times = [...String(text || '').matchAll(/\b(\d{1,2}):(\d{2})\b/g)]
    .map(match => ({
      value: `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`,
      index: match.index,
    }));
  const before = times.filter(time => time.index < flightNumberIndex).at(-1)?.value || '';
  const after = times.find(time => time.index > flightNumberIndex)?.value || '';
  return { before, after };
}

function isCalendarFlightNoise(event) {
  if (isTaskPlannerCalendarEvent(event)) return true;
  const summary = String(event.summary || '');
  return /^\s*(check in online|pre-flight)\b/i.test(summary);
}

function extractFlightFromCalendarEvent(event) {
  if (isCalendarFlightNoise(event)) return null;
  const sourceText = [event.summary, event.location, event.notes].filter(Boolean).join('\n');
  const number = sourceText.match(/\b(FR|EI|BA|U2|EZY|VY|LS)\s*(\d{1,4})\b/i);
  const direction = routeFromText(sourceText) || routeFromItinerarySummary(event.summary);
  if (!number || !direction || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || ''))) return null;

  const airlineCode = number[1].toUpperCase();
  const flightNumber = `${airlineCode}${number[2]}`;
  const summaryNumber = String(event.summary || '').match(/\b(FR|EI|BA|U2|EZY|VY|LS)\s*\d{1,4}\b/i);
  const summaryTimes = itineraryTimes(event.summary, summaryNumber?.index ?? -1);
  const scheduledDep = /^\d{2}:\d{2}$/.test(String(event.time || ''))
    ? event.time
    : summaryTimes.before;
  // A normal timed calendar event can safely provide an arrival time only
  // when its duration looks like a short-haul flight, not a whole trip.
  const scheduledArr = summaryTimes.after || (!event.isAllDay && event.durationMins >= 20 && event.durationMins <= 360
    ? addMinutes(scheduledDep, event.durationMins)
    : '');

  return {
    flightNumber,
    airline: AIRLINES[airlineCode],
    direction,
    date: event.date,
    scheduledDep,
    scheduledArr,
    eventId: String(event.id || ''),
    eventSummary: String(event.summary || '').trim(),
  };
}

function calendarProvenance(flight) {
  const event = flight.eventId ? `Calendar event ${flight.eventId}` : 'Calendar event';
  return `${event}: ${flight.eventSummary || `${flight.flightNumber} ${flight.direction}`}`;
}

function importCalendarFlights({ user, hub, events, report = [] }) {
  const importedRows = [];
  const candidates = new Set();
  const exists = hub.prepare(
    'SELECT id FROM flights WHERE user = ? AND flight_date = ? AND flight_number = ?'
  );
  const insert = hub.prepare(`
    INSERT INTO flights (id, user, flight_number, airline, direction, flight_date,
      scheduled_dep, scheduled_arr, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `);

  for (const event of events || []) {
    const flight = extractFlightFromCalendarEvent(event);
    if (!flight) continue;
    const key = `${flight.date}:${flight.flightNumber}`;
    candidates.add(key);
    if (exists.get(user, flight.date, flight.flightNumber)) continue;

    const row = {
      id: uuid(),
      user,
      flight_number: flight.flightNumber,
      airline: flight.airline,
      direction: flight.direction,
      flight_date: flight.date,
      scheduled_dep: flight.scheduledDep,
      scheduled_arr: flight.scheduledArr,
      status: 'scheduled',
      notes: calendarProvenance(flight),
    };
    insert.run(
      row.id, row.user, row.flight_number, row.airline, row.direction, row.flight_date,
      row.scheduled_dep, row.scheduled_arr, row.notes,
    );
    importedRows.push(row);
    report.push(`✈ Imported calendar flight: ${row.flight_number} ${row.direction} on ${row.flight_date}`);
  }

  return { events: (events || []).length, candidates: candidates.size, importedRows };
}

async function discoverCalendarFlights(user, hub, report = [], calendarEvents = null) {
  let events = calendarEvents;
  if (!events) {
    const { fetchCalendarEvents } = require('./crm');
    events = await fetchCalendarEvents(user, { daysBack: 1, daysForward: 180 });
  }
  const result = importCalendarFlights({ user, hub, events, report });
  if (result.importedRows.length) {
    const { scheduleJob, scheduleFlightRefresh } = require('./job-queue');
    scheduleJob('mycelium_flights', { user }, null, 'calendar-flight');
    for (const flight of result.importedRows) scheduleFlightRefresh(flight);
  }
  return {
    node: 'calendar→flights',
    events: result.events,
    candidates: result.candidates,
    imported: result.importedRows.length,
  };
}

module.exports = {
  extractFlightFromCalendarEvent,
  importCalendarFlights,
  discoverCalendarFlights,
  routeFromText,
  routeFromItinerarySummary,
  isCalendarFlightNoise,
};
