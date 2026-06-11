const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  writeLimiter, uploadLimiter, upload, requireAuth, requireSameOrigin,
} = require('./hub-shared');

// ── Flights (DUB ↔ EDI personal log) ─────────────────────────────────────────

const FLIGHT_DIRECTIONS = [
  'DUB-EDI', 'EDI-DUB',
  'DUB-GLA', 'GLA-DUB',
  'DUB-REU', 'REU-DUB',
  'DUB-MAN', 'MAN-DUB',
  'DUB-STN', 'STN-DUB',
];
const FLIGHT_STATUSES = ['scheduled', 'completed', 'cancelled', 'diverted'];

function parseFlightMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function flightDuration(dep, arr) {
  const d = parseFlightMinutes(dep);
  const a = parseFlightMinutes(arr);
  if (d === null || a === null) return null;
  let diff = a - d;
  if (diff < 0) diff += 1440; // overnight flights (e.g. EDI-DUB 23:35→00:17)
  return diff;
}

function flightDelay(scheduled, actual) {
  const s = parseFlightMinutes(scheduled);
  const a = parseFlightMinutes(actual);
  if (s === null || a === null) return null;
  let diff = a - s;
  if (diff < -720) diff += 1440; // handle midnight crossings
  if (diff > 720) diff -= 1440;
  return diff;
}

function computeFlightStats(flights) {
  const completed = flights.filter(f => f.status === 'completed');
  const withArr = completed.filter(f => f.scheduled_arr && f.actual_arr);
  const arrDelays = withArr
    .map(f => flightDelay(f.scheduled_arr, f.actual_arr))
    .filter(d => d !== null);

  const onTime = arrDelays.length ? arrDelays.filter(d => d <= 5).length : 0;
  const rawAvg = arrDelays.length
    ? arrDelays.reduce((a, b) => a + b, 0) / arrDelays.length
    : null;
  const avgArr = rawAvg !== null ? Math.round(rawAvg * 10) / 10 : null;
  const worstArr = arrDelays.length ? Math.max(...arrDelays) : null;

  function airlineStats(name) {
    const af = completed.filter(f => (f.airline || '').trim() === name);
    const delays = af
      .filter(f => f.scheduled_arr && f.actual_arr)
      .map(f => flightDelay(f.scheduled_arr, f.actual_arr))
      .filter(d => d !== null);
    return {
      count: af.length,
      onTimePct: delays.length ? Math.round(delays.filter(d => d <= 5).length / delays.length * 100) : null,
      sample: delays.length,
    };
  }

  // ── Schedule vs reality ───────────────────────────────────────────────────

  // Actual flight durations (gate-to-gate, sanity-bounded 20–180 min)
  const actualDurations = completed
    .filter(f => f.actual_dep && f.actual_arr)
    .map(f => flightDuration(f.actual_dep, f.actual_arr))
    .filter(d => d !== null && d > 20 && d < 180);
  const avgActualDuration = actualDurations.length
    ? Math.round(actualDurations.reduce((a, b) => a + b, 0) / actualDurations.length)
    : null;

  // Scheduled block times
  const schedDurations = completed
    .filter(f => f.scheduled_dep && f.scheduled_arr)
    .map(f => flightDuration(f.scheduled_dep, f.scheduled_arr))
    .filter(d => d !== null && d > 20 && d < 180);
  const avgSchedDuration = schedDurations.length
    ? Math.round(schedDurations.reduce((a, b) => a + b, 0) / schedDurations.length)
    : null;

  // Departure punctuality: actual_dep vs scheduled_dep
  const depDelays = completed
    .filter(f => f.scheduled_dep && f.actual_dep)
    .map(f => flightDelay(f.scheduled_dep, f.actual_dep))
    .filter(d => d !== null);
  const depOnTimePct = depDelays.length
    ? Math.round(depDelays.filter(d => d <= 5).length / depDelays.length * 100)
    : null;

  // Real arrival on-time: actual_arr vs (scheduled_dep + avgActualDuration)
  // "If you left at the advertised time, did you land within a fair window?"
  const realArrDelays = avgActualDuration !== null
    ? completed
        .filter(f => f.scheduled_dep && f.actual_arr)
        .map(f => {
          const expected = (parseFlightMinutes(f.scheduled_dep) + avgActualDuration) % 1440;
          const a = parseFlightMinutes(f.actual_arr);
          if (a === null) return null;
          let diff = a - expected;
          if (diff < -720) diff += 1440;
          if (diff > 720) diff -= 1440;
          return diff;
        })
        .filter(d => d !== null)
    : [];
  const realOnTimePct = realArrDelays.length
    ? Math.round(realArrDelays.filter(d => d <= 5).length / realArrDelays.length * 100)
    : null;
  const realLateSample = realArrDelays.length;

  return {
    total: completed.length,
    cancelled: flights.filter(f => f.status === 'cancelled').length,
    onTimePct: arrDelays.length ? Math.round((onTime / arrDelays.length) * 100) : null,
    onTimeSample: arrDelays.length,
    avgArrDelay: avgArr,
    worstArrDelay: worstArr,
    dubToEdi: completed.filter(f => f.direction === 'DUB-EDI').length,
    ediToDub: completed.filter(f => f.direction === 'EDI-DUB').length,
    dubToGla: completed.filter(f => f.direction === 'DUB-GLA').length,
    glaToDub: completed.filter(f => f.direction === 'GLA-DUB').length,
    ryanair: airlineStats('Ryanair'),
    aerLingus: airlineStats('Aer Lingus'),
    avgActualDuration,
    avgSchedDuration,
    bufferMinutes: (avgActualDuration !== null && avgSchedDuration !== null)
      ? avgSchedDuration - avgActualDuration : null,
    depOnTimePct,
    depOnTimeSample: depDelays.length,
    realOnTimePct,
    realLateSample,
  };
}

