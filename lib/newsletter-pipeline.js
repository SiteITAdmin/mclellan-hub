'use strict';

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { fetchEmailsByLabel } = require('./gmail');
const { sendEmail: amSend } = require('./agentmail');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { logUsageFromResponse } = require('./openrouter-usage');

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

function briefingFormatName(briefing) {
  return String(
    briefing?.format_name
    || briefing?.resolved_format_name
    || briefing?.linked_format_name
    || 'Intelligence Briefing'
  ).trim();
}

function briefingTitle(briefing) {
  return `${briefingFormatName(briefing)} — ${briefingPeriodLabel(briefing)}`;
}

function briefingPdfFilename(briefing) {
  const slug = briefingTitle(briefing)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
  return `${slug || 'intelligence-briefing'}.pdf`;
}

function modelDisplayName(modelId) {
  if (!modelId) return 'Unknown model';
  try {
    const row = db.hub().prepare(`
      SELECT label FROM model_config
      WHERE model_id = ?
      ORDER BY enabled DESC, display_order
      LIMIT 1
    `).get(modelId);
    if (row?.label) return row.label;
  } catch (_) {}
  const words = String(modelId).split('/').pop().replace(/[-_]+/g, ' ')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bgemini\b/gi, 'Gemini')
    .replace(/\bdeepseek\b/gi, 'DeepSeek')
    .replace(/\bgrok\b/gi, 'Grok')
    .replace(/\bsonnet\b/gi, 'Sonnet')
    .replace(/\bhaiku\b/gi, 'Haiku')
    .replace(/\bopus\b/gi, 'Opus')
    .replace(/\bflash\b/gi, 'Flash')
    .replace(/\blite\b/gi, 'Lite')
    .replace(/\bgpt\s+/gi, 'GPT-');
  return words.replace(/\b(\d+) (\d+)\b/g, '$1.$2');
}

