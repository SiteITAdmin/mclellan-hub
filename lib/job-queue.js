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
const { queueCrmKnowledgeEngine } = require('./crm-knowledge-queue');

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

// Cross-entity synthesis is a global nightly refresh. More than one pending
// run is never useful: each would read the same graph and replace the same
// derived insight set. Keep one queued successor even while today's job runs.
function scheduleCrossEntitySynthesis(runAt, source = 'system') {
  const hub = db.hub();
  const id = uuid();
  const ts = Math.floor(runAt === null ? now() : runAt);
  const result = hub.prepare(`
    INSERT OR IGNORE INTO system_jobs (id, type, payload, run_at, status, source)
    VALUES (?, 'cross_entity_synthesis', '{}', ?, 'pending', ?)
  `).run(id, ts, source);
  if (result.changes) return id;
  return hub.prepare(`
    SELECT id FROM system_jobs
     WHERE type = 'cross_entity_synthesis' AND status = 'pending'
     ORDER BY run_at ASC, created_at ASC
     LIMIT 1
  `).get()?.id || null;
}

// Suggestions do not govern same-day execution. Keep exactly one evening
// batch queued and retime a legacy/seeded pending row rather than stacking
// expensive opportunity analysis throughout the day.
function scheduleSuggestionRun(runAt, source = 'system') {
  const hub = db.hub();
  const ts = Math.floor(runAt === null ? now() : runAt);
  const existing = hub.prepare(`
    SELECT id FROM system_jobs
     WHERE type = 'suggestion_run' AND status = 'pending'
     ORDER BY run_at ASC, created_at ASC
     LIMIT 1
  `).get();
  if (existing) {
    hub.prepare(`UPDATE system_jobs SET run_at = ?, source = ? WHERE id = ?`)
      .run(ts, source, existing.id);
    return existing.id;
  }

  const id = uuid();
  hub.prepare(`
    INSERT OR IGNORE INTO system_jobs (id, type, payload, run_at, status, source)
    VALUES (?, 'suggestion_run', '{}', ?, 'pending', ?)
  `).run(id, ts, source);
  return hub.prepare(`
    SELECT id FROM system_jobs
     WHERE type = 'suggestion_run' AND status = 'pending'
     ORDER BY run_at ASC, created_at ASC
     LIMIT 1
  `).get()?.id || null;
}

function hasPending(type) {
  return !!db.hub().prepare(
    "SELECT 1 FROM system_jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1"
  ).get(type);
}

// ── Job handlers ──────────────────────────────────────────────────────────────

const handlers = {};

// One-off evidence-backed comparison of a new Nakai briefing with its two
// predecessors. The review itself is queued to the Mac subscription worker;
// if the 07:00 briefing is still rendering, retry for a bounded morning window.
handlers.nakai_briefing_quality_review = async payload => {
  const review = require('../scripts/review-nakai-briefing-quality');
  const result = review.enqueueReview(payload);
  if (result.waiting) {
    const attempt = Number(payload.attempt || 0) + 1;
    if (attempt >= 7) throw new Error(result.reason || 'target briefing not available after morning retries');
    scheduleJob(
      'nakai_briefing_quality_review',
      { ...payload, attempt },
      now() + 30 * 60,
      'nakai-quality-review-retry',
    );
  }
};

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

// Google Tasks sync — pulls completions and new tasks from Google every 15 min.
// Without this, completions are only detected when the user opens the task view.
handlers.google_tasks_sync = async () => {
  const { syncTasks } = require('./google-tasks');
  for (const user of BRIEFING_USERS()) {
    try {
      const items = await syncTasks(user);
      if (items?.length) console.log(`[jobs] google_tasks_sync ${user}: ${items.length} open tasks`);
    } catch (err) {
      console.error(`[jobs] google_tasks_sync error (${user}):`, err.message);
    }
  }
  scheduleJob('google_tasks_sync', {}, now() + 15 * 60, 'self');
};

// CRM knowledge engine — prompt-led source triage with receipts, followed by
// source-backed atom synthesis for sources worth remembering. This is the CRM's
// near-real-time ingest-to-knowledge loop; the nightly synthesis job remains the
// slower safety net.
function pendingGlobalCrmKnowledgeJob() {
  return db.hub().prepare(`
    SELECT id
    FROM system_jobs
    WHERE type = 'crm_knowledge_engine' AND status IN ('pending', 'running')
      AND json_extract(payload, '$.source_kind') IS NULL
      AND json_extract(payload, '$.source_id') IS NULL
    ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
             run_at ASC, created_at ASC, id ASC
    LIMIT 1
  `).get();
}

