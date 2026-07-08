'use strict';

const db = require('./db');
const { writeAgentReceipt } = require('./agent-receipts');

const STAGE = 'agent:daily_consigliere_report';
const SOURCE_KIND = 'hub_governance';
const SOURCE_ID = 'daily_consigliere';

function now() { return Math.floor(Date.now() / 1000); }

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function receiptPayload(row) {
  return parseJson(row?.payload, {});
}

function latestAgentReceipts(user = 'douglas', since = now() - 86400, limit = 200) {
  try {
    return db.hub().prepare(`
      SELECT *
      FROM knowledge_receipts
      WHERE user = ?
        AND stage LIKE 'agent:%'
        AND stage != ?
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(user, STAGE, since, limit);
  } catch (_) {
    return [];
  }
}

function recentReceiptHistory(user = 'douglas', since = now() - 7 * 86400, limit = 600) {
  try {
    return db.hub().prepare(`
      SELECT *
      FROM knowledge_receipts
      WHERE user = ?
        AND stage LIKE 'agent:%'
        AND stage != ?
        AND created_at >= ?
      ORDER BY source_kind, source_id, stage, created_at DESC
      LIMIT ?
    `).all(user, STAGE, since, limit);
  } catch (_) {
    return [];
  }
}

function latestPerSubject(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.stage}:${row.source_kind}:${row.source_id}`;
    const existing = map.get(key);
    if (!existing || Number(row.created_at || 0) > Number(existing.created_at || 0)) {
      map.set(key, row);
    }
  }
  return [...map.values()];
}

function statusKind(status) {
  const clean = String(status || '').toLowerCase();
  if (['fail', 'failed', 'error'].includes(clean)) return 'fail';
  if (['warn', 'warning', 'needs_revision', 'review'].includes(clean)) return 'warn';
  if (['pass', 'ok', 'done', 'success'].includes(clean)) return 'pass';
  return clean || 'unknown';
}

function firstEvidence(payload, row) {
  if (payload.retry_or_appeal) return payload.retry_or_appeal;
  if (Array.isArray(payload.blocking_checks) && payload.blocking_checks.length) {
    return `Blocking checks: ${payload.blocking_checks.join(', ')}`;
  }
  if (Array.isArray(payload.checks)) {
    const issue = payload.checks.find(c => c.verdict && c.verdict !== 'pass');
    if (issue?.evidence) return issue.evidence;
  }
  return row.summary || row.stage;
}

function questionFor(row, payload, reason) {
  const target = `${row.source_kind}:${row.source_id}`;
  const title = payload.title || payload.board || payload.agent || row.stage;
  if (reason === 'clarification') {
    return `Please clarify ${target}: ${title}.`;
  }
  if (reason === 'veto') {
    return `Please decide whether to revise, override, or abandon ${target}.`;
  }
  if (reason === 'failure') {
    return `Please decide how to unblock ${target}; the agent could not solve this alone.`;
  }
  return `Please review ${target}.`;
}

function escalationItems(rows) {
  const items = [];
  for (const row of rows) {
    const payload = receiptPayload(row);
    const status = statusKind(row.status);
    const clarificationRequests = Array.isArray(payload.clarification_requests)
      ? payload.clarification_requests
      : [];
    const hasVeto = Boolean(payload.quality_veto);

    if (status === 'fail' && !hasVeto) {
      items.push({
        kind: 'human_intervention',
        reason: 'failure',
        severity: 'blocker',
        receipt_id: row.id,
        stage: row.stage,
        source_kind: row.source_kind,
        source_id: row.source_id,
        status: row.status,
        summary: row.summary || '',
        evidence: firstEvidence(payload, row),
        question: questionFor(row, payload, 'failure'),
        created_at: row.created_at,
      });
    }

    if (hasVeto) {
      items.push({
        kind: 'human_intervention',
        reason: 'veto',
        severity: 'decision',
        receipt_id: row.id,
        stage: row.stage,
        source_kind: row.source_kind,
        source_id: row.source_id,
        status: row.status,
        summary: row.summary || '',
        evidence: firstEvidence(payload, row),
        question: questionFor(row, payload, 'veto'),
        created_at: row.created_at,
      });
    }

    if (clarificationRequests.length) {
      items.push({
        kind: 'human_intervention',
        reason: 'clarification',
        severity: 'question',
        receipt_id: row.id,
        stage: row.stage,
        source_kind: row.source_kind,
        source_id: row.source_id,
        status: row.status,
        summary: row.summary || '',
        evidence: `${clarificationRequests.length} clarification request(s)`,
        question: questionFor(row, payload, 'clarification'),
        clarification_requests: clarificationRequests,
        created_at: row.created_at,
      });
    }
  }

  return dedupeItems(items).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function severityRank(value) {
  return { blocker: 0, decision: 1, question: 2, watch: 3 }[value] ?? 4;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.reason}:${item.receipt_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function correctionItems(historyRows) {
  const bySubject = new Map();
  for (const row of historyRows) {
    const key = `${row.stage}:${row.source_kind}:${row.source_id}`;
    const list = bySubject.get(key) || [];
    list.push(row);
    bySubject.set(key, list);
  }

  const corrections = [];
  for (const rows of bySubject.values()) {
    const ordered = rows.slice().sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    const latest = ordered[0];
    const previousIssue = ordered.slice(1).find(row => ['fail', 'warn'].includes(statusKind(row.status)));
    if (!latest || statusKind(latest.status) !== 'pass' || !previousIssue) continue;
    corrections.push({
      kind: 'agent_correction',
      receipt_id: latest.id,
      previous_receipt_id: previousIssue.id,
      stage: latest.stage,
      source_kind: latest.source_kind,
      source_id: latest.source_id,
      summary: latest.summary || '',
      previous_summary: previousIssue.summary || '',
      created_at: latest.created_at,
      previous_created_at: previousIssue.created_at,
    });
  }

  return corrections.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, 40);
}

function monitoringItems(rows) {
  return rows
    .filter(row => statusKind(row.status) === 'warn')
    .filter(row => {
      const payload = receiptPayload(row);
      return !payload.quality_veto && !(Array.isArray(payload.clarification_requests) && payload.clarification_requests.length);
    })
    .map(row => ({
      kind: 'monitoring',
      receipt_id: row.id,
      stage: row.stage,
      source_kind: row.source_kind,
      source_id: row.source_id,
      status: row.status,
      summary: row.summary || '',
      evidence: firstEvidence(receiptPayload(row), row),
      created_at: row.created_at,
    }))
    .slice(0, 40);
}

function buildDailyConsigliereReport(user = 'douglas', options = {}) {
  const ts = options.now || now();
  const since = options.since || ts - 86400;
  const rows = latestPerSubject(options.rows || latestAgentReceipts(user, since));
  const historyRows = options.historyRows || recentReceiptHistory(user, ts - 7 * 86400);
  const humanIntervention = escalationItems(rows);
  const corrections = correctionItems(historyRows);
  const monitoring = monitoringItems(rows);
  const verdict = humanIntervention.some(item => item.severity === 'blocker')
    ? 'fail'
    : humanIntervention.length ? 'warn' : 'pass';

  return {
    agent: 'daily_consigliere',
    role: 'human_intervention_router',
    user,
    run_at: new Date(ts * 1000).toISOString(),
    verdict,
    asks_douglas: humanIntervention,
    agent_corrections: corrections,
    monitoring,
    counts: {
      asks_douglas: humanIntervention.length,
      blockers: humanIntervention.filter(item => item.severity === 'blocker').length,
      decisions: humanIntervention.filter(item => item.severity === 'decision').length,
      clarifications: humanIntervention.filter(item => item.severity === 'question').length,
      agent_corrections: corrections.length,
      monitoring: monitoring.length,
    },
  };
}

function writeDailyConsigliereReport(user = 'douglas', options = {}) {
  const report = buildDailyConsigliereReport(user, options);
  const id = writeAgentReceipt({
    user,
    sourceKind: SOURCE_KIND,
    sourceId: SOURCE_ID,
    stage: STAGE,
    status: report.verdict,
    summary: `Daily Consigliere: ${report.counts.asks_douglas} ask(s), ${report.counts.agent_corrections} correction(s), ${report.counts.monitoring} watch item(s)`,
    payload: report,
  });
  return { id, report };
}

function formatTime(epoch) {
  return epoch ? new Date(epoch * 1000).toISOString().replace('T', ' ').slice(0, 16) : 'unknown';
}

function markdownList(items, formatter, empty) {
  if (!items.length) return `- ${empty}`;
  return items.map(formatter).join('\n');
}

function dailyConsigliereMarkdown(report) {
  const lines = [
    `# Daily Consigliere Report`,
    '',
    `Verdict: ${String(report.verdict || 'unknown').toUpperCase()}`,
    `Asks for Douglas: ${report.counts.asks_douglas} (${report.counts.blockers} blocker, ${report.counts.decisions} decision, ${report.counts.clarifications} clarification)`,
    `Agent corrections: ${report.counts.agent_corrections}`,
    `Watch items: ${report.counts.monitoring}`,
    '',
    '## Ask Douglas',
    markdownList(report.asks_douglas, item => {
      const detail = item.clarification_requests?.length
        ? ` Clarifications: ${item.clarification_requests.slice(0, 3).map(req => req.evidence || req.reason || req.type || JSON.stringify(req)).join(' | ')}`
        : '';
      return `- [${item.severity}] ${item.question} Evidence: ${item.evidence}.${detail} Receipt: ${item.receipt_id}.`;
    }, 'No human decisions needed.'),
    '',
    '## Agent Corrections',
    markdownList(report.agent_corrections, item =>
      `- ${item.stage} corrected ${item.source_kind}:${item.source_id}. Now: ${item.summary || 'pass'}; before: ${item.previous_summary || 'warn/fail'}. Receipt: ${item.receipt_id}.`,
    'No agent corrections detected in the recent receipt history.'),
    '',
    '## Watch',
    markdownList(report.monitoring, item =>
      `- ${item.stage} watching ${item.source_kind}:${item.source_id}. ${item.summary || item.evidence} (${formatTime(item.created_at)}).`,
    'No watch items.'),
  ];
  return lines.join('\n');
}

function dailyConsigliereSection(report) {
  const lines = [
    `${String(report.verdict || 'unknown').toUpperCase()}: ${report.counts.asks_douglas} ask(s), ${report.counts.agent_corrections} correction(s), ${report.counts.monitoring} watch item(s)`,
  ];
  if (report.asks_douglas.length) {
    lines.push('Ask Douglas:');
    for (const item of report.asks_douglas.slice(0, 12)) {
      const clarification = item.clarification_requests?.length
        ? ` Clarifications: ${item.clarification_requests.slice(0, 3).map(req => req.evidence || req.reason || req.type || JSON.stringify(req)).join(' | ')}.`
        : '';
      lines.push(`- [${item.severity}] ${item.question} Evidence: ${item.evidence}.${clarification} Receipt: ${item.receipt_id}`);
    }
  } else {
    lines.push('Ask Douglas: no human decisions needed.');
  }
  if (report.agent_corrections.length) {
    lines.push('Agent corrections:');
    for (const item of report.agent_corrections.slice(0, 8)) {
      lines.push(`- ${item.stage} corrected ${item.source_kind}:${item.source_id} (${item.receipt_id})`);
    }
  } else {
    lines.push('Agent corrections: none detected in recent receipt history.');
  }
  if (report.monitoring.length) {
    lines.push('Watch:');
    for (const item of report.monitoring.slice(0, 8)) {
      lines.push(`- ${item.summary || item.evidence} (${item.receipt_id})`);
    }
  }
  return lines;
}

module.exports = {
  STAGE,
  buildDailyConsigliereReport,
  dailyConsigliereMarkdown,
  dailyConsigliereSection,
  writeDailyConsigliereReport,
};
