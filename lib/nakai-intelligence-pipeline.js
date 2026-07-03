'use strict';

// Orchestrates the daily Nakai intelligence pipeline in the correct order:
// 1. Regulatory monitor scrapes + assesses sources, stores every checked item.
// 2. Daily briefing builds from the freshly-stored items and emails the PDF.
// 3. A single audit email goes to Douglas confirming what was checked, what
//    made it into the briefing, what didn't and why, and flags loudly if the
//    pipeline failed to actually check anything.
//
// Replaces the old setup where the briefing (07:30) ran before the monitor
// (08:00) and the monitor sent its own separate, never-stored email.

const db = require('./db');
const { sendEmail } = require('./gmail');
const { runRegulatoryMonitor } = require('./regulatory-monitor');
const { sendTodayNakaiDailyBriefing } = require('../scripts/build-nakai-daily-briefing');

function douglasEmail() {
  const raw = process.env.DOUGLAS_GOOGLE_EMAILS || 'douglas@mclellan.scot';
  return raw.split(',').map(s => s.trim()).filter(Boolean)[0];
}

function markRunReported(runId, fields) {
  if (!runId) return;
  db.hub().prepare(`
    UPDATE reg_monitor_runs
    SET briefing_edition = ?, briefing_ok = ?, briefing_error = ?,
        items_included_in_briefing = ?, report_email_sent = 1
    WHERE id = ?
  `).run(fields.edition || null, fields.ok ? 1 : 0, fields.error || null, fields.includedCount || 0, runId);
}

function getDailyPipelineRunState(dateKey) {
  const row = db.hub().prepare(`
    SELECT id, run_date, briefing_ok, briefing_edition, briefing_error, report_email_sent,
           started_at, finished_at
    FROM reg_monitor_runs
    WHERE run_date = ? AND report_email_sent = 1
    ORDER BY COALESCE(finished_at, started_at) DESC, started_at DESC
    LIMIT 1
  `).get(dateKey);
  if (!row) return { reported: false, dateKey };
  return {
    reported: true,
    dateKey,
    runId: row.id,
    briefingOk: row.briefing_ok === 1,
    briefingEdition: row.briefing_edition || null,
    briefingError: row.briefing_error || null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function fmtItem(item) {
  const lines = [`- [${item.site}] ${item.title}`];
  lines.push(`  Source: ${item.url}`);
  if (item.priority) lines.push(`  Priority: ${item.priority}`);
  if (item.synopsis) lines.push(`  Summary: ${item.synopsis}`);
  return lines.join('\n');
}

function composeReport({ date, monitorReport, monitorError, dbItems, briefingResult, briefingError }) {
  const edition = briefingResult?.manifest?.edition || null;
  const included = dbItems.filter(i => i.included_in_briefing);
  const relevantNotSelected = dbItems.filter(i => i.is_relevant && !i.included_in_briefing);
  const excluded = dbItems.filter(i => !i.is_relevant);

  const panicReasons = [...(monitorReport?.panicReasons || [])];
  if (monitorError) panicReasons.push(`Regulatory monitor crashed before completing: ${monitorError.message}`);
  if (briefingError) panicReasons.push(`Daily briefing failed to build/send: ${briefingError.message} — the Hub will retry hourly until it succeeds today.`);
  const panic = panicReasons.length > 0;

  const lines = [];
  lines.push(panic ? `PANIC — Daily Intelligence Pipeline - ${date}` : `Daily Intelligence Pipeline - ${date}`);
  lines.push('');

  if (panic) {
    lines.push('SOMETHING NEEDS YOUR ATTENTION:');
    for (const reason of panicReasons) lines.push(`  - ${reason}`);
    lines.push('');
  }

  lines.push('Sources checked:');
  for (const s of (monitorReport?.sourceSummary || [])) {
    const tag = s.baselined
      ? 'baselined (first run, no comparison yet)'
      : s.error
        ? `ERROR — ${s.errorMessage || 'unknown'}`
        : s.zeroLinks
          ? 'WARNING — 0 links extracted, scraper may be broken'
          : `${s.linksExtracted} link(s) on page, ${s.newLinks} new, ${s.relevantCount} relevant`;
    lines.push(`  ${s.name}: ${tag}`);
  }
  lines.push('');

  lines.push(`Stories checked today: ${dbItems.length}`);
  lines.push(`  Included in today's briefing: ${included.length}`);
  lines.push(`  Regulatory and relevant, but not selected by the briefing: ${relevantNotSelected.length}`);
  lines.push(`  Excluded as not relevant: ${excluded.length}`);
  lines.push('');

  if (included.length) {
    lines.push('═══ INCLUDED IN TODAY\'S BRIEFING ═══', '');
    for (const item of included) lines.push(fmtItem(item), '');
  }

  if (relevantNotSelected.length) {
    lines.push('═══ REGULATORY/RELEVANT BUT NOT SELECTED FOR THIS EDITION ═══', '');
    for (const item of relevantNotSelected) lines.push(fmtItem(item), '');
  }

  if (excluded.length) {
    lines.push('═══ CHECKED AND EXCLUDED (NOT RELEVANT) ═══', '');
    for (const item of excluded) {
      lines.push(`- [${item.site}] ${item.title}`);
      lines.push(`  Source: ${item.url}`);
      lines.push(`  Why excluded: ${item.exclusion_reason || 'not specified'}`);
      lines.push('');
    }
  }

  lines.push('═══ BRIEFING CONFIRMATION ═══', '');
  if (briefingError) {
    lines.push(`FAILED — the daily PDF briefing did not send: ${briefingError.message}`);
  } else if (briefingResult?.skipped && briefingResult?.reason === 'before-start-date') {
    lines.push('Briefing schedule not active yet for this date.');
  } else if (briefingResult?.manifest) {
    lines.push(`Daily Briefing ${edition} — ${briefingResult.skipped ? 'already sent earlier today' : 'sent'} to ${briefingResult.manifest.to || 'nakai@mclellan.scot'}.`);
    lines.push(`Stored copy: data/nakai-briefings/${edition}/briefing.pdf`);
  } else {
    lines.push('Briefing result unclear — check logs.');
  }

  return { subject: panic ? `PANIC — Daily Intelligence Pipeline - ${date}` : `Daily Intelligence Pipeline - ${date}: ${included.length} new in briefing, ${dbItems.length} checked`, body: lines.join('\n'), panic, edition };
}

async function runDailyIntelligencePipeline() {
  const date = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin',
  });

  let monitorReport = null;
  let monitorError = null;
  try {
    monitorReport = await runRegulatoryMonitor();
  } catch (err) {
    console.error('[intelligence-pipeline] regulatory monitor crashed:', err);
    monitorError = err;
  }

  let briefingResult = null;
  let briefingError = null;
  try {
    briefingResult = await sendTodayNakaiDailyBriefing();
  } catch (err) {
    console.error('[intelligence-pipeline] briefing failed:', err);
    briefingError = err;
  }

  const dbItems = monitorReport?.runId
    ? db.hub().prepare(`
        SELECT site, title, url, synopsis, priority, is_relevant, exclusion_reason, included_in_briefing
        FROM reg_monitor_items
        WHERE run_id = ?
        ORDER BY (priority = 'high') DESC, (priority = 'medium') DESC, site
      `).all(monitorReport.runId)
    : [];

  const report = composeReport({ date, monitorReport, monitorError, dbItems, briefingResult, briefingError });

  try {
    await sendEmail('douglas', douglasEmail(), report.subject, report.body);
    console.log(`[intelligence-pipeline] report emailed to ${douglasEmail()} — panic=${report.panic}`);
  } catch (err) {
    console.error('[intelligence-pipeline] failed to send report email:', err);
    try {
      await sendEmail('douglas', douglasEmail(),
        `PANIC — Daily Intelligence Pipeline report failed - ${date}`,
        `The pipeline ran but the report email itself failed to send: ${err.message}\n\nCheck hub.service logs.`);
    } catch (_) { /* nothing more we can do */ }
  }

  markRunReported(monitorReport?.runId, {
    edition: report.edition,
    ok: !!briefingResult && !briefingError,
    error: briefingError?.message || null,
    includedCount: dbItems.filter(i => i.included_in_briefing).length,
  });

  return { monitorReport, briefingResult, report, briefingOk: !!briefingResult && !briefingError };
}

