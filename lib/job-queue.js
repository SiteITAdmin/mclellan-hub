'use strict';

/**
 * System job queue.
 *
 * Jobs live in SQLite — they survive restarts and are visible in the admin UI.
 * Each job type re-enqueues itself when done, so the system self-schedules.
 * A single 60s tick in server.js calls processJobs(); nothing else polls.
 */

const db = require('./db');
const { uuid } = require('./id');

const BRIEFING_USERS = () =>
  (process.env.BRIEFING_USERS || 'douglas,nakai').split(',').map(u => u.trim()).filter(Boolean);

// ── Core queue operations ─────────────────────────────────────────────────────

function now() { return Math.floor(Date.now() / 1000); }

function scheduleJob(type, payload = {}, runAt = null, source = 'system') {
  const hub = db.hub();
  const ts = runAt !== null ? Math.floor(runAt) : now();
  const id = uuid();
  hub.prepare(`
    INSERT INTO system_jobs (id, type, payload, run_at, status, source)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, type, JSON.stringify(payload), ts, source);
  return id;
}

function hasPending(type) {
  return !!db.hub().prepare(
    "SELECT 1 FROM system_jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1"
  ).get(type);
}

// ── Job handlers ──────────────────────────────────────────────────────────────

const handlers = {};

// Email processing — runs for all users, re-enqueues in 15 minutes
handlers.email_process = async () => {
  const { processNewEmails } = require('./email-processor');
  for (const user of BRIEFING_USERS()) {
    await processNewEmails(user).catch(err =>
      console.error(`[jobs] email_process error (${user}):`, err.message));
  }
  scheduleJob('email_process', {}, now() + 15 * 60, 'self');
};

// AgentMail ingestion — re-enqueues in 15 minutes
handlers.agentmail_process = async () => {
  if (!process.env.AGENTMAIL_API_KEY || !process.env.AGENTMAIL_INBOX_ID) {
    scheduleJob('agentmail_process', {}, now() + 15 * 60, 'self');
    return;
  }
  const { processAgentMail } = require('./agentmail-processor');
  await processAgentMail('douglas').catch(err =>
    console.error('[jobs] agentmail_process error:', err.message));
  scheduleJob('agentmail_process', {}, now() + 15 * 60, 'self');
};

// Mycelium full run — re-enqueues in 6 hours
handlers.mycelium_run = async (payload) => {
  const { runMycelium } = require('./mycelium');
  const user = payload.user || 'douglas';
  await runMycelium(user).catch(err =>
    console.error('[jobs] mycelium_run error:', err.message));
  scheduleJob('mycelium_run', { user }, now() + 6 * 3600, 'self');
};

// Ad-hoc: extract tasks from a newly uploaded document
handlers.mycelium_doc = async (payload) => {
  const { autoExtractDocumentTasks, connectDocumentsToContacts } = require('./mycelium');
  const hub = db.hub();
  const user = payload.user || 'douglas';
  await autoExtractDocumentTasks(user, hub, []).catch(err =>
    console.warn('[jobs] mycelium_doc error:', err.message));
  try { connectDocumentsToContacts(user, hub, []); } catch {}
};

// Ad-hoc: create tasks for newly added scheduled flights
handlers.mycelium_flights = async (payload) => {
  const { connectFlightsToTasks } = require('./mycelium');
  const hub = db.hub();
  const user = payload.user || 'douglas';
  await connectFlightsToTasks(user, hub, []).catch(err =>
    console.warn('[jobs] mycelium_flights error:', err.message));
};

// Live flight status polling — re-enqueues itself until landed or attempt limit
handlers.flight_refresh = async (payload) => {
  const { flightId, flightNumber, flightDate, direction, user = 'douglas', attempts = 0 } = payload;
  if (!flightId || !flightNumber || !process.env.AERODATABOX_KEY) return;

  const hub = db.hub();
  const flight = hub.prepare('SELECT * FROM flights WHERE id = ?').get(flightId);
  if (!flight || flight.status !== 'scheduled') return; // already resolved

  const fetch = require('node-fetch');
  const MAX_ATTEMPTS = 24; // ~12h of 30-min checks

  let landed = false;
  let resolved = false;

  try {
    const key = process.env.AERODATABOX_KEY;
    const resp = await fetch(
      `https://aerodatabox.p.rapidapi.com/flights/number/${flightNumber}/${flightDate}?withAircraftImage=false&withLocation=false`,
      { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } }
    );
    if (!resp.ok) throw new Error(`AeroDataBox ${resp.status}`);

    const json = await resp.json();
    const records = Array.isArray(json) ? json : (json.items || []);
    if (!records.length) throw new Error('no records');

    const [fromIata, toIata] = (direction || '').split('-');
    const rec = fromIata && toIata
      ? (records.find(r => r.departure?.airport?.iata === fromIata && r.arrival?.airport?.iata === toIata)
         || records.find(r => r.departure?.airport?.iata === fromIata)
         || records[0])
      : records[0];
    if (!rec) throw new Error('no matching record');

    function hhmm(t) {
      const s = t?.local || t?.utc || '';
      const p = s.split(' ');
      return p[1] ? p[1].slice(0, 5) : '';
    }

    const rawStatus = (rec.status || '').toLowerCase();
    landed   = rawStatus.includes('landed') || rawStatus.includes('arrived');
    const cancelled = rawStatus.includes('cancel');
    const diverted  = rawStatus.includes('diverted');
    resolved = landed || cancelled || diverted;

    const status      = landed ? 'completed' : cancelled ? 'cancelled' : diverted ? 'diverted' : 'scheduled';
    const actualDep   = hhmm(rec.departure?.actualTime   || rec.departure?.runway?.actualTime);
    const actualArr   = hhmm(rec.arrival?.actualTime     || rec.arrival?.runway?.actualTime);
    const scheduledDep = hhmm(rec.departure?.scheduledTime);
    const scheduledArr = hhmm(rec.arrival?.scheduledTime);

    hub.prepare(`
      UPDATE flights SET
        status        = ?,
        actual_dep    = CASE WHEN actual_dep    = '' AND ? != '' THEN ? ELSE actual_dep    END,
        actual_arr    = CASE WHEN actual_arr    = '' AND ? != '' THEN ? ELSE actual_arr    END,
        scheduled_dep = CASE WHEN scheduled_dep = '' AND ? != '' THEN ? ELSE scheduled_dep END,
        scheduled_arr = CASE WHEN scheduled_arr = '' AND ? != '' THEN ? ELSE scheduled_arr END
      WHERE id = ?
    `).run(
      status,
      actualDep, actualDep, actualArr, actualArr,
      scheduledDep, scheduledDep, scheduledArr, scheduledArr,
      flightId
    );

    if (actualDep) console.log(`[jobs] ${flightNumber} ${flightDate}: departed ${actualDep}`);
    if (actualArr) console.log(`[jobs] ${flightNumber} ${flightDate}: arrived ${actualArr}, status=${status}`);
  } catch (err) {
    console.warn(`[jobs] flight_refresh ${flightNumber} attempt ${attempts}:`, err.message);
  }

  // Re-enqueue unless resolved or out of attempts
  if (!resolved && attempts < MAX_ATTEMPTS) {
    scheduleJob('flight_refresh',
      { ...payload, attempts: attempts + 1 },
      now() + 30 * 60,
      'self'
    );
  } else if (resolved) {
    console.log(`[jobs] ${flightNumber} ${flightDate}: tracking complete`);
  } else {
    console.log(`[jobs] ${flightNumber} ${flightDate}: gave up after ${attempts} attempts`);
  }
};