// A manually targeted replay must not consume or suppress the recurring
// global successor. Its own running row is intentionally not considered a
// global job here, so a quiet system resumes ordinary incomplete/error scans.
function ensureGlobalCrmKnowledgeSuccessor(runAt, source = 'crm-knowledge-target-successor') {
  // queueCrmKnowledgeEngine wraps lookup+insert in BEGIN IMMEDIATE. Do not
  // replace it with a local preflight lookup: two target handlers in separate
  // processes can otherwise both observe no global successor and enqueue two.
  return queueCrmKnowledgeEngine({ requestedBy: source, runAt }).jobId;
}

async function runCrmKnowledgeEngineJob(payload = {}) {
  const sourceKind = String(payload?.source_kind || '').trim();
  const sourceId = String(payload?.source_id || '').trim();
  if (Boolean(sourceKind) !== Boolean(sourceId)) {
    throw new Error('crm_knowledge_engine source-scoped job requires both source_kind and source_id');
  }

  if (sourceKind) {
    const user = String(payload?.user || '').trim();
    if (!user) throw new Error('crm_knowledge_engine source-scoped job requires a user');
    const { runCrmKnowledgeSource } = require('./crm-knowledge-engine');
    try {
      const res = await runCrmKnowledgeSource(user, {
        sourceKind,
        sourceId,
        linkBudget: 12,
      });
      console.log(`[jobs] crm_knowledge_engine ${user} ${sourceKind}/${sourceId}:`, res);
      return res;
    } finally {
      // Do not schedule another target implicitly. Explicit source replay is
      // one-shot, whereas the regular all-user job is the recurring worker.
      ensureGlobalCrmKnowledgeSuccessor(now() + 5 * 60);
    }
  }

  const { runCrmKnowledgeEngine } = require('./crm-knowledge-engine');
  let anyWork = false;
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await runCrmKnowledgeEngine(user, { limit: 8, linkBudget: 12 });
      if (res.considered || res.synthesised || res.skipped || res.errors) {
        console.log(`[jobs] crm_knowledge_engine ${user}:`, res);
        anyWork = anyWork || res.considered > 0;
      }
    } catch (err) {
      console.error(`[jobs] crm_knowledge_engine error (${user}):`, err.message);
    }
  }
  scheduleJob('crm_knowledge_engine', {}, now() + (anyWork ? 5 * 60 : 20 * 60), 'self');
  return { scoped: false, any_work: anyWork };
}

handlers.crm_knowledge_engine = async payload => runCrmKnowledgeEngineJob(payload);

// Release at most ten sealed historical messages per Dublin day into the
// ordinary prompt-led CRM path. The archive itself remains immutable.
handlers.messaging_archive_release = async () => {
  const { releaseDailyArchive } = require('./messaging-archive');
  const { epochAtNextDublin } = require('./reminders');
  let anyRemaining = false;
  for (const user of BRIEFING_USERS()) {
    try {
      const result = releaseDailyArchive(user);
      anyRemaining = anyRemaining || result.remaining > 0;
      if (result.released || result.remaining) {
        console.log(`[jobs] messaging_archive_release ${user}:`, result);
      }
    } catch (err) {
      anyRemaining = true;
      console.error(`[jobs] messaging_archive_release error (${user}):`, err.message);
    }
  }
  if (anyRemaining) {
    scheduleJob('messaging_archive_release', {}, epochAtNextDublin(6, 40), 'self');
  }
};

// Scheduled project reports — hourly check; the runner itself decides which
// schedules are due (Dublin-day cadence with a 20h double-send guard).
handlers.project_report_schedules = async () => {
  try {
    const { runDueProjectReportSchedules } = require('../routes/hub-crm');
    const res = await runDueProjectReportSchedules();
    if (res.sent || res.errors) console.log('[jobs] project_report_schedules:', res);
  } catch (err) {
    console.error('[jobs] project_report_schedules error:', err.message);
  }
  scheduleJob('project_report_schedules', {}, now() + 3600, 'self');
};

