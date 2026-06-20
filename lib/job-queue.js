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
const { extractFlightState } = require('./flight-status');

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

// Knowledge embeddings backfill (L3). Indexes any source not yet embedded —
// documents, email summaries, CRM facts, meeting transcripts. Picks up new
// content on each pass, so no write-path edits are needed. Re-enqueues fast
// while a backlog remains, otherwise idles at 30 minutes.
handlers.embed_backfill = async () => {
  const { backfillEmbeddings } = require('./retrieval');
  let anyRemaining = false;
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await backfillEmbeddings(user, { limit: 40 });
      if (res.processed || res.remaining) console.log(`[jobs] embed_backfill ${user}:`, res);
      if (res.remaining) anyRemaining = true;
    } catch (err) {
      console.error(`[jobs] embed_backfill error (${user}):`, err.message);
    }
  }
  scheduleJob('embed_backfill', {}, now() + (anyRemaining ? 60 : 30 * 60), 'self');
};

// Atoms backfill (L2). Converts curated crm_facts into knowledge atoms with
// provenance. Cheap (no LLM); refreshes daily and on startup so new facts join
// the substrate. The synthesis linker (synthesis_run) adds atoms from raw text.
handlers.atoms_backfill = async () => {
  const { backfillFromCrmFacts } = require('./atoms');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = backfillFromCrmFacts(user);
      if (res.created) console.log(`[jobs] atoms_backfill ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] atoms_backfill error (${user}):`, err.message);
    }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('atoms_backfill', {}, epochAtNextDublin(2, 30), 'self');
};

// Knowledge synthesis (L4) — the self-improving loop. Re-reads raw sources,
// derives atoms with provenance, links them to entities. Runs nightly ~03:00
// Dublin; while a backlog of unprocessed sources remains it comes back in a few
// minutes so a first run drains over the night rather than starving.
handlers.synthesis_run = async () => {
  const { runSynthesis } = require('./synthesis');
  const { projectAllEntities } = require('./knowledge-projection');
  let anyRemaining = false;
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await runSynthesis(user, { limit: 15, linkBudget: 20 });
      if (res.processed || res.remaining) console.log(`[jobs] synthesis_run ${user}:`, res);
      if (res.remaining) anyRemaining = true;
    } catch (err) {
      console.error(`[jobs] synthesis_run error (${user}):`, err.message);
    }
    // Project the substrate into the wiki: regenerate each entity's knowledge
    // block + connections so the wiki/graph reflect derived knowledge.
    try {
      const proj = projectAllEntities(user);
      if (proj.written) console.log(`[jobs] knowledge projection ${user}:`, proj);
    } catch (err) {
      console.error(`[jobs] knowledge projection error (${user}):`, err.message);
    }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('synthesis_run', {}, anyRemaining ? now() + 5 * 60 : epochAtNextDublin(3, 0), 'self');
};

handlers.content_research_run = async () => {
  const { runDueContentResearch } = require('./content-research');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await runDueContentResearch(user);
      console.log(`[jobs] content_research_run ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] content_research_run error (${user}):`, err.message);
    }
  }
  const { getContentCadencePolicy } = require('./content-cadence-policy');
  const { nextRecurOccurrenceAfter } = require('./reminders');
  const policy = getContentCadencePolicy('douglas');
  const next = nextRecurOccurrenceAfter(policy.topicPlan.researchRecur || 'daily:06:00', now()) || (now() + 86400);
  scheduleJob('content_research_run', {}, next, 'self');
};

// Task routing (Stage 3) — attaches open free-text tasks to the entity their
// knowledge points to ("get dad's medicine" → Alister). Daily, after synthesis.
handlers.task_route_run = async () => {
  const { routeTasks } = require('./task-router');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await routeTasks(user, { limit: 40 });
      if (res.routed) console.log(`[jobs] task_route_run ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] task_route_run error (${user}):`, err.message);
    }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('task_route_run', {}, epochAtNextDublin(3, 30), 'self');
};

// Knowledge lint (Stage 4) — weekly. Decays/marks stale atoms and counts what
// needs human review. The /admin/knowledge queue reads the analysis live.
handlers.knowledge_lint_run = async () => {
  const { runLint } = require('./knowledge-lint');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = runLint(user);
      console.log(`[jobs] knowledge_lint_run ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] knowledge_lint_run error (${user}):`, err.message);
    }
  }
  // Weekly — next Sunday 04:00 Dublin.
  const { epochAtNextDublinWeekly } = require('./reminders');
  const next = typeof epochAtNextDublinWeekly === 'function'
    ? epochAtNextDublinWeekly(0, 4, 0)
    : now() + 7 * 86400;
  scheduleJob('knowledge_lint_run', {}, next, 'self');
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