function parseBriefingProvenance(briefing) {
  try {
    const parsed = JSON.parse(briefing?.provenance_json || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function briefingProvenanceText(briefing) {
  const provenance = parseBriefingProvenance(briefing);
  if (!provenance?.writer?.label) return '';
  const sourceCount = Number(provenance.source_count || 0);
  const itemCount = Number(provenance.item_count || 0);
  const parts = [`Briefing written by ${provenance.writer.label} using ${itemCount} item${itemCount === 1 ? '' : 's'} from ${sourceCount} external source${sourceCount === 1 ? '' : 's'}`];
  const extraction = (provenance.extraction_models || []).map(model =>
    `${model.label} extracted ${model.item_count} item${model.item_count === 1 ? '' : 's'} from ${model.source_count} source${model.source_count === 1 ? '' : 's'}`
  );
  if (extraction.length) parts.push(`AI extraction: ${extraction.join('; ')}`);
  if (provenance.direct_ingestion?.item_count) {
    const direct = provenance.direct_ingestion;
    parts.push(`${direct.item_count} item${direct.item_count === 1 ? ' was' : 's were'} ingested directly from RSS`);
  }
  if (provenance.unattributed_item_count) {
    const count = provenance.unattributed_item_count;
    parts.push(`extraction provenance was unavailable for ${count} legacy or fallback item${count === 1 ? '' : 's'}`);
  }
  return `${parts.join('. ')}.`;
}

function buildBriefingProvenance(items, writerModelId) {
  const sourceNames = [...new Set(items.map(item =>
    item.source_name || item.sender_name || item.sender_email || item.document_title
  ).filter(Boolean))];
  const extractionMap = new Map();
  let directItems = 0;
  const directSources = new Set();
  let unattributedItems = 0;

  for (const item of items) {
    const sourceName = item.source_name || item.sender_name || item.sender_email || item.document_title;
    if (item.extraction_method === 'direct_rss') {
      directItems++;
      if (sourceName) directSources.add(sourceName);
      continue;
    }
    if (!item.extraction_model_id) {
      unattributedItems++;
      continue;
    }
    const key = item.extraction_model_id;
    const current = extractionMap.get(key) || {
      model_id: key,
      label: item.extraction_model_label || modelDisplayName(key),
      item_count: 0,
      sources: new Set(),
    };
    current.item_count++;
    if (sourceName) current.sources.add(sourceName);
    extractionMap.set(key, current);
  }

  return {
    version: 1,
    writer: {
      model_id: writerModelId,
      label: modelDisplayName(writerModelId),
    },
    item_count: items.length,
    source_count: sourceNames.length,
    sources: sourceNames,
    extraction_models: [...extractionMap.values()].map(model => ({
      model_id: model.model_id,
      label: model.label,
      item_count: model.item_count,
      source_count: model.sources.size,
    })),
    direct_ingestion: {
      item_count: directItems,
      source_count: directSources.size,
      method: directItems ? 'rss' : null,
    },
    unattributed_item_count: unattributedItems,
  };
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
  let actualModelId = modelId;
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
      logUsageFromResponse({
        user,
        feature: 'newsletter_extractor',
        modelKey: 'newsletter_extractor',
        fallbackModelId: modelId,
        data,
      });
      actualModelId = data.model || modelId;
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
    console.error(`[newsletter] extraction failed for "${email.subject}" after retry; storing full source as one item`);
  }
  if (!topics.length) {
    topics = [{
      title: email.subject,
      summary: `Full external publication from ${email.fromName || email.fromEmail}.`,
      content: contentText,
      item_type: 'article',
      category: 'Other',
      entities: [],
      themes: [],
      source_url: email.sourceUrl || null,
    }];
  }
  const inserted = [];
  const ins = hub.prepare(`
    INSERT INTO intel_items
      (id, user, document_id, title, summary, content_text, item_type, category,
       entities_json, themes_json, source_url, published_at, extraction_model_id,
       extraction_model_label, extraction_method, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
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
      Number(email.receivedAt) || Math.floor(Date.now() / 1000),
      extractionError ? null : actualModelId,
      extractionError ? null : modelDisplayName(actualModelId),
      extractionError ? 'direct_fallback' : 'ai'
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
           d.source_kind, s.name AS source_name,
           COALESCE(i.source_url, d.source_url) AS resolved_url
    FROM intel_items i
    JOIN intel_documents d ON d.id = i.document_id
    LEFT JOIN intel_sources s ON s.id = d.source_id
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
    .slice(0, 60);

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
{"matches":[{"id":"...","relevance":"direct|context","reason":"maximum 12 words"}]}

Include direct reporting and genuinely useful context. Exclude coincidental keyword matches, internal operational material, generic AI news, and items that do not help answer the request. Return at most ${limit} matches.

Candidates:
${JSON.stringify(catalogue)}`,
        }],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: 3000,
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
  const usedItems = [];
  for (const item of items) {
    const remaining = evidenceLimit - evidenceChars;
    if (remaining <= 0) break;
    const content = String(item.content_text || item.summary || '').slice(0, Math.min(12000, remaining));
    const source = item.sender_name || item.sender_email || 'External source';
    const url = item.resolved_url ? `\nURL: ${item.resolved_url}` : '';
    evidence.push(`## ${item.title}\nSource: ${source} — ${item.document_title}${url}\nType: ${item.item_type}; Category: ${item.category || 'Other'}\nRelevance: ${item.relevance_reason || 'Matched the request'}\n\n${content}`);
    evidenceChars += content.length;
    usedItems.push(item);
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
  logUsageFromResponse({
    user,
    feature: 'newsletter_briefing',
    modelKey: 'newsletter_briefing',
    fallbackModelId: modelId,
    data,
  });
  const actualWriterModelId = data.model || modelId;
  const text = data.choices[0].message.content.trim();
  const provenance = buildBriefingProvenance(usedItems, actualWriterModelId);
  const provenanceJson = JSON.stringify(provenance);
  const html = markdownToHtml(text, periodLabel, format.name, provenance);

  // Store briefing
  const id = uuid();
  hub.prepare(`
    INSERT INTO nl_briefings
      (id, user, week_key, format_id, format_name, topic_count, html_content, text_content,
       date_from, date_to, writer_model_id, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, weekKey || getWeekKey(new Date(`${from}T12:00:00Z`)),
    format.id, format.name, usedItems.length, html, text, from, to, actualWriterModelId, provenanceJson);

  return {
    id, text, html, topicCount: usedItems.length, formatName: format.name,
    periodLabel, dateFrom: from, dateTo: to, provenance,
  };
}

// ── Simple markdown → HTML for email ─────────────────────────────────────────

function markdownToHtml(md, periodLabel, formatName = 'Intelligence Briefing', provenance = null) {
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
  .provenance { margin: 0 0 28px; padding: 12px 14px; border-left: 3px solid #7c6af5; background: #f7f5ff; color: #666174; font: 12px/1.55 sans-serif; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #e5e3f0; font-size: 13px; color: #888; font-family: sans-serif; }
</style>
</head>
<body>
<h1>${escHtml(formatName)} — ${escHtml(periodLabel)}</h1>
${provenance ? `<div class="provenance">${escHtml(briefingProvenanceText({ provenance_json: JSON.stringify(provenance) }))}</div>` : ''}
${body}
<div class="footer">Generated by McLellan Hub · <a href="https://dchat.mclellan.scot/newsletter">Review topics</a></div>
</body>
</html>`;
}

// ── Send briefing via AgentMail ───────────────────────────────────────────────

async function sendBriefing({ user, briefingId }) {
  const hub = db.hub();
  const briefing = hub.prepare(`
    SELECT b.*, f.name AS linked_format_name
    FROM nl_briefings b
    LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.id = ? AND b.user = ?
  `).get(briefingId, user);
  if (!briefing) throw new Error('Briefing not found');

  const toEmail = process.env.AGENTMAIL_TO_DOUGLAS || 'aio.mclellan@gmail.com';
  const subject = briefingTitle(briefing);
  const pdf = await renderBriefingPdf(briefing);
  const filename = briefingPdfFilename(briefing);

  await amSend({
    to: toEmail,
    subject,
    text: `${briefing.text_content}\n\n---\n${briefingProvenanceText(briefing)}`.trim(),
    html: markdownToHtml(
      briefing.text_content,
      briefingPeriodLabel(briefing),
      briefingFormatName(briefing),
      parseBriefingProvenance(briefing)
    ),
    attachments: [{
      filename,
      content_type: 'application/pdf',
      content: Buffer.from(pdf).toString('base64'),
    }],
  });

  hub.prepare('UPDATE nl_briefings SET sent_at = unixepoch() WHERE id = ?').run(briefingId);
  console.log(`[newsletter] briefing sent to ${toEmail}: ${subject} (${filename})`);
  return { ok: true, to: toEmail, subject, filename };
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
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
}

function mdToReportHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (!listType) return;
    out.push(`</${listType}>`);
    listType = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^## /.test(line)) {
      closeList();
      out.push(`<h2 class="rpt-h2">${inlineMd(line.slice(3))}</h2>`);
    } else if (/^### /.test(line)) {
      closeList();
      out.push(`<h3 class="rpt-h3">${inlineMd(line.slice(4))}</h3>`);
    } else if (/^- /.test(line)) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul class="rpt-list rpt-ul">');
        listType = 'ul';
      }
      out.push(`<li class="rpt-li">${inlineMd(line.slice(2))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol class="rpt-list rpt-ol">');
        listType = 'ol';
      }
      out.push(`<li class="rpt-li">${inlineMd(line.replace(/^\d+\. /, ''))}</li>`);
    } else if (/^> /.test(line)) {
      closeList();
      out.push(`<blockquote class="rpt-quote">${inlineMd(line.slice(2))}</blockquote>`);
    } else if (/^---+$/.test(line)) {
      closeList();
      out.push('<hr class="rpt-rule">');
    } else if (line === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p class="rpt-p">${inlineMd(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildBriefingPdfHtml(textContent, weekLabel, formatName = 'Intelligence Briefing', provenance = null) {
  const contentHtml = mdToReportHtml(textContent);
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const PUR = '#7c6af5';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,700;0,800;1,700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#272432}
@page cover{size:A4;margin:0}
@page report{size:A4;margin:25mm 19mm 23mm}

/* Cover */
.cover{page:cover;width:210mm;height:297mm;display:flex;flex-direction:column;position:relative;overflow:hidden;background:#fff;break-after:page}
.cover-bar{height:2.5mm;background:${PUR};flex-shrink:0}
.cover-orbit{position:absolute;width:112mm;height:112mm;border:1px solid #ded8ff;border-radius:50%;right:-43mm;top:24mm}
.cover-orbit::before,.cover-orbit::after{content:'';position:absolute;border-radius:50%;border:1px solid #eeeaff}
.cover-orbit::before{inset:13mm}.cover-orbit::after{inset:27mm}
.cover-block{position:absolute;width:21mm;height:21mm;background:${PUR};right:17mm;top:69.5mm;border-radius:4mm;transform:rotate(12deg);box-shadow:0 8mm 20mm rgba(124,106,245,.18)}
.cover-body{flex:1;padding:21mm 21mm 17mm;display:flex;flex-direction:column;position:relative;z-index:1}
.cover-label{font-size:8pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:${PUR};margin-bottom:38mm}
.cover-title{font-family:'Playfair Display',Georgia,serif;font-size:52pt;font-weight:800;line-height:1.02;color:#15131e;margin-bottom:9mm;max-width:155mm}
.cover-rule{width:15mm;height:1.2mm;background:${PUR};border-radius:2mm;margin-bottom:8mm}
.cover-week{font-size:18pt;font-weight:600;color:#4d4a5a;margin-bottom:3mm}
.cover-date{font-size:10pt;color:#8a8693}
.cover-spacer{flex:1}
.cover-footer{padding-top:6mm;border-top:1px solid #e9e6ee;display:flex;justify-content:space-between}
.cover-footer span{font-size:8.5pt;color:#777381}

/* Content */
.report{page:report}
.report-masthead,.report-end{display:flex;justify-content:space-between;color:#8a8693;font-size:7.5pt}
.report-masthead{align-items:flex-start;margin-bottom:12mm;padding-bottom:4mm;border-bottom:1px solid #e9e6ee;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.report-masthead .brand{color:${PUR}}
.report-end{align-items:flex-end;margin-top:12mm;padding-top:4mm;border-top:1px solid #e9e6ee;break-inside:avoid;page-break-inside:avoid}
.content-inner{width:100%}
.provenance{margin:0 0 10mm;padding:4mm 5mm;border-left:1.2mm solid ${PUR};background:#f7f5ff;color:#666174;font-size:8.5pt;line-height:1.55;break-inside:avoid;page-break-inside:avoid}
.provenance-label{display:block;margin-bottom:1.5mm;color:${PUR};font-size:7.5pt;font-weight:800;letter-spacing:.12em;text-transform:uppercase}

/* Report elements */
.rpt-h2{font-family:'Playfair Display',Georgia,serif;font-size:23pt;font-weight:700;line-height:1.12;color:#15131e;margin:12mm 0 5mm;padding:0 0 4mm;border-bottom:1.2mm solid ${PUR};break-after:avoid;page-break-after:avoid}
.rpt-h2:first-child{margin-top:0}
.rpt-h3{font-size:8.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.13em;color:${PUR};margin:7mm 0 2.5mm;break-after:avoid;page-break-after:avoid}
.rpt-p{font-size:10.5pt;line-height:1.72;color:#3d3b46;margin-bottom:4.2mm;orphans:3;widows:3}
.rpt-p strong{color:#15131e;font-weight:750}
.rpt-p a{color:#5f4bd8;text-decoration-color:#c9c0ff;text-underline-offset:2px}
.rpt-p code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8.8pt;background:#f2f0f6;padding:.4mm 1.2mm;border-radius:1mm}
.rpt-list{margin:3mm 0 6mm;padding:4.5mm 6mm 3.5mm 11mm;background:#faf9fd;border-left:1.2mm solid ${PUR}}
.rpt-ul{list-style:none;padding-left:10mm}
.rpt-ol{padding-left:12mm}
.rpt-li{font-size:10.2pt;line-height:1.65;color:#3d3b46;margin-bottom:2.5mm;position:relative;break-inside:avoid;page-break-inside:avoid}
.rpt-ul .rpt-li::before{content:'';position:absolute;left:-5mm;top:2.4mm;width:2mm;height:2mm;background:${PUR};border-radius:50%}
.rpt-quote{font-family:'Playfair Display',Georgia,serif;font-size:14pt;line-height:1.5;color:#292535;margin:7mm 0;padding:5mm 7mm;border-left:1.2mm solid ${PUR};background:#f7f5ff;break-inside:avoid;page-break-inside:avoid}
.rpt-rule{border:0;height:1px;background:#e9e6ee;margin:9mm 0}
</style></head><body>

<section class="cover">
  <div class="cover-bar"></div>
  <div class="cover-orbit"></div>
  <div class="cover-block"></div>
  <div class="cover-body">
    <div class="cover-label">McLellan Hub · Intelligence</div>
    <div class="cover-title">${escHtml(formatName)}</div>
    <div class="cover-rule"></div>
    <div class="cover-week">${escHtml(weekLabel)}</div>
    <div class="cover-date">Generated ${dateStr}</div>
    <div class="cover-spacer"></div>
    <div class="cover-footer">
      <span>Douglas McLellan</span>
      <span>mclellan.scot</span>
    </div>
  </div>
</section>

<main class="report">
  <div class="report-masthead">
    <span class="brand">McLellan Intelligence</span>
    <span>${escHtml(weekLabel)}</span>
  </div>
  ${provenance ? `<div class="provenance"><span class="provenance-label">Production provenance</span>${escHtml(briefingProvenanceText({ provenance_json: JSON.stringify(provenance) }))}</div>` : ''}
  <div class="content-inner">
    ${contentHtml}
  </div>
  <div class="report-end">
    <span>Douglas McLellan · Technology Leader · Ireland</span>
    <span>douglas.mclellan.scot</span>
  </div>
</main>

</body></html>`;
}

async function renderBriefingPdf(briefing) {
  const puppeteer = require('puppeteer');
  const html = buildBriefingPdfHtml(
    briefing.text_content,
    briefingPeriodLabel(briefing),
    briefingFormatName(briefing),
    parseBriefingProvenance(briefing)
  );
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
}

async function buildBriefingPdf(briefingId, user) {
  const briefing = db.hub().prepare(`
    SELECT b.*, f.name AS linked_format_name
    FROM nl_briefings b
    LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.id = ? AND b.user = ?
  `).get(briefingId, user);
  if (!briefing) throw new Error('Briefing not found');
  return renderBriefingPdf(briefing);
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
  logUsageFromResponse({
    user,
    feature: 'newsletter_briefing',
    modelKey: 'newsletter_briefing',
    fallbackModelId: modelId,
    data,
  });
  const actualWriterModelId = data.model || modelId;
  const text = data.choices[0].message.content.trim();
  const formatName = `${creatorName} Briefing`;
  const provenance = buildBriefingProvenance(articles.map(article => ({
    source_name: creatorName,
    extraction_method: 'direct_rss',
  })), actualWriterModelId);
  const provenanceJson = JSON.stringify(provenance);
  const html = markdownToHtml(text, periodLabel, formatName, provenance);

  const id = uuid();
  hub.prepare(`
    INSERT INTO nl_briefings
      (id, user, week_key, format_id, format_name, topic_count, html_content, text_content,
       date_from, date_to, writer_model_id, provenance_json)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, `creator-${creatorSlug}-${from}`, formatName, articles.length, html, text,
    from, to, actualWriterModelId, provenanceJson
  );

  return { id, text, html, articleCount: articles.length };
}

module.exports = {
  getWeekKey,
  weekKeyLabel,
  weekKeyRange,
  normalizeBriefingRange,
  dateRangeLabel,
  briefingPeriodLabel,
  briefingFormatName,
  briefingTitle,
  briefingPdfFilename,
  parseBriefingProvenance,
  briefingProvenanceText,
  buildBriefingProvenance,
  topicFallsInRange,
  isNewsletter,
  isApprovedExternalEmail,
  extractTopicsFromEmail,
  backfillFromLabels,
  previewBriefing,
  generateBriefing,
  generateCreatorBriefing,
  buildBriefingPdfHtml,
  buildBriefingPdf,
  sendBriefing,
  sendWeeklyReminder,
};
