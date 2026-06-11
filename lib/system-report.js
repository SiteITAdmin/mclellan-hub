'use strict';

const { execSync } = require('child_process');
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
  for (const line of lines) {
    const msg = line.replace(/^.*node\[\d+\]:\s*/, '').trim();
    if (!msg) continue;
    const lower = msg.toLowerCase();
    if (lower.includes('[agentmail]')) categories.agentmail.push(msg);
    else if (lower.includes('[email]')) categories.email.push(msg);
    else if (lower.includes('[crm]')) categories.crm.push(msg);
    else if (lower.includes('[newsletter]') || lower.includes('[rss]')) categories.newsletter.push(msg);
    else if (lower.includes('[tasks]')) categories.tasks.push(msg);
    else if (lower.includes('error') || lower.includes('failed') || lower.includes('warn')) categories.errors.push(msg);
    else categories.other.push(msg);
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
    FROM inbound_email_records WHERE source = 'gmail' AND processed_at >= ?
  `).get(since24h);

  const facts = hub.prepare(
    "SELECT COUNT(*) AS n FROM crm_facts WHERE created_at >= ? AND status = 'active'"
  ).get(since24h);

  const tasks = hub.prepare(
    "SELECT COUNT(*) AS n FROM google_tasks WHERE created_at >= ?"
  ).get(since24h);

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

  return { agentmail, gmail, facts, tasks, costs, topFeatures };
}

async function sendSystemReport() {
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const lines = getJournalLogs(86400);
  const cats = categoriseLines(lines);
  const stats = dbStats(since24h);

  const sections = [];

  // Header
  sections.push(`McLellan Hub — Daily System Report\n${dateStr}\n${'─'.repeat(50)}`);

  // DB Stats
  const am = stats.agentmail;
  const co = stats.costs;
  sections.push(`ACTIVITY SUMMARY
AgentMail processed : ${am.total} messages  (${am.with_project} linked to project, ${am.needs_review} needs review)
Gmail processed     : ${stats.gmail.total} emails
CRM facts created   : ${stats.facts.n}
Tasks created       : ${stats.tasks.n}
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

module.exports = { sendSystemReport };