// Backfill actual times for recently completed flights that are missing them.
// Re-enqueues itself daily at 23:00 so past flights always get filled in.
handlers.flight_backfill = async () => {
  const { epochAtNextDublin } = require('./reminders');
  const scheduleNext = () => {
    const pending = db.hub().prepare(
      "SELECT 1 FROM system_jobs WHERE type = 'flight_backfill' AND status = 'pending' LIMIT 1"
    ).get();
    if (!pending) {
      scheduleJob('flight_backfill', {}, epochAtNextDublin(23, 0), 'self');
    }
  };
  if (!process.env.AERODATABOX_KEY) {
    scheduleNext();
    return;
  }
  const hub = db.hub();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const since = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const nowDublin = new Date().toLocaleString('sv-SE', {
    timeZone: 'Europe/Dublin',
    hour12: false,
  });
  const [today, currentTimeWithSeconds] = nowDublin.split(' ');
  const currentTime = currentTimeWithSeconds.slice(0, 5);

  const flights = hub.prepare(`
    SELECT * FROM flights
    WHERE (COALESCE(actual_dep, '') = '' OR COALESCE(actual_arr, '') = '')
      AND flight_date >= ?
      AND (
        flight_date < ?
        OR (flight_date = ? AND scheduled_dep != '' AND scheduled_dep <= ?)
      )
      AND flight_number != ''
    ORDER BY flight_date DESC
  `).all(since, today, today, currentTime);

  if (!flights.length) {
    scheduleNext();
    return;
  }
  console.log(`[jobs] flight_backfill: ${flights.length} flight(s) missing actual times`);

  for (const f of flights) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const key = process.env.AERODATABOX_KEY;
      const resp = await fetch(
        `https://aerodatabox.p.rapidapi.com/flights/number/${f.flight_number}/${f.flight_date}?withAircraftImage=false&withLocation=false`,
        { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } }
      );
      if (!resp.ok) continue;
      const json = await resp.json();
      const records = Array.isArray(json) ? json : (json.items || []);
      if (!records.length) continue;

      const [fromIata, toIata] = (f.direction || '').split('-');
      const rec = fromIata && toIata
        ? (records.find(r => r.departure?.airport?.iata === fromIata && r.arrival?.airport?.iata === toIata)
           || records.find(r => r.departure?.airport?.iata === fromIata)
           || records[0])
        : records[0];
      if (!rec) continue;

      const {
        status, actualDep, actualArr, scheduledDep, scheduledArr,
      } = extractFlightState(rec, f.status);

      hub.prepare(`
        UPDATE flights SET
          status        = ?,
          actual_dep    = CASE WHEN COALESCE(actual_dep, '')    = '' AND ? != '' THEN ? ELSE actual_dep    END,
          actual_arr    = CASE WHEN COALESCE(actual_arr, '')    = '' AND ? != '' THEN ? ELSE actual_arr    END,
          scheduled_dep = CASE WHEN COALESCE(scheduled_dep, '') = '' AND ? != '' THEN ? ELSE scheduled_dep END,
          scheduled_arr = CASE WHEN COALESCE(scheduled_arr, '') = '' AND ? != '' THEN ? ELSE scheduled_arr END
        WHERE id = ?
      `).run(
        status,
        actualDep, actualDep, actualArr, actualArr,
        scheduledDep, scheduledDep, scheduledArr, scheduledArr,
        f.id
      );
      if (actualDep || actualArr) {
        console.log(`[jobs] backfilled ${f.flight_number} ${f.flight_date}: dep=${actualDep||'?'} arr=${actualArr||'?'}`);
      }
    } catch (err) {
      console.warn(`[jobs] backfill error ${f.flight_number} ${f.flight_date}:`, err.message);
    }
  }

  scheduleNext();
};

// Fire a single reminder — the reminder row decides what actually happens
handlers.reminder_fire = async (payload) => {
  if (!payload.reminderId) return;
  const { fireReminder } = require('./reminders');
  await fireReminder(payload.reminderId);
};

// Reminder sweep — overdue tasks/follow-ups, crash recovery, cancel resolved.
// Idempotent; re-enqueues itself every 15 minutes.
handlers.reminder_sweep = async () => {
  const { sweepReminders } = require('./reminders');
  for (const user of BRIEFING_USERS()) {
    try { sweepReminders(user); }
    catch (err) { console.error(`[jobs] reminder_sweep error (${user}):`, err.message); }
  }
  scheduleJob('reminder_sweep', {}, now() + 15 * 60, 'self');
};