// Knowledge embeddings backfill (L3). Indexes any source not yet embedded —
// documents, email summaries, CRM facts, meeting transcripts. Picks up new
// content on each pass, so no write-path edits are needed. Re-enqueues fast
// while a backlog remains, otherwise idles at 30 minutes.
// The cost of a pass is dominated by fixed setup, not by the sources embedded:
// it rebuilds the whole corpus view (~3,500 records, ~5MB, re-chunked) to select
// the next batch, so a pass takes ~45 minutes whether it embeds 40 or 400. Batch
// size is therefore the throughput lever. The Mac that serves embeddings is
// guaranteed free 23:00–07:00 Dublin, so the window takes a much larger batch;
// daytime stays modest because the same machine runs the subscription CLIs the
// CRM depends on.
function embedBackfillLimit(at = new Date()) {
  const override = Number(process.env.EMBED_BACKFILL_LIMIT);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Dublin', hour: '2-digit', hour12: false,
    }).format(at));
  } catch {
    hour = at.getUTCHours();
  }
  return (hour >= 23 || hour < 7) ? 600 : 120;
}

handlers.embed_backfill = async () => {
  const { backfillEmbeddings, pruneOrphanedEmbeddings } = require('./retrieval');
  const limit = embedBackfillLimit();
  let anyRemaining = false;
  // Sweep vectors whose source has been deleted. Nightly synthesis strands a
  // batch every run by reinserting its atoms under fresh ids, so without this
  // the index accrues dead rows forever and the report's coverage figure sinks
  // even when every live source is embedded.
  try {
    const pruned = pruneOrphanedEmbeddings();
    const total = Object.values(pruned).reduce((sum, n) => sum + n, 0);
    if (total) console.log('[jobs] embed_backfill pruned orphaned embeddings:', pruned);
  } catch (err) {
    console.warn('[jobs] embed_backfill prune failed:', err.message);
  }
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await backfillEmbeddings(user, { limit });
      if (res.processed || res.remaining) console.log(`[jobs] embed_backfill ${user} (limit ${limit}):`, res);
      if (res.remaining) anyRemaining = true;
    } catch (err) {
      console.error(`[jobs] embed_backfill error (${user}):`, err.message);
    }
  }
  // Only one chain may exist. This job re-arms itself, so any extra pending row
  // (a manual kick, a duplicate schedule) becomes a second self-perpetuating
  // chain that pays the same expensive corpus scan for the same work.
  const alreadyQueued = db.hub().prepare(
    "SELECT 1 FROM system_jobs WHERE type = 'embed_backfill' AND status = 'pending' LIMIT 1"
  ).get();
  if (!alreadyQueued) {
    scheduleJob('embed_backfill', {}, now() + (anyRemaining ? 60 : 30 * 60), 'self');
  }
};

// Historical atoms-backfill job name. In normal operation it queues curated
// crm_facts for the canonical knowledge engine; only the explicit rollback flag
// can invoke the former deterministic direct compiler.
handlers.atoms_backfill = async () => {
  const { backfillFromCrmFacts } = require('./atoms');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = backfillFromCrmFacts(user);
      if (res.created || res.deferred) console.log(`[jobs] atoms_backfill ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] atoms_backfill error (${user}):`, err.message);
    }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleJob('atoms_backfill', {}, epochAtNextDublin(2, 30), 'self');
};

// Knowledge synthesis (L4) — the historical job name now delegates to the one
// canonical source-evidence -> triage -> duplicate review -> atom/action engine.
// Runs nightly ~03:00 Dublin; while a recoverable backlog remains it comes back
// in a few minutes so a first run drains over the night rather than starving.
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

// Cross-entity synthesis — nightly at 04:15 Dublin. Claude Sonnet over a
// bounded packet (max 80 recent active atoms — not the full table). Writes
// insight atoms (patterns, workflows, connections, gaps). subject_kind = 'insight'.
handlers.cross_entity_synthesis = async () => {
  const { runCrossEntitySynthesis } = require('./knowledge-synthesis');
  const { epochAtNextDublin } = require('./reminders');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await runCrossEntitySynthesis(user);
      console.log(`[jobs] cross_entity_synthesis ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] cross_entity_synthesis error (${user}):`, err.message);
    }
  }
  scheduleCrossEntitySynthesis(epochAtNextDublin(4, 15), 'self');
};

