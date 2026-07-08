'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const db = require('./db');
const { sendEmail } = require('./agentmail');
const { saveHtmlArtifact } = require('./html-artifact-builder');

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
  const crmKnowledge = recentCrmKnowledgeActivity(hub, since24h);

  const tasks = hub.prepare(`
    SELECT
      SUM(CASE WHEN source = 'google' THEN 1 ELSE 0 END) AS synced,
      SUM(CASE WHEN COALESCE(source, '') != 'google' THEN 1 ELSE 0 END) AS created,
      (SELECT COUNT(*) FROM google_tasks WHERE completed_at >= ?) AS completed
    FROM google_tasks WHERE created_at >= ?
  `).get(since24h, since24h);

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

  return { agentmail, gmail, facts, crmKnowledge, tasks, reminders, costs, topFeatures };
}

function recentCrmKnowledgeActivity(hub, since, user = 'douglas') {
  const row = hub.prepare(`
    SELECT
      (SELECT COUNT(*) FROM inbound_email_records
        WHERE user = ? AND source = 'agentmail' AND processed_at >= ?) AS agentmail_sources,
      (SELECT COUNT(*) FROM email_summaries
        WHERE user = ? AND gmail_message_id NOT LIKE 'agentmail:%' AND processed_at >= ?) AS gmail_sources,
      (SELECT COUNT(*) FROM email_summaries
        WHERE user = ? AND gmail_message_id LIKE 'agentmail:%' AND processed_at >= ?) AS agentmail_summaries,
      (SELECT COUNT(*) FROM knowledge_atoms
        WHERE user = ? AND status IN ('active','proposed') AND first_seen >= ?) AS atoms_created,
      (SELECT COUNT(*) FROM knowledge_receipts
        WHERE user = ? AND created_at >= ?
          AND source_kind IN ('email_summary','meeting_intake','document','open_task','completed_task','crm_fact')
          AND stage IN ('crm_source_triage','crm_duplicate_reviewed','crm_action_projected','crm_knowledge_synthesised')) AS receipts,
      (SELECT COUNT(*) FROM synthesis_state
        WHERE user = ? AND processed_at >= ?
          AND source_kind IN ('email_summary','meeting_intake','document','open_task','completed_task','crm_fact')) AS synthesised_sources,
      (SELECT COUNT(*) FROM crm_facts
        WHERE user = ? AND status = 'active' AND created_at >= ?) AS legacy_facts
  `).get(
    user, since,
    user, since,
    user, since,
    user, since,
    user, since,
    user, since,
    user, since
  );
  return {
    agentmailSources: row.agentmail_sources || 0,
    gmailSources: row.gmail_sources || 0,
    agentmailSummaries: row.agentmail_summaries || 0,
    atomsCreated: row.atoms_created || 0,
    receipts: row.receipts || 0,
    synthesisedSources: row.synthesised_sources || 0,
    legacyFacts: row.legacy_facts || 0,
  };
}

