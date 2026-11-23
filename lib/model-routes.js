'use strict';

// Which model does each AI function, with two stand-ins (asked for 20 Nov 2026).
// The chosen lanes travel inside every queued job, so a change on /models reaches
// the Mac's hand-copied worker without copying a new registry to it.

const db = require('./db');

// `can` limits what each model may be given: PDF pages and screenshots reach
// ChatGPT and Grok as a rendered picture; web search runs only where the CLI has
// a web tool the Hub turns on.
const MODELS = Object.freeze({
  'claude-opus': { label: 'Claude Opus', runner: 'claude', model: 'opus', can: ['text', 'pdf', 'image', 'web'] },
  'claude-sonnet': { label: 'Claude Sonnet', runner: 'claude', model: 'sonnet', can: ['text', 'pdf', 'image', 'web'] },
  'claude-haiku': { label: 'Claude Haiku', runner: 'claude', model: 'haiku', can: ['text', 'pdf', 'image', 'web'] },
  chatgpt: { label: 'ChatGPT', runner: 'codex', model: 'gpt-5.6-luna', effort: 'high', can: ['text', 'pdf', 'image'] },
  grok: { label: 'Grok', runner: 'grok', model: 'grok-4.7', effort: 'high', can: ['text', 'pdf', 'image', 'web'] },
  'gemini-neon': { label: 'Gemini Neon', runner: 'antigravity', model: 'gemini-4-neon', can: ['text'] },
});

const RUNNER_NAMES = Object.freeze({ claude: 'Claude', codex: 'ChatGPT', grok: 'Grok', antigravity: 'Antigravity' });

const STANDINS = ['chatgpt', 'grok'];
const WEB_STANDINS = ['grok', null];