// Live-thread synthesis — nightly at 04:35 Dublin. Reads across source streams
// (emails, meetings, intel/RSS, opportunities, atoms) and writes thread atoms
// for ideas recurring across otherwise separate parts of the Hub.
handlers.live_thread_synthesis = async () => {
  const { runLiveThreadSynthesis } = require('./knowledge-synthesis');
  const { epochAtNextDublin } = require('./reminders');
  for (const user of BRIEFING_USERS()) {
    try {
      const res = await runLiveThreadSynthesis(user);
      console.log(`[jobs] live_thread_synthesis ${user}:`, res);
    } catch (err) {
      console.error(`[jobs] live_thread_synthesis error (${user}):`, err.message);
    }
  }
  scheduleJob('live_thread_synthesis', {}, epochAtNextDublin(4, 35), 'self');
};

// Interest radar — daily at 05:45 Dublin so compiled interest atoms and the
// radar cache reflect the latest meetings and calendar.
handlers.interest_synthesis_run = async () => {
  const { runInterestSynthesis } = require('./interest-synthesis');
  const { epochAtNextDublin } = require('./reminders');
  try {
    const res = await runInterestSynthesis('douglas');
    console.log('[jobs] interest_synthesis_run:', res);
  } catch (err) {
    console.error('[jobs] interest_synthesis_run error:', err.message);
  }
  scheduleJob('interest_synthesis_run', {}, epochAtNextDublin(5, 45), 'self');
};

