'use strict';

// The catch-and-correct layer. Capos DETECT failures; this layer tries to FIX
// them before anything reaches Douglas, retries, and reports the outcome up the
// family chain: "fixed it" (pass), "retry dispatched, verifies next cycle"
// (warn), or "cannot self-heal, escalating" (fail). It is the loop that turns
// the family from a monitor into an institution that corrects itself.
//
// Safety: fixers may only take reversible, idempotent actions — enqueue an
// existing job type or a backfill. They never run shell, never delete, never
// write domain data directly. The optional model advisor can only CHOOSE from
// this same whitelist or decline; it cannot emit an action of its own.

const db = require('./db');
const { CAPOS, capoByKey } = require('./hub-agent-roster');
const { capoChecks } = require('./hub-family-agents');
const { writeAgentReceipt } = require('./agent-receipts');
const { scheduleJob } = require('./job-queue');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');

const STAGE_PREFIX = 'agent:remediation';
const SOURCE_KIND = 'hub_remediation';
const ADVISOR_FEATURE = 'remediation_advisor';
const ADVISOR_FALLBACK_MODEL = 'google/gemini-2.5-flash';

function now() { return Math.floor(Date.now() / 1000); }

// Whitelisted reversible actions. Each fixer enqueues one existing job type.
// mode 'sync'    — enqueuing flips the failing check to pass this cycle (a
//                  missing pending job); we can re-run the check and prove it.
// mode 'deferred'— the fix is a job that must run before the check can pass
//                  (a backfill, or retrying a job whose last run failed); we
//                  dispatch it and verify on the next audit cycle.
const FIXERS = {
  email_process_pending:          { label: 'Email processor',       jobType: 'email_process',          mode: 'sync' },
  agentmail_process_pending:      { label: 'AgentMail processor',    jobType: 'agentmail_process',      mode: 'sync' },
  google_tasks_sync_pending:      { label: 'Google Tasks sync',      jobType: 'google_tasks_sync',      mode: 'sync' },
  task_route_run_pending:         { label: 'Task router',            jobType: 'task_route_run',         mode: 'sync' },
  mycelium_run_pending:           { label: 'Mycelium run',           jobType: 'mycelium_run',           mode: 'sync' },
  reminder_sweep_pending:         { label: 'Reminder sweep',         jobType: 'reminder_sweep',         mode: 'sync' },
  watchlist_poll_pending:         { label: 'Watchlist poll',         jobType: 'watchlist_poll',         mode: 'sync' },
  briefing_schedule_run_pending:  { label: 'Briefing scheduler',     jobType: 'briefing_schedule_run',  mode: 'sync' },

  email_process_outcome:          { label: 'Email processor retry',  jobType: 'email_process',          mode: 'deferred' },
  agentmail_process_outcome:      { label: 'AgentMail retry',        jobType: 'agentmail_process',      mode: 'deferred' },
  google_tasks_sync_outcome:      { label: 'Google Tasks retry',     jobType: 'google_tasks_sync',      mode: 'deferred' },
  task_route_run_outcome:         { label: 'Task router retry',      jobType: 'task_route_run',         mode: 'deferred' },
  mycelium_run_outcome:           { label: 'Mycelium retry',         jobType: 'mycelium_run',           mode: 'deferred' },
  reminder_sweep_outcome:         { label: 'Reminder sweep retry',   jobType: 'reminder_sweep',         mode: 'deferred' },
  watchlist_poll_outcome:         { label: 'Watchlist poll retry',   jobType: 'watchlist_poll',         mode: 'deferred' },
  briefing_schedule_run_outcome:  { label: 'Briefing retry',         jobType: 'briefing_schedule_run',  mode: 'deferred' },
  flight_refresh_outcome:         { label: 'Flight refresh retry',   jobType: 'flight_refresh',         mode: 'deferred' },

  completed_flights_have_actuals: { label: 'Flight actuals backfill', jobType: 'flight_backfill',       mode: 'deferred' },
  recent_documents_have_task_review: { label: 'Document task extraction', jobType: 'task_route_run',    mode: 'deferred' },
  crm_knowledge_engine_health:    { label: 'CRM knowledge engine',    jobType: 'crm_knowledge_engine',   mode: 'deferred' },
};