// ── Job runner ────────────────────────────────────────────────────────────────

let _running = false;

async function processJobs() {
  if (_running) return;
  _running = true;
  const hub = db.hub();

  // Clean up completed jobs older than 7 days
  hub.prepare(
    "DELETE FROM system_jobs WHERE status IN ('done','failed') AND ran_at < ?"
  ).run(now() - 7 * 86400);

  // Reset any jobs stuck in 'running' from a previous crash
  hub.prepare(
    "UPDATE system_jobs SET status = 'pending' WHERE status = 'running' AND created_at < ?"
  ).run(now() - 3600); // stuck for > 1h = crashed

  try {
    const jobs = hub.prepare(
      "SELECT * FROM system_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 10"
    ).all(now());

    for (const job of jobs) {
      hub.prepare("UPDATE system_jobs SET status = 'running' WHERE id = ?").run(job.id);
      const handler = handlers[job.type];
      let payload;
      try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }

      if (!handler) {
        hub.prepare("UPDATE system_jobs SET status = 'failed', error = ?, ran_at = ? WHERE id = ?")
           .run(`no handler for type "${job.type}"`, now(), job.id);
        continue;
      }
      try {
        await handler(payload);
        hub.prepare("UPDATE system_jobs SET status = 'done', ran_at = ? WHERE id = ?")
           .run(now(), job.id);
      } catch (err) {
        console.error(`[jobs] ${job.type} failed:`, err.message);
        hub.prepare("UPDATE system_jobs SET status = 'failed', error = ?, ran_at = ? WHERE id = ?")
           .run(err.message.slice(0, 500), now(), job.id);
      }
    }
  } finally {
    _running = false;
  }
}