// Nightly CRM nudges — recompute last-contacted cache, create birthday
// reminders. Re-enqueues itself for ~06:50 Dublin (before the 07:30 briefing).
handlers.crm_nudges = async () => {
  const { runNightlyNudges } = require('./crm-nudges');
  for (const user of BRIEFING_USERS()) {
    try { runNightlyNudges(user); }
    catch (err) { console.error(`[jobs] crm_nudges error (${user}):`, err.message); }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('crm_nudges', {}, epochAtNextDublin(6, 50), 'self');
};

// Daily LLM suggestion run (~07:00 Dublin — lands in the morning briefing).
// Suggesters are advisory only; dedup keys make re-runs free.
handlers.suggestion_run = async () => {
  const { runSuggesters } = require('./suggestion-engine');
  for (const user of BRIEFING_USERS()) {
    try { await runSuggesters(user); }
    catch (err) { console.error(`[jobs] suggestion_run error (${user}):`, err.message); }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('suggestion_run', {}, epochAtNextDublin(7, 0), 'self');
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

  const MAX_ATTEMPTS = 24; // ~12h of 30-min checks

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

    const state = extractFlightState(rec, flight.status);
    const {
      status, actualDep, actualArr, scheduledDep, scheduledArr,
    } = state;
    resolved = state.resolved;

    hub.prepare(`
      UPDATE flights SET
        status        = ?,
        actual_dep    = CASE WHEN COALESCE(actual_dep, '')    = '' AND ? != '' THEN ? ELSE actual_dep    END,
        actual_arr    = CASE WHEN COALESCE(actual_arr, '')    = '' AND ? != '' THEN ? ELSE actual_arr    END,
        scheduled_dep = CASE WHEN COALESCE(scheduled_dep, '') = '' AND ? != '' THEN ? ELSE scheduled_dep END,
        scheduled_arr = CASE WHEN COALESCE(scheduled_arr, '') = '' AND ? != '' THEN ? ELSE scheduled_arr END
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

  // Immediately backfill missing actual times only when no chain already exists.
  if (!hasPending('flight_backfill'))
    scheduleJob('flight_backfill', {}, now() + 10, 'seed');

  if (!hasPending('email_process'))
    scheduleJob('email_process', {}, now() + 30, 'seed');

  if (!hasPending('agentmail_process'))
    scheduleJob('agentmail_process', {}, now() + 45, 'seed');

  if (!hasPending('mycelium_run'))
    scheduleJob('mycelium_run', { user: 'douglas' }, now() + 60, 'seed');

  if (!hasPending('embed_backfill'))
    scheduleJob('embed_backfill', {}, now() + 75, 'seed');

  if (!hasPending('atoms_backfill'))
    scheduleJob('atoms_backfill', {}, now() + 150, 'seed');

  if (!hasPending('synthesis_run'))
    scheduleJob('synthesis_run', {}, now() + 240, 'seed');

  if (!hasPending('content_research_run')) {
    const { getContentCadencePolicy } = require('./content-cadence-policy');
    const { nextRecurOccurrenceAfter } = require('./reminders');
    const policy = getContentCadencePolicy('douglas');
    scheduleJob('content_research_run', {}, nextRecurOccurrenceAfter(policy.topicPlan.researchRecur || 'daily:06:00', now()) || (now() + 86400), 'seed');
  }

  if (!hasPending('task_route_run'))
    scheduleJob('task_route_run', {}, now() + 300, 'seed');

  if (!hasPending('knowledge_lint_run'))
    scheduleJob('knowledge_lint_run', {}, now() + 360, 'seed');

  if (!hasPending('reminder_sweep'))
    scheduleJob('reminder_sweep', {}, now() + 90, 'seed');

  if (!hasPending('crm_nudges'))
    scheduleJob('crm_nudges', {}, now() + 120, 'seed');

  if (!hasPending('suggestion_run'))
    scheduleJob('suggestion_run', {}, now() + 180, 'seed');

  // Seed flight_refresh for all upcoming scheduled flights with no pending job
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const flights = hub.prepare(
    "SELECT * FROM flights WHERE status = 'scheduled' AND flight_date >= ? AND flight_number != '' ORDER BY flight_date ASC"
  ).all(today);

  for (const f of flights) {
    const hasJob = hub.prepare(
      "SELECT 1 FROM system_jobs WHERE type = 'flight_refresh' AND status IN ('pending','running') AND json_extract(payload, '$.flightId') = ?"
    ).get(f.id);
    if (!hasJob) scheduleFlightRefresh(f);
  }
}

module.exports = { scheduleJob, processJobs, seedJobs, scheduleFlightRefresh };
