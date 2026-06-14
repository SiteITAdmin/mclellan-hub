'use strict';

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { fetchEmailsByLabel } = require('./gmail');
const { sendEmail: amSend } = require('./agentmail');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

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

function isoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[0]
    ? null
    : match[0];
}

function weekKeyRange(key) {
  const match = String(key || '').match(/^(\d{4})-W(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    dateFrom: monday.toISOString().slice(0, 10),
    dateTo: sunday.toISOString().slice(0, 10),
  };
}

function normalizeBriefingRange({ dateFrom, dateTo, weekKey }) {
  const fallback = weekKeyRange(weekKey || getWeekKey()) || weekKeyRange(getWeekKey());
  const parsedFrom = isoDate(dateFrom);
  const parsedTo = isoDate(dateTo);
  if (dateFrom && !parsedFrom) throw new Error('From date is invalid.');
  if (dateTo && !parsedTo) throw new Error('To date is invalid.');
  const from = parsedFrom || fallback.dateFrom;
  const to = parsedTo || fallback.dateTo;
  if (from > to) throw new Error('From date must be on or before To date.');
  return { dateFrom: from, dateTo: to };
}

function dateRangeLabel(dateFrom, dateTo) {
  const from = isoDate(dateFrom);
  const to = isoDate(dateTo);
  if (!from || !to) return null;
  const format = (date, includeYear) => new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
  if (from === to) return format(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${format(from, !sameYear)} – ${format(to, true)}`;
}

function briefingPeriodLabel(briefing) {
  return dateRangeLabel(briefing?.date_from, briefing?.date_to)
    || weekKeyLabel(briefing?.week_key);
}

function topicFallsInRange(topic, dateFrom, dateTo) {
  const fromTs = Date.parse(`${dateFrom}T00:00:00.000Z`) / 1000;
  const toTs = Date.parse(`${dateTo}T23:59:59.999Z`) / 1000;
  if (topic.received_at) return topic.received_at >= fromTs && topic.received_at <= toTs;
  const legacyRange = weekKeyRange(topic.week_key);
  return Boolean(legacyRange && legacyRange.dateFrom <= dateTo && legacyRange.dateTo >= dateFrom);
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

function normalizeSourceValue(value) {
  return String(value || '').trim().toLowerCase();
}

function findIntelligenceSource(user, email, sourceLabel = '') {
  const hub = db.hub();
  const label = normalizeSourceValue(sourceLabel);
  const emailAddress = normalizeSourceValue(email.fromEmail);
  const domain = emailAddress.split('@')[1] || '';
  const approvedLabel = label === 'resources/newsletters' || label === 'resources/research';

  let source = hub.prepare(`
    SELECT * FROM intel_sources
    WHERE user = ? AND source_kind = 'email' AND enabled = 1
      AND (
        (match_type = 'sender_email' AND lower(match_value) = ?)
        OR (match_type = 'sender_domain' AND (? = lower(match_value) OR ? LIKE '%.' || lower(match_value)))
      )
    ORDER BY CASE match_type WHEN 'sender_email' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(user, emailAddress, domain, domain);

  if (!source && approvedLabel && emailAddress) {
    const id = uuid();
    hub.prepare(`
      INSERT OR IGNORE INTO intel_sources
        (id, user, name, source_kind, match_type, match_value)
      VALUES (?, ?, ?, 'email', 'sender_email', ?)
    `).run(id, user, email.fromName || emailAddress, emailAddress);
    source = hub.prepare(`
      SELECT * FROM intel_sources
      WHERE user = ? AND source_kind = 'email'
        AND match_type = 'sender_email' AND lower(match_value) = ?
    `).get(user, emailAddress);
  }

  return source || null;
}

function isApprovedExternalEmail(user, email, sourceLabel = '') {
  return Boolean(findIntelligenceSource(user, email, sourceLabel));
}

function safeStringArray(value, limit = 20) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

// ── Default extraction prompts per mode ───────────────────────────────────────

const EXTRACTION_PROMPTS = {
  selective: (categoryList) => getSystemPrompt('newsletter_extractor', 'system', PROMPTS.newsletter_extractor)
    .replace('[CATEGORIES]', categoryList),

  full: (categoryList) => getSystemPrompt('newsletter_extractor_full', 'system',
    `Extract every distinct item from this email. Capture all content verbatim — do not filter anything.

Rules:
- Extract everything: action items, meetings, email threads, tasks, announcements, summaries, updates
- Do NOT ignore anything — if it is in the email, capture it as a topic
- Each headline must be specific (under 12 words)
- Summary: one sentence, under 35 words, factual and close to verbatim where possible
- Category must be one of: ${categoryList}
- If nothing fits, use "Other"`),

  minimal: (categoryList) => getSystemPrompt('newsletter_extractor_minimal', 'system',
    `Extract only the 1-2 most significant headlines from this email. Ignore everything else.

Rules:
- Maximum 2 topics — pick only the genuinely important items
- Each headline must be specific (under 12 words)
- Summary: one sentence, under 20 words
- Category must be one of: ${categoryList}`),
};

// ── Topic extraction ──────────────────────────────────────────────────────────

async function extractTopicsFromEmail(email, user, { sourceLabel } = {}) {
  const hub = db.hub();
  const source = findIntelligenceSource(user, email, sourceLabel);
  if (!source) {
    console.log(`[newsletter] ignoring unapproved external source "${email.subject}" from ${email.fromEmail}`);
    return [];
  }

  // Skip if already processed
  const externalId = email.id || `${email.fromEmail}:${email.subject}:${email.receivedAt}`;
  const existing = hub.prepare(`
    SELECT id FROM intel_documents
    WHERE user = ? AND source_kind = 'email' AND external_id = ?
  `).get(user, externalId);
  if (existing) return [];

  const allInterests = hub.prepare(
    'SELECT * FROM nl_interests WHERE user = ? AND gmail_label IS NULL ORDER BY display_order'
  ).all(user);
  const bodyLimit = 500000;
  const maxTokens = 16000;
  const categoryList = allInterests.length
    ? allInterests.map(i => i.name).join(', ')
    : 'AI & Machine Learning, Cybersecurity, Business & Finance, Other';
  const contentText = String(email.bodyText || '').slice(0, bodyLimit);
  const prompt = `Extract the substantial readable items from this external publication.

Email subject: ${email.subject}
From: ${email.fromName} <${email.fromEmail}>

Content:
${contentText}

Return JSON only, no markdown fences:
{"items":[{"title":"...","summary":"factual retrieval summary","content":"complete relevant paragraphs or prompt/tutorial text","item_type":"news|analysis|prompt|tutorial|product|event|advertisement|other","category":"one of: ${categoryList}","entities":["..."],"themes":["..."],"source_url":"optional URL"}]}

Rules:
- Preserve substance. The content field should contain the complete relevant passage for the item, not a one-sentence compression.
- Preserve prompts, procedures, numbered steps, examples, and quotations as written when they are the useful content.
- Split multi-story newsletters into distinct items.
- Exclude navigation, unsubscribe text, generic sponsorship boilerplate, and repeated footer material.
- Do not invent facts or merge unrelated stories.
- Keep each content field under 20,000 characters.`;

  const modelId = getSystemModelId('newsletter_extractor', 'system', 'google/gemini-2.5-flash-lite');

  let topics = [];
  let extractionError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
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
          messages: [{
            role: 'user',
            content: attempt === 1
              ? prompt
              : `${prompt}\n\nThis is a retry. Return strictly valid JSON and reduce the number of items if necessary to finish the JSON object cleanly.`,
          }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: attempt === 1 ? maxTokens : 24000,
        }),
      });
      if (!r.ok) throw new Error(`LLM ${r.status}`);
      const data = await r.json();
      const raw = data.choices[0].message.content;
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      topics = Array.isArray(parsed.items) ? parsed.items : [];
      extractionError = null;
      break;
    } catch (err) {
      extractionError = err;
      console.warn(`[newsletter] extraction attempt ${attempt} failed for "${email.subject}":`, err.message);
    }
  }
  if (extractionError) {
    console.error(`[newsletter] extraction failed for "${email.subject}" after retry`);
    return [];
  }

  if (!topics.length) return [];

  const documentId = uuid();
  hub.prepare(`
    INSERT INTO intel_documents
      (id, user, source_id, external_id, source_kind, title, sender_name, sender_email,
       source_url, published_at, content_text)
    VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)
  `).run(
    documentId, user, source.id, externalId, email.subject,
    email.fromName || '', email.fromEmail || '', email.sourceUrl || null,
    Number(email.receivedAt) || Math.floor(Date.now() / 1000), contentText
  );
  const inserted = [];
  const ins = hub.prepare(`
    INSERT INTO intel_items
      (id, user, document_id, title, summary, content_text, item_type, category,
       entities_json, themes_json, source_url, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const t of topics) {
    if (!t.title && !t.headline) continue;
    const id = uuid();
    ins.run(
      id, user, documentId, String(t.title || t.headline).trim(),
      String(t.summary || '').trim(), String(t.content || '').trim().slice(0, 20000),
      String(t.item_type || 'news'), String(t.category || 'Other'),
      JSON.stringify(safeStringArray(t.entities)), JSON.stringify(safeStringArray(t.themes)),
      t.source_url || email.sourceUrl || null,
      Number(email.receivedAt) || Math.floor(Date.now() / 1000)
    );
    inserted.push(id);
  }

  console.log(`[newsletter] extracted ${inserted.length} substantial items from "${email.subject}"`);
  return inserted;
}

// ── Backfill from Gmail labels ────────────────────────────────────────────────

async function backfillFromLabels(user, labelNames, sinceTs) {
  const results = {};
  for (const label of labelNames) {
    try {
      const emails = await fetchEmailsByLabel(user, label, sinceTs);
      let count = 0;
      const queue = [...emails];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const email = queue.shift();
          const ids = await extractTopicsFromEmail(email, user, { sourceLabel: label });
          count += ids.length;
        }
      });
      for (const worker of workers) {
        await worker;
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

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function queryTerms(value) {
  const stop = new Set(['about', 'after', 'again', 'also', 'from', 'have', 'into', 'more', 'that', 'the', 'their', 'this', 'what', 'when', 'where', 'which', 'with', 'week']);
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9.+-]{2,}/g) || [])]
    .filter(term => !stop.has(term));
}

function lexicalRelevance(item, terms) {
  if (!terms.length) return 1;
  const title = String(item.title || '').toLowerCase();
  const metadata = [
    item.summary,
    item.category,
    item.item_type,
    item.document_title,
    item.sender_name,
    ...parseJsonArray(item.entities_json),
    ...parseJsonArray(item.themes_json),
  ].join(' ').toLowerCase();
  const content = String(item.content_text || '').slice(0, 4000).toLowerCase();
  return terms.reduce((score, term) => score
    + (title.includes(term) ? 8 : 0)
    + (metadata.includes(term) ? 4 : 0)
    + (content.includes(term) ? 1 : 0), 0);
}

async function retrieveIntelligenceItems({ user, focus, dateFrom, dateTo, limit = 40 }) {
  const hub = db.hub();
  const fromTs = Date.parse(`${dateFrom}T00:00:00.000Z`) / 1000;
  const toTs = Date.parse(`${dateTo}T23:59:59.999Z`) / 1000;
  const candidates = hub.prepare(`
    SELECT i.*, d.title AS document_title, d.sender_name, d.sender_email,
           COALESCE(i.source_url, d.source_url) AS resolved_url
    FROM intel_items i
    JOIN intel_documents d ON d.id = i.document_id
    WHERE i.user = ? AND i.selected = 1
      AND i.published_at >= ? AND i.published_at <= ?
    ORDER BY i.published_at DESC
    LIMIT 2000
  `).all(user, fromTs, toTs);

  if (!candidates.length) return [];
  const terms = queryTerms(focus);
  const shortlist = candidates
    .map(item => ({ ...item, lexical_score: lexicalRelevance(item, terms) }))
    .filter(item => !terms.length || item.lexical_score > 0)
    .sort((a, b) => b.lexical_score - a.lexical_score || b.published_at - a.published_at)
    .slice(0, 120);

  if (!focus || !shortlist.length) return shortlist.slice(0, limit);

  const catalogue = shortlist.map(item => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    type: item.item_type,
    category: item.category,
    entities: parseJsonArray(item.entities_json),
    themes: parseJsonArray(item.themes_json),
    source: item.sender_name,
    publication: item.document_title,
  }));
  const modelId = getSystemModelId('newsletter_extractor', 'system', 'google/gemini-2.5-flash-lite');
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://dchat.mclellan.scot',
        'X-Title': 'McLellan Hub Intelligence Retrieval',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{
          role: 'user',
          content: `Select the external-publication items that materially answer this briefing request:

${focus}

Return JSON only:
{"matches":[{"id":"...","relevance":"direct|context","reason":"brief factual reason"}]}

Include direct reporting and genuinely useful context. Exclude coincidental keyword matches, internal operational material, generic AI news, and items that do not help answer the request. Return at most ${limit} matches.

Candidates:
${JSON.stringify(catalogue)}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 5000,
      }),
    });
    if (!response.ok) throw new Error(`retrieval LLM ${response.status}`);
    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
    const byId = new Map(shortlist.map(item => [item.id, item]));
    return matches.slice(0, limit).map(match => {
      const item = byId.get(match.id);
      return item ? { ...item, relevance: match.relevance, relevance_reason: match.reason } : null;
    }).filter(Boolean);
  } catch (err) {
    console.warn('[newsletter] relevance ranking fallback:', err.message);
    return shortlist.slice(0, limit);
  }
}

