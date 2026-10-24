'use strict';

// Flight tracker: Ryanair booking email → flights row → live AeroDataBox
// tracking around departure → nightly backfill of actual times.
// AeroDataBox reports actual times as `revisedTime`, not `actualTime`.

const { google } = require('googleapis');
const db = require('./db');
const { uuid } = require('./id');
const { extractFlightState, actualsMatchSchedule } = require('./flight-status');

const RYANAIR_SENDER = 'itinerary@ryanair.com';
const RYANAIR_CURSOR_KEY = '_ryanair_import_last_ts';
// First run after the 24 Oct 2026 retool looks back far enough to pick up
// bookings made while the Hub was paused (13–24 Oct).
const RYANAIR_FIRST_LOOKBACK_DAYS = 45;

function now() { return Math.floor(Date.now() / 1000); }

// ── Ryanair itinerary parsing ────────────────────────────────────────────────

const MONTH_MAP = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

const CITY_IATA = {
  dublin: 'DUB', edinburgh: 'EDI', glasgow: 'GLA',
  reus: 'REU', manchester: 'MAN', 'london stansted': 'STN', london: 'STN',
};

function parseRyanairDate(str) {
  const m = str.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{2,4})/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = String(MONTH_MAP[m[2]]).padStart(2, '0');
  const yr = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yr}-${mon}-${day}`;
}

function parseRyanairReservation(body) {
  // HTML itineraries contain the label "Reservation Number" before the PNR.
  // `Reservation:?` plus six alphanumerics therefore captured "Number".
  const matches = [...String(body || '').matchAll(/Reservation:\s*([A-Z0-9]{6})\b/gi)];
  for (const match of matches) {
    const ref = match[1].toUpperCase();
    if (!/\d/.test(ref)) continue;
    return ref;
  }
  return null;
}

// Gmail often stores the itinerary as raw HTML. The leg fields sit in separate
// table cells, so "Departure time - 06:10" only matches once the tags are gone.
function ryanairPlainText(body) {
  const text = String(body || '');
  if (!/<[a-z][^>]*>/i.test(text)) return text;
  return text
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

function detectRyanairFlights(email) {
  if (!new RegExp(RYANAIR_SENDER.replace('.', '\\.'), 'i').test(email.fromEmail || '')) return [];
  const body = ryanairPlainText(email.bodyText);
  const ref = parseRyanairReservation(body);

  // No leading \b — HTML stripping can leave "EdinburghFR808" with no word boundary
  const frRe = /FR\s*(\d{3,4})/g;
  const positions = [];
  let m;
  while ((m = frRe.exec(body)) !== null) positions.push({ num: 'FR' + m[1], idx: m.index });
  if (!positions.length) {
    console.warn(`[flights] Ryanair itinerary but no flight numbers found — body: ${body.slice(0, 300)}`);
    return [];
  }

  const flights = [];
  for (let i = 0; i < positions.length; i++) {
    const chunk = body.slice(positions[i].idx, positions[i + 1]?.idx ?? body.length);
    const date = parseRyanairDate(chunk);
    const dep = chunk.match(/Departure time\s*[-:]\s*(\d{2}:\d{2})/i)?.[1] ?? null;
    const arr = chunk.match(/Arrival time\s*[-:]\s*(\d{2}:\d{2})/i)?.[1] ?? null;

    let direction = null;
    const iataParens = chunk.match(/\(([A-Z]{3})\)\s*[-–]?\s*\(([A-Z]{3})\)/);
    const iataPlain  = chunk.match(/\b([A-Z]{3})\s*[-–]\s*([A-Z]{3})\b/);
    const cityRoute  = chunk.match(/\b(Dublin|Edinburgh|Glasgow|Reus|Manchester|London)\s*[-–]\s*(Dublin|Edinburgh|Glasgow|Reus|Manchester|London)\b/i);
    if (iataParens) {
      direction = `${iataParens[1]}-${iataParens[2]}`;
    } else if (iataPlain) {
      direction = `${iataPlain[1]}-${iataPlain[2]}`;
    } else if (cityRoute) {
      const from = CITY_IATA[cityRoute[1].toLowerCase()];
      const to   = CITY_IATA[cityRoute[2].toLowerCase()];
      if (from && to) direction = `${from}-${to}`;
    }

    if (!date || !direction) {
      console.warn(`[flights] Ryanair leg ${positions[i].num}: missing date=${date} direction=${direction} — chunk: ${chunk.slice(0, 200)}`);
      continue;
    }
    flights.push({
      flightNumber: positions[i].num,
      date,
      scheduledDep: dep,
      scheduledArr: arr,
      direction,
      notes: ref ? `Booking ref ${ref}` : '',
    });
  }
  return flights;
}

// A leg first seen from an earlier parse or a manual entry may lack the
// itinerary's times and booking ref; fill blanks, never overwrite.
function upsertRyanairLeg(user, leg) {
  const hub = db.hub();
  const existing = hub.prepare(
    'SELECT id FROM flights WHERE user = ? AND flight_date = ? AND flight_number = ?'
  ).get(user, leg.date, leg.flightNumber);
  if (existing) {
    hub.prepare(`
      UPDATE flights SET
        scheduled_dep = CASE WHEN COALESCE(scheduled_dep, '') = '' THEN ? ELSE scheduled_dep END,
        scheduled_arr = CASE WHEN COALESCE(scheduled_arr, '') = '' THEN ? ELSE scheduled_arr END,
        notes         = CASE WHEN COALESCE(notes, '') = '' THEN ? ELSE notes END
      WHERE id = ?
    `).run(leg.scheduledDep ?? '', leg.scheduledArr ?? '', leg.notes, existing.id);
    return { inserted: false, id: existing.id };
  }
  const id = uuid();
  hub.prepare(`
    INSERT INTO flights (id, user, flight_number, airline, direction, flight_date,
      scheduled_dep, scheduled_arr, status, notes)
    VALUES (?, ?, ?, 'Ryanair', ?, ?, ?, ?, 'scheduled', ?)
  `).run(id, user, leg.flightNumber, leg.direction, leg.date,
    leg.scheduledDep ?? '', leg.scheduledArr ?? '', leg.notes);
  console.log(`[flights] added ${leg.flightNumber} ${leg.date} (${leg.direction})`);
  const flight = hub.prepare('SELECT * FROM flights WHERE id = ?').get(id);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  if (flight.flight_date >= today) scheduleFlightRefresh(flight);
  return { inserted: true, id };
}

// ── Gmail: Ryanair itineraries only ──────────────────────────────────────────

async function gmailClient(user) {
  const row = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!row) throw new Error(`No Google refresh token stored for user "${user}"`);
  const auth = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: row.value });
  return google.gmail({ version: 'v1', auth });
}

function decode(data) {
  return Buffer.from(String(data || ''), 'base64url').toString('utf8');
}

async function messageBody(gmail, messageId, payload) {
  const html = [];
  const plain = [];
  const walk = async part => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    if (type === 'text/html' || type === 'text/plain') {
      let data = part.body?.data;
      if (!data && part.body?.attachmentId) {
        const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId });
        data = att.data?.data;
      }
      if (data) (type === 'text/html' ? html : plain).push(decode(data));
    }
    for (const child of part.parts || []) await walk(child);
  };
  await walk(payload);
  return (html.length ? html : plain).join('\n');
}

async function importRyanairBookings(user = 'douglas', { gmail = null } = {}) {
  const hub = db.hub();
  const cursorRow = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, RYANAIR_CURSOR_KEY);
  const since = cursorRow ? parseInt(cursorRow.value, 10) : now() - RYANAIR_FIRST_LOOKBACK_DAYS * 86400;
  const startedAt = now();
  const client = gmail || await gmailClient(user);

  const ids = [];
  let pageToken;
  do {
    const list = await client.users.messages.list({
      userId: 'me',
      q: `from:${RYANAIR_SENDER} after:${since - 3600}`,
      maxResults: 100,
      pageToken,
    });
    ids.push(...(list.data.messages || []).map(m => m.id));
    pageToken = list.data.nextPageToken;
  } while (pageToken);

  let legs = 0;
  let inserted = 0;
  for (const id of ids) {
    const full = await client.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = Object.fromEntries((full.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const fromEmail = (String(headers.from || '').match(/<([^>]+)>/)?.[1] || headers.from || '').trim();
    const bodyText = await messageBody(client, id, full.data.payload);
    for (const leg of detectRyanairFlights({ fromEmail, bodyText })) {
      legs += 1;
      if (upsertRyanairLeg(user, leg).inserted) inserted += 1;
    }
  }

  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, RYANAIR_CURSOR_KEY, String(startedAt));
  return { emails: ids.length, legs, inserted };
}

// ── AeroDataBox ──────────────────────────────────────────────────────────────

async function fetchFlightRecords(flightNumber, flightDate) {
  const resp = await fetch(
    `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${flightDate}?withAircraftImage=false&withLocation=false`,
    { headers: { 'X-RapidAPI-Key': process.env.AERODATABOX_KEY, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } }
  );
  if (!resp.ok) throw new Error(`AeroDataBox ${resp.status}`);
  const json = await resp.json();
  return Array.isArray(json) ? json : (json.items || []);
}

function pickRecord(records, direction) {
  const [fromIata, toIata] = (direction || '').split('-');
  if (!fromIata || !toIata) return records[0];
  return records.find(r => r.departure?.airport?.iata === fromIata && r.arrival?.airport?.iata === toIata)
    || records.find(r => r.departure?.airport?.iata === fromIata)
    || records[0];
}

function applyFlightState(flight, rec) {
  const state = extractFlightState(rec, flight.status);
  const { status, actualDep, actualArr, scheduledDep, scheduledArr } = state;
  const actualsOk = actualsMatchSchedule(flight.scheduled_dep, actualDep, flight.scheduled_arr, actualArr);
  if (!actualsOk) {
    console.warn(`[flights] skipped implausible actuals for ${flight.flight_number} ${flight.flight_date}: scheduled ${flight.scheduled_dep}→${flight.scheduled_arr} vs live ${actualDep}→${actualArr}`);
  }
  db.hub().prepare(`
    UPDATE flights SET
      status        = ?,
      actual_dep    = CASE WHEN COALESCE(actual_dep, '')    = '' AND ? != '' THEN ? ELSE actual_dep    END,
      actual_arr    = CASE WHEN COALESCE(actual_arr, '')    = '' AND ? != '' THEN ? ELSE actual_arr    END,
      scheduled_dep = CASE WHEN COALESCE(scheduled_dep, '') = '' AND ? != '' THEN ? ELSE scheduled_dep END,
      scheduled_arr = CASE WHEN COALESCE(scheduled_arr, '') = '' AND ? != '' THEN ? ELSE scheduled_arr END
    WHERE id = ?
  `).run(
    actualsOk ? status : flight.status,
    actualsOk ? actualDep : '', actualsOk ? actualDep : '',
    actualsOk ? actualArr : '', actualsOk ? actualArr : '',
    scheduledDep, scheduledDep, scheduledArr, scheduledArr,
    flight.id
  );
  return { actualsOk, resolved: actualsOk && state.resolved, actualDep, actualArr, status };
}

// ── Scheduling ───────────────────────────────────────────────────────────────

function dublinParts(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms));
  return {
    hours: Number(parts.find(p => p.type === 'hour').value) % 24,
    minutes: Number(parts.find(p => p.type === 'minute').value),
  };
}

function epochAtNextDublin(hour, minute) {
  const nowMs = Date.now();
  for (let m = 1; m <= 24 * 60; m++) {
    const probe = nowMs + m * 60000;
    const { hours, minutes } = dublinParts(probe);
    if (hours === hour && minutes === minute) return Math.floor(probe / 60000) * 60;
  }
  return now() + 3600;
}

// Dublin wall time → epoch, so the 2h-before-departure start is right in
// both GMT and IST.
function dublinWallToEpoch(date, hhmm) {
  const asUtc = new Date(`${date}T${hhmm}:00Z`);
  const wall = new Date(asUtc.toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
  const utcWall = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.floor((asUtc.getTime() - (wall.getTime() - utcWall.getTime())) / 1000);
}

function scheduleFlightRefresh(flight) {
  const { scheduleJob } = require('./jobs');
  let runAt = now() + 60;
  if (flight.scheduled_dep && /^\d{2}:\d{2}$/.test(flight.scheduled_dep)) {
    runAt = Math.max(dublinWallToEpoch(flight.flight_date, flight.scheduled_dep) - 7200, now() + 60);
  }
  scheduleJob('flight_refresh', {
    flightId: flight.id,
    flightNumber: flight.flight_number,
    flightDate: flight.flight_date,
    direction: flight.direction,
    user: flight.user,
    attempts: 0,
  }, runAt, 'flight-import');
  console.log(`[flights] tracking ${flight.flight_number} ${flight.flight_date} from ${new Date(runAt * 1000).toISOString()}`);
}

// ── Job handlers ─────────────────────────────────────────────────────────────

const MAX_REFRESH_ATTEMPTS = 24; // ~12h of 30-min checks

async function runFlightRefresh(payload) {
  const { scheduleJob } = require('./jobs');
  const { flightId, flightNumber, flightDate, attempts = 0 } = payload;
  if (!flightId || !flightNumber || !process.env.AERODATABOX_KEY) return;
  const flight = db.hub().prepare('SELECT * FROM flights WHERE id = ?').get(flightId);
  if (!flight || flight.status !== 'scheduled') return;

  let resolved = false;
  try {
    const records = await fetchFlightRecords(flightNumber, flightDate);
    if (!records.length) throw new Error('no records');
    const result = applyFlightState(flight, pickRecord(records, flight.direction));
    resolved = result.resolved;
    if (result.actualsOk && result.actualDep) console.log(`[flights] ${flightNumber} ${flightDate}: departed ${result.actualDep}`);
    if (result.actualsOk && result.actualArr) console.log(`[flights] ${flightNumber} ${flightDate}: arrived ${result.actualArr}, status=${result.status}`);
  } catch (err) {
    console.warn(`[flights] refresh ${flightNumber} attempt ${attempts}:`, err.message);
  }

  if (!resolved && attempts < MAX_REFRESH_ATTEMPTS) {
    scheduleJob('flight_refresh', { ...payload, attempts: attempts + 1 }, now() + 30 * 60, 'self');
  } else if (resolved) {
    console.log(`[flights] ${flightNumber} ${flightDate}: tracking complete`);
  } else {
    console.log(`[flights] ${flightNumber} ${flightDate}: gave up after ${attempts} attempts`);
  }
}

// Fills actual times for flights in the last 7 days that are still missing them.
async function runFlightBackfill() {
  const { scheduleJob, hasPending } = require('./jobs');
  try {
    if (!process.env.AERODATABOX_KEY) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const since = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
    const [today, clock] = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Dublin', hour12: false }).split(' ');
    const currentTime = clock.slice(0, 5);
    const flights = db.hub().prepare(`
      SELECT * FROM flights
      WHERE (COALESCE(actual_dep, '') = '' OR COALESCE(actual_arr, '') = '')
        AND flight_date >= ?
        AND (flight_date < ? OR (flight_date = ? AND scheduled_dep != '' AND scheduled_dep <= ?))
        AND flight_number != ''
      ORDER BY flight_date DESC
    `).all(since, today, today, currentTime);
    if (flights.length) console.log(`[flights] backfill: ${flights.length} flight(s) missing actual times`);
    for (const f of flights) {
      await new Promise(r => setTimeout(r, 600));
      try {
        const records = await fetchFlightRecords(f.flight_number, f.flight_date);
        if (!records.length) continue;
        const result = applyFlightState(f, pickRecord(records, f.direction));
        if (result.actualsOk && (result.actualDep || result.actualArr)) {
          console.log(`[flights] backfilled ${f.flight_number} ${f.flight_date}: dep=${result.actualDep || '?'} arr=${result.actualArr || '?'}`);
        }
      } catch (err) {
        console.warn(`[flights] backfill error ${f.flight_number} ${f.flight_date}:`, err.message);
      }
    }
  } finally {
    if (!hasPending('flight_backfill')) scheduleJob('flight_backfill', {}, epochAtNextDublin(23, 0), 'self');
  }
}

async function runRyanairImport(payload = {}) {
  const { scheduleJob, hasPending } = require('./jobs');
  try {
    const result = await importRyanairBookings(payload.user || 'douglas');
    if (result.emails) console.log(`[flights] Ryanair import: ${result.emails} email(s), ${result.legs} leg(s), ${result.inserted} new`);
  } finally {
    if (!hasPending('ryanair_import')) scheduleJob('ryanair_import', { user: payload.user || 'douglas' }, now() + 30 * 60, 'self');
  }
}

module.exports = {
  detectRyanairFlights,
  parseRyanairReservation,
  parseRyanairDate,
  ryanairPlainText,
  upsertRyanairLeg,
  importRyanairBookings,
  fetchFlightRecords,
  pickRecord,
  scheduleFlightRefresh,
  dublinWallToEpoch,
  epochAtNextDublin,
  runFlightRefresh,
  runFlightBackfill,
  runRyanairImport,
};
