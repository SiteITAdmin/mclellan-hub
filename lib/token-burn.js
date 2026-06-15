const fs = require('fs');
const path = require('path');
const db = require('./db');

const DEPLOY_DATA_PATH = path.join(__dirname, '..', 'token-burn-dashboard', 'deploy-data', 'daily-burn.sample.json');
const LOCAL_DATA_PATH = path.join(__dirname, '..', 'token-burn-dashboard', 'data', 'daily-burn.sample.json');
const DEPLOY_OPENROUTER_SUMMARY_PATH = path.join(__dirname, '..', 'token-burn-dashboard', 'deploy-data', 'openrouter-activity.summary.json');
const LOCAL_OPENROUTER_SUMMARY_PATH = path.join(__dirname, '..', 'token-burn-dashboard', 'data', 'openrouter-activity.summary.json');

function readJsonFile(paths, fallback) {
  for (const filePath of paths) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      // Try the next deploy/dev path.
    }
  }
  return fallback;
}

function readImportedRows() {
  const rows = readJsonFile([DEPLOY_DATA_PATH, LOCAL_DATA_PATH], []);
  return Array.isArray(rows) ? rows : [];
}

function readOpenRouterSummary() {
  const summary = readJsonFile(
    [DEPLOY_OPENROUTER_SUMMARY_PATH, LOCAL_OPENROUTER_SUMMARY_PATH],
    { rows: 0, tokens: 0, cost_usd: 0, by_model: [], by_provider: [], by_app: [] },
  );
  summary.by_app = (summary.by_app || []).map(row => ({
    ...row,
    label: row.label === 'unknown' ? 'Legacy-Unattributed' : row.label,
  }));
  return summary;
}

function exactTotal(row) {
  return Number(row.codex_tokens || 0) + Number(row.claude_code_tokens || 0) + Number(row.api_tokens || 0);
}

function hubOpenRouterRows(user) {
  try {
    return db.hub().prepare(`
      SELECT
        date(ts, 'unixepoch', 'localtime') AS date,
        COALESCE(SUM(tokens_in), 0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COUNT(*) AS calls
      FROM request_logs
      WHERE user IN (?, 'system')
        AND status = 'ok'
        AND COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) > 0
      GROUP BY date
      ORDER BY date
    `).all(user);
  } catch (_) {
    return [];
  }
}

function hubOpenRouterTaskRows(user) {
  try {
    return db.hub().prepare(`
      SELECT
        COALESCE(NULLIF(task_code, ''), 'Legacy-Unattributed') AS task_code,
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        ROUND(AVG(duration_ms)) AS avg_duration_ms,
        MAX(ts) AS last_used_at
      FROM request_logs
      WHERE user IN (?, 'system')
        AND status = 'ok'
        AND COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0) > 0
      GROUP BY COALESCE(NULLIF(task_code, ''), 'Legacy-Unattributed')
      ORDER BY COALESCE(SUM(tokens_in), 0) + COALESCE(SUM(tokens_out), 0) DESC
    `).all(user);
  } catch (_) {
    return [];
  }
}

function buildTokenBurnSummary(user) {
  const importedRows = readImportedRows();
  const openRouter = readOpenRouterSummary();
  const liveRows = hubOpenRouterRows(user);
  const liveTasks = hubOpenRouterTaskRows(user);
  const importedExact = importedRows.reduce((sum, row) => sum + exactTotal(row), 0);
  const liveExact = liveRows.reduce((sum, row) => sum + Number(row.tokens_in || 0) + Number(row.tokens_out || 0), 0);
  const last = importedRows[importedRows.length - 1];

  return {
    importedRows,
    liveRows,
    liveTasks,
    firstDate: importedRows[0]?.date || null,
    lastDate: last?.date || null,
    importedExact,
    liveExact,
    codex: importedRows.reduce((sum, row) => sum + Number(row.codex_tokens || 0), 0),
    claudeCode: importedRows.reduce((sum, row) => sum + Number(row.claude_code_tokens || 0), 0),
    api: importedRows.reduce((sum, row) => sum + Number(row.api_tokens || 0), 0),
    liveCost: liveRows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0),
    latestExact: last ? exactTotal(last) : 0,
    openRouter,
  };
}

function buildTokenBurnPage(user) {
  const summary = buildTokenBurnSummary(user);
  const importedDaily = summary.importedRows
    .map(row => ({ ...row, exact_total: exactTotal(row) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const liveDaily = summary.liveRows.map(row => ({
    ...row,
    total: Number(row.tokens_in || 0) + Number(row.tokens_out || 0),
  }));
  const liveTasks = summary.liveTasks.map(row => ({
    ...row,
    total: Number(row.tokens_in || 0) + Number(row.tokens_out || 0),
    task_type: String(row.task_code || '').startsWith('UT-') ? 'user' :
      String(row.task_code || '').startsWith('AT-') ? 'automatic' : 'legacy',
  }));
  const topDays = importedDaily
    .slice()
    .sort((a, b) => b.exact_total - a.exact_total)
    .slice(0, 10);
  const recentDays = importedDaily.slice(-30).reverse();
  const maxDay = Math.max(...importedDaily.map(row => row.exact_total), 1);

  return {
    ...summary,
    importedDaily,
    liveDaily,
    liveTasks,
    topDays,
    recentDays,
    maxDay,
  };
}

function formatTokens(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function heatLevel(value, max) {
  const n = Number(value || 0);
  if (n <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(5, Math.ceil((Math.log10(n + 1) / Math.log10(max + 1)) * 5)));
}

module.exports = {
  buildTokenBurnPage,
  buildTokenBurnSummary,
  formatTokens,
  formatUsd,
  heatLevel,
};