// A retry that keeps getting dispatched without clearing its check is not
// self-healing — it is masking a stuck failure. After this many dispatches over
// the recent window, stop retrying and escalate to Douglas.
const MAX_DISPATCHES = 2;
const DISPATCH_WINDOW_SECONDS = 3 * 86400;

// The advisor may only recommend one of these job types (the whitelist above),
// so a model can never widen the blast radius beyond a reversible enqueue.
const ADVISOR_WHITELIST = [...new Set(Object.values(FIXERS).map(f => f.jobType))];

function hasPending(jobType) {
  try {
    return !!db.hub().prepare(
      "SELECT 1 FROM system_jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1"
    ).get(jobType);
  } catch (_) {
    return false;
  }
}

function lastFailedError(jobType) {
  try {
    const row = db.hub().prepare(
      "SELECT error FROM system_jobs WHERE type = ? AND status = 'failed' AND ran_at IS NOT NULL ORDER BY ran_at DESC LIMIT 1"
    ).get(jobType);
    return row?.error || null;
  } catch (_) {
    return null;
  }
}

// Perform the whitelisted action for a job type: enqueue it unless one is
// already pending (idempotent — never stacks duplicate jobs).
function enqueueIfIdle(jobType) {
  if (hasPending(jobType)) {
    return { action: `ensure_${jobType}`, enqueued: false, evidence: `${jobType} already pending; retry will run on next cycle` };
  }
  const jobId = scheduleJob(jobType, {}, null, 'remediation');
  return { action: `enqueue_${jobType}`, enqueued: true, jobId, evidence: `enqueued ${jobType}` };
}

function recheck(capoKey, checkName, nowTs) {
  return capoChecks(capoKey, 'douglas', { now: nowTs }).find(c => c.name === checkName) || null;
}

// How many times we have already dispatched a retry for this exact check in the
// recent window without it resolving (a resolved fix writes a 'pass', which
// resets the count by ending the string of 'warn' dispatches).
function recentDispatchCount(capoKey, checkName, user, since) {
  try {
    const row = db.hub().prepare(`
      SELECT COUNT(*) AS n FROM knowledge_receipts
      WHERE user = ? AND source_kind = ? AND stage = ? AND source_id = ? AND status = 'warn' AND created_at >= ?
    `).get(user, SOURCE_KIND, `${STAGE_PREFIX}:${capoKey}`, checkName, since);
    return Number(row?.n || 0);
  } catch (_) {
    return 0;
  }
}

// Ask a cheap model to pick a whitelisted action for a check that has no
// deterministic fixer, or to decline. Returns null on any failure so the caller
// falls back to a clean deterministic escalation.
async function adviseAction({ capo, check, user }) {
  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1') return null;
  const modelId = getSystemModelId(ADVISOR_FEATURE, 'system', ADVISOR_FALLBACK_MODEL);
  const system = getSystemPrompt(ADVISOR_FEATURE, 'system', PROMPTS.remediation_advisor);
  const prompt = [
    system,
    '',
    'Allowed reversible job types:',
    ADVISOR_WHITELIST.map(t => `- ${t}`).join('\n'),
    '',
    `Capo (subsystem): ${capo.title}`,
    `Soldiers: ${(capo.soldiers || []).join(', ')}`,
    `Failed check: ${check.name}`,
    `Verdict: ${check.verdict}`,
    `Evidence: ${check.evidence}`,
  ].join('\n');

  try {
    const parsed = await requestModelObject({
      modelId,
      messages: [{ role: 'user', content: prompt }],
      user,
      feature: ADVISOR_FEATURE,
      modelKey: ADVISOR_FEATURE,
      taskCode: TASK_CODES.ADMIN,
      temperature: 0,
      defaults: { diagnosis: '', recommended_action: 'none', escalate: true, message: '' },
      label: 'remediation advisor',
    });
    const action = String(parsed.recommended_action || 'none');
    return {
      diagnosis: String(parsed.diagnosis || ''),
      message: String(parsed.message || ''),
      recommended_action: ADVISOR_WHITELIST.includes(action) ? action : 'none',
      escalate: Boolean(parsed.escalate),
      model_id: modelId,
    };
  } catch (_) {
    return null;
  }
}