router.get('/flights', requireAuth, (req, res) => {
  const user = req.hubUser;
  const raw = db.hub().prepare(
    'SELECT * FROM flights WHERE user = ? ORDER BY flight_date DESC, created_at DESC'
  ).all(user);
  const flights = raw.map(f => ({
    ...f,
    dep_delay: flightDelay(f.scheduled_dep, f.actual_dep),
    arr_delay: flightDelay(f.scheduled_arr, f.actual_arr),
  }));
  const stats = computeFlightStats(raw);
  res.render('hub/flights', { user, flights, stats });
});

router.post('/api/flights', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const user = req.hubUser;
  const { flight_number, airline, direction, flight_date,
    scheduled_dep, actual_dep, scheduled_arr, actual_arr,
    status, notes, tracker_url } = req.body;

  if (!direction || !flight_date) {
    return res.status(400).json({ error: 'direction and flight_date are required' });
  }
  if (!FLIGHT_DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  if (status && !FLIGHT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flight_date)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const id = uuid();
  db.hub().prepare(`
    INSERT INTO flights
      (id, user, flight_number, airline, direction, flight_date,
       scheduled_dep, actual_dep, scheduled_arr, actual_arr, status, notes, tracker_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user,
    (flight_number || '').trim().toUpperCase(),
    (airline || '').trim(),
    direction,
    flight_date,
    (scheduled_dep || '').trim(),
    (actual_dep || '').trim(),
    (scheduled_arr || '').trim(),
    (actual_arr || '').trim(),
    status || 'completed',
    (notes || '').trim(),
    (tracker_url || '').trim(),
  );

  // If this is a future/scheduled flight, immediately create any tasks due
  if ((status || 'completed') === 'scheduled') {
    const { connectFlightsToTasks } = require('../lib/mycelium');
    const hub2 = db.hub();
    setImmediate(() => {
      connectFlightsToTasks(user, hub2, [])
        .catch(err => console.warn('[flights] mycelium trigger:', err.message));
    });
  }

  res.json({ ok: true, id });
});

router.put('/api/flights/:id', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const user = req.hubUser;
  const existing = db.hub().prepare('SELECT id FROM flights WHERE id = ? AND user = ?').get(req.params.id, user);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { flight_number, airline, direction, flight_date,
    scheduled_dep, actual_dep, scheduled_arr, actual_arr,
    status, notes, tracker_url } = req.body;

  if (!FLIGHT_DIRECTIONS.includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction' });
  }
  if (status && !FLIGHT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.hub().prepare(`
    UPDATE flights SET
      flight_number = ?, airline = ?, direction = ?, flight_date = ?,
      scheduled_dep = ?, actual_dep = ?, scheduled_arr = ?, actual_arr = ?,
      status = ?, notes = ?, tracker_url = ?
    WHERE id = ? AND user = ?
  `).run(
    (flight_number || '').trim().toUpperCase(),
    (airline || '').trim(),
    direction,
    flight_date,
    (scheduled_dep || '').trim(),
    (actual_dep || '').trim(),
    (scheduled_arr || '').trim(),
    (actual_arr || '').trim(),
    status || 'completed',
    (notes || '').trim(),
    (tracker_url || '').trim(),
    req.params.id, user,
  );
  res.json({ ok: true });
});

router.post('/api/flights/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare('DELETE FROM flights WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/flights/import', requireAuth, requireSameOrigin, uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let XLSX;
  try { XLSX = require('xlsx'); } catch (_) {
    return res.status(500).json({ error: 'xlsx package not available on this server' });
  }

  const VALID = new Set(FLIGHT_DIRECTIONS);
  const MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

  function parseExcelDate(s) {
    const parts = String(s || '').trim().split(' ');
    if (parts.length !== 3) return '';
    const [d, m, y] = parts;
    const mn = MONTHS[m];
    if (!mn) return '';
    return `${y}-${String(mn).padStart(2,'0')}-${String(parseInt(d,10)).padStart(2,'0')}`;
  }

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file — upload a valid .xlsx' });
  }

  const ws = wb.Sheets['Flight History'] || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 2) return res.json({ inserted: 0, skipped: 0 });

  const user = req.hubUser;
  const insert = db.hub().prepare(`
    INSERT INTO flights
      (id, user, flight_number, airline, direction, flight_date,
       scheduled_dep, actual_dep, scheduled_arr, actual_arr, status, notes, tracker_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0, skipped = 0;

  for (const row of rows.slice(1)) {
    const flnr = String(row[1] || '').trim().toUpperCase();
    if (!flnr) { skipped++; continue; }

    const fromCode = String(row[3] || '').trim().toUpperCase();
    const toCode   = String(row[5] || '').trim().toUpperCase();
    const direction = `${fromCode}-${toCode}`;
    if (!VALID.has(direction)) { skipped++; continue; }

    const flightDate = parseExcelDate(row[6]);
    if (!flightDate) { skipped++; continue; }

    // Skip if already imported (same user + flight number + date)
    const exists = db.hub().prepare(
      'SELECT 1 FROM flights WHERE user = ? AND flight_number = ? AND flight_date = ?'
    ).get(user, flnr, flightDate);
    if (exists) { skipped++; continue; }

    const boardingStatus = String(row[10] || '').trim().toUpperCase();
    const bookingStatus  = String(row[9]  || '').trim().toUpperCase();
    const status = boardingStatus === 'BOARDED' ? 'completed'
                 : bookingStatus  === 'CANCELLED' ? 'cancelled'
                 : 'completed';

    const notes = String(row[22] || '').trim(); // Calendar Notes column

    try {
      insert.run(
        uuid(), user,
        flnr,
        fromCode === 'DUB' ? 'Ryanair' : 'Ryanair',
        direction,
        flightDate,
        String(row[7] || '').trim(),
        '',
        String(row[8] || '').trim(),
        '',
        status,
        notes,
        '',
      );
      inserted++;
    } catch (_) { skipped++; }
  }

  res.json({ ok: true, inserted, skipped });
});

async function aerodataboxLookup(flightNumber, flightDate, direction) {
  const key = process.env.AERODATABOX_KEY;
  if (!key) throw new Error('AERODATABOX_KEY not set');

  const [fromIata, toIata] = (direction || '').split('-');

  function localHHMM(timeObj) {
    const local = timeObj?.local || timeObj?.utc || '';
    // Format: "2024-11-06 05:55+00:00" — take the time portion only
    const parts = local.split(' ');
    return parts[1] ? parts[1].slice(0, 5) : '';
  }

  const resp = await fetch(
    `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${flightDate}?withAircraftImage=false&withLocation=false`,
    {
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
      },
    }
  );

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.message || `AeroDataBox API HTTP ${resp.status}`);
  }

  const json = await resp.json();
  const records = Array.isArray(json) ? json : (json.items || []);
  if (!records.length) return null;

  // Prefer exact origin+dest match, then origin only, then first record
  let f = null;
  if (fromIata && toIata) {
    f = records.find(r => r.departure?.airport?.iata === fromIata && r.arrival?.airport?.iata === toIata)
      || records.find(r => r.departure?.airport?.iata === fromIata)
      || records[0];
  } else {
    f = records[0];
  }
  if (!f) return null;

  const rawStatus = (f.status || '').toLowerCase();
  const status = rawStatus.includes('landed') ? 'completed'
    : rawStatus.includes('cancel') ? 'cancelled'
    : rawStatus.includes('diverted') ? 'diverted'
    : rawStatus.includes('arrived') ? 'completed'
    : null; // caller decides default based on flight date

  return {
    scheduled_dep: localHHMM(f.departure?.scheduledTime),
    actual_dep:    localHHMM(f.departure?.actualTime || f.departure?.runway?.actualTime),
    scheduled_arr: localHHMM(f.arrival?.scheduledTime),
    actual_arr:    localHHMM(f.arrival?.actualTime || f.arrival?.runway?.actualTime),
    status,
    airline: f.airline?.name || '',
    dep_iata: f.departure?.airport?.iata || fromIata || '',
    arr_iata: f.arrival?.airport?.iata  || toIata   || '',
  };
}