// Model style profiles — re-distils per-family prompt style profiles from the
// system_prompts_leaks repo. Monthly: the repo changes slowly and each run
// costs five LLM calls. Failures keep the previous profile (stale beats absent).
handlers.style_profile_run = async () => {
  const { runStyleProfileSynthesis } = require('./model-style-profiles');
  try {
    const res = await runStyleProfileSynthesis();
    console.log('[jobs] style_profile_run:', JSON.stringify(res));
  } catch (err) {
    console.error('[jobs] style_profile_run error:', err.message);
  }
  scheduleJob('style_profile_run', {}, now() + 30 * 24 * 3600, 'self');
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

// Daily LLM suggestion run (19:00 Dublin). Suggestions do not govern the
// current day, so batch the non-urgent analysis once each evening.
handlers.suggestion_run = async () => {
  const { runSuggesters } = require('./suggestion-engine');
  for (const user of BRIEFING_USERS()) {
    try { await runSuggesters(user); }
    catch (err) { console.error(`[jobs] suggestion_run error (${user}):`, err.message); }
  }
  const { epochAtNextDublin } = require('./reminders');
  scheduleSuggestionRun(epochAtNextDublin(19, 0), 'self');
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

// Briefing schedules — check every 5 minutes so scheduled times fire within 5 min of due
handlers.briefing_schedule_run = async () => {
  const hub = db.hub();
  const { generateBriefing, sendBriefing } = require('./newsletter-pipeline');
  const { nextRecurOccurrenceAfter } = require('./reminders');

  const schedules = hub.prepare(`
    SELECT * FROM briefing_schedules WHERE enabled = 1
  `).all();

  for (const sched of schedules) {
    const lastRun = sched.last_run_at || (now() - sched.date_window_days * 86400);
    const nextRun = nextRecurOccurrenceAfter(sched.recur_spec, lastRun);
    if (!nextRun || nextRun > now()) continue;

    const windowDays = sched.date_window_days || 7;
    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom = new Date(Date.now() - windowDays * 86400 * 1000).toISOString().slice(0, 10);

    try {
      const result = await generateBriefing({
        user: sched.user,
        formatId: sched.format_id || undefined,
        focus: sched.focus_query || undefined,
        dateFrom,
        dateTo,
      });
      hub.prepare('UPDATE nl_briefings SET schedule_id = ? WHERE id = ?').run(sched.id, result.id);
      hub.prepare('UPDATE briefing_schedules SET last_run_at = ? WHERE id = ?').run(now(), sched.id);
      console.log(`[jobs] briefing_schedule_run: "${sched.name}" → briefing ${result.id} (${result.topicCount} topics)`);

      if (sched.auto_send) {
        await sendBriefing({ user: sched.user, briefingId: result.id });
      }
    } catch (err) {
      console.error(`[jobs] briefing_schedule_run "${sched.name}" failed:`, err.message);
    }
  }

  scheduleJob('briefing_schedule_run', {}, now() + 5 * 60, 'self');
};

// Unified feed poll — processes all rss_feeds (RSS + cascade) that are due
handlers.watchlist_poll = async () => {
  const { ingestAllFeeds } = require('./rss-ingest');
  for (const user of BRIEFING_USERS()) {
    await ingestAllFeeds(user, { dueOnly: true }).catch(err =>
      console.error(`[jobs] feed_poll error (${user}):`, err.message));
  }
  scheduleJob('watchlist_poll', {}, now() + 15 * 60, 'self');
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
      // Conditional claim makes this safe across multiple Hub processes: only
      // the process that changes pending → running is allowed to execute it.
      const claim = hub.prepare(
        "UPDATE system_jobs SET status = 'running' WHERE id = ? AND status = 'pending'"
      ).run(job.id);
      if (!claim.changes) continue;
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

  if (!hasPending('google_tasks_sync'))
    scheduleJob('google_tasks_sync', {}, now() + 30, 'seed');

  // A source-scoped repair is not the recurring scanner. The transactional
  // queue helper preserves one delayed global successor without allowing an
  // explicit replay to suppress it.
  ensureGlobalCrmKnowledgeSuccessor(now() + 105, 'seed');
  const hasArchiveBacklog = !!hub.prepare(`
    SELECT 1
    FROM messaging_archive_messages
    WHERE released_at IS NULL
    LIMIT 1
  `).get();
  if (hasArchiveBacklog && !hasPending('messaging_archive_release')) {
    const { epochAtNextDublin } = require('./reminders');
    scheduleJob('messaging_archive_release', {}, epochAtNextDublin(6, 40), 'seed');
  }
  if (!hasPending('project_report_schedules'))
    scheduleJob('project_report_schedules', {}, now() + 150, 'seed');

  if (!hasPending('mycelium_run'))
    scheduleJob('mycelium_run', { user: 'douglas' }, now() + 60, 'seed');

  if (!hasPending('embed_backfill'))
    scheduleJob('embed_backfill', {}, now() + 75, 'seed');

  if (!hasPending('atoms_backfill'))
    scheduleJob('atoms_backfill', {}, now() + 150, 'seed');

  if (!hasPending('synthesis_run'))
    scheduleJob('synthesis_run', {}, now() + 240, 'seed');

  if (!hasPending('briefing_schedule_run'))
    scheduleJob('briefing_schedule_run', {}, now() + 120, 'seed');

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

  if (!hasPending('cross_entity_synthesis'))
    scheduleCrossEntitySynthesis(now() + 420, 'seed');

  if (!hasPending('live_thread_synthesis'))
    scheduleJob('live_thread_synthesis', {}, now() + 450, 'seed');

  if (!hasPending('interest_synthesis_run'))
    scheduleJob('interest_synthesis_run', {}, now() + 480, 'seed');

  if (!hasPending('reminder_sweep'))
    scheduleJob('reminder_sweep', {}, now() + 90, 'seed');

  if (!hasPending('crm_nudges'))
    scheduleJob('crm_nudges', {}, now() + 120, 'seed');

  // Always align a queued legacy/seeded suggestion job to the nightly window.
  // The singleton scheduler updates an existing pending row rather than adding
  // another job.
  {
    const { epochAtNextDublin } = require('./reminders');
    scheduleSuggestionRun(epochAtNextDublin(19, 0), 'seed');
  }

  if (!hasPending('watchlist_poll'))
    scheduleJob('watchlist_poll', {}, now() + 120, 'seed');

  if (!hasPending('style_profile_run')) {
    // First distillation shortly after boot when no profiles exist yet; monthly after that
    const { getStyleProfile, MODEL_FAMILIES } = require('./model-style-profiles');
    const anyProfile = MODEL_FAMILIES.some(f => getStyleProfile(f.key));
    scheduleJob('style_profile_run', {}, anyProfile ? now() + 30 * 24 * 3600 : now() + 600, 'seed');
  }

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

module.exports = {
  scheduleJob, scheduleCrossEntitySynthesis, scheduleSuggestionRun,
  processJobs, seedJobs, scheduleFlightRefresh,
  _test: {
    handlers,
    pendingGlobalCrmKnowledgeJob,
    ensureGlobalCrmKnowledgeSuccessor,
    runCrmKnowledgeEngineJob,
  },
};
