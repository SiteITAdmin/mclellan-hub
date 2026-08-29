'use strict';

const db = require('./db');
const { CAPOS, UNDERBOSSES, capoByKey } = require('./hub-agent-roster');
const { writeAgentReceipt } = require('./agent-receipts');

function now() { return Math.floor(Date.now() / 1000); }

function check(name, verdict, evidence, details = {}) {
  return { name, verdict, evidence, details };
}

function overall(checks) {
  if (checks.some(c => c.verdict === 'fail')) return 'fail';
  if (checks.some(c => c.verdict === 'warn')) return 'warn';
  return 'pass';
}

function safeGet(sql, params = []) {
  try { return db.hub().prepare(sql).get(...params); } catch (err) { return { __error: err.message }; }
}

function safeAll(sql, params = []) {
  try { return db.hub().prepare(sql).all(...params); } catch (err) { return [{ __error: err.message }]; }
}

function pendingJobCheck(jobType, label = jobType) {
  const row = safeGet("SELECT 1 AS ok FROM system_jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1", [jobType]);
  if (row?.__error) return check(`${jobType}_pending`, 'warn', `${label}: check unavailable (${row.__error})`);
  return check(`${jobType}_pending`, row ? 'pass' : 'fail', row ? `${label} has pending/running job` : `${label} has no pending/running job`);
}

function tableCountCheck(table, label, minimum = 1) {
  const row = safeGet(`SELECT COUNT(*) AS n FROM ${table}`);
  if (row?.__error) return check(`${table}_present`, 'warn', `${label}: table unavailable (${row.__error})`);
  return check(`${table}_present`, Number(row.n || 0) >= minimum ? 'pass' : 'warn', `${label}: ${Number(row.n || 0)} row(s)`);
}

// pendingJobCheck only proves the job is scheduled; this proves runs succeed.
function jobHealthCheck(jobType, label = jobType, sinceEpoch = now() - 86400) {
  const latest = safeGet(
    "SELECT status FROM system_jobs WHERE type = ? AND status IN ('done','failed') AND ran_at IS NOT NULL ORDER BY ran_at DESC LIMIT 1",
    [jobType],
  );
  if (latest?.__error) return check(`${jobType}_outcome`, 'warn', `${label}: outcome check unavailable (${latest.__error})`);
  if (latest?.status === 'failed') return check(`${jobType}_outcome`, 'fail', `${label}: most recent completed run failed`);
  const failed = safeGet(
    "SELECT COUNT(*) AS n FROM system_jobs WHERE type = ? AND status = 'failed' AND ran_at >= ?",
    [jobType, sinceEpoch],
  );
  if (failed?.__error) return check(`${jobType}_outcome`, 'warn', `${label}: outcome check unavailable (${failed.__error})`);
  const n = Number(failed?.n || 0);
  if (n) return check(`${jobType}_outcome`, 'warn', `${label}: ${n} failed run(s) in last 24h; latest run succeeded`);
  return check(`${jobType}_outcome`, 'pass', latest ? `${label}: latest completed run succeeded` : `${label}: no completed runs recorded yet`);
}

