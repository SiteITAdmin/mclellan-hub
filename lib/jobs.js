'use strict';

// SQLite job queue. Each job type re-enqueues itself, so the work survives
// restarts. A single 60s tick in server.js calls processJobs().

const db = require('./db');
const { uuid } = require('./id');
const flights = require('./flights');

const handlers = {
  flight_refresh: flights.runFlightRefresh,
  flight_backfill: flights.runFlightBackfill,
  ryanair_import: flights.runRyanairImport,
};

function now() { return Math.floor(Date.now() / 1000); }

function scheduleJob(type, payload = {}, runAt = null, source = 'system') {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO system_jobs (id, type, payload, run_at, status, source)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, type, JSON.stringify(payload), runAt !== null ? Math.floor(runAt) : now(), source);
  return id;
}

function hasPending(type) {
  return !!db.hub().prepare(
    "SELECT 1 FROM system_jobs WHERE type = ? AND status = 'pending' LIMIT 1"
  ).get(type);
}

let running = false;

async function processJobs() {
  if (running) return;
  running = true;
  const hub = db.hub();
  try {
    hub.prepare("DELETE FROM system_jobs WHERE status IN ('done','failed') AND ran_at < ?").run(now() - 30 * 86400);
    const jobs = hub.prepare(
      "SELECT * FROM system_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 10"
    ).all(now());
    for (const job of jobs) {
      const claim = hub.prepare("UPDATE system_jobs SET status = 'running' WHERE id = ? AND status = 'pending'").run(job.id);
      if (!claim.changes) continue;
      const handler = handlers[job.type];
      if (!handler) {
        hub.prepare("UPDATE system_jobs SET status = 'failed', error = ?, ran_at = ? WHERE id = ?")
          .run(`no handler for type "${job.type}"`, now(), job.id);
        continue;
      }
      let payload;
      try { payload = JSON.parse(job.payload || '{}'); } catch { payload = {}; }
      try {
        await handler(payload);
        hub.prepare("UPDATE system_jobs SET status = 'done', ran_at = ? WHERE id = ?").run(now(), job.id);
      } catch (err) {
        console.error(`[jobs] ${job.type} failed:`, err.message);
        hub.prepare("UPDATE system_jobs SET status = 'failed', error = ?, ran_at = ? WHERE id = ?")
          .run(String(err.message).slice(0, 500), now(), job.id);
      }
    }
  } finally {
    running = false;
  }
}

function seedJobs() {
  db.hub().prepare("UPDATE system_jobs SET status = 'pending', ran_at = NULL WHERE status = 'running'").run();
  if (!hasPending('flight_backfill')) scheduleJob('flight_backfill', {}, now() + 10, 'seed');
  if (!hasPending('ryanair_import')) scheduleJob('ryanair_import', { user: 'douglas' }, now() + 30, 'seed');
}

module.exports = { scheduleJob, hasPending, processJobs, seedJobs, handlers };