// Attempt to fix one failing check. Returns an outcome the caller turns into a
// receipt: resolved | dispatched | escalate.
async function remediateCheck({ capoKey, check, user = 'douglas', attempts = 2, nowTs = now(), useModel = true }) {
  const capo = capoByKey(capoKey) || { key: capoKey, title: capoKey, soldiers: [] };
  let fixer = FIXERS[check.name];
  let advisory = null;

  if (!fixer && useModel) {
    advisory = await adviseAction({ capo, check, user });
    if (advisory && advisory.recommended_action !== 'none' && !advisory.escalate) {
      const jobType = advisory.recommended_action;
      fixer = { label: `Advisor: ${jobType}`, jobType, mode: 'deferred', viaModel: true };
    }
  }

  if (!fixer) {
    return {
      capoKey, check, status: 'escalate', reason: advisory ? 'model_declined' : 'no_fixer',
      advisory,
      evidence: advisory?.diagnosis
        ? `No safe automated fix. Advisor: ${advisory.diagnosis}`
        : `No automated fix registered for ${check.name}`,
    };
  }

  if (fixer.mode === 'deferred') {
    // A retry we cannot verify this cycle. If we have already retried this same
    // check to the limit without it clearing, stop masking it and escalate.
    const priorDispatches = recentDispatchCount(capoKey, check.name, user, nowTs - DISPATCH_WINDOW_SECONDS);
    if (priorDispatches >= MAX_DISPATCHES) {
      return {
        capoKey, check, status: 'escalate', reason: 'repeated_dispatch_unresolved', fixer, advisory,
        action: `retry_${fixer.jobType}`,
        evidence: `Retried ${priorDispatches}× over recent cycles without clearing this check; escalating.`
          + (advisory?.diagnosis ? ` Advisor: ${advisory.diagnosis}` : ''),
      };
    }
    const applied = enqueueIfIdle(fixer.jobType);
    return {
      capoKey, check, status: 'dispatched', attempts: 1, fixer, advisory,
      action: applied.action, before: check.verdict,
      error_context: lastFailedError(fixer.jobType),
      evidence: `${applied.evidence}; verifies on next audit cycle`,
    };
  }

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = enqueueIfIdle(fixer.jobType);
    const after = recheck(capoKey, check.name, nowTs);
    if (after && after.verdict === 'pass') {
      return {
        capoKey, check, status: 'resolved', attempts: attempt, fixer, advisory,
        action: last.action, before: check.verdict, after: 'pass', evidence: after.evidence,
      };
    }
  }

  return {
    capoKey, check, status: 'escalate', reason: 'fix_did_not_resolve', attempts, fixer, advisory,
    action: last?.action, evidence: `Still ${check.verdict} after ${attempts} attempt(s)`,
  };
}

function statusForOutcome(outcome) {
  if (outcome.status === 'resolved') return 'pass';
  if (outcome.status === 'dispatched') return 'warn';
  return 'fail';
}

function summaryForOutcome(outcome) {
  const target = `${outcome.capoKey}:${outcome.check.name}`;
  if (outcome.status === 'resolved') return `Remediation: fixed ${target} via ${outcome.action}`;
  if (outcome.status === 'dispatched') return `Remediation: retry dispatched for ${target}; verifies next cycle`;
  return `Remediation: cannot self-heal ${target} — escalating to consigliere`;
}

