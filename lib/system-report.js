'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const db = require('./db');
const { sendEmail } = require('./agentmail');

const REPORT_TO = process.env.SYSTEM_REPORT_EMAIL || 'douglas@mclellan.scot';

function getJournalLogs(sinceSeconds = 86400) {
  try {
    const since = new Date(Date.now() - sinceSeconds * 1000).toISOString();
    const raw = execSync(
      `journalctl -u hub.service --since "${since}" --no-pager -o short 2>/dev/null || true`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 15000 }
    ).toString();
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function categoriseLines(lines) {
  const categories = {
    agentmail: [],
    email: [],
    crm: [],
    newsletter: [],
    rss: [],
    tasks: [],
    errors: [],
    other: [],
  };
  let punycodeWarnings = 0;
  for (const line of lines) {
    const msg = line.replace(/^.*node\[\d+\]:\s*/, '').trim();
    if (!msg) continue;
    const lower = msg.toLowerCase();
    if (lower.includes('[dep0040]') && lower.includes('punycode')) {
      punycodeWarnings++;
      continue;
    }
    if (lower.startsWith('(use `node --trace-deprecation')) continue;

    const isError = lower.includes('deprecationwarning')
      || lower.includes('unhandled rejection')
      || lower.includes('uncaught exception')
      || /\]\s+(?:error|failed|warn(?:ing)?)\b/.test(lower)
      || /\].*\b(?:error|failed)\b/.test(lower)
      || /\b(?:error|failed):\s/.test(lower);
    if (isError) categories.errors.push(msg);

    if (lower.includes('[agentmail]')) categories.agentmail.push(msg);
    else if (lower.includes('[email]')) categories.email.push(msg);
    else if (lower.includes('[crm]')) categories.crm.push(msg);
    else if (lower.includes('[newsletter]') || lower.includes('[rss]')) categories.newsletter.push(msg);
    else if (lower.includes('[tasks]')) categories.tasks.push(msg);
    else if (!isError) categories.other.push(msg);
  }
  if (punycodeWarnings) {
    categories.errors.unshift(
      `DeprecationWarning [DEP0040]: node-fetch loaded deprecated punycode (${punycodeWarnings} occurrence${punycodeWarnings === 1 ? '' : 's'})`
    );
  }
  return categories;
}

