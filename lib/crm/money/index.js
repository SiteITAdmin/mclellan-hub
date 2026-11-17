'use strict';

// Personal money, as one tool made of eight small modules. Each module owns its
// own tables (SCHEMA), its own routes (mount) and its own part of the 1-minute
// `crm_money_tick` (tick). A module that throws is recorded under its own
// name in job_runs and shown on the Money screen; it never stops the others.

const MODULES = ['ledger', 'receipts', 'subscriptions', 'offers', 'deals', 'prices', 'budget', 'insights'];
const load = name => require(`./${name}`);

function schema(db) {
  for (const name of MODULES) { const m = load(name); if (m.SCHEMA) db.exec(m.SCHEMA); if (m.migrate) m.migrate(db); }
}

function mount(router, helpers) {
  for (const name of MODULES) { const m = load(name); if (m.mount) m.mount(router, helpers); }
}

async function tick() {
  const runs = require('../runs');
  const failures = [];
  for (const name of MODULES) {
    const m = load(name);
    if (!m.tick) continue;
    try { await runs.track(`money_${name}`, () => m.tick()); }
    catch (err) { failures.push(`${name}: ${String(err.message || err).slice(0, 200)}`); }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

// What is silently wrong, in words, for the top of the Money screen (CLAUDE.md rule 5).
function problems() {
  const runs = require('../runs').all(), out = [];
  for (const name of MODULES) {
    const r = runs[`money_${name}`];
    if (r?.last_error && (!r.last_ok || r.last_error_at >= r.last_ok)) out.push({ module: name, text: r.last_error });
    const m = load(name);
    if (m.problems) out.push(...m.problems());
  }
  return out;
}

// Small cards for the Overview: each module may export summary() -> { title, lines: [string], href } | null.
function summaries() {
  const out = [];
  for (const name of MODULES) {
    const m = load(name);
    if (!m.summary) continue;
    try { const s = m.summary(); if (s) out.push({ module: name, ...s }); } catch (err) { out.push({ module: name, title: name, lines: [`Could not summarise: ${String(err.message).slice(0, 120)}`], error: true }); }
  }
  return out;
}

module.exports = { MODULES, schema, mount, tick, problems, summaries };
