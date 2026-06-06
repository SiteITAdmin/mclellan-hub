'use strict';

const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { fetchEmailsByLabel } = require('./gmail');
const { sendEmail: amSend } = require('./agentmail');
const { getSystemModelId } = require('./settings');

// ── Week key ──────────────────────────────────────────────────────────────────

function getWeekKey(date = new Date()) {
  // ISO 8601 week: YYYY-Www
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function weekKeyLabel(key) {
  // '2026-W23' → 'Week 23, 2026'
  const [year, w] = key.split('-W');
  return `Week ${w}, ${year}`;
}

// ── Newsletter detection ──────────────────────────────────────────────────────

const NEWSLETTER_SENDER_RE = /substack|tldr|newsletter|digest|rundown|briefing|weekly|daily|futurepedia|agentmail|implicator|forwardfuture|artificialcorner/i;
const NEWSLETTER_SUBJECT_RE = /newsletter|digest|weekly|daily|edition|issue\s*#|briefing|\bvol\b|\bno\.\s*\d/i;

function isNewsletter(email) {
  const from = `${email.fromName || ''} ${email.fromEmail || ''}`;
  if (NEWSLETTER_SENDER_RE.test(from)) return true;
  // Strip Fwd:/FW: prefix before checking subject (catches forwarded newsletters)
  const subject = (email.subject || '').replace(/^(fwd?|fw):\s*/i, '');
  return NEWSLETTER_SUBJECT_RE.test(subject);
}

// ── Default extraction prompts per mode ───────────────────────────────────────

const EXTRACTION_PROMPTS = {
  selective: (categoryList) => `Extract every distinct topic from this newsletter email as separate items.

Rules:
- A topic is a distinct story, announcement, product launch, or piece of analysis
- Single-topic newsletters produce 1 item; multi-topic newsletters produce N items, one per story
- Ignore: unsubscribe links, sponsorships, promotional course upsells, generic CTAs, "forward to a friend"
- Each headline must be specific (under 12 words) — not vague like "AI is changing things"
- Summary: one sentence, under 25 words, factual
- Category must be one of: ${categoryList}
- If nothing fits, use "Other"`,

  full: (categoryList) => `Extract every distinct item from this email. Capture all content verbatim — do not filter anything.

Rules:
- Extract everything: action items, meetings, email threads, tasks, announcements, summaries, updates
- Do NOT ignore anything — if it is in the email, capture it as a topic
- Each headline must be specific (under 12 words)
- Summary: one sentence, under 35 words, factual and close to verbatim where possible
- Category must be one of: ${categoryList}
- If nothing fits, use "Other"`,

  minimal: (categoryList) => `Extract only the 1-2 most significant headlines from this email. Ignore everything else.

Rules:
- Maximum 2 topics — pick only the genuinely important items
- Each headline must be specific (under 12 words)
- Summary: one sentence, under 20 words
- Category must be one of: ${categoryList}`,
};

// ── Topic extraction ──────────────────────────────────────────────────────────

async function extractTopicsFromEmail(email, user, { sourceLabel } = {}) {
  const hub = db.hub();

  // Skip if already processed
  if (email.id) {
    const already = hub.prepare(
      'SELECT id FROM nl_topics WHERE user = ? AND gmail_message_id = ? LIMIT 1'
    ).get(user, email.id);
    if (already) return [];
  }

  const allInterests = hub.prepare(
    'SELECT * FROM nl_interests WHERE user = ? ORDER BY display_order'
  ).all(user);

  // Look up source settings from linked interest (match by gmail_label)
  const source = sourceLabel
    ? allInterests.find(i => i.gmail_label && i.gmail_label.toLowerCase() === sourceLabel.toLowerCase())
    : null;

  // Skip entirely if mode is 'skip'
  if (source?.mode === 'skip') {
    console.log(`[newsletter] skipping "${email.subject}" — source "${sourceLabel}" is set to skip`);
    return [];
  }

  const mode = source?.mode || 'selective';
  const bodyLimit = source?.body_limit || 20000;
  const maxTokens = source?.extract_max_tokens || 4000;
  const categoryList = allInterests.length
    ? allInterests.map(i => i.name).join(', ')
    : 'AI & Machine Learning, Cybersecurity, Business & Finance, Other';
  const weekKey = getWeekKey(new Date(email.receivedAt * 1000));

  // Build extraction prompt: custom > mode default
  const basePrompt = source?.extraction_prompt
    ? source.extraction_prompt
    : (EXTRACTION_PROMPTS[mode] || EXTRACTION_PROMPTS.selective)(categoryList);

  const prompt = `${basePrompt}

Email subject: ${email.subject}
From: ${email.fromName} <${email.fromEmail}>

Content:
${(email.bodyText || '').slice(0, bodyLimit)}

Return JSON only, no markdown fences:
{"topics":[{"headline":"...","summary":"...","category":"..."}]}`;

  const modelId = getSystemModelId('newsletter_extractor', 'system', 'google/gemini-2.5-flash-lite');

  let topics = [];
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://dchat.mclellan.scot',
        'X-Title': 'McLellan Hub Newsletter',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}`);
    const data = await r.json();
    const raw = data.choices[0].message.content;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    topics = Array.isArray(parsed.topics) ? parsed.topics : [];
  } catch (err) {
    console.error(`[newsletter] extraction failed for "${email.subject}":`, err.message);
    return [];
  }

  if (!topics.length) return [];

  // Determine default selected state based on interest auto_include
  const autoInclude = new Set(
    allInterests.filter(i => i.auto_include).map(i => i.name)
  );

  const inserted = [];
  const ins = hub.prepare(`
    INSERT INTO nl_topics (id, user, gmail_message_id, from_email, from_name, email_subject, headline, summary, category, week_key, selected)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of topics) {
    if (!t.headline) continue;
    const selected = autoInclude.has(t.category) ? 1 : 0;
    const id = uuid();
    ins.run(id, user, email.id || null, email.fromEmail, email.fromName, email.subject,
      t.headline.trim(), (t.summary || '').trim(), t.category || 'Other', weekKey, selected);
    inserted.push(id);
  }

  console.log(`[newsletter] extracted ${inserted.length} topics from "${email.subject}" (mode: ${mode}${source?.extraction_prompt ? ', custom prompt' : ''})`);
  return inserted;
}