function dbStats(since24h) {
  const hub = db.hub();

  const agentmail = hub.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN project_slug IS NOT NULL THEN 1 ELSE 0 END) AS with_project,
      SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS needs_review
    FROM inbound_email_records WHERE source = 'agentmail' AND processed_at >= ?
  `).get(since24h);

  const gmail = hub.prepare(`
    SELECT COUNT(*) AS total
    FROM email_summaries
    WHERE gmail_message_id NOT LIKE 'agentmail:%' AND processed_at >= ?
  `).get(since24h);

  const facts = hub.prepare(
    "SELECT COUNT(*) AS n FROM crm_facts WHERE created_at >= ? AND status = 'active'"
  ).get(since24h);

  const tasks = hub.prepare(`
    SELECT
      SUM(CASE WHEN source = 'google' THEN 1 ELSE 0 END) AS synced,
      SUM(CASE WHEN COALESCE(source, '') != 'google' THEN 1 ELSE 0 END) AS created
    FROM google_tasks WHERE created_at >= ?
  `).get(since24h);

  const reminders = hub.prepare(`
    SELECT
      SUM(CASE WHEN last_fired_at >= ? THEN 1 ELSE 0 END) AS fired,
      SUM(CASE WHEN status = 'stale' THEN 1 ELSE 0 END) AS stale,
      SUM(CASE WHEN status IN ('scheduled','snoozed') THEN 1 ELSE 0 END) AS open
    FROM reminders
  `).get(since24h);

  const costs = hub.prepare(`
    SELECT ROUND(SUM(cost_usd), 4) AS total_cost,
      COUNT(*) AS requests,
      ROUND(SUM(tokens_in), 0) AS tokens_in,
      ROUND(SUM(tokens_out), 0) AS tokens_out
    FROM request_logs WHERE ts >= ?
  `).get(since24h);

  const topFeatures = hub.prepare(`
    SELECT model_key, ROUND(SUM(cost_usd), 4) AS cost, COUNT(*) AS reqs
    FROM request_logs WHERE ts >= ?
    GROUP BY model_key ORDER BY cost DESC LIMIT 8
  `).all(since24h);

  return { agentmail, gmail, facts, tasks, reminders, costs, topFeatures };
}

function moduleHealthChecks() {
  const hub = db.hub();
  const warnings = [];
  const now = Math.floor(Date.now() / 1000);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const arrivalGrace = new Date(Date.now() - 90 * 60 * 1000);
  const graceDate = arrivalGrace.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const graceTime = arrivalGrace.toLocaleTimeString('en-GB', {
    timeZone: 'Europe/Dublin',
    hour: '2-digit',
    minute: '2-digit',
  });
  const since7d = now - 7 * 86400;

  // Job queue — email processing must always have a pending job
  const emailJob = hub.prepare(
    "SELECT 1 FROM system_jobs WHERE type='email_process' AND status IN ('pending','running') LIMIT 1"
  ).get();
  if (!emailJob) warnings.push('CRITICAL: email_process has no pending job — email processing has stopped');

  const agentJob = hub.prepare(
    "SELECT 1 FROM system_jobs WHERE type='agentmail_process' AND status IN ('pending','running') LIMIT 1"
  ).get();
  if (!agentJob) warnings.push('CRITICAL: agentmail_process has no pending job — AgentMail processing has stopped');

  // Flight tracker — completed flights must have actual times
  const missingActuals = hub.prepare(`
    SELECT COUNT(*) AS n FROM flights
    WHERE (COALESCE(actual_dep, '') = '' OR COALESCE(actual_arr, '') = '')
      AND status NOT IN ('cancelled', 'diverted')
      AND flight_date >= date(?, '-30 days')
      AND (
        flight_date < ?
        OR (
          flight_date = ?
          AND scheduled_arr != ''
          AND scheduled_arr <= ?
        )
      )
  `).get(today, graceDate, graceDate, graceTime);
  if (missingActuals.n > 0) {
    warnings.push(`Flight tracker: ${missingActuals.n} completed flight(s) in last 30 days missing actual times — AeroDataBox parsing may be broken`);
  }

  // Scheduled flights with no tracking job
  const untrackedFlights = hub.prepare(`
    SELECT COUNT(*) AS n FROM flights f
    WHERE f.status = 'scheduled' AND f.flight_date >= ?
      AND NOT EXISTS (
        SELECT 1 FROM system_jobs j
        WHERE j.type = 'flight_refresh'
          AND j.status IN ('pending','running')
          AND json_extract(j.payload, '$.flightId') = f.id
      )
  `).get(today);
  if (untrackedFlights.n > 0) {
    warnings.push(`Flight tracker: ${untrackedFlights.n} scheduled future flight(s) with no tracking job`);
  }

  // CRM — no facts in 7 days suggests email extraction is broken
  const recentFacts = hub.prepare(
    "SELECT COUNT(*) AS n FROM crm_facts WHERE created_at >= ? AND status = 'active'"
  ).get(since7d);
  if (recentFacts.n === 0) {
    warnings.push('CRM: no facts created in 7 days — email/agentmail extraction may be broken');
  }

  const unresolvedProcessing = hub.prepare(`
    SELECT source, COUNT(*) AS n
    FROM processing_failures
    WHERE resolved_at IS NULL
    GROUP BY source
    ORDER BY source
  `).all();
  for (const row of unresolvedProcessing) {
    warnings.push(`${row.source}: ${row.n} unresolved message processing failure(s) — automatic retries have not recovered`);
  }

  // Reminders — the sweep must always have a pending job, fires must not fail silently
  const sweepJob = hub.prepare(
    "SELECT 1 FROM system_jobs WHERE type='reminder_sweep' AND status IN ('pending','running') LIMIT 1"
  ).get();
  if (!sweepJob) warnings.push('CRITICAL: reminder_sweep has no pending job — reminders have stopped');

  const failedFires = hub.prepare(
    "SELECT COUNT(*) AS n FROM system_jobs WHERE type IN ('reminder_fire','reminder_sweep','crm_nudges') AND status = 'failed' AND ran_at >= ?"
  ).get(now - 86400);
  if (failedFires.n > 0) {
    warnings.push(`Reminders: ${failedFires.n} reminder/nudge job(s) failed in last 24h — check /admin/jobs`);
  }

  const stuckReminders = hub.prepare(`
    SELECT COUNT(*) AS n FROM reminders r
    WHERE r.status IN ('scheduled','snoozed') AND r.next_fire_at < ?
      AND NOT EXISTS (
        SELECT 1 FROM system_jobs j
        WHERE j.type = 'reminder_fire' AND j.status IN ('pending','running')
          AND json_extract(j.payload, '$.reminderId') = r.id
      )
  `).get(now - 1800);
  if (stuckReminders.n > 0) {
    warnings.push(`Reminders: ${stuckReminders.n} reminder(s) past fire time with no pending job — sweep recovery may be broken`);
  }

  // Reg monitor — should have run today
  const regToday = hub.prepare(
    'SELECT COUNT(*) AS n FROM reg_monitor_items WHERE found_at >= ?'
  ).get(now - 86400);
  if (regToday.n === 0) {
    warnings.push('Regulatory monitor: no items found in last 24h — monitor may not have run');
  }

  // Nginx config — VPS running config must match the committed nginx/mclellan.conf
  try {
    const deployed  = fs.readFileSync('/app/nginx/mclellan.conf', 'utf8').trim();
    const live      = fs.readFileSync('/etc/nginx/sites-enabled/mclellan.conf', 'utf8').trim();
    if (deployed !== live) {
      warnings.push('CRITICAL: nginx config drift — /etc/nginx/sites-enabled/mclellan.conf does not match /app/nginx/mclellan.conf. Run deploy.sh to resync.');
    }
  } catch (err) {
    warnings.push(`nginx config check failed: ${err.message}`);
  }

  // Documents — uploaded in last 7 days with no tasks extracted
  const untaskedDocs = hub.prepare(`
    SELECT COUNT(*) AS n FROM documents d
    WHERE d.uploaded_at >= datetime(?, 'unixepoch')
      AND d.mimetype NOT LIKE 'image/%'
      AND NOT EXISTS (
        SELECT 1 FROM google_tasks t
        WHERE t.source = 'document' AND t.source_id LIKE 'doc:' || d.id || ':%'
      )
  `).get(since7d);
  if (untaskedDocs.n > 0) {
    warnings.push(`Documents: ${untaskedDocs.n} non-image document(s) uploaded in last 7 days with no tasks extracted`);
  }

  return warnings;
}

async function sendSystemReport() {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const lines = getJournalLogs(86400);
  const cats = categoriseLines(lines);
  const stats = dbStats(since24h);
  const healthWarnings = moduleHealthChecks();

  const sections = [];

  // Header
  sections.push(`McLellan Hub — Daily System Report\n${dateStr}\n${'─'.repeat(50)}`);

  // Module health — put this first so problems are impossible to miss
  const runtimeFailures = cats.errors.filter(line => !line.startsWith('DeprecationWarning'));
  if (healthWarnings.length) {
    sections.push(`⚠ MODULE HEALTH — ${healthWarnings.length} ISSUE(S)\n${healthWarnings.map(w => `  • ${w}`).join('\n')}`);
  } else if (runtimeFailures.length) {
    sections.push(`⚠ MODULE HEALTH — scheduled checks passed, but ${runtimeFailures.length} runtime failure(s) were logged below`);
  } else {
    sections.push(`✓ MODULE HEALTH — all checks passed`);
  }

  // DB Stats
  const am = stats.agentmail;
  const co = stats.costs;
  sections.push(`ACTIVITY SUMMARY
