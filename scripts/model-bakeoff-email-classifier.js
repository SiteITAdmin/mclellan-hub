#!/usr/bin/env node
'use strict';

// Report-only model bake-off for the Luna-tier email classifier.
//
// Runs the exact production classifier prompt for recent real emails through
// several candidate subscription lanes and writes a side-by-side report with
// token usage. It never writes to the Hub DB, never creates tasks, and never
// re-queues anything: run it against a production diagnostic snapshot.
//
//   source "<snapshot>/env.sh"
//   node scripts/model-bakeoff-email-classifier.js --limit 40 --out /tmp/bakeoff.json
//
// Lanes default to the incumbent (Codex gpt-5.6-luna low) plus the challengers
// under evaluation in Oct 2026. Override with --lanes runner:model:effort,...

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

if (!process.env.HUB_DB_PATH) {
  console.error('HUB_DB_PATH is not set — source a prod snapshot env.sh first. Refusing to run against the live DB.');
  process.exit(2);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const LIMIT = Number(arg('limit', 40));
const OUT = arg('out', path.join(require('os').tmpdir(), `email-classifier-bakeoff-${Date.now()}.json`));
const LANES = arg('lanes', 'codex:gpt-5.6-luna:low,codex:gpt-6-luna:low,claude:haiku:low')
  .split(',')
  .map(s => { const [runner, model, effort] = s.split(':'); return { runner, model, effort, id: `${runner}/${model}@${effort}` }; });

// Capture the prompt classifyEmail builds instead of sending it anywhere.
const modelRequestPath = require.resolve('../lib/model-request');
const realModelRequest = require(modelRequestPath);
let captured = null;
require.cache[modelRequestPath].exports = {
  ...realModelRequest,
  requestModelObject: async ({ messages, defaults }) => {
    captured = messages;
    return { ...defaults };
  },
};

const db = require('../lib/db');
const { classifyEmail } = require('../lib/email-processor');
const { getEnabledEmailLabels } = require('../lib/email-taxonomy');
const { commandFor } = require('../lib/subscription-agent');
const { parseModelObject } = require('../lib/model-response');

const JSON_CONTRACT = 'Return one valid JSON object only. No markdown fences, no prose outside the object.';

function runCli(lane, systemPrompt, userPrompt) {
  const config = { runner: lane.runner, model: lane.model, effort: lane.effort, allowTools: false };
  const cmd = commandFor(config, systemPrompt);
  let args = cmd.args;
  let input = userPrompt;
  if (lane.runner === 'codex') {
    // Codex has no system-prompt flag; the Hub folds both into stdin the same way.
    args = [...args.slice(0, -1), '--json', '-'];
    input = `${systemPrompt}\n\n${userPrompt}`;
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd.command, args, { cwd: path.join(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(input);
  });
}

function parseLaneOutput(lane, raw) {
  if (lane.runner === 'claude') {
    const parsed = JSON.parse(raw.stdout);
    const u = parsed.usage || {};
    return {
      text: String(parsed.result || ''),
      usage: {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      },
      stopReason: parsed.stop_reason || parsed.subtype || null,
    };
  }
  let text = '';
  let usage = { input: 0, output: 0 };
  for (const line of raw.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text;
    if (ev.type === 'turn.completed' && ev.usage) {
      usage = { input: ev.usage.input_tokens || 0, output: (ev.usage.output_tokens || 0) + (ev.usage.reasoning_output_tokens || 0) };
    }
  }
  return { text, usage, stopReason: null };
}

function norm(v) {
  return v == null || v === '' ? null : String(v).trim().toLowerCase();
}

async function main() {
  const hub = db.hub();
  const user = 'douglas';
  const contacts = hub.prepare('SELECT id, name, email, phone, aliases FROM contacts WHERE user = ?').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  const emailLabels = getEnabledEmailLabels(user);
  const contactById = new Map(contacts.map(c => [c.id, c]));

  const rows = hub.prepare(`
    SELECT id, gmail_message_id, subject, from_name, from_email, body_text, summary,
           project_slug, contact_id, gmail_label, received_at
    FROM email_summaries
    WHERE user = ? AND direction = 'received' AND ingestion_status = 'processed'
      AND body_text IS NOT NULL AND length(body_text) > 40
      AND (project_slug IS NULL OR project_slug NOT LIKE '\\_\\_%' ESCAPE '\\')
    ORDER BY received_at DESC
    LIMIT ?
  `).all(user, LIMIT);

  console.log(`Bake-off: ${rows.length} emails × ${LANES.length} lanes → ${OUT}`);
  const results = [];
  const totals = Object.fromEntries(LANES.map(l => [l.id, { calls: 0, ok: 0, failed: 0, input: 0, output: 0, ms: 0 }]));

  for (const [i, row] of rows.entries()) {
    const known = row.contact_id ? contactById.get(row.contact_id) : null;
    const identity = known ? { contact: known, matchedBy: ['stored contact_id'] } : null;
    captured = null;
    await classifyEmail({
      id: row.gmail_message_id,
      fromName: row.from_name || '',
      fromEmail: row.from_email || '',
      subject: row.subject || '',
      bodyText: row.body_text || '',
    }, contacts, projects, emailLabels, user, 'email', identity);
    const userPrompt = `User: ${captured[0].content}`;

    const entry = {
      email: { id: row.id, subject: row.subject, from: `${row.from_name} <${row.from_email}>` },
      stored: { contact: known?.name || null, project_slug: row.project_slug, gmail_label: row.gmail_label, summary: row.summary },
      lanes: {},
    };
    for (const lane of LANES) {
      const t = totals[lane.id];
      t.calls++;
      const raw = await runCli(lane, JSON_CONTRACT, userPrompt);
      try {
        const out = parseLaneOutput(lane, raw);
        const obj = parseModelObject(out.text, {}, lane.id);
        entry.lanes[lane.id] = { ...obj, _usage: out.usage, _ms: raw.ms };
        t.ok++; t.input += out.usage.input; t.output += out.usage.output; t.ms += raw.ms;
      } catch (err) {
        entry.lanes[lane.id] = { _error: `${err.message} | ${(raw.stderr || raw.stdout).slice(0, 300)}`, _ms: raw.ms };
        t.failed++;
      }
    }
    results.push(entry);
    const brief = LANES.map(l => {
      const r = entry.lanes[l.id];
      return r._error ? `${l.model}:ERR` : `${l.model}:${r.project_slug || '-'}/${r.move_label || '-'}${r.action_task ? '/task' : ''}`;
    }).join('  ');
    console.log(`[${i + 1}/${rows.length}] ${String(row.subject || '').slice(0, 50).padEnd(50)} ${brief}`);
    fs.writeFileSync(OUT, JSON.stringify({ lanes: LANES, totals, results }, null, 2));
  }

  // Agreement with the incumbent lane on the routing fields that drive behaviour.
  const base = LANES[0].id;
  const fields = ['contact_name', 'project_slug', 'move_label', 'action_task'];
  const agreement = {};
  for (const lane of LANES.slice(1)) {
    agreement[lane.id] = {};
    for (const f of fields) {
      let same = 0; let n = 0;
      for (const r of results) {
        const a = r.lanes[base]; const b = r.lanes[lane.id];
        if (!a || !b || a._error || b._error) continue;
        n++;
        const va = f === 'action_task' ? Boolean(a[f]) : norm(a[f]);
        const vb = f === 'action_task' ? Boolean(b[f]) : norm(b[f]);
        if (va === vb) same++;
      }
      agreement[lane.id][f] = n ? `${same}/${n}` : 'n/a';
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ lanes: LANES, totals, agreement, results }, null, 2));

  console.log('\nTotals (tokens include each CLI\'s own harness overhead):');
  for (const [id, t] of Object.entries(totals)) {
    const per = t.ok ? `avg in ${Math.round(t.input / t.ok)} / out ${Math.round(t.output / t.ok)} tok, ${Math.round(t.ms / t.ok / 1000)}s` : '';
    console.log(`  ${id.padEnd(28)} ok ${t.ok}/${t.calls}  ${per}`);
  }
  console.log(`\nAgreement with ${base} (contact / project / label / task-or-not):`);
  for (const [id, a] of Object.entries(agreement)) console.log(`  ${id.padEnd(28)} ${fields.map(f => a[f]).join('  ')}`);
  console.log(`\nFull report: ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