function crmKnowledgeHealthWarning(activity) {
  const agentmailSourceCount = Math.max(activity.agentmailSources || 0, activity.agentmailSummaries || 0);
  const sourceCount = agentmailSourceCount + (activity.gmailSources || 0);
  const compiledCount = (activity.atomsCreated || 0)
    + (activity.receipts || 0)
    + (activity.synthesisedSources || 0)
    + (activity.legacyFacts || 0);
  if (compiledCount > 0) return null;
  if (sourceCount > 0) {
    return `CRM knowledge: ${sourceCount} email/AgentMail source item(s) arrived in 7 days, but no facts, atoms, receipts, or synthesis runs were created — crm_knowledge_engine may be stalled`;
  }
  return 'CRM intake: no Gmail/AgentMail source records in 7 days — inbox processing or source volume may need checking';
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function bullet(lines) {
  return lines.filter(Boolean).map(line => `- ${line}`).join('\n');
}

function reportSection(title, lines) {
  return `${title}\n${bullet(lines)}`;
}

function normaliseLogLine(line) {
  return String(line || '')
    .replace(/^[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+\s+/, '')
    .replace(/\bnode\[\d+\]:\s*/g, 'node: ')
    .trim();
}

function compactRepeatedLines(lines, limit = 30) {
  const groups = new Map();
  for (const line of lines || []) {
    const key = normaliseLogLine(line);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { line, count: 0 });
    groups.get(key).count++;
  }
  const compacted = [...groups.values()].map(group =>
    group.count > 1 ? `${group.line} (repeated ${group.count} times)` : group.line
  );
  return compacted.length > limit
    ? compacted.slice(0, limit).concat([`and ${compacted.length - limit} more unique line(s)`])
    : compacted;
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

  // Local secret/data permissions — app secrets must not be world-readable,
  // and the writable data directory must remain private to the service user.
  for (const sensitivePath of ['/app/.env', '/app/config/google-service-account.json']) {
    try {
      const stat = fs.statSync(sensitivePath);
      if ((stat.mode & 0o007) !== 0) {
        warnings.push(`CRITICAL: ${sensitivePath} is readable or writable by other users`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') warnings.push(`Permission check failed for ${sensitivePath}: ${err.message}`);
    }
  }
  try {
    const dataStat = fs.statSync('/app/data');
    if ((dataStat.mode & 0o077) !== 0) {
      warnings.push('CRITICAL: /app/data is accessible outside its owner');
    }
  } catch (err) {
    warnings.push(`Permission check failed for /app/data: ${err.message}`);
  }

  // The Node service must only be reachable through Nginx.
  try {
    const listeners = execSync('ss -ltnH 2>/dev/null', { timeout: 5000 }).toString()
      .split('\n')
      .filter(line => /:3000\s*$/.test(line.trim()));
    const publicListener = listeners.some(line =>
      !line.includes('127.0.0.1:3000') && !line.includes('[::1]:3000')
    );
    if (publicListener) {
      warnings.push('CRITICAL: Hub port 3000 is listening publicly instead of loopback-only');
    }
  } catch (err) {
    warnings.push(`Hub listener check failed: ${err.message}`);
  }

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

  // CRM knowledge — the current pipeline compiles source evidence into atoms
  // and receipts. Legacy crm_facts alone no longer proves extraction health.
  const crmWarning = crmKnowledgeHealthWarning(recentCrmKnowledgeActivity(hub, since7d));
  if (crmWarning) warnings.push(crmWarning);

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

  for (const warning of openRouterPolicyWarnings(hub, now - 86400)) {
    warnings.push(warning);
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

function openRouterPolicyWarnings(hub = db.hub(), since = Math.floor(Date.now() / 1000) - 86400) {
  const warnings = [];

  const missingTaskCode = hub.prepare(`
    SELECT COUNT(*) AS n
    FROM request_logs
    WHERE ts >= ?
      AND endpoint = 'openrouter'
      AND (
        task_code IS NULL
        OR TRIM(task_code) = ''
        OR task_code = 'AT-Unclassified'
      )
  `).get(since);
  if ((missingTaskCode?.n || 0) > 0) {
    warnings.push(`OpenRouter attribution: ${missingTaskCode.n} request(s) in the last 24h had no app/task identifier`);
  }

  const gateViolations = recentOpenRouterGateViolations(since);
  if (gateViolations.length) {
    const detail = gateViolations.slice(0, 8)
      .map(event => {
        const time = event.ts ? new Date(event.ts).toISOString().slice(11, 19) : 'unknown-time';
        return `${time} ${event.model || '(unknown model)'}`;
      })
      .join('; ');
    warnings.push(`OpenRouter gate: ${gateViolations.length} request(s) in the last 24h were missing app headers before the gate stamped them — ${detail}`);
  }

  const unapprovedModels = openRouterUnapprovedModels(hub, since);
  if (unapprovedModels.length) {
    const detail = unapprovedModels
      .map(row => `${row.model_id} (${row.n} req${row.n === 1 ? '' : 's'}; ${row.features || 'unknown feature'})`)
      .join('; ');
    warnings.push(`OpenRouter model policy: ${unapprovedModels.length} model(s) used in the last 24h are not enabled on /admin/models — ${detail}`);
  }

  return warnings;
}

function openRouterGateLogPath() {
  return process.env.OPENROUTER_GATE_LOG
    || '/app/data/openrouter-gate.jsonl';
}

function recentOpenRouterGateViolations(since = Math.floor(Date.now() / 1000) - 86400) {
  const filePath = openRouterGateLogPath();
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return [{ ts: new Date().toISOString(), model: '(gate log unreadable)', error: err.message }];
    }
    return [];
  }

  const sinceMs = since * 1000;
  return text.split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(event => {
      if (!event || event.ok !== false) return false;
      const ts = Date.parse(event.ts || '');
      return Number.isFinite(ts) && ts >= sinceMs;
    });
}

function canonicalOpenRouterModelId(modelId) {
  const value = String(modelId || '').trim();
  if (!value) return '';
  const suffix = value.match(/(:[^/:]+)$/)?.[1] || '';
  const base = suffix ? value.slice(0, -suffix.length) : value;
  return base.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '') + suffix;
}

function normalizeFeatureKey(value) {
  return String(value || '').trim().replace(/-/g, '_');
}

function openRouterUnapprovedModels(hub, since) {
  const enabledModels = hub.prepare(`
    SELECT key, model_id FROM model_config WHERE enabled = 1
  `).all();
  const allowedKeys = new Set();
  const allowedModelIds = new Set();
  for (const row of enabledModels) {
    if (row.key) allowedKeys.add(row.key);
    if (row.model_id) allowedModelIds.add(canonicalOpenRouterModelId(row.model_id));
  }

  const slotRows = hub.prepare(`
    SELECT cc.key AS setting_key, cc.value AS model_key, mc.model_id
    FROM crm_context cc
    LEFT JOIN model_config mc ON mc.key = cc.value AND mc.enabled = 1
    WHERE cc.key LIKE 'hub_sys_model_%'
  `).all();
  const slotModels = new Map();
  for (const row of slotRows) {
    if (!row.model_id) continue;
    const feature = normalizeFeatureKey(String(row.setting_key || '').replace(/^hub_sys_model_/, ''));
    slotModels.set(feature, canonicalOpenRouterModelId(row.model_id));
  }

  const rows = hub.prepare(`
    SELECT model_key, model_id
    FROM request_logs
    WHERE ts >= ?
      AND endpoint = 'openrouter'
      AND COALESCE(model_id, '') != ''
  `).all(since);

  const grouped = new Map();
  for (const row of rows) {
    const modelId = String(row.model_id || '').trim();
    const canonical = canonicalOpenRouterModelId(modelId);
    const modelKey = String(row.model_key || '').trim();
    const featureKey = normalizeFeatureKey(modelKey);
    const slotModel = slotModels.get(featureKey);

    const approved = allowedKeys.has(modelKey)
      || allowedModelIds.has(canonical)
      || (slotModel && slotModel === canonical);
    if (approved) continue;

    const current = grouped.get(modelId) || { model_id: modelId, n: 0, features: new Set() };
    current.n += 1;
    current.features.add(modelKey || '(unknown)');
    grouped.set(modelId, current);
  }

  return [...grouped.values()]
    .sort((a, b) => b.n - a.n || a.model_id.localeCompare(b.model_id))
    .slice(0, 8)
    .map(row => ({
      model_id: row.model_id,
      n: row.n,
      features: [...row.features].join(','),
    }));
}

// What the knowledge substrate did lately: live status counts plus the last
// lint run's decisions, so facts leaving default view are visible in the daily
// report instead of only in the /admin/knowledge queue.
function knowledgeHealth(user = 'douglas') {
  const hub = db.hub();
  const counts = { active: 0, proposed: 0, stale: 0 };
  for (const r of hub.prepare(
    'SELECT status, COUNT(*) AS n FROM knowledge_atoms WHERE user = ? GROUP BY status'
  ).all(user)) {
    if (counts[r.status] !== undefined) counts[r.status] = r.n;
  }
  let lint = null;
  try {
    const { LINT_CONTEXT_KEY } = require('./knowledge-lint');
    const row = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?')
      .get(user, LINT_CONTEXT_KEY);
    if (row) lint = JSON.parse(row.value);
  } catch (_) {}
  return { counts, lint };
}

function knowledgeSection(user = 'douglas') {
  const { counts, lint } = knowledgeHealth(user);
  const lines = [
    `Atoms in view: ${fmt(counts.active)} active, ${fmt(counts.proposed)} proposed`,
    `Out of view: ${fmt(counts.stale)} stale atom(s); still searchable in Ask the Hub`,
  ];
  if (lint) {
    const when = new Date(lint.ranAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    lines.push(`Last lint (${when}): ${fmt(lint.decayed)} decayed, ${fmt(lint.staled)} newly stale, ${fmt(lint.contradictions)} contradiction(s), ${fmt(lint.proposed)} awaiting review`);
    if (lint.newlyStale && lint.newlyStale.length) {
      lines.push('Newly out of view:');
      for (const a of lint.newlyStale.slice(0, 10)) {
        lines.push(`${a.subjectLabel}: ${a.predicate}: ${a.value}`);
      }
    }
  } else {
    lines.push('Lint has not run yet (weekly, Sunday 04:00).');
  }
  return reportSection('KNOWLEDGE', lines);
}

function agentTeamsSection(user = 'douglas') {
  const { latestAgentReceipts } = require('./agent-receipts');
  const rows = latestAgentReceipts({
    user,
    limit: 24,
  });
  if (!rows.length) {
    return reportSection('AGENT TEAMS', ['No agent team receipts recorded yet.']);
  }
  return reportSection('AGENT TEAMS', rows.map(row => {
    const when = row.created_at
      ? new Date(row.created_at * 1000).toISOString().replace('T', ' ').slice(0, 16)
      : 'unknown time';
    return `${String(row.status || 'unknown').toUpperCase()}: ${row.summary || row.stage} (${row.source_kind}:${row.source_id}, ${when})`;
  }));
}

function dailyConsigliereReportSection(report) {
  const { dailyConsigliereSection } = require('./daily-consigliere-report');
  return reportSection('DAILY CONSIGLIERE', dailyConsigliereSection(report));
}

function systemReportMarkdown(sections) {
  return sections.map((section, index) => {
    const lines = String(section || '').split('\n');
    if (index === 0) return `# ${lines[0] || 'McLellan Hub Daily System Report'}\n\n${lines.slice(1).join('\n')}`;
    const heading = lines[0] || 'Section';
    const body = lines.slice(1).join('\n').trim();
    return `## ${heading}\n\n${body}`;
  }).join('\n\n');
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
  sections.push(`McLellan Hub — Daily Consigliere Report\n${dateStr}\n${'─'.repeat(50)}`);

  try {
    const { runFamilyAudit } = require('./hub-family-agents');
    const { runHubQualityBoards } = require('./hub-quality-board');
    const { writeConsigliereAudit } = require('./hub-consigliere-agent');
    const { writeDailyConsigliereReport } = require('./daily-consigliere-report');
    runFamilyAudit('douglas');
    runHubQualityBoards('douglas');
    writeConsigliereAudit('douglas');
    const { report } = writeDailyConsigliereReport('douglas');
    sections.push(dailyConsigliereReportSection(report));
  } catch (err) {
    console.warn('[system-report] Consigliere escalation report failed:', err.message);
  }

  // Module health — put this first so problems are impossible to miss
  const runtimeFailures = cats.errors.filter(line => !line.startsWith('DeprecationWarning'));
  if (healthWarnings.length) {
    sections.push(reportSection(`⚠ MODULE HEALTH — ${healthWarnings.length} ISSUE(S)`, healthWarnings));
  } else if (runtimeFailures.length) {
    sections.push(reportSection('⚠ MODULE HEALTH', [
      `Scheduled checks passed; ${fmt(runtimeFailures.length)} runtime failure(s) were logged below`,
    ]));
  } else {
    sections.push(reportSection('✓ MODULE HEALTH', ['All scheduled checks passed']));
  }

  // DB Stats
  const am = stats.agentmail;
  const co = stats.costs;
  sections.push(reportSection('ACTIVITY SUMMARY', [
    `AgentMail: ${fmt(am.total)} processed; ${fmt(am.with_project)} linked to projects; ${fmt(am.needs_review)} need review`,
    `Gmail: ${fmt(stats.gmail.total)} processed`,
    `CRM knowledge: ${fmt(stats.crmKnowledge.atomsCreated)} atom(s), ${fmt(stats.crmKnowledge.receipts)} receipt(s), ${fmt(stats.crmKnowledge.synthesisedSources)} synthesis run(s)`,
    `Legacy CRM facts: ${fmt(stats.crmKnowledge.legacyFacts)} created; shown for compatibility only`,
    `Tasks: ${fmt(stats.tasks.created)} created; ${fmt(stats.tasks.synced)} imported from Google; ${fmt(stats.tasks.completed)} completed`,
    `Reminders: ${fmt(stats.reminders.fired)} fired; ${fmt(stats.reminders.open)} open; ${fmt(stats.reminders.stale)} stale`,
    `AI: ${fmt(co.requests)} request(s); ${fmt(co.tokens_in)} tokens in; ${fmt(co.tokens_out)} tokens out; $${co.total_cost || '0.0000'}`,
  ]));

  try {
    sections.push(knowledgeSection('douglas'));
  } catch (err) {
    console.warn('[system-report] knowledge section failed:', err.message);
  }

  try {
    sections.push(agentTeamsSection('douglas'));
  } catch (err) {
    console.warn('[system-report] agent teams section failed:', err.message);
  }

  if (stats.topFeatures.length) {
    const featureLines = stats.topFeatures.map(f =>
      `${f.model_key || 'unknown'}: $${f.cost || 0} (${fmt(f.reqs)} reqs)`
    );
    sections.push(reportSection('COST BY FEATURE', featureLines));
  }

  if (cats.errors.length) {
    sections.push(reportSection(`ERRORS & WARNINGS (${cats.errors.length} log lines)`, compactRepeatedLines(cats.errors, 30)));
  }

  if (cats.agentmail.length) {
    sections.push(reportSection(`AGENTMAIL (${cats.agentmail.length} log lines)`, compactRepeatedLines(cats.agentmail, 30)));
  }

  if (cats.email.length) {
    sections.push(reportSection(`EMAIL PROCESSING (${cats.email.length} log lines)`, compactRepeatedLines(cats.email, 30)));
  }

  if (cats.crm.length) {
    sections.push(reportSection(`CRM (${cats.crm.length} log lines)`, compactRepeatedLines(cats.crm, 20)));
  }

  if (cats.newsletter.length) {
    sections.push(reportSection(`NEWSLETTER / RSS (${cats.newsletter.length} log lines)`, compactRepeatedLines(cats.newsletter, 15)));
  }

  if (cats.tasks.length) {
    sections.push(reportSection(`TASKS (${cats.tasks.length} log lines)`, compactRepeatedLines(cats.tasks, 30)));
  }

  sections.push(`${'─'.repeat(50)}\nGenerated by McLellan Hub at ${now.toISOString()}`);

  const body = sections.join('\n\n');
  const markdown = systemReportMarkdown(sections);
  let html;
  try {
    const artifact = saveHtmlArtifact({
      user: 'douglas',
      title: `Daily Consigliere Report — ${dateStr}`,
      subtitle: 'Human decisions, agent corrections, and Hub health for McLellan Hub.',
      markdown,
    });
    html = artifact.html;
    console.log(`[system-report] html artifact: ${artifact.filePath}`);
  } catch (err) {
    console.warn('[system-report] html artifact failed:', err.message);
  }

  await sendEmail({
    to: REPORT_TO,
    subject: `Daily Consigliere Report — ${dateStr}`,
    text: body,
    html,
  });

  console.log(`[system-report] sent to ${REPORT_TO}`);
}

module.exports = {
  categoriseLines,
  dbStats,
  moduleHealthChecks,
  canonicalOpenRouterModelId,
  openRouterUnapprovedModels,
  openRouterPolicyWarnings,
  recentOpenRouterGateViolations,
  sendSystemReport,
  systemReportMarkdown,
  recentCrmKnowledgeActivity,
  crmKnowledgeHealthWarning,
  compactRepeatedLines,
  knowledgeHealth,
  knowledgeSection,
  agentTeamsSection,
  dailyConsigliereReportSection,
};