// match(feature, meta) picks the function out of the job each module already queues.
const FUNCTIONS = Object.freeze([
  { fn: 'read_source', group: 'CRM', label: 'Reading what comes in', what: 'Mail, messages, notes and transcripts turned into facts, promises and tasks',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.sourceId },
  { fn: 'task_help', group: 'CRM', label: 'Task help', what: 'What the Hub holds, what is really going on, steps and drafts for each open task',
    effort: 'medium', lanes: ['claude-opus', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.taskHelp },
  { fn: 'job_help', group: 'CRM', label: 'Jobs', what: 'One reading per job: outcome, goal, order and missing steps',
    effort: 'medium', lanes: ['claude-opus', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.jobHelp },
  { fn: 'followups', group: 'CRM', label: 'Follow-ups', what: 'Suggested next moves after a task is finished',
    effort: 'medium', lanes: ['claude-opus', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.followups },
  { fn: 'task_length', group: 'CRM', label: 'Task lengths', what: 'How long each task should take, for the calendar',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.taskLength },
  { fn: 'promise_check', group: 'CRM', label: 'Promise checks', what: 'Reads later mail to see whether a promise was kept',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.promise },
  { fn: 'promise_sort', group: 'CRM', label: 'Sorting older promises', what: 'Decides which older facts are promises',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.batch },
  { fn: 'project_check', group: 'CRM', label: 'Project check', what: 'Re-checks facts filed before a project was described',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.projectCheck },
  { fn: 'standings', group: 'CRM', label: 'Where things stand', what: 'The summary on each person, project and organisation',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.standing },
  { fn: 'connections', group: 'CRM', label: 'Relationships', what: 'Weekly reading of who is connected to whom',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.connections },
  { fn: 'meeting_prep', group: 'CRM', label: 'Meeting prep', what: 'Cited prep for today’s meetings',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.meeting },
  { fn: 'ask', group: 'CRM', label: 'Search answers', what: 'Source-cited answers on Search and in your own WhatsApp chat',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_atomise' && m.ask },
  { fn: 'digest', group: 'Writing', label: 'Morning email', what: 'The daily and Friday weekly briefing emails',
    effort: 'high', lanes: ['claude-opus', ...STANDINS], match: (f, m) => f === 'crm_report' && m.digest },
  { fn: 'report', group: 'Writing', label: 'Reports', what: 'Weekly, monthly, quarterly and topic reports',
    effort: 'high', lanes: ['claude-opus', ...STANDINS], match: (f, m) => f === 'crm_report' && !m.digest },
  { fn: 'money_challenge', group: 'Writing', label: 'Weekly money challenge', what: 'The challenge written from your spending numbers',
    effort: 'high', lanes: ['claude-opus', ...STANDINS], match: f => f === 'crm_money_challenge' },
  { fn: 'site_chat', group: 'Writing', label: 'Site chat and JD analyser', what: 'Answers on the public sites and in the site editor',
    effort: 'high', lanes: ['claude-sonnet', ...STANDINS], match: f => f === 'chat' || f === 'hub_chat' },
  { fn: 'briefing_themes', group: 'Work briefing', label: 'Briefing themes', what: 'Names public themes from your work, privately',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: f => f === 'crm_briefing_themes' },
  { fn: 'briefing_search', group: 'Work briefing', label: 'Briefing news search', what: 'Searches the web for news on those themes', needs: ['web'],
    effort: 'medium', lanes: ['claude-sonnet', ...WEB_STANDINS], match: f => f === 'crm_briefing_search' },
  { fn: 'money_read', group: 'Money and house', label: 'Bank screenshots and statements', what: 'Reads banking screenshots, PDF pages and CSV runs', needs: ['pdf', 'image'],
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: f => f === 'crm_money_read' },
  { fn: 'money_orders', group: 'Money and house', label: 'Orders from email', what: 'Shop, total and items from receipts and order confirmations',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_money_mail' && m.moneyOrders },
  { fn: 'money_mail', group: 'Money and house', label: 'Subscriptions and offers', what: 'Subscriptions and retailer offers found in mail',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: (f, m) => f === 'crm_money_mail' && !m.moneyOrders },
  { fn: 'money_deals', group: 'Money and house', label: 'Discount codes', what: 'Weekly web search for codes for shops you use', needs: ['web'],
    effort: 'medium', lanes: ['claude-sonnet', ...WEB_STANDINS], match: f => f === 'crm_money_deals' },
  { fn: 'house_mail', group: 'Money and house', label: 'House-hunting mail', what: 'Daft alerts, solicitors and viewings read one email at a time',
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: f => f === 'crm_house_mail' },
  { fn: 'house_photos', group: 'Money and house', label: 'House listing photos', what: 'Checks Daft listing photos for heating (gas boiler, wet radiators), full bathrooms vs WC, and visible condition', needs: ['image'],
    effort: 'medium', lanes: ['claude-sonnet', ...STANDINS], match: f => f === 'crm_house_photos' },
]);

const BY_FN = Object.freeze(Object.fromEntries(FUNCTIONS.map(f => [f.fn, f])));

function capable(def, key) {
  const m = MODELS[key];
  return !!m && (def.needs || ['text']).every(n => m.can.includes(n));
}

function choices(fn) {
  const def = BY_FN[fn];
  return def ? Object.keys(MODELS).filter(k => capable(def, k)) : [];
}

// Lane 1 is required; empty later lanes are allowed; a model appears once.
function clean(def, keys) {
  const out = [];
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 3)) {
    if (!k) break;
    if (!capable(def, k) || out.includes(k)) return null;
    out.push(k);
  }
  return out.length ? out : null;
}

function stored(fn) {
  const row = db.hub().prepare('SELECT lanes FROM model_routes WHERE fn = ?').get(fn);
  if (!row) return null;
  try { return JSON.parse(row.lanes); } catch { return null; }
}

function laneKeys(fn) {
  const def = BY_FN[fn];
  if (!def) return [];
  return clean(def, stored(fn)) || def.lanes.filter(Boolean);
}

function functionFor(feature, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return FUNCTIONS.find(def => def.match(String(feature || ''), m)) || null;
}

function lane(def, key) {
  const m = MODELS[key];
  return { key, runner: m.runner, model: m.model, effort: m.effort || def.effort };
}

// Null when the job is not one of the functions on the page; it then runs as before.
function forJob(feature, payload) {
  const def = functionFor(feature, payload?.meta);
  if (!def) return null;
  return { fn: def.fn, lanes: laneKeys(def.fn).map(k => lane(def, k)) };
}

function save(fn, keys, t = Math.floor(Date.now() / 1000)) {
  const def = BY_FN[fn];
  if (!def) throw new Error(`Unknown function: ${fn}`);
  const lanes = clean(def, keys);
  if (!lanes) throw new Error(`${def.label}: choose a main model, use each model once, and only models that can do this job`);
  const same = lanes.length === def.lanes.filter(Boolean).length && lanes.every((k, i) => k === def.lanes[i]);
  if (same) db.hub().prepare('DELETE FROM model_routes WHERE fn = ?').run(fn);
  else db.hub().prepare('INSERT INTO model_routes(fn, lanes, updated_at) VALUES(?, ?, ?) ON CONFLICT(fn) DO UPDATE SET lanes = excluded.lanes, updated_at = excluded.updated_at')
    .run(fn, JSON.stringify(lanes), t);
  return lanes;
}

function seen(workerId, available, t = Math.floor(Date.now() / 1000)) {
  if (!available || typeof available !== 'object') return;
  const clean = Object.fromEntries(Object.keys(RUNNER_NAMES).map(r => [r, available[r] === true]));
  db.hub().prepare('INSERT INTO model_workers(id, seen_at, available) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen_at = excluded.seen_at, available = excluded.available')
    .run(String(workerId).slice(0, 80), t, JSON.stringify(clean));
}

function machineName(id) {
  const s = String(id || '');
  if (s.startsWith('mac')) return 'Mac mini';
  if (s.startsWith('dev-server')) return 'Dev server';
  return s || 'Unknown';
}

function workers(t = Math.floor(Date.now() / 1000)) {
  return db.hub().prepare('SELECT * FROM model_workers WHERE seen_at > ? ORDER BY id').all(t - 7 * 86400).map(w => {
    let available = {};
    try { available = JSON.parse(w.available || '{}'); } catch {}
    return { id: w.id, machine: machineName(w.id), seenAt: w.seen_at, live: w.seen_at > t - 300, available };
  });
}

function modelLabel(runner, model) {
  const hit = Object.values(MODELS).find(m => m.runner === runner && m.model === model);
  return hit ? hit.label : [RUNNER_NAMES[runner] || runner, model].filter(Boolean).join(' ');
}

// What actually ran in the last 7 days, read from the job receipts. Older jobs
// carry no `fn`, so their function is worked out from feature and meta as on enqueue.
function activity(t = Math.floor(Date.now() / 1000), days = 7) {
  const rows = db.hub().prepare(`SELECT feature, status, claimed_by, json_extract(payload, '$.fn') fn, json_extract(payload, '$.meta') meta,
    json_extract(result_json, '$.meta.runner') runner, json_extract(result_json, '$.meta.model') model,
    json_extract(result_json, '$.meta.fallbackFrom') fallback_from
    FROM subscription_agent_jobs WHERE created_at > ?`).all(t - days * 86400);
  const out = {};
  for (const r of rows) {
    let meta = {};
    try { meta = JSON.parse(r.meta || '{}') || {}; } catch {}
    const fn = r.fn || functionFor(r.feature, meta)?.fn;
    if (!fn) continue;
    const a = out[fn] ||= { runs: 0, done: 0, failed: 0, waiting: 0, standIn: 0, models: {}, machines: {} };
    a.runs++;
    if (r.status === 'completed') {
      a.done++;
      if (r.fallback_from) a.standIn++;
      const label = modelLabel(r.runner, r.model);
      a.models[label] = (a.models[label] || 0) + 1;
      const machine = machineName(r.claimed_by);
      a.machines[machine] = (a.machines[machine] || 0) + 1;
    } else if (r.status === 'failed') a.failed++;
    else a.waiting++;
  }
  return out;
}

module.exports = { MODELS, FUNCTIONS, RUNNER_NAMES, choices, laneKeys, forJob, functionFor, save, seen, workers, activity, modelLabel, machineName };
