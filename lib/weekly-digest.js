'use strict';

const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { pushGoogleChatBriefing } = require('./crm');
const { logUsageFromResponse } = require('./openrouter-usage');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function llm(prompt, user = 'system') {
  const started = Date.now();
  const modelId = process.env.DIGEST_MODEL || 'google/gemini-2.5-pro-preview';
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'weekly-digest',
    modelKey: 'weekly-digest',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
  });
  return data.choices[0].message.content.trim();
}

async function buildWeeklyDigest(user) {
  const hub = db.hub();
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const sections = [];

  // ── 1. Chat activity ────────────────────────────────────────────────────────
  const chatRows = hub.prepare(`
    SELECT p.name AS project_name, p.slug,
      COUNT(CASE WHEN m.role = 'user' THEN 1 END) AS user_turns,
      GROUP_CONCAT(CASE WHEN m.role = 'user' THEN substr(m.content, 1, 120) END, ' | ') AS samples
    FROM messages m
    JOIN projects p ON p.id = m.project_id
    WHERE m.user = ? AND m.ts > ? AND m.role = 'user'
    GROUP BY p.id
    ORDER BY user_turns DESC
  `).all(user, cutoff);

  if (chatRows.length) {
    const chatLines = chatRows.map(r =>
      `${r.project_name} (${r.user_turns} messages): ${(r.samples || '').slice(0, 200)}`
    ).join('\n');
    const synthesis = await llm(
      `Summarise the week's chat activity across these projects for a personal weekly digest. Be concise — 2-3 sentences covering which projects were most active and what topics came up.\n\n${chatLines}`
    , user);
    sections.push(`*Chats & Projects*\n${synthesis}`);
  }

  // ── 2. Email digest ─────────────────────────────────────────────────────────
  const emailRows = hub.prepare(`
    SELECT subject, from_name, summary, project_slug
    FROM email_summaries
    WHERE user = ? AND received_at > ?
      AND (project_slug IS NULL OR project_slug NOT IN ('__system', '__skip'))
    ORDER BY received_at DESC
    LIMIT 40
  `).all(user, cutoff);

  if (emailRows.length) {
    const emailLines = emailRows.map(e =>
      `[${e.project_slug || 'uncategorised'}] ${e.from_name}: ${e.subject} — ${e.summary}`
    ).join('\n');
    const synthesis = await llm(
      `Summarise this week's emails for a personal weekly digest. 2-3 sentences covering key themes, important senders, or anything that needs follow-up.\n\n${emailLines}`
    , user);
    sections.push(`*Emails*\n${synthesis}`);
  }

  // ── 3. CRM facts added this week ────────────────────────────────────────────
  const factRows = hub.prepare(`
    SELECT f.fact, c.name AS contact_name, f.status
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.created_at > ?
    ORDER BY f.created_at DESC
    LIMIT 20
  `).all(user, cutoff);

  if (factRows.length) {
    const factLines = factRows.map(f => `${f.contact_name}: ${f.fact} [${f.status}]`).join('\n');
    const synthesis = await llm(
      `Summarise these CRM updates from this week. 1-2 sentences on key people and any open follow-ups.\n\n${factLines}`
    , user);
    sections.push(`*People & CRM*\n${synthesis}`);
  }

  // ── 4. Flights ──────────────────────────────────────────────────────────────
  const flightRows = hub.prepare(`
    SELECT flight_number, direction, flight_date, status, scheduled_dep, actual_dep
    FROM flights
    WHERE user = ? AND (created_at > ? OR flight_date >= date('now', '-7 days'))
    ORDER BY flight_date DESC
    LIMIT 10
  `).all(user, cutoff);

  if (flightRows.length) {
    const completed = flightRows.filter(f => f.status === 'completed');
    const upcoming  = flightRows.filter(f => f.status === 'scheduled');
    const lines = [];
    if (completed.length) lines.push(`Completed: ${completed.map(f => `${f.flight_number} ${f.direction} ${f.flight_date}`).join(', ')}`);
    if (upcoming.length)  lines.push(`Upcoming: ${upcoming.map(f => `${f.flight_number} ${f.direction} ${f.flight_date}`).join(', ')}`);
    sections.push(`*Flights*\n${lines.join('\n')}`);
  }

  // ── 5. Regulatory monitor findings ─────────────────────────────────────────
  const regRows = hub.prepare(`
    SELECT site, title, synopsis FROM reg_monitor_items
    WHERE found_at > ?
    ORDER BY found_at DESC
    LIMIT 15
  `).all(cutoff);

  if (regRows.length) {
    const regLines = regRows.map(r => `[${r.site}] ${r.title}: ${r.synopsis}`).join('\n');
    const synthesis = await llm(
      `Summarise these regulatory updates from this week for a personal digest. 2-3 sentences on the most significant developments.\n\n${regLines}`
    , user);
    sections.push(`*Regulatory*\n${synthesis}`);
  }

  // ── 6. LinkedIn content ─────────────────────────────────────────────────────
  const linkedinRows = hub.prepare(`
    SELECT topic, status, content_type, refined_draft FROM linkedin_posts
    WHERE user = ? AND created_at > ?
    ORDER BY created_at DESC
    LIMIT 14
  `).all(user, cutoff);

  if (linkedinRows.length) {
    const liLines = linkedinRows.map(r => {
      const source = (r.refined_draft || '').trim();
      const summary = source
        ? source.replace(/\s+/g, ' ').slice(0, 200).replace(/\s\S*$/, '') + '…'
        : '(no draft yet)';
      return `• *${r.topic}* (${r.status}${r.content_type ? ', ' + r.content_type : ''})\n  ${summary}`;
    }).join('\n');
    sections.push(`*LinkedIn*\n${liLines}`);
  }

  if (!sections.length) return null;

  const header = `*Weekly Digest — ${dateStr}*\n${'─'.repeat(36)}`;
  return [header, '', ...sections.join('\n\n─────\n\n').split('\n')].join('\n');
}

async function sendWeeklyDigest(user) {
  const hub = db.hub();
  const dateStr = `weekly-${new Date().toISOString().slice(0, 10)}`;

  const alreadySent = hub.prepare(
    'SELECT 1 FROM crm_briefing_log WHERE user = ? AND date_str = ?'
  ).get(user, dateStr);
  if (alreadySent) { console.log(`[weekly] already sent for ${user} this week`); return; }

  try {
    const text = await buildWeeklyDigest(user);
    if (!text) { console.log(`[weekly] nothing to digest for ${user}`); return; }

    const claimed = hub.prepare(`
      INSERT OR IGNORE INTO crm_context (id, user, key, value)
      VALUES (?, ?, ?, ?)
    `).run(uuid(), user, `weekly_digest_sent_${dateStr}`, String(Date.now()));
    if (claimed.changes === 0) {
      console.log(`[weekly] already claimed for ${user} this week`);
      return;
    }

    const sent = await pushGoogleChatBriefing(user, text);
    if (sent) {
      hub.prepare('INSERT INTO crm_briefing_log (id, user, date_str) VALUES (?, ?, ?)').run(uuid(), user, dateStr);
      console.log(`[weekly] digest sent for ${user}`);
    }
  } catch (err) {
    console.error(`[weekly] error for ${user}:`, err.message);
  }
}

module.exports = { sendWeeklyDigest };
