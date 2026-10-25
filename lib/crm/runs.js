'use strict';

// Records the last outcome of each CRM job so the Today screens can say when
// something failed or stopped (CLAUDE.md rule 5).

const { crm, now } = require('./db');

async function track(name, fn) {
  crm().prepare(`
    INSERT INTO job_runs (name, last_started) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET last_started = excluded.last_started
  `).run(name, now());
  try {
    const detail = await fn();
    crm().prepare("UPDATE job_runs SET last_ok = ?, last_error = '', detail = ? WHERE name = ?")
      .run(now(), JSON.stringify(detail || {}), name);
    return detail;
  } catch (err) {
    crm().prepare('UPDATE job_runs SET last_error = ?, last_error_at = ? WHERE name = ?')
      .run(String(err.message || err).slice(0, 500), now(), name);
    throw err;
  }
}

function all() {
  const rows = crm().prepare('SELECT * FROM job_runs').all();
  return Object.fromEntries(rows.map(r => [r.name, { ...r, detail: safe(r.detail) }]));
}

function safe(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { track, all };
