const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(APP_ROOT, 'data');
const REPORT_PATH = process.env.MODEL_GOVERNANCE_REPORT_PATH || path.join(DATA_ROOT, 'model-governance-review.json');
const MARKDOWN_PATH = process.env.MODEL_GOVERNANCE_MARKDOWN_PATH || path.join(DATA_ROOT, 'model-governance-review.md');
const CATALOG_PATH = process.env.MODEL_GOVERNANCE_CATALOG_PATH || path.join(DATA_ROOT, 'openrouter-model-catalogue.json');
const LOCK_PATH = process.env.MODEL_GOVERNANCE_LOCK_PATH || path.join(DATA_ROOT, '.model-governance-review.lock');
const HUB_DB_PATH = process.env.HUB_DB_PATH || path.join(DATA_ROOT, 'hub.db');
const PYTHON = process.env.MODEL_GOVERNANCE_PYTHON || 'python3';
const SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'prompt-model-review.py');

let activeRun = null;

function readGovernanceReport() {
  try {
    const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    return { report, error: null, path: REPORT_PATH };
  } catch (err) {
    if (err.code === 'ENOENT') return { report: null, error: null, path: REPORT_PATH };
    return { report: null, error: err.message, path: REPORT_PATH };
  }
}

function lastRunAt(report) {
  const value = report?.generated_at;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isWeeklyReviewDue(now, report) {
  if (now.getDay() !== 0 || now.getHours() !== 4 || now.getMinutes() !== 15) return false;
  const lastRun = lastRunAt(report);
  return !lastRun || (now.getTime() - lastRun.getTime()) >= 6 * 24 * 60 * 60 * 1000;
}

function runGovernanceReview({ reason = 'manual' } = {}) {
  if (activeRun) return activeRun;
  const safeReason = String(reason).replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'manual';
  const args = [
    SCRIPT_PATH,
    'weekly',
    '--repo', APP_ROOT,
    '--hub-db', HUB_DB_PATH,
    '--write-root', APP_ROOT,
    '--save-catalog', CATALOG_PATH,
    '--output', REPORT_PATH,
    '--markdown', MARKDOWN_PATH,
    '--lock-file', LOCK_PATH,
    '--reason', safeReason,
  ];
  activeRun = new Promise((resolve, reject) => {
    execFile(PYTHON, args, {
      cwd: APP_ROOT,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().slice(0, 1200);
        const wrapped = new Error(detail || 'Prompt/model governance review failed');
        wrapped.cause = err;
        reject(wrapped);
        return;
      }
      const finalLine = String(stdout).trim().split('\n').filter(Boolean).pop() || '{}';
      try {
        resolve(JSON.parse(finalLine));
      } catch (_) {
        resolve({ ok: true, output: REPORT_PATH });
      }
    });
  }).finally(() => {
    activeRun = null;
  });
  return activeRun;
}

module.exports = {
  REPORT_PATH,
  readGovernanceReport,
  isWeeklyReviewDue,
  runGovernanceReview,
};