async function previewBriefing({ user, weekKey, formatId, focus, dateFrom, dateTo }) {
  const hub = db.hub();
  const range = normalizeBriefingRange({ dateFrom, dateTo, weekKey });
  const format = formatId
    ? hub.prepare('SELECT * FROM nl_formats WHERE id = ? AND user = ?').get(formatId, user)
    : hub.prepare('SELECT * FROM nl_formats WHERE user = ? AND is_default = 1').get(user)
      || hub.prepare('SELECT * FROM nl_formats WHERE user = ? ORDER BY created_at LIMIT 1').get(user);
  if (!format) throw new Error('No briefing format found — create one first.');
  const resolvedFocus = String(focus || format.focus_query || format.name || '').trim();
  const limit = Math.min(Math.max(Number(format.retrieval_limit) || 40, 5), 100);
  const items = await retrieveIntelligenceItems({
    user,
    focus: resolvedFocus,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    limit,
  });
  return { format, focus: resolvedFocus, items, ...range };
}

async function generateBriefing({ user, weekKey, formatId, focus, dateFrom, dateTo }) {
  const hub = db.hub();
  const preview = await previewBriefing({ user, weekKey, formatId, focus, dateFrom, dateTo });
  const { format, items, dateFrom: from, dateTo: to } = preview;
  if (!items.length) throw new Error(`No external intelligence matched "${preview.focus}" in this date range.`);
  const periodLabel = dateRangeLabel(from, to);
  const readingMinutes = Math.min(Math.max(Number(format.reading_minutes) || 20, 5), 90);
  const targetWords = format.target_words || readingMinutes * 220;
  const maxTokens = format.max_tokens || Math.min(24000, Math.max(3000, Math.ceil(targetWords * 1.5)));
  const modelId = format.model_id || getSystemModelId('newsletter_briefing', user, 'anthropic/claude-sonnet-4-6');
  const briefingInstructions = format.instructions
    || getSystemPrompt('newsletter_briefing', user, PROMPTS.newsletter_briefing);
  let evidenceChars = 0;
  const evidenceLimit = 280000;
  const evidence = [];
  for (const item of items) {
    const remaining = evidenceLimit - evidenceChars;
    if (remaining <= 0) break;
    const content = String(item.content_text || item.summary || '').slice(0, Math.min(12000, remaining));
    const source = item.sender_name || item.sender_email || 'External source';
    const url = item.resolved_url ? `\nURL: ${item.resolved_url}` : '';
    evidence.push(`## ${item.title}\nSource: ${source} — ${item.document_title}${url}\nType: ${item.item_type}; Category: ${item.category || 'Other'}\nRelevance: ${item.relevance_reason || 'Matched the request'}\n\n${content}`);
    evidenceChars += content.length;
  }
  const prompt = `${briefingInstructions}

Briefing request: ${preview.focus}
Period: ${periodLabel}
Target reading time: approximately ${readingMinutes} minutes (${targetWords} words).

Use only the external evidence below. Synthesize across publications, preserve useful prompts and procedures in full, distinguish reporting from analysis, and cite the publication or sender for substantive claims. Do not add personal CRM, project, task, or wiki context.

---
${evidence.join('\n\n---\n\n')}`;

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
  const html = markdownToHtml(text, periodLabel);

  // Store briefing
  const id = uuid();
  hub.prepare(`
    INSERT INTO nl_briefings
      (id, user, week_key, format_id, topic_count, html_content, text_content, date_from, date_to)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, weekKey || getWeekKey(new Date(`${from}T12:00:00Z`)),
    format.id, items.length, html, text, from, to);

  return { id, text, html, topicCount: items.length, periodLabel, dateFrom: from, dateTo: to };
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
  const subject = `Intelligence Briefing — ${briefingPeriodLabel(briefing)}`;

  await amSend({
    to: toEmail,
    subject,
    text: briefing.text_content,
    html: briefing.html_content,
  });

  hub.prepare('UPDATE nl_briefings SET sent_at = unixepoch() WHERE id = ?').run(briefingId);
  console.log(`[newsletter] briefing sent to ${toEmail} for ${briefingPeriodLabel(briefing)}`);
  return { ok: true, to: toEmail, subject };
}

// ── Saturday morning reminder ─────────────────────────────────────────────────

async function sendWeeklyReminder(user) {
  const hub = db.hub();
  const weekKey = getWeekKey();
  const weekLabel = weekKeyLabel(weekKey);
  const range = weekKeyRange(weekKey);
  const fromTs = Date.parse(`${range.dateFrom}T00:00:00Z`) / 1000;
  const toTs = Date.parse(`${range.dateTo}T23:59:59Z`) / 1000;

  const totalRow = hub.prepare(
    'SELECT COUNT(*) as n FROM intel_items WHERE user = ? AND published_at BETWEEN ? AND ?'
  ).get(user, fromTs, toTs);
  const total = totalRow?.n || 0;

  if (!total) {
    console.log(`[newsletter] Saturday reminder: no topics for ${weekKey}, skipping`);
    return;
  }

  const categories = hub.prepare(`
    SELECT category, COUNT(*) as n, SUM(selected) as selected
    FROM intel_items WHERE user = ? AND published_at BETWEEN ? AND ?
    GROUP BY category ORDER BY n DESC
  `).all(user, fromTs, toTs);

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
  const html = buildBriefingPdfHtml(b.text_content, briefingPeriodLabel(b));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({ format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }
}

// ── Creator briefing (from RSS articles) ──────────────────────────────────────

async function generateCreatorBriefing({ user, creatorSlug, creatorName, dateFrom, dateTo }) {
  const hub = db.hub();
  const from = dateFrom || new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
  const to = dateTo || new Date().toISOString().slice(0, 10);
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs = Math.floor(new Date(to + 'T23:59:59').getTime() / 1000);

  const articles = hub.prepare(`
    SELECT title, url, published_at, content_markdown, word_count
    FROM rss_articles
    WHERE user = ? AND creator_slug = ? AND published_at >= ? AND published_at <= ?
    ORDER BY published_at DESC
    LIMIT 20
  `).all(user, creatorSlug, fromTs, toTs);

  if (!articles.length) throw new Error(`No articles found for ${creatorName} in this date range.`);

  const articleBlocks = articles.map(a => {
    const date = new Date(a.published_at * 1000).toISOString().slice(0, 10);
    const excerpt = (a.content_markdown || '').slice(0, 4000);
    return `## ${a.title} (${date})\n${excerpt}${a.content_markdown.length > 4000 ? '\n\n[…article continues]' : ''}`;
  }).join('\n\n---\n\n');

  const periodLabel = from === to ? from : `${from} to ${to}`;
  const modelId = getSystemModelId('newsletter_briefing', user, 'anthropic/claude-sonnet-4-6');

  const prompt = `${getSystemPrompt('newsletter_briefing', user, PROMPTS.newsletter_briefing)}

Creator: ${creatorName}
Period: ${from} to ${to}

---
${articleBlocks}`;

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 6000,
    }),
  });

  if (!r.ok) throw new Error(`Creator briefing LLM ${r.status}`);
  const data = await r.json();
  const text = data.choices[0].message.content.trim();
  const html = markdownToHtml(text, `${creatorName} — ${periodLabel}`);

  const id = uuid();
  hub.prepare(`
    INSERT INTO nl_briefings (id, user, week_key, format_id, topic_count, html_content, text_content, date_from, date_to)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(id, user, `creator-${creatorSlug}-${from}`, articles.length, html, text, from, to);

  return { id, text, html, articleCount: articles.length };
}

module.exports = {
  getWeekKey,
  weekKeyLabel,
  weekKeyRange,
  normalizeBriefingRange,
  dateRangeLabel,
  briefingPeriodLabel,
  topicFallsInRange,
  isNewsletter,
  isApprovedExternalEmail,
  extractTopicsFromEmail,
  backfillFromLabels,
  previewBriefing,
  generateBriefing,
  generateCreatorBriefing,
  buildBriefingPdf,
  sendBriefing,
  sendWeeklyReminder,
};
