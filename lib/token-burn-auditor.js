'use strict';

const { buildTokenBurnSummary } = require('./token-burn');
const { writeAgentReceipt } = require('./agent-receipts');

const STAGE = 'agent:token_burn_auditor';
const SOURCE_KIND = 'token_burn';
const SOURCE_ID = 'dashboard';
const FRESH_DAYS = 3;

function exactTotal(row) {
  return Number(row.codex_tokens || 0) +
    Number(row.claude_code_tokens || 0) +
    Number(row.antigravity_tokens || 0) +
    Number(row.api_tokens || 0);
}

function localDateDaysOld(dateValue, nowMs = Date.now()) {
  const date = String(dateValue || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((nowMs - then) / 86400000));
}

function timestampDaysOld(value, nowMs = Date.now()) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 86400000));
}

function check(name, verdict, evidence, details = {}) {
  return { name, verdict, evidence, details };
}

function overallVerdict(checks) {
  if (checks.some(c => c.verdict === 'fail')) return 'fail';
  if (checks.some(c => c.verdict === 'warn')) return 'warn';
  return 'pass';
}

function buildTokenBurnAudit(user = 'douglas', summary = buildTokenBurnSummary(user), nowMs = Date.now()) {
  const importedRows = Array.isArray(summary.importedRows) ? summary.importedRows : [];
  const checks = [];

  checks.push(check(
    'daily_rows_present',
    importedRows.length ? 'pass' : 'fail',
    importedRows.length ? `${importedRows.length} imported daily row(s)` : 'No imported daily burn rows found',
  ));

  const invalidRows = importedRows.filter(row => {
    const values = ['codex_tokens', 'claude_code_tokens', 'antigravity_tokens', 'api_tokens']
      .map(key => Number(row[key] || 0));
    return !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')) ||
      values.some(value => !Number.isFinite(value) || value < 0);
  });
  checks.push(check(
    'daily_rows_valid',
    invalidRows.length ? 'fail' : 'pass',
    invalidRows.length ? `${invalidRows.length} invalid row(s)` : 'All imported rows have valid dates and non-negative numeric lanes',
    { invalid_dates: invalidRows.slice(0, 5).map(row => row.date) },
  ));

  const recomputedImported = importedRows.reduce((sum, row) => sum + exactTotal(row), 0);
  checks.push(check(
    'component_totals_reconcile',
    recomputedImported === Number(summary.importedExact || 0) ? 'pass' : 'fail',
    `components=${recomputedImported}; summary=${Number(summary.importedExact || 0)}`,
    { recomputed: recomputedImported, summary: Number(summary.importedExact || 0) },
  ));

  const latestAge = localDateDaysOld(summary.lastDate, nowMs);
  checks.push(check(
    'latest_import_fresh',
    latestAge == null ? 'fail' : latestAge > FRESH_DAYS ? 'fail' : 'pass',
    latestAge == null ? 'No latest imported date' : `latest=${summary.lastDate}; age=${latestAge} day(s)`,
    { last_date: summary.lastDate, age_days: latestAge, threshold_days: FRESH_DAYS },
  ));

  const liveAge = timestampDaysOld(summary.openRouterLive?.fetched_at, nowMs);
  const liveManagementFresh = summary.openRouterLive?.source === 'openrouter_management_api' &&
    Number(summary.openRouterLive?.tokens || 0) > 0 &&
    liveAge != null &&
    liveAge <= FRESH_DAYS;
  const exportAge = summary.openRouterExportAgeDays;
  checks.push(check(
    'openrouter_activity_source_fresh',
    liveManagementFresh ? 'pass' : exportAge == null ? 'warn' : exportAge > FRESH_DAYS ? 'fail' : 'pass',
    liveManagementFresh
      ? `live management API fetched at ${summary.openRouterLive.fetched_at}; legacy export age=${exportAge ?? 'unknown'} day(s)`
      : exportAge == null ? 'No OpenRouter export timestamp and no fresh live management API summary' : `export_last_at=${summary.openRouter?.export_last_at}; age=${exportAge} day(s)`,
    {
      live_source: summary.openRouterLive?.source || null,
      live_fetched_at: summary.openRouterLive?.fetched_at || null,
      live_age_days: liveAge,
      export_last_at: summary.openRouter?.export_last_at || null,
      export_age_days: exportAge,
      threshold_days: FRESH_DAYS,
    },
  ));

  checks.push(check(
    'openrouter_live_summary_visible',
    summary.openRouterLive?.fetched_at ? (liveAge != null && liveAge > FRESH_DAYS ? 'warn' : 'pass') : 'warn',
    summary.openRouterLive?.fetched_at
      ? `live fetched at ${summary.openRouterLive.fetched_at}${liveAge == null ? '' : ` (${liveAge} day(s) old)`}`
      : 'No live OpenRouter summary timestamp',
    { fetched_at: summary.openRouterLive?.fetched_at || null, age_days: liveAge },
  ));

  checks.push(check(
    'hub_request_logs_visible',
    Number(summary.liveExact || 0) > 0 ? 'pass' : 'warn',
    Number(summary.liveExact || 0) > 0
      ? `${Number(summary.liveExact || 0)} live Hub token(s) in request_logs`
      : 'No live Hub request log tokens visible for this user/system window',
    { live_exact: Number(summary.liveExact || 0), live_rows: Array.isArray(summary.liveRows) ? summary.liveRows.length : 0 },
  ));

  const verdict = overallVerdict(checks);
  return {
    agent: 'token_burn_auditor',
    source_kind: SOURCE_KIND,
    source_id: SOURCE_ID,
    user,
    run_at: new Date(nowMs).toISOString(),
    verdict,
    summary: {
      first_date: summary.firstDate || null,
      last_date: summary.lastDate || null,
      imported_tokens: Number(summary.importedExact || 0),
      live_tokens: Number(summary.liveExact || 0),
      live_cost_usd: Number(summary.liveCost || 0),
      openrouter_export_last_at: summary.openRouter?.export_last_at || null,
      openrouter_live_fetched_at: summary.openRouterLive?.fetched_at || null,
    },
    checks,
    retry_or_appeal: verdict === 'pass'
      ? 'No action needed.'
      : 'Refresh token burn data, inspect OpenRouter export/live summaries, then rerun the auditor. If a check is stale because the source is intentionally unavailable, record the exception in the receipt.',
  };
}

function writeTokenBurnAudit(user = 'douglas', options = {}) {
  const audit = buildTokenBurnAudit(user, options.summary, options.nowMs);
  const id = writeAgentReceipt({
    user,
    sourceKind: SOURCE_KIND,
    sourceId: SOURCE_ID,
    stage: STAGE,
    status: audit.verdict,
    summary: `Token Burn Auditor: ${audit.verdict.toUpperCase()} (${audit.checks.filter(c => c.verdict !== 'pass').length} issue(s))`,
    payload: audit,
  });
  return { id, audit };
}

module.exports = {
  STAGE,
  buildTokenBurnAudit,
  writeTokenBurnAudit,
};