AgentMail processed : ${am.total} messages  (${am.with_project} linked to project, ${am.needs_review} needs review)
Gmail processed     : ${stats.gmail.total} emails
CRM facts created   : ${stats.facts.n}
Tasks created       : ${stats.tasks.created || 0}  |  Google tasks imported: ${stats.tasks.synced || 0}
Reminders fired     : ${stats.reminders.fired || 0}  |  Open: ${stats.reminders.open || 0}  Stale: ${stats.reminders.stale || 0}
AI requests         : ${co.requests}  |  Tokens in: ${(co.tokens_in || 0).toLocaleString()}  out: ${(co.tokens_out || 0).toLocaleString()}
AI cost (24h)       : $${co.total_cost || '0.0000'}`);

  if (stats.topFeatures.length) {
    const featureLines = stats.topFeatures.map(f => `  ${(f.model_key || 'unknown').padEnd(30)} $${String(f.cost).padStart(7)}  (${f.reqs} reqs)`);
    sections.push(`COST BY FEATURE\n${featureLines.join('\n')}`);
  }

  if (cats.errors.length) {
    sections.push(`ERRORS & WARNINGS (${cats.errors.length})\n${cats.errors.slice(0, 30).join('\n')}`);
  }

  if (cats.agentmail.length) {
    sections.push(`AGENTMAIL (${cats.agentmail.length} log lines)\n${cats.agentmail.join('\n')}`);
  }

  if (cats.email.length) {
    const shown = cats.email.length > 40 ? cats.email.slice(0, 40).concat([`… and ${cats.email.length - 40} more`]) : cats.email;
    sections.push(`EMAIL PROCESSING (${cats.email.length} log lines)\n${shown.join('\n')}`);
  }

  if (cats.crm.length) {
    const shown = cats.crm.length > 20 ? cats.crm.slice(0, 20).concat([`… and ${cats.crm.length - 20} more`]) : cats.crm;
    sections.push(`CRM (${cats.crm.length} log lines)\n${shown.join('\n')}`);
  }

  if (cats.newsletter.length) {
    sections.push(`NEWSLETTER / RSS (${cats.newsletter.length} log lines)\n${cats.newsletter.slice(0, 15).join('\n')}${cats.newsletter.length > 15 ? `\n… and ${cats.newsletter.length - 15} more` : ''}`);
  }

  if (cats.tasks.length) {
    sections.push(`TASKS (${cats.tasks.length} log lines)\n${cats.tasks.join('\n')}`);
  }

  sections.push(`${'─'.repeat(50)}\nGenerated by McLellan Hub at ${now.toISOString()}`);

  const body = sections.join('\n\n');

  await sendEmail({
    to: REPORT_TO,
    subject: `Hub Daily Report — ${dateStr}`,
    text: body,
  });

  console.log(`[system-report] sent to ${REPORT_TO}`);
}

module.exports = { categoriseLines, dbStats, moduleHealthChecks, sendSystemReport };