// ── Backfill from Gmail labels ────────────────────────────────────────────────

async function backfillFromLabels(user, labelNames, sinceTs) {
  const results = {};
  for (const label of labelNames) {
    try {
      const emails = await fetchEmailsByLabel(user, label, sinceTs);
      let count = 0;
      for (const email of emails) {
        const ids = await extractTopicsFromEmail(email, user, { sourceLabel: label });
        count += ids.length;
      }
      results[label] = { emails: emails.length, topics: count };
      console.log(`[newsletter] backfill "${label}": ${emails.length} emails → ${count} topics`);
    } catch (err) {
      results[label] = { error: err.message };
      console.error(`[newsletter] backfill error for label "${label}":`, err.message);
    }
  }
  return results;
}

// ── Briefing generation ───────────────────────────────────────────────────────

async function generateBriefing({ user, weekKey, formatId, topicIds }) {
  const hub = db.hub();

  const format = formatId
    ? hub.prepare('SELECT * FROM nl_formats WHERE id = ? AND user = ?').get(formatId, user)
    : hub.prepare('SELECT * FROM nl_formats WHERE user = ? AND is_default = 1').get(user)
      || hub.prepare('SELECT * FROM nl_formats WHERE user = ? ORDER BY created_at LIMIT 1').get(user);

  if (!format) throw new Error('No briefing format found — create one first.');

  const topicFilter = topicIds?.length
    ? hub.prepare(`SELECT * FROM nl_topics WHERE id IN (${topicIds.map(() => '?').join(',')}) ORDER BY category, created_at`).all(...topicIds)
    : hub.prepare('SELECT * FROM nl_topics WHERE user = ? AND week_key = ? AND selected = 1 ORDER BY category, created_at').all(user, weekKey);

  if (!topicFilter.length) throw new Error('No topics selected for this week.');

  const grouped = {};
  for (const t of topicFilter) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(`- ${t.headline}${t.summary ? ': ' + t.summary : ''} [${t.from_name}]`);
  }

  const topicBlock = Object.entries(grouped)
    .map(([cat, items]) => `### ${cat}\n${items.join('\n')}`)
    .join('\n\n');

  const weekLabel = weekKeyLabel(weekKey);

  const topicCount = topicFilter.length;
  const categoryCount = Object.keys(grouped).length;

  // Format overrides take precedence over dynamic defaults
  const maxTokens = format.max_tokens || Math.min(12000, Math.max(900, topicCount * 150));
  const modelId = format.model_id || getSystemModelId('newsletter_briefing', user, 'anthropic/claude-sonnet-4-6');

  const wordGuidance = format.target_words
    ? `Target length: approximately ${format.target_words} words total.`
    : `Scale length to the volume: aim for roughly 40–60 words per topic so a larger week gets proportionally more coverage. Do not artificially truncate.`;

  const prompt = `${format.instructions}

You have ${topicCount} topic${topicCount !== 1 ? 's' : ''} across ${categoryCount} categor${categoryCount !== 1 ? 'ies' : 'y'} this week. ${wordGuidance}

---
Topics for ${weekLabel}:

${topicBlock}`;

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
      'X-Title': 'McLellan Hub Briefing',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });

  if (!r.ok) throw new Error(`Briefing LLM ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data.choices[0].message.content.trim();
  const html = markdownToHtml(text, weekLabel);

  // Store briefing
  const id = uuid();
  hub.prepare(`
    INSERT INTO nl_briefings (id, user, week_key, format_id, topic_count, html_content, text_content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, weekKey, format.id, topicFilter.length, html, text);

  return { id, text, html, topicCount: topicFilter.length, weekLabel };
}

