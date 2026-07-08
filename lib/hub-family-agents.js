'use strict';

const db = require('./db');
const { CAPOS, UNDERBOSSES, capoByKey } = require('./hub-agent-roster');
const { writeAgentReceipt } = require('./agent-receipts');
const { buildTokenBurnAudit } = require('./token-burn-auditor');

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

function recentCount(table, column, sinceEpoch) {
  return safeGet(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} >= ?`, [sinceEpoch]);
}

function recentCountCheck(table, column, label, sinceEpoch, minimum = 1) {
  const row = recentCount(table, column, sinceEpoch);
  if (row?.__error) return check(`${table}_recent`, 'warn', `${label}: check unavailable (${row.__error})`);
  return check(`${table}_recent`, Number(row.n || 0) >= minimum ? 'pass' : 'warn', `${label}: ${Number(row.n || 0)} recent row(s)`);
}

function capoChecks(capoKey, user = 'douglas', options = {}) {
  const ts = options.now || now();
  const since24h = ts - 86400;
  const since7d = ts - 7 * 86400;
  const today = new Date(ts * 1000).toISOString().slice(0, 10);

  switch (capoKey) {
    case 'email':
      return [pendingJobCheck('email_process'), recentCountCheck('email_summaries', 'received_at', 'email summaries', since7d)];
    case 'agentmail':
      return [pendingJobCheck('agentmail_process'), recentCountCheck('inbound_email_records', 'received_at', 'AgentMail records', since7d)];
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
      return [tableCountCheck('google_tasks', 'Google Tasks mirror', 0), pendingJobCheck('task_route_run', 'task router')];
    case 'documents_projects': {
      const untasked = safeGet(`
        SELECT COUNT(*) AS n FROM documents d
        WHERE d.uploaded_at >= ?
          AND COALESCE(d.mimetype, '') NOT LIKE 'image/%'
          AND NOT EXISTS (
            SELECT 1 FROM google_tasks t
            WHERE t.source = 'document' AND t.source_id LIKE 'doc:' || d.id || ':%'
          )
      `, [since7d]);
      return [
        tableCountCheck('documents', 'documents', 0),
        check('recent_documents_have_task_review', untasked?.__error ? 'warn' : Number(untasked.n || 0) ? 'warn' : 'pass',
          untasked?.__error ? `check unavailable (${untasked.__error})` : `${Number(untasked.n || 0)} recent non-image document(s) without extracted tasks`),
      ];
    }
    case 'knowledge':
      return [
        tableCountCheck('knowledge_atoms', 'knowledge atoms'),
        recentCountCheck('knowledge_receipts', 'created_at', 'knowledge receipts', since7d),
      ];
    case 'mycelium':
      return [pendingJobCheck('mycelium_run')];
    case 'reminders':
      return [pendingJobCheck('reminder_sweep'), tableCountCheck('reminders', 'reminders', 0)];
    case 'flights': {
      const missingActuals = safeGet(`
        SELECT COUNT(*) AS n FROM flights
        WHERE (COALESCE(actual_dep, '') = '' OR COALESCE(actual_arr, '') = '')
          AND status NOT IN ('cancelled', 'diverted')
          AND flight_date >= date(?, '-30 days')
          AND flight_date < ?
      `, [today, today]);
      return [
        tableCountCheck('flights', 'flights', 0),
        check('completed_flights_have_actuals', missingActuals?.__error ? 'warn' : Number(missingActuals.n || 0) ? 'fail' : 'pass',
          missingActuals?.__error ? `check unavailable (${missingActuals.__error})` : `${Number(missingActuals.n || 0)} completed recent flight(s) missing actual times`),
      ];
    }
    case 'linkedin_content':
      return [tableCountCheck('linkedin_posts', 'LinkedIn posts', 0), recentCountCheck('knowledge_receipts', 'created_at', 'LinkedIn agent receipts', since7d, 0)];
    case 'briefings':
      return [tableCountCheck('nl_briefings', 'newsletter/briefing rows', 0), tableCountCheck('reg_monitor_items', 'regulatory monitor items', 0)];
    case 'rss_watchlist':
      return [pendingJobCheck('watchlist_poll'), tableCountCheck('rss_articles', 'RSS articles', 0)];
    case 'wiki':
      return [tableCountCheck('documents', 'documents available for wiki/synthadoc', 0)];
    case 'model_governance':
      return [tableCountCheck('model_config', 'model config'), recentCountCheck('request_logs', 'ts', 'request logs', since7d)];
    case 'token_burn': {
      const audit = buildTokenBurnAudit(user, undefined, ts * 1000);
      return audit.checks.map(c => check(c.name, c.verdict, c.evidence, c.details));
    }
    case 'system_report':
      return [recentCountCheck('knowledge_receipts', 'created_at', 'agent/system receipts', since7d, 0)];
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
  runFamilyAudit,
  writeCapoReceipt,
  writeUnderbossReceipt,
};