function writeRemediationReceipt(outcome, user = 'douglas', nowTs = now()) {
  const status = statusForOutcome(outcome);
  const payload = {
    agent: 'hub_remediation',
    capo: outcome.capoKey,
    check: outcome.check.name,
    check_evidence: outcome.check.evidence,
    result: outcome.status,
    reversible: true,
    action: outcome.action || null,
    attempts: outcome.attempts || 0,
    via_model: Boolean(outcome.fixer?.viaModel),
    advisory: outcome.advisory || null,
    evidence: outcome.evidence,
    run_at: new Date(nowTs * 1000).toISOString(),
  };
  const id = writeAgentReceipt({
    user,
    sourceKind: SOURCE_KIND,
    sourceId: outcome.check.name,
    stage: `${STAGE_PREFIX}:${outcome.capoKey}`,
    status,
    summary: summaryForOutcome(outcome),
    payload,
    modelId: outcome.advisory?.model_id || null,
  });
  return id;
}

function clearedRemediationOutcome(capoKey, check, previous) {
  if (check.verdict !== 'pass' || !previous || previous.status === 'pass') return null;
  return {
    capoKey,
    check,
    status: 'resolved',
    attempts: 0,
    action: 'verified_current_check_passes',
    before: previous.status,
    after: 'pass',
    evidence: check.evidence,
  };
}

function latestRemediationReceipt(capoKey, checkName, user) {
  try {
    return db.hub().prepare(`
      SELECT status, summary, created_at
      FROM knowledge_receipts
      WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(user, SOURCE_KIND, checkName, `${STAGE_PREFIX}:${capoKey}`);
  } catch (_) {
    return null;
  }
}

// Run one remediation pass across the whole family. Acts on every failing check
// and on the warn-level checks that have a registered fixer.
async function remediateFamily(user = 'douglas', options = {}) {
  const nowTs = options.now || now();
  const attempts = options.attempts || 2;
  const useModel = options.useModel !== false;
  const outcomes = [];

  for (const capo of CAPOS) {
    let checks;
    try {
      checks = capoChecks(capo.key, user, { now: nowTs });
    } catch (err) {
      continue;
    }
    for (const check of checks) {
      const cleared = clearedRemediationOutcome(
        capo.key,
        check,
        latestRemediationReceipt(capo.key, check.name, user),
      );
      if (cleared) {
        writeRemediationReceipt(cleared, user, nowTs);
        outcomes.push(cleared);
        continue;
      }
      const actionable = check.verdict === 'fail' || (check.verdict === 'warn' && FIXERS[check.name]);
      if (!actionable) continue;
      const outcome = await remediateCheck({ capoKey: capo.key, check, user, attempts, nowTs, useModel });
      writeRemediationReceipt(outcome, user, nowTs);
      outcomes.push(outcome);
    }
  }

  const resolved = outcomes.filter(o => o.status === 'resolved');
  const dispatched = outcomes.filter(o => o.status === 'dispatched');
  const escalated = outcomes.filter(o => o.status === 'escalate');
  return {
    run_at: new Date(nowTs * 1000).toISOString(),
    counts: { resolved: resolved.length, dispatched: dispatched.length, escalated: escalated.length },
    resolved, dispatched, escalated,
    outcomes,
  };
}

// Compact read of recent remediation activity for the consigliere / daily report.
function remediationSummary(user = 'douglas', since = now() - 26 * 3600) {
  let rows = [];
  try {
    rows = db.hub().prepare(`
      SELECT stage, source_id, status, summary, created_at
      FROM knowledge_receipts
      WHERE user = ? AND source_kind = ? AND created_at >= ?
      ORDER BY created_at DESC
    `).all(user, SOURCE_KIND, since);
  } catch (_) {
    rows = [];
  }
  const bucket = (s) => rows.filter(r => r.status === s);
  return {
    fixed: bucket('pass').map(r => r.summary),
    dispatched: bucket('warn').map(r => r.summary),
    escalated: bucket('fail').map(r => r.summary),
    counts: {
      fixed: bucket('pass').length,
      dispatched: bucket('warn').length,
      escalated: bucket('fail').length,
    },
  };
}

module.exports = {
  FIXERS,
  ADVISOR_WHITELIST,
  ADVISOR_FEATURE,
  clearedRemediationOutcome,
  remediateCheck,
  remediateFamily,
  remediationSummary,
  writeRemediationReceipt,
};