router.post('/api/flights/lookup', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const { flight_number, flight_date, direction } = req.body;
  if (!flight_number || !flight_date) {
    return res.status(400).json({ error: 'flight_number and flight_date are required' });
  }
  if (flight_date >= new Date().toISOString().slice(0, 10)) {
    return res.status(400).json({ error: 'Cannot look up future flights — date must be in the past' });
  }
  if (!process.env.AERODATABOX_KEY) {
    return res.status(503).json({ error: 'AERODATABOX_KEY not configured on this server' });
  }
  try {
    const data = await aerodataboxLookup(flight_number.trim().toUpperCase(), flight_date, direction);
    if (!data) return res.status(404).json({ error: 'No flight data found for that number and date' });
    if (!data.status) data.status = 'completed';
    res.json(data);
  } catch (err) {
    console.error('[flights lookup]', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/api/flights/bulk-lookup', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const user = req.hubUser;
  if (!process.env.AERODATABOX_KEY) {
    return res.status(503).json({ error: 'AERODATABOX_KEY not configured on this server' });
  }

  const candidates = db.hub().prepare(`
    SELECT id, flight_number, flight_date, direction FROM flights
    WHERE user = ? AND flight_number != '' AND (scheduled_dep = '' OR actual_arr = '')
      AND flight_date < date('now')
    ORDER BY flight_date ASC
  `).all(user);

  if (!candidates.length) return res.json({ updated: 0, failed: 0, results: [] });

  const results = [];
  let updated = 0, failed = 0;

  for (const row of candidates) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const data = await aerodataboxLookup(row.flight_number, row.flight_date, row.direction);
      if (!data) { failed++; results.push({ id: row.id, ok: false, error: 'No data' }); continue; }
      if (!data.status) data.status = 'completed';

      db.hub().prepare(`
        UPDATE flights SET
          scheduled_dep = CASE WHEN scheduled_dep = '' THEN ? ELSE scheduled_dep END,
          actual_dep    = CASE WHEN actual_dep    = '' THEN ? ELSE actual_dep    END,
          scheduled_arr = CASE WHEN scheduled_arr = '' THEN ? ELSE scheduled_arr END,
          actual_arr    = CASE WHEN actual_arr    = '' THEN ? ELSE actual_arr    END,
          status  = ?,
          airline = CASE WHEN airline = '' THEN ? ELSE airline END
        WHERE id = ? AND user = ?
      `).run(
        data.scheduled_dep, data.actual_dep, data.scheduled_arr, data.actual_arr,
        data.status, data.airline,
        row.id, user,
      );

      updated++;
      results.push({ id: row.id, ok: true, flight_number: row.flight_number, flight_date: row.flight_date });
    } catch (err) {
      failed++;
      results.push({ id: row.id, ok: false, error: err.message });
    }
  }

  res.json({ updated, failed, results });
});

module.exports = router;