// ── Seed on startup ───────────────────────────────────────────────────────────

function scheduleFlightRefresh(flight) {
  // Start 2h before scheduled departure; if dep unknown or today, start in 1 min
  let runAt = now() + 60;
  if (flight.scheduled_dep && /^\d{2}:\d{2}$/.test(flight.scheduled_dep)) {
    // Parse as Dublin local — use +01:00 (BST). Close enough; we adjust live.
    const depTs = Math.floor(
      new Date(`${flight.flight_date}T${flight.scheduled_dep}:00+01:00`).getTime() / 1000
    );
    runAt = Math.max(depTs - 7200, now() + 60);
  }
  scheduleJob('flight_refresh', {
    flightId: flight.id,
    flightNumber: flight.flight_number,
    flightDate: flight.flight_date,
    direction: flight.direction,
    user: flight.user,
    attempts: 0,
  }, runAt, 'flight-import');
  console.log(`[jobs] flight_refresh scheduled: ${flight.flight_number} ${flight.flight_date} at ${new Date(runAt * 1000).toISOString()}`);
}

function seedJobs() {
  const hub = db.hub();

  // Reset any jobs that got stuck 'running' during previous shutdown
  hub.prepare(
    "UPDATE system_jobs SET status = 'pending', ran_at = NULL WHERE status = 'running'"
  ).run();

  if (!hasPending('email_process'))
    scheduleJob('email_process', {}, now() + 30, 'seed');

  if (!hasPending('agentmail_process'))
    scheduleJob('agentmail_process', {}, now() + 45, 'seed');

  if (!hasPending('mycelium_run'))
    scheduleJob('mycelium_run', { user: 'douglas' }, now() + 60, 'seed');

  // Seed flight_refresh for any scheduled flights today/tomorrow with no pending job
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const flights  = hub.prepare(
    "SELECT * FROM flights WHERE status = 'scheduled' AND flight_date BETWEEN ? AND ? AND flight_number != ''"
  ).all(today, tomorrow);

  for (const f of flights) {
    const hasJob = hub.prepare(
      "SELECT 1 FROM system_jobs WHERE type = 'flight_refresh' AND status IN ('pending','running') AND json_extract(payload, '$.flightId') = ?"
    ).get(f.id);
    if (!hasJob) scheduleFlightRefresh(f);
  }
}

module.exports = { scheduleJob, processJobs, seedJobs, scheduleFlightRefresh };