// Rebuilds and sends today's briefing only — no monitor re-scrape, the items
// are already stored. Called by the hourly retry loop in server.js after a
// scheduled run reports briefingOk=false (e.g. OpenRouter out of credits).
// sendTodayNakaiDailyBriefing is idempotent, so a retry racing an admin
// resend just reports skipped=true.
async function retryDailyBriefing() {
  let briefingResult = null;
  let briefingError = null;
  try {
    briefingResult = await sendTodayNakaiDailyBriefing();
  } catch (err) {
    console.error('[intelligence-pipeline] briefing retry failed:', err);
    briefingError = err;
  }

  const ok = !briefingError && !!briefingResult;
  const manifest = briefingResult?.manifest;
  if (ok && manifest && !briefingResult.skipped) {
    const hub = db.hub();
    const includedCount = hub.prepare(
      'SELECT COUNT(*) AS n FROM reg_monitor_items WHERE included_in_briefing = ?'
    ).get(manifest.edition).n;
    const latestRun = hub.prepare('SELECT id FROM reg_monitor_runs ORDER BY started_at DESC LIMIT 1').get();
    markRunReported(latestRun?.id, { edition: manifest.edition, ok: true, error: null, includedCount });
    try {
      await sendEmail('douglas', douglasEmail(),
        `RECOVERED — Daily Briefing ${manifest.edition} sent after retry`,
        [
          `Daily Briefing ${manifest.edition} failed this morning but a retry has now succeeded.`,
          '',
          `Sent to: ${manifest.to || 'nakai@mclellan.scot'}`,
          `Items from the regulatory monitor included: ${includedCount}`,
          `Stored copy: data/nakai-briefings/${manifest.edition}/briefing.pdf`,
        ].join('\n'));
    } catch (err) {
      console.error('[intelligence-pipeline] recovery email failed:', err);
    }
  }

  return { ok, briefingResult, briefingError };
}

module.exports = { runDailyIntelligencePipeline, retryDailyBriefing, getDailyPipelineRunState };
