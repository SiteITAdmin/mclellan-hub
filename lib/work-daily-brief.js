'use strict';

/**
 * Work Daily Brief — sent each weekday morning to Douglas.
 *
 * Sections:
 *   1. Yesterday recap: emails/AgentMail, meetings, completed tasks
 *   2. Today's calendar
 *   3. Coming up: meetings + due tasks in next 7 days
 *   4. All outstanding tasks, grouped by project
 *
 * LLM synthesis is used only for the email/meetings recap narrative.
 * Everything else is templated from the DB.
 */

const db       = require('./db');
const fetch    = require('./fetch');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { uuid } = require('./id');

const OR_URL   = 'https://openrouter.ai/api/v1/chat/completions';

// ── Helpers ───────────────────────────────────────────────────────────────────

function dublinToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Dublin' }).format(new Date());
}

function dublinYesterday() {
  const today = dublinToday();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dublinDatePlusDays(n) {
  const today = dublinToday();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dayOfWeek(isoDate) {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const [y, m, d] = isoDate.split('-').map(Number);
  return days[new Date(y, m - 1, d).getDay()];
}

function fmtDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${dayOfWeek(isoDate)} ${d} ${months[m - 1]} ${y}`;
}

function unixDayRange(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
  const end   = Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
  return { start, end };
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── LLM synthesis for email/meeting narrative ─────────────────────────────────

async function synthesise(prompt, user) {
  const modelId = getSystemModelId('work_daily_brief', 'system', 'anthropic/claude-haiku-4-5');
  const started = Date.now();
  const resp = await fetch(OR_URL, {
    method:  'POST',
    headers: openRouterHeaders(TASK_CODES.DAILY_DIGEST),
    body: JSON.stringify({
      model:       modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.25,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature: 'work-daily-brief', modelKey: 'work_daily_brief',
    fallbackModelId: modelId, data, durationMs: Date.now() - started,
    taskCode: TASK_CODES.DAILY_DIGEST,
  });
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Data gathering ────────────────────────────────────────────────────────────

function gatherData(user) {
  const hub  = db.hub();
  const today     = dublinToday();
  const yesterday = dublinYesterday();
  const weekOut   = dublinDatePlusDays(7);
  const { start: yStart, end: yEnd } = unixDayRange(yesterday);
  const { start: tStart } = unixDayRange(today);

  // ── Yesterday ──

  const agentmailYesterday = hub.prepare(`
    SELECT from_name, from_email, subject, summary, project_slug, classification
    FROM inbound_email_records
    WHERE user = ? AND source = 'agentmail'
      AND received_at >= ? AND received_at <= ?
    ORDER BY received_at ASC
  `).all(user, yStart, yEnd);

  const emailsYesterday = hub.prepare(`
    SELECT from_name, subject, summary, project_slug
    FROM email_summaries
    WHERE user = ? AND received_at >= ? AND received_at <= ?
      AND (project_slug IS NULL OR project_slug NOT IN ('__system','__skip'))
    ORDER BY received_at ASC
    LIMIT 30
  `).all(user, yStart, yEnd);

  const meetingsYesterday = hub.prepare(`
    SELECT m.title, m.meeting_time, m.duration_mins, m.location, m.notes,
      GROUP_CONCAT(c.name, ', ') AS attendees,
      mi.summary AS intake_summary
    FROM meetings m
    LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
    LEFT JOIN contacts c ON c.id = ma.contact_id
    LEFT JOIN meeting_intakes mi ON mi.meeting_id = m.id AND mi.user = m.user
    WHERE m.user = ? AND m.meeting_date = ?
    GROUP BY m.id
    ORDER BY m.meeting_time ASC
  `).all(user, yesterday);

  const completedYesterday = hub.prepare(`
    SELECT title, project_slug, notes
    FROM google_tasks
    WHERE user = ? AND completed_at >= ? AND completed_at <= ?
      AND deleted_at IS NULL
    ORDER BY completed_at ASC
  `).all(user, yStart, yEnd);

  // ── Today's calendar ──

  const meetingsToday = hub.prepare(`
    SELECT m.title, m.meeting_time, m.duration_mins, m.location,
      GROUP_CONCAT(c.name, ', ') AS attendees
    FROM meetings m
    LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
    LEFT JOIN contacts c ON c.id = ma.contact_id
    WHERE m.user = ? AND m.meeting_date = ?
    GROUP BY m.id
    ORDER BY m.meeting_time ASC
  `).all(user, today);

  // ── Coming up (next 7 days, excluding today) ──

  const meetingsUpcoming = hub.prepare(`
    SELECT m.title, m.meeting_date, m.meeting_time, m.duration_mins, m.location,
      GROUP_CONCAT(c.name, ', ') AS attendees
    FROM meetings m
    LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
    LEFT JOIN contacts c ON c.id = ma.contact_id
    WHERE m.user = ? AND m.meeting_date > ? AND m.meeting_date <= ?
    GROUP BY m.id
    ORDER BY m.meeting_date ASC, m.meeting_time ASC
  `).all(user, today, weekOut);

  const tasksDueSoon = hub.prepare(`
    SELECT t.title, t.due, t.project_slug, t.notes
    FROM google_tasks t
    WHERE t.user = ? AND t.status = 'needsAction' AND t.deleted_at IS NULL
      AND t.due IS NOT NULL AND t.due <= ? AND t.parent_id IS NULL
    ORDER BY t.due ASC, t.title ASC
  `).all(user, weekOut);

  // ── All outstanding tasks ──

  const allOpenTasks = hub.prepare(`
    SELECT t.title, t.due, t.project_slug, t.notes, t.contact_id,
      c.name AS contact_name
    FROM google_tasks t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.user = ? AND t.status = 'needsAction' AND t.deleted_at IS NULL
      AND t.parent_id IS NULL
    ORDER BY
      t.project_slug NULLS LAST,
      t.due ASC NULLS LAST,
      t.title ASC
  `).all(user);

  return {
    today, yesterday,
    agentmailYesterday, emailsYesterday,
    meetingsYesterday, completedYesterday,
    meetingsToday, meetingsUpcoming, tasksDueSoon,
    allOpenTasks,
  };
}

// ── Interest radar stories ────────────────────────────────────────────────────

// For each interest the radar holds (derived nightly from recent meetings and
// the upcoming calendar), pull a handful of recent stories. Search failure or
// a missing key just means the section is omitted — the brief still sends.
async function gatherRadarStories(user) {
  let radar = [];
  try {
    const { getInterestRadar } = require('./interest-synthesis');
    radar = getInterestRadar(user).slice(0, 3);
  } catch (err) {
    console.warn('[work-brief] interest radar unavailable:', err.message);
    return [];
  }
  if (!radar.length) return [];
  const { exaSearch } = require('./router');
  const out = [];
  for (const item of radar) {
    try {
      const r = await exaSearch(`${item.topic} — significant recent news and developments`, 7);
      const stories = (r.sources || []).slice(0, 3);
      if (stories.length) out.push({ ...item, stories });
      else console.warn(`[work-brief] radar: no stories found for "${item.topic}"`);
    } catch (err) {
      console.warn(`[work-brief] radar search failed for "${item.topic}":`, err.message);
    }
  }
  return out;
}

function radarSectionHtml(radarItems) {
  if (!radarItems.length) return '';
  const blocks = radarItems.map(item => `
    <div style="margin-bottom:18px">
      <div style="font-family:${BODY_FONT};font-size:14px;font-weight:700;color:#26243d">${esc(item.topic)}</div>
      ${item.why ? `<div style="font-family:${BODY_FONT};font-size:12px;color:#9996b0;margin:2px 0 8px">Why: ${esc(item.why)}</div>` : ''}
      ${item.stories.map(s => `
        <div style="margin:0 0 8px">
          <a href="${esc(s.url)}" style="font-family:${BODY_FONT};font-size:13px;color:${PUR};font-weight:600">${esc(s.title)}</a>
          ${s.snippet ? `<div style="font-family:${BODY_FONT};font-size:12px;color:#6b6885;margin-top:2px">${esc(String(s.snippet).slice(0, 220))}…</div>` : ''}
        </div>`).join('')}
    </div>`).join('');
  return `${sectionHead('On your radar')}
<tr><td style="padding:0 0 8px">${blocks}</td></tr>`;
}

function radarSectionText(radarItems) {
  if (!radarItems.length) return [];
  const lines = ['', 'ON YOUR RADAR', '─'.repeat(36)];
  for (const item of radarItems) {
    lines.push(`${item.topic}`);
    if (item.why) lines.push(`  Why: ${item.why}`);
    for (const s of item.stories) lines.push(`  • ${s.title} — ${s.url}`);
    lines.push('');
  }
  return lines;
}

// ── HTML builder ──────────────────────────────────────────────────────────────

const PUR = '#7c6af5';
const BODY_FONT = "'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

function sectionHead(title) {
  return `
<tr><td style="padding:28px 0 0">
  <div style="font-family:${BODY_FONT};font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:${PUR};margin-bottom:12px">${esc(title)}</div>
  <div style="height:1px;background:#ece9fa;margin-bottom:20px"></div>
</td></tr>`;
}

function pill(label) {
  return `<span style="display:inline-block;background:#f0eeff;color:${PUR};font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;margin-left:6px">${esc(label)}</span>`;
}

function taskRow(t, showDue = true) {
  const due = t.due ? `<span style="color:#999;font-size:12px;margin-left:8px">${t.due}</span>` : '';
  const proj = t.project_slug ? pill(t.project_slug) : '';
  return `<li style="font-family:${BODY_FONT};font-size:14px;color:#3d3b46;line-height:1.6;padding:5px 0;border-bottom:1px solid #f5f5f5">${esc(t.title)}${showDue ? due : ''}${proj}</li>`;
}

function meetingRow(m, showDate = false) {
  const isAllDay = !m.meeting_time;
  const dateLabel = showDate ? `<span style="color:#888;font-size:12px;margin-right:6px">${fmtDate(m.meeting_date).slice(0,3)} ${m.meeting_date.slice(5)}</span>` : '';
  const who = m.attendees ? `<span style="color:#888;font-size:12px;margin-left:8px">${esc(m.attendees)}</span>` : '';
  if (isAllDay) {
    return `<li style="font-family:${BODY_FONT};font-size:13px;color:#7c6af5;line-height:1.6;padding:4px 0;border-bottom:1px solid #f5f5f5;font-style:italic">${dateLabel}All day — ${esc(m.title)}${who}</li>`;
  }
  const time = m.meeting_time.slice(0, 5);
  const dur  = m.duration_mins ? ` (${Math.round(m.duration_mins / 60 * 10) / 10}h)` : '';
  return `<li style="font-family:${BODY_FONT};font-size:14px;color:#3d3b46;line-height:1.6;padding:5px 0;border-bottom:1px solid #f5f5f5">${dateLabel}<strong style="color:#15131e">${time}${dur}</strong> ${esc(m.title)}${who}</li>`;
}

function proseParagraph(text) {
  if (!text) return '';
  return `<p style="font-family:${BODY_FONT};font-size:14px;line-height:1.75;color:#3d3b46;margin:0 0 14px">${esc(text)}</p>`;
}

function emptyLine(label) {
  return `<p style="font-family:${BODY_FONT};font-size:13px;color:#aaa;font-style:italic;margin:0 0 14px">${esc(label)}</p>`;
}

function buildHtml(data, yesterdayNarrative, todayNarrative, radarItems = []) {
  const { today, yesterday, meetingsToday, meetingsUpcoming, tasksDueSoon, allOpenTasks,
          completedYesterday, agentmailYesterday, emailsYesterday, meetingsYesterday } = data;

  // Group outstanding tasks by project
  const byProject = {};
  for (const t of allOpenTasks) {
    const key = t.project_slug || '__none';
    (byProject[key] ||= []).push(t);
  }
  const projectOrder = Object.keys(byProject).sort((a, b) => {
    if (a === '__none') return 1;
    if (b === '__none') return -1;
    return a.localeCompare(b);
  });

  let html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
</head><body style="margin:0;padding:0;background:#f7f5ff">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5ff;padding:32px 16px">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">

<!-- Header -->
<tr><td style="background:${PUR};padding:6px 0;border-radius:6px 6px 0 0"></td></tr>
<tr><td style="background:#fff;padding:32px 40px 8px;border-left:1px solid #ece9fa;border-right:1px solid #ece9fa">
  <p style="font-family:${BODY_FONT};font-size:10px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:${PUR};margin:0 0 10px">McLellan Hub</p>
  <h1 style="font-family:'Playfair Display',Georgia,serif;font-size:34px;font-weight:800;color:#15131e;margin:0 0 6px;line-height:1.1">Work Brief</h1>
  <p style="font-family:${BODY_FONT};font-size:15px;color:#6b6879;margin:0 0 28px">${fmtDate(today)}</p>
</td></tr>

<!-- Body -->
<tr><td style="background:#fff;padding:0 40px 32px;border-left:1px solid #ece9fa;border-right:1px solid #ece9fa">
<table width="100%" cellpadding="0" cellspacing="0">`;

  // ── Yesterday recap ──────────────────────────────────────────────────────────
  html += sectionHead(`Yesterday — ${fmtDate(yesterday)}`);
  html += `<tr><td style="padding-bottom:8px">`;

  if (yesterdayNarrative) {
    html += proseParagraph(yesterdayNarrative);
  } else if (!agentmailYesterday.length && !emailsYesterday.length && !meetingsYesterday.length) {
    html += emptyLine('No emails or meetings recorded yesterday.');
  }

  if (completedYesterday.length) {
    html += `<p style="font-family:${BODY_FONT};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin:14px 0 6px">Completed</p>`;
    html += `<ul style="margin:0;padding:0 0 0 0;list-style:none">`;
    for (const t of completedYesterday) html += taskRow(t, false);
    html += `</ul>`;
  } else {
    html += emptyLine('No tasks completed yesterday.');
  }

  html += `</td></tr>`;

  // ── Today ────────────────────────────────────────────────────────────────────
  html += sectionHead(`Today — ${fmtDate(today)}`);
  html += `<tr><td style="padding-bottom:8px">`;

  if (todayNarrative) html += proseParagraph(todayNarrative);

  if (meetingsToday.length) {
    html += `<ul style="margin:0;padding:0;list-style:none">`;
    for (const m of meetingsToday) html += meetingRow(m);
    html += `</ul>`;
  } else {
    html += emptyLine('No meetings in the calendar today.');
  }

  html += `</td></tr>`;

  // ── Coming up ────────────────────────────────────────────────────────────────
  html += sectionHead('Coming Up — Next 7 Days');
  html += `<tr><td style="padding-bottom:8px">`;

  if (meetingsUpcoming.length) {
    html += `<p style="font-family:${BODY_FONT};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin:0 0 6px">Calendar</p>`;
    html += `<ul style="margin:0 0 16px;padding:0;list-style:none">`;
    for (const m of meetingsUpcoming) html += meetingRow(m, true);
    html += `</ul>`;
  } else {
    html += emptyLine('No meetings in the next 7 days.');
  }

  if (tasksDueSoon.length) {
    html += `<p style="font-family:${BODY_FONT};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#888;margin:14px 0 6px">Tasks due this week</p>`;
    html += `<ul style="margin:0;padding:0;list-style:none">`;
    for (const t of tasksDueSoon) html += taskRow(t);
    html += `</ul>`;
  }

  html += `</td></tr>`;

  // ── On your radar ─────────────────────────────────────────────────────────────
  html += radarSectionHtml(radarItems);

  // ── Outstanding tasks ─────────────────────────────────────────────────────────
  html += sectionHead(`Outstanding Tasks (${allOpenTasks.length})`);
  html += `<tr><td style="padding-bottom:8px">`;

  if (!allOpenTasks.length) {
    html += emptyLine('No open tasks. Inbox zero.');
  } else {
    for (const proj of projectOrder) {
      const label = proj === '__none' ? 'No Project' : proj;
      const tasks = byProject[proj];
      html += `<p style="font-family:${BODY_FONT};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${proj === '__none' ? '#aaa' : PUR};margin:16px 0 4px">${esc(label)} (${tasks.length})</p>`;
      html += `<ul style="margin:0 0 8px;padding:0;list-style:none">`;
      for (const t of tasks) html += taskRow(t);
      html += `</ul>`;
    }
  }

  html += `</td></tr>`;

  // ── Footer ────────────────────────────────────────────────────────────────────
  html += `</table></td></tr>
<tr><td style="background:#f0eeff;padding:18px 40px;border-radius:0 0 6px 6px;border:1px solid #ece9fa;border-top:none">
  <p style="font-family:${BODY_FONT};font-size:12px;color:#9996b0;margin:0">
    McLellan Hub · Work Brief · ${today} · <a href="${process.env.HUB_URL || 'https://dchat.mclellan.scot'}" style="color:${PUR}">Open Hub</a>
  </p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

  return html;
}

// ── Plain-text fallback ───────────────────────────────────────────────────────

function buildText(data, yesterdayNarrative, radarItems = []) {
  const { today, yesterday, meetingsToday, meetingsUpcoming, tasksDueSoon, allOpenTasks,
          completedYesterday } = data;
  const lines = [
    `WORK BRIEF — ${fmtDate(today)}`,
    '═'.repeat(48),
    '',
    `YESTERDAY — ${fmtDate(yesterday)}`,
    '─'.repeat(36),
  ];
  if (yesterdayNarrative) lines.push(yesterdayNarrative, '');
  if (completedYesterday.length) {
    lines.push('Completed:');
    for (const t of completedYesterday) lines.push(`  ✓ ${t.title}${t.project_slug ? ` [${t.project_slug}]` : ''}`);
    lines.push('');
  }
  lines.push(`TODAY — ${fmtDate(today)}`, '─'.repeat(36));
  if (meetingsToday.length) {
    for (const m of meetingsToday) lines.push(`  ${m.meeting_time ? m.meeting_time.slice(0,5) : 'All day'} ${m.title}${m.attendees ? ' · ' + m.attendees : ''}`);
  } else {
    lines.push('  No meetings today.');
  }
  lines.push('', 'COMING UP (7 DAYS)', '─'.repeat(36));
  for (const m of meetingsUpcoming) lines.push(`  ${m.meeting_date} ${m.meeting_time ? m.meeting_time.slice(0,5) : ''} ${m.title}`);
  if (!meetingsUpcoming.length) lines.push('  No upcoming meetings.');
  lines.push(...radarSectionText(radarItems));
  if (tasksDueSoon.length) {
    lines.push('', 'DUE THIS WEEK');
    for (const t of tasksDueSoon) lines.push(`  ${t.due || '?'} ${t.title}${t.project_slug ? ` [${t.project_slug}]` : ''}`);
  }
  lines.push('', `OUTSTANDING TASKS (${allOpenTasks.length})`, '─'.repeat(36));
  const byProj = {};
  for (const t of allOpenTasks) (byProj[t.project_slug || '__none'] ||= []).push(t);
  for (const [proj, tasks] of Object.entries(byProj)) {
    lines.push(`\n${proj === '__none' ? 'No Project' : proj.toUpperCase()} (${tasks.length})`);
    for (const t of tasks) lines.push(`  • ${t.title}${t.due ? ' · ' + t.due : ''}`);
  }
  return lines.join('\n');
}

// ── Main send function ────────────────────────────────────────────────────────

async function sendWorkDailyBrief(user = 'douglas') {
  const hub   = db.hub();
  const today = dublinToday();
  const dateKey = `work_brief_sent_${today}`;

  const alreadySent = hub.prepare(
    "SELECT 1 FROM crm_context WHERE user = ? AND key = ?"
  ).get(user, dateKey);
  if (alreadySent) {
    console.log(`[work-brief] already sent for ${user} on ${today}`);
    return { ok: true, skipped: true };
  }

  const data = gatherData(user);

  // LLM: yesterday recap (emails + meetings)
  let yesterdayNarrative = '';
  let todayNarrative = '';
  try {
    const emailLines = [
      ...data.agentmailYesterday.map(e => `[AgentMail] From: ${e.from_name} <${e.from_email}> — "${e.subject}" · ${e.summary || ''}${e.project_slug ? ` [${e.project_slug}]` : ''}`),
      ...data.emailsYesterday.map(e => `[Email] From: ${e.from_name} — "${e.subject}" · ${e.summary || ''}${e.project_slug ? ` [${e.project_slug}]` : ''}`),
    ];
    const meetingLines = data.meetingsYesterday.map(m =>
      `${m.title}${m.meeting_time ? ` at ${m.meeting_time.slice(0,5)}` : ''}${m.attendees ? ` (${m.attendees})` : ''}${m.intake_summary ? `: ${m.intake_summary}` : ''}`
    );

    if (emailLines.length || meetingLines.length) {
      const prompt = [
        'Write a concise 2–3 sentence recap of yesterday\'s work activity for a personal morning brief.',
        'Focus on what arrived, what was discussed, and any clear follow-ups implied.',
        'Tone: direct, professional, no fluff.',
        '',
        emailLines.length ? `Emails and messages:\n${emailLines.join('\n')}` : '',
        meetingLines.length ? `Meetings:\n${meetingLines.join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      yesterdayNarrative = await synthesise(prompt, user);
    }

    if (data.meetingsToday.length) {
      const meetStr = data.meetingsToday.map(m =>
        `${m.meeting_time ? m.meeting_time.slice(0,5) : ''} ${m.title}${m.attendees ? ` (${m.attendees})` : ''}`
      ).join('; ');
      const todayPrompt = `In one sentence, summarise what today looks like based on these calendar items: ${meetStr}. Keep it short and practical.`;
      todayNarrative = await synthesise(todayPrompt, user);
    }
  } catch (err) {
    console.warn('[work-brief] LLM synthesis failed, proceeding without narrative:', err.message);
  }

  const radarItems = await gatherRadarStories(user);

  const html    = buildHtml(data, yesterdayNarrative, todayNarrative, radarItems);
  const text    = buildText(data, yesterdayNarrative, radarItems);
  const subject = `Work Brief — ${fmtDate(today)}`;
  const to      = process.env.WORK_BRIEF_EMAIL || process.env.SYSTEM_REPORT_EMAIL || 'douglas@mclellan.scot';

  const { sendEmail } = require('./gmail');
  await sendEmail(user, to, subject, { html, text });

  hub.prepare(
    'INSERT OR IGNORE INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)'
  ).run(uuid(), user, dateKey, String(Date.now()));

  console.log(`[work-brief] sent to ${to} for ${user} on ${today}`);
  return { ok: true, skipped: false, to };
}

module.exports = { sendWorkDailyBrief, gatherRadarStories, radarSectionHtml, radarSectionText };