function recentCount(table, column, sinceEpoch) {
  return safeGet(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ?`, [sinceEpoch]);
}

function recentCountCheck(table, column, label, sinceEpoch, minimum = 1) {
  const row = recentCount(table, column, sinceEpoch);
  if (row?.__error) return check(`${table}_recent`, 'warn', `${label}: check unavailable (${row.__error})`);
  return check(`${table}_recent`, Number(row.n || 0) >= minimum ? 'pass' : 'warn', `${label}: ${Number(row.n || 0)} recent row(s)`);
}

function documentsAwaitingTaskReview(documents = []) {
  const { isGeneratedDocument } = require('./document-tasks');
  return documents.filter(doc => !doc.task_extracted_at && !isGeneratedDocument(doc));
}

function capoChecks(capoKey, user = 'douglas', options = {}) {
  const ts = options.now || now();
  const since24h = ts - 86400;
  const since7d = ts - 7 * 86400;
  const since14d = ts - 14 * 86400;
  const today = new Date(ts * 1000).toISOString().slice(0, 10);

  switch (capoKey) {
    case 'email':
      return [pendingJobCheck('email_process'), jobHealthCheck('email_process', 'email processor', since24h), recentCountCheck('email_summaries', 'received_at', 'email summaries', since7d)];
    case 'agentmail':
      return [pendingJobCheck('agentmail_process'), jobHealthCheck('agentmail_process', 'AgentMail processor', since24h), recentCountCheck('inbound_email_records', 'received_at', 'AgentMail records', since7d)];
    case 'crm': {
      const { recentCrmKnowledgeActivity, crmKnowledgeHealthWarning } = require('./system-report');
      let warning = null;
      try { warning = crmKnowledgeHealthWarning(recentCrmKnowledgeActivity(db.hub(), since7d)); }
      catch (err) { warning = `CRM knowledge check unavailable: ${err.message}`; }
      return [
        check('crm_knowledge_engine_health', warning ? 'fail' : 'pass', warning || 'CRM knowledge activity is healthy'),
        tableCountCheck('contacts', 'contacts'),
      ];
    }
    case 'tasks':
      return [
        pendingJobCheck('google_tasks_sync', 'Google Tasks sync'),
        jobHealthCheck('google_tasks_sync', 'Google Tasks sync', since24h),
        pendingJobCheck('task_route_run', 'task router'),
        jobHealthCheck('task_route_run', 'task router', since24h),
      ];
    case 'documents_projects': {
      // "[meeting].md" documents are generated by meeting intake; their actions
      // flow through the intake action register, not document task extraction.
      const recentDocuments = safeAll(`
        SELECT d.id, d.filename, d.markdown, d.task_extracted_at
        FROM documents d
        WHERE d.uploaded_at >= ?
          AND COALESCE(d.mimetype, '') NOT LIKE 'image/%'
          AND d.filename NOT LIKE '%[meeting].md'
      `, [since7d]);
      const unavailable = recentDocuments.find(row => row.__error);
      const awaiting = unavailable ? [] : documentsAwaitingTaskReview(recentDocuments);
      return [
        tableCountCheck('documents', 'documents'),
        check('recent_documents_have_task_review', unavailable ? 'warn' : awaiting.length ? 'warn' : 'pass',
          unavailable
            ? `check unavailable (${unavailable.__error})`
            : `${awaiting.length} recent non-image document(s) awaiting task review`,
          { documents: awaiting.map(doc => ({ id: doc.id, filename: doc.filename })) }),
      ];
    }
    case 'knowledge':
      return [
        tableCountCheck('knowledge_atoms', 'knowledge atoms'),
        recentCountCheck('knowledge_receipts', 'created_at', 'knowledge receipts', since7d),
      ];
    case 'mycelium':
      return [pendingJobCheck('mycelium_run'), jobHealthCheck('mycelium_run', 'mycelium run', since24h)];
    case 'reminders':
      return [pendingJobCheck('reminder_sweep'), jobHealthCheck('reminder_sweep', 'reminder sweep', since24h)];
    case 'flights': {
      const missingActuals = safeGet(`
        SELECT COUNT(*) AS n FROM flights
        WHERE (COALESCE(actual_dep, '') = '' OR COALESCE(actual_arr, '') = '')
          AND status NOT IN ('cancelled', 'diverted')
          AND flight_date >= date(?, '-30 days')
          AND flight_date < ?
      `, [today, today]);
      return [
        tableCountCheck('flights', 'flights'),
        jobHealthCheck('flight_refresh', 'flight refresh', since24h),
        check('completed_flights_have_actuals', missingActuals?.__error ? 'warn' : Number(missingActuals.n || 0) ? 'fail' : 'pass',
          missingActuals?.__error ? `check unavailable (${missingActuals.__error})` : `${Number(missingActuals.n || 0)} completed recent flight(s) missing actual times`),
      ];
    }
    case 'linkedin_content': {
      const recentPost = safeGet('SELECT id FROM linkedin_posts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1', [since7d]);
      const receipted = recentPost?.id
        ? safeGet("SELECT COUNT(*) AS n FROM knowledge_receipts WHERE source_kind = 'linkedin_post' AND source_id = ? AND stage LIKE 'agent:%'", [String(recentPost.id)])
        : null;
      return [
        tableCountCheck('linkedin_posts', 'LinkedIn posts'),
        check('recent_post_has_agent_receipts',
          recentPost?.__error || receipted?.__error ? 'warn' : !recentPost ? 'pass' : Number(receipted?.n || 0) ? 'pass' : 'fail',
          recentPost?.__error || receipted?.__error
            ? `check unavailable (${recentPost?.__error || receipted?.__error})`
            : !recentPost
              ? 'No posts created in last 7 days; nothing to verify'
              : `Latest recent post has ${Number(receipted?.n || 0)} agent receipt(s)`),
      ];
    }
    case 'briefings':
      return [
        pendingJobCheck('briefing_schedule_run', 'briefing scheduler'),
        jobHealthCheck('briefing_schedule_run', 'briefing scheduler', since24h),
        recentCountCheck('nl_briefings', 'created_at', 'newsletter/briefing rows', since14d),
        tableCountCheck('reg_monitor_items', 'regulatory monitor items'),
      ];
    case 'rss_watchlist':
      return [
        pendingJobCheck('watchlist_poll'),
        jobHealthCheck('watchlist_poll', 'watchlist poll', since24h),
        recentCountCheck('rss_articles', 'created_at', 'RSS articles ingested', since7d),
      ];
    case 'wiki':
      return [tableCountCheck('documents', 'documents available for wiki/synthadoc')];
    case 'model_governance': {
      // Agent-level self-check rollup: requestModelObject records every
      // bad-shape model response in request_logs.status, so a degrading model
      // slot surfaces here BEFORE its jobs start crashing. There is no fixer
      // for this — the fix is a model-slot change in /admin/models/system —
      // so remediation escalates it to the Consigliere brief as a config ask.
      let shape;
      try {
        const { modelShapeHealth } = require('./model-request');
        shape = modelShapeHealth({ sinceEpoch: since24h });
      } catch (err) {
        shape = { __error: err.message };
      }
      const shapeCheck = shape.__error
        ? check('model_response_shape_health', 'warn', `check unavailable (${shape.__error})`)
        : check('model_response_shape_health',
            shape.unhealthy.length ? 'fail' : 'pass',
            shape.unhealthy.length
              ? shape.unhealthy.map(u =>
                  `${u.model_key} (${u.model_id}): ${u.shape_failures}/${u.attempts} bad-shape responses (${Math.round(u.failure_rate * 100)}%), ${u.recoveries} rescued by retry — change the model slot in /admin/models/system`,
                ).join('; ')
              : `No model slot over the 10% bad-shape threshold (${shape.watched} slot(s) with enough traffic in 24h)`,
            { unhealthy: shape.unhealthy || [] });
      let loopHealth;
      try {
        loopHealth = require('./work-loop-guard').workLoopHealth(ts);
      } catch (err) {
        loopHealth = { verdict: 'warn', active: [], error: err.message };
      }
      const loopEvidence = loopHealth.error
        ? `check unavailable (${loopHealth.error})`
        : loopHealth.verdict === 'pass'
          ? 'No successful-work loops or subscription queue stalls detected'
          : require('./work-loop-guard').workLoopReportLines(ts).join('; ');
      return [
        tableCountCheck('model_config', 'model config'),
        recentCountCheck('request_logs', 'ts', 'request logs', since7d),
        shapeCheck,
        pendingJobCheck('work_loop_guard', 'work-loop guard'),
        jobHealthCheck('work_loop_guard', 'work-loop guard', since24h),
        check('successful_work_loop', loopHealth.verdict, loopEvidence, loopHealth),
      ];
    }
    case 'system_report': {
      // The nightly report writes this receipt; its absence means the report
      // itself is failing. warn (not fail) so the very first run bootstraps.
      const reportReceipt = safeGet(
        "SELECT COUNT(*) AS n FROM knowledge_receipts WHERE stage = 'agent:daily_consigliere_report' AND created_at >= ?",
        [ts - 26 * 3600],
      );
      return [
        check('daily_report_receipt_recent',
          reportReceipt?.__error ? 'warn' : Number(reportReceipt.n || 0) ? 'pass' : 'warn',
          reportReceipt?.__error
            ? `check unavailable (${reportReceipt.__error})`
            : Number(reportReceipt.n || 0)
              ? 'Daily Consigliere report receipt found in last 26h'
              : 'No Daily Consigliere report receipt in last 26h (first run, or the nightly report is failing)'),
      ];
    }
    case 'infrastructure': {
      const failedJobs = safeGet("SELECT COUNT(*) AS n FROM system_jobs WHERE status = 'failed' AND ran_at >= ?", [since24h]);
      return [
        tableCountCheck('system_jobs', 'system jobs'),
        check('recent_failed_jobs', failedJobs?.__error ? 'warn' : Number(failedJobs.n || 0) ? 'warn' : 'pass',
          failedJobs?.__error ? `check unavailable (${failedJobs.__error})` : `${Number(failedJobs.n || 0)} failed job(s) in last 24h`),
      ];
    }
    default:
      return [check('contract_exists', 'warn', `No health check contract implemented for ${capoKey}`)];
  }
}

function writeCapoReceipt(capo, user = 'douglas', options = {}) {
  const checks = capoChecks(capo.key, user, options);
  const verdict = overall(checks);
  const payload = {
    agent: `capo:${capo.key}`,
    title: capo.title,
    reports_to: capo.reportsTo,
    soldiers: capo.soldiers,
    associates: capo.associates,
    verdict,
    checks,
    run_at: new Date((options.now || now()) * 1000).toISOString(),
  };
  const id = writeAgentReceipt({
    user,
    sourceKind: 'hub_module',
    sourceId: capo.key,
    stage: `agent:capo:${capo.key}`,
    status: verdict,
    summary: `${capo.title}: ${verdict.toUpperCase()} (${checks.filter(c => c.verdict !== 'pass').length} issue(s))`,
    payload,
  });
  return { id, receipt: payload };
}

function latestCapoReceipt(capoKey, user = 'douglas') {
  return safeGet(`
    SELECT *
    FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'hub_module' AND source_id = ? AND stage = ?
    ORDER BY created_at DESC
    LIMIT 1
  `, [user, capoKey, `agent:capo:${capoKey}`]);
}

function writeUnderbossReceipt(underboss, user = 'douglas', options = {}) {
  const reports = underboss.capos.map(key => {
    const capo = capoByKey(key);
    const row = latestCapoReceipt(key, user);
    const status = row?.status || 'missing';
    return {
      capo: key,
      title: capo?.title || key,
      status,
      summary: row?.summary || 'No capo receipt found',
      created_at: row?.created_at || null,
    };
  });
  const missing = reports.filter(r => r.status === 'missing');
  const failing = reports.filter(r => ['fail', 'failed', 'error'].includes(String(r.status).toLowerCase()));
  const warnings = reports.filter(r => String(r.status).toLowerCase() === 'warn');
  const checks = [
    check('all_capos_reported', missing.length ? 'fail' : 'pass', `${missing.length} missing capo receipt(s)`, { missing: missing.map(r => r.capo) }),
    check('capo_failures', failing.length ? 'fail' : 'pass', `${failing.length} failing capo(s)`, { failing: failing.map(r => r.capo) }),
    check('capo_warnings', warnings.length ? 'warn' : 'pass', `${warnings.length} warning capo(s)`, { warnings: warnings.map(r => r.capo) }),
  ];
  const verdict = overall(checks);
  const payload = {
    agent: underboss.key,
    title: underboss.title,
    reports_to: underboss.reportsTo,
    verdict,
    checks,
    reports,
    run_at: new Date((options.now || now()) * 1000).toISOString(),
  };
  const id = writeAgentReceipt({
    user,
    sourceKind: 'hub_underboss',
    sourceId: underboss.key,
    stage: `agent:${underboss.key}`,
    status: verdict,
    summary: `${underboss.title}: ${verdict.toUpperCase()} (${checks.filter(c => c.verdict !== 'pass').length} issue(s))`,
    payload,
  });
  return { id, receipt: payload };
}

function runFamilyAudit(user = 'douglas', options = {}) {
  const capoReceipts = CAPOS.map(capo => writeCapoReceipt(capo, user, options).receipt);
  const underbossReceipts = UNDERBOSSES.map(underboss => writeUnderbossReceipt(underboss, user, options).receipt);
  return { capoReceipts, underbossReceipts };
}

module.exports = {
  capoChecks,
  documentsAwaitingTaskReview,
  runFamilyAudit,
  writeCapoReceipt,
  writeUnderbossReceipt,
};