// ── Simple markdown → HTML for email ─────────────────────────────────────────

function markdownToHtml(md, weekLabel) {
  const body = md
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .split('\n\n')
    .map(p => {
      if (p.startsWith('<h') || p.startsWith('<ul')) return p;
      if (!p.trim()) return '';
      return `<p>${p.trim()}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: Georgia, serif; font-size: 16px; line-height: 1.7; color: #1a1a2e; max-width: 640px; margin: 0 auto; padding: 32px 24px; background: #fff; }
  h1 { font-size: 22px; font-weight: 700; color: #0f0e1a; border-bottom: 2px solid #7c6af5; padding-bottom: 10px; margin-bottom: 24px; }
  h2 { font-size: 18px; font-weight: 700; color: #3d3b5c; margin-top: 32px; margin-bottom: 8px; }
  h3 { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #7c6af5; margin-top: 20px; margin-bottom: 4px; }
  p { margin: 0 0 16px; }
  ul { margin: 8px 0 16px; padding-left: 20px; }
  li { margin-bottom: 6px; font-size: 15px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e3f0; font-size: 13px; color: #888; font-family: sans-serif; }
</style>
</head>
<body>
<h1>Intelligence Briefing — ${weekLabel}</h1>
${body}
<div class="footer">Generated by McLellan Hub · <a href="https://dchat.mclellan.scot/newsletter">Review topics</a></div>
</body>
</html>`;
}

// ── Send briefing via AgentMail ───────────────────────────────────────────────

async function sendBriefing({ user, briefingId }) {
  const hub = db.hub();
  const briefing = hub.prepare('SELECT * FROM nl_briefings WHERE id = ? AND user = ?').get(briefingId, user);
  if (!briefing) throw new Error('Briefing not found');

  const toEmail = process.env.AGENTMAIL_TO_DOUGLAS || 'aio.mclellan@gmail.com';
  const subject = `Intelligence Briefing — ${weekKeyLabel(briefing.week_key)}`;

  await amSend({
    to: toEmail,
    subject,
    text: briefing.text_content,
    html: briefing.html_content,
  });

  hub.prepare('UPDATE nl_briefings SET sent_at = unixepoch() WHERE id = ?').run(briefingId);
  console.log(`[newsletter] briefing sent to ${toEmail} for ${briefing.week_key}`);
  return { ok: true, to: toEmail, subject };
}

// ── Saturday morning reminder ─────────────────────────────────────────────────

async function sendWeeklyReminder(user) {
  const hub = db.hub();
  const weekKey = getWeekKey();
  const weekLabel = weekKeyLabel(weekKey);

  const totalRow = hub.prepare('SELECT COUNT(*) as n FROM nl_topics WHERE user = ? AND week_key = ?').get(user, weekKey);
  const total = totalRow?.n || 0;

  if (!total) {
    console.log(`[newsletter] Saturday reminder: no topics for ${weekKey}, skipping`);
    return;
  }

  const categories = hub.prepare(`
    SELECT category, COUNT(*) as n, SUM(selected) as selected
    FROM nl_topics WHERE user = ? AND week_key = ?
    GROUP BY category ORDER BY n DESC
  `).all(user, weekKey);

  const catLines = categories.map(c => `  • ${c.category}: ${c.n} topics (${c.selected} selected)`).join('\n');

  const toEmail = process.env.AGENTMAIL_TO_DOUGLAS || 'aio.mclellan@gmail.com';
  const subject = `Newsletter digest ready — ${total} topics for ${weekLabel}`;
  const text = `Good morning,

Your weekly newsletter topics are ready for review.

${weekLabel}: ${total} topics extracted

By category:
${catLines}

Review and generate your briefing at:
https://dchat.mclellan.scot/newsletter

—
McLellan Hub`;

  try {
    await amSend({ to: toEmail, subject, text });
    console.log(`[newsletter] Saturday reminder sent (${total} topics)`);
  } catch (err) {
    console.error('[newsletter] reminder send failed:', err.message);
  }
}

// ── PDF generation ────────────────────────────────────────────────────────────

function inlineMd(s) {
  // Escape HTML first, then convert markdown (* doesn't get HTML-escaped so patterns still match)
  return escHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
}

function mdToReportHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^## /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<div class="rpt-h2">${inlineMd(line.slice(3))}</div>`);
    } else if (/^### /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<div class="rpt-h3">${inlineMd(line.slice(4))}</div>`);
    } else if (/^- /.test(line)) {
      if (!inList) { out.push('<ul class="rpt-ul">'); inList = true; }
      out.push(`<li class="rpt-li">${inlineMd(line.slice(2))}</li>`);
    } else if (line === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p class="rpt-p">${inlineMd(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildBriefingPdfHtml(textContent, weekLabel) {
  const contentHtml = mdToReportHtml(textContent);
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const PUR = '#7c6af5';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-family:'Manrope',-apple-system,sans-serif}
@page{size:A4;margin:0}

.page{width:794px;min-height:1123px;position:relative;page-break-after:always;break-after:page}

/* Cover */
.cover{display:flex;flex-direction:column}
.cover-bar{height:10px;background:${PUR};flex-shrink:0}
.cover-body{flex:1;padding:80px;display:flex;flex-direction:column;min-height:1113px}
.cover-label{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${PUR};margin-bottom:80px}
.cover-title{font-family:'Playfair Display',Georgia,serif;font-size:72px;font-weight:800;line-height:1.05;color:#15131e;margin-bottom:28px}
.cover-rule{width:56px;height:4px;background:${PUR};border-radius:2px;margin-bottom:28px}
.cover-week{font-size:26px;font-weight:600;color:#4d4a5a;margin-bottom:12px}
.cover-date{font-size:15px;color:#8a8693}
.cover-spacer{flex:1}
.cover-footer{padding-top:32px;border-top:1px solid #e9e6ee;display:flex;justify-content:space-between}
.cover-footer span{font-size:13px;color:#8a8693}

/* Content */
.content-page{padding:64px 80px 80px;display:flex;flex-direction:column}
.content-inner{flex:1}

/* Report elements */
.rpt-h2{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;color:#15131e;margin:40px 0 14px;padding-bottom:10px;border-bottom:2px solid ${PUR}}
.rpt-h2:first-child{margin-top:0}
.rpt-h3{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${PUR};margin:20px 0 6px}
.rpt-p{font-size:14px;line-height:1.8;color:#3d3b5c;margin-bottom:14px}
.rpt-ul{margin:8px 0 16px;padding-left:0;list-style:none}
.rpt-li{font-size:14px;line-height:1.75;color:#3d3b5c;padding-left:18px;margin-bottom:8px;position:relative}
.rpt-li::before{content:'·';position:absolute;left:4px;color:${PUR};font-weight:900;font-size:16px;line-height:1.6}

/* Page footer */
.page-foot{margin-top:auto;padding-top:16px;border-top:1px solid #e9e6ee;display:flex;justify-content:space-between}
.page-foot span{font-size:11px;color:#8a8693}
</style></head><body>

<div class="page cover">
  <div class="cover-bar"></div>
  <div class="cover-body">
    <div class="cover-label">McLellan Hub · Intelligence</div>
    <div class="cover-title">Intelligence<br>Briefing</div>
    <div class="cover-rule"></div>
    <div class="cover-week">${escHtml(weekLabel)}</div>
    <div class="cover-date">Generated ${dateStr}</div>
    <div class="cover-spacer"></div>
    <div class="cover-footer">
      <span>Douglas McLellan</span>
      <span>mclellan.scot</span>
    </div>
  </div>
</div>

<div class="page content-page">
  <div class="content-inner">
    ${contentHtml}
  </div>
  <div class="page-foot">
    <span>McLellan Hub · Intelligence</span>
    <span>${escHtml(weekLabel)}</span>
  </div>
</div>

</body></html>`;
}

async function buildBriefingPdf(briefingId, user) {
  const hub = db.hub();
  const b = hub.prepare('SELECT * FROM nl_briefings WHERE id = ? AND user = ?').get(briefingId, user);
  if (!b) throw new Error('Briefing not found');

  const puppeteer = require('puppeteer');
  const html = buildBriefingPdfHtml(b.text_content, weekKeyLabel(b.week_key));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}

module.exports = {
  getWeekKey,
  weekKeyLabel,
  isNewsletter,
  extractTopicsFromEmail,
  backfillFromLabels,
  generateBriefing,
  buildBriefingPdf,
  sendBriefing,
  sendWeeklyReminder,
};
