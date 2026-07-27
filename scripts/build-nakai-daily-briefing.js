'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('../lib/fetch');
const { PROMPTS } = require('../lib/prompts');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { runSubscriptionText } = require('../lib/subscription-agent');
const { captureNakaiDailyBriefing } = require('../lib/knowledge-format');
const { getRefAtoms } = require('../lib/nakai-ref-synthesis');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'data', 'nakai-briefings');
const OUT_DIR = process.env.NAKAI_DAILY_BRIEFING_WORK_DIR || path.join(STORE_DIR, '.work');
const START_DATE = process.env.NAKAI_DAILY_BRIEFING_START_DATE || '2026-06-19';
const MODEL_TIMEOUT_MS = parseInt(process.env.NAKAI_DAILY_BRIEFING_TIMEOUT_MS || '180000', 10);
const FALLBACK_MODEL_ID = process.env.NAKAI_DAILY_BRIEFING_FALLBACK_MODEL || 'google/gemini-2.5-flash';
const FALLBACK_TIMEOUT_MS = parseInt(process.env.NAKAI_DAILY_BRIEFING_FALLBACK_TIMEOUT_MS || '120000', 10);

function briefingMeta(date = new Date()) {
  const now = date instanceof Date ? date : new Date(date);
  const iso = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const label = now.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Dublin',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const edition = editionForDate(iso);
  const title = edition ? `Daily Briefing ${edition}` : 'Daily Briefing';
  const previousEdition = previousEditionFor(edition);
  // asOfEpoch is the exact moment this edition is being built — real "now"
  // for the live daily run, or a historical instant when rebuilding a past
  // edition. The source pack's 48h window is computed relative to this, not
  // wall-clock now, so a rebuild can't leak later items into an earlier date.
  return { iso, label, edition, title, previousEdition, asOfEpoch: Math.floor(now.getTime() / 1000) };
}

function editionForDate(isoDate) {
  const start = Date.parse(`${START_DATE}T00:00:00Z`);
  const current = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start) return null;
  const days = Math.floor((current - start) / 86400000) + 1;
  return String(days).padStart(3, '0');
}

function previousEditionFor(edition) {
  if (!edition) return null;
  const n = Number(edition);
  if (!Number.isFinite(n) || n <= 1) return null;
  return String(n - 1).padStart(3, '0');
}

function adminBaseUrl() {
  return process.env.HUB_URL || 'https://dchat.mclellan.scot';
}

function resendUrl(edition) {
  return edition ? `${adminBaseUrl().replace(/\/$/, '')}/admin/nakai-briefings/${edition}/resend` : '';
}

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}


// Standing audit-horizon context — compiled from nakai_ref_atoms (DB).
// Bootstrap atoms are used immediately; synthesis job upgrades them to LLM-compiled versions.
function standingContextMarkdown() {
  const atoms = getRefAtoms();
  if (!atoms.length) return '';
  return atoms.map(a => {
    const lines = [
      `[${a.source_key}] ${a.title}`,
      `URL: ${a.url}`,
    ];
    if (a.is_bootstrap) lines.push('(Bootstrap context — pending live synthesis)');
    lines.push(a.content || '');
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

function alertIntelMarkdown(asOfEpoch = Math.floor(Date.now() / 1000)) {
  const hub = require('../lib/db').hub();
  const since = asOfEpoch - 72 * 3600;
  const rows = hub.prepare(`
    SELECT i.id, i.title, i.summary, i.source_url, i.published_at, i.category,
           d.source_kind, d.sender_name, d.sender_email,
           s.name AS source_name, s.briefing_priority
    FROM intel_items i
    JOIN intel_documents d ON d.id = i.document_id
    LEFT JOIN intel_sources s ON s.id = d.source_id
    WHERE i.published_at >= ? AND i.published_at <= ?
      AND i.user IN ('nakai', 'douglas')
      AND i.selected = 1
      AND COALESCE(s.briefing_priority, 3) <= 3
      AND (
        lower(COALESCE(s.name, '')) LIKE '%fca%'
        OR lower(COALESCE(s.name, '')) LIKE '%esma%'
        OR lower(COALESCE(s.name, '')) LIKE '%financial times%'
        OR lower(COALESCE(s.name, '')) LIKE '%myft%'
        OR lower(COALESCE(d.sender_email, '')) LIKE '%fca.org.uk%'
        OR lower(COALESCE(d.sender_email, '')) LIKE '%esma%'
        OR lower(COALESCE(d.sender_email, '')) LIKE '%ft.com%'
        OR lower(COALESCE(d.sender_email, '')) LIKE '%news-alerts.ft.com%'
        OR lower(COALESCE(d.sender_email, '')) LIKE '%newsletters.ft.com%'
      )
    ORDER BY COALESCE(s.briefing_priority, 3), i.published_at DESC
    LIMIT 20
  `).all(since, asOfEpoch);

  if (!rows.length) return '';
  const dateStr = d => new Date(d * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin',
  });
  return rows.map((item, i) => [
    `[I${i + 1}] ${item.title}`,
    `Source: ${item.source_name || item.sender_name || item.sender_email || item.source_kind || 'email/RSS'}`,
    item.source_kind ? `Source kind: ${item.source_kind}` : '',
    item.category ? `Category: ${item.category}` : '',
    item.source_url ? `URL: ${item.source_url}` : '',
    item.published_at ? `Published/received: ${dateStr(item.published_at)}` : '',
    item.summary ? `Summary: ${String(item.summary).replace(/\s+/g, ' ').slice(0, 700)}` : '',
    'Use note: press/email intelligence is context only unless the source is an official regulator/government item.',
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');
}

// Live source pack — reads from reg_monitor_items (last 48 hours as of
// asOfEpoch) so the briefing reflects what the regulatory monitor actually
// found overnight. asOfEpoch defaults to now (the live daily run); a rebuild
// of a past edition passes the historical cutoff so it doesn't pull in items
// found after that edition's date.
function liveSourcePackMarkdown(asOfEpoch = Math.floor(Date.now() / 1000)) {
  const db = require('../lib/db');
  const hub = db.hub();
  // Primary window: 48h. If monitor hasn't run recently, fall back to last 100
  // items as of that cutoff regardless of age so the briefing is never built
  // from nothing (and a historical rebuild never leaks future-dated items).
  const since48h = asOfEpoch - 48 * 3600;
  let items = hub.prepare(`
    SELECT id, site, title, url, synopsis, found_at,
           publication_type, priority, why_it_matters, ireland_eu_relevance,
           source_kind, external_id, detail_json
    FROM reg_monitor_items
    WHERE found_at >= ? AND found_at <= ?
      AND is_relevant = 1
      AND title NOT LIKE '%View in Irish%'
      AND url NOT LIKE '%/ga/%'
    ORDER BY found_at DESC
    LIMIT 80
  `).all(since48h, asOfEpoch);

  let staleFallback = false;
  if (!items.length) {
    items = hub.prepare(`
      SELECT id, site, title, url, synopsis, found_at,
             publication_type, priority, why_it_matters, ireland_eu_relevance,
             source_kind, external_id, detail_json
      FROM reg_monitor_items
      WHERE found_at <= ?
        AND is_relevant = 1
        AND title NOT LIKE '%View in Irish%'
        AND url NOT LIKE '%/ga/%'
      ORDER BY found_at DESC
      LIMIT 80
    `).all(asOfEpoch);
    staleFallback = true;
  }

  if (!items.length) return { text: '', staleFallback: false, ids: [] };

  const dateStr = d => new Date(d * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin',
  });

  const text = items.map((item, i) => {
    const lines = [
      `[L${i + 1}] ${item.title}`,
      `Source: ${item.site}`,
      item.source_kind && item.source_kind !== 'web' ? `Source kind: ${item.source_kind}` : '',
      item.external_id ? `External ID: ${item.external_id}` : '',
      item.publication_type ? `Publication type: ${item.publication_type}` : '',
      item.priority ? `Priority: ${item.priority}` : '',
      `URL: ${item.url}`,
      `Found: ${dateStr(item.found_at)}`,
    ].filter(Boolean);
    if (item.synopsis) lines.push(`Synopsis: ${item.synopsis}`);
    if (item.why_it_matters) lines.push(`Why it matters: ${item.why_it_matters}`);
    if (item.ireland_eu_relevance) lines.push(`Ireland/EU relevance: ${item.ireland_eu_relevance}`);
    if (item.detail_json && item.detail_json !== '{}') lines.push(`Structured details: ${item.detail_json}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  // ids[i] is the DB row id for citation [L{i+1}] — used after generation to
  // mark which checked items actually made it into the briefing.
  return { text, staleFallback, ids: items.map(item => item.id) };
}

function sourcePackMarkdown(asOfEpoch) {
  const { text: live, staleFallback, ids } = liveSourcePackMarkdown(asOfEpoch);
  const alertIntel = alertIntelMarkdown(asOfEpoch);
  const standing = standingContextMarkdown();
  const parts = [];
  if (live) {
    const label = staleFallback
      ? 'LIVE REGULATORY MONITOR OUTPUT (most recent available — monitor may not have run today)'
      : 'LIVE REGULATORY MONITOR OUTPUT (last 48 hours)';
    parts.push(`## ${label}\n\n${live}`);
  } else {
    parts.push('## LIVE REGULATORY MONITOR OUTPUT\n\nNo items found in database.');
  }
  if (alertIntel) {
    parts.push('## REGULATOR / PRESS EMAIL-RSS INTELLIGENCE (last 72 hours; summaries only)\n\n' + alertIntel);
  }
  parts.push('## AUDIT HORIZON — STANDING CONTEXT (evergreen reference, not today\'s news)\n\n' + standing);
  return { text: parts.join('\n\n═══\n\n'), liveIds: ids };
}

function fallbackBriefing(meta = briefingMeta()) {
  const editionLine = meta.previousEdition
    ? `\nPrevious edition: Daily Briefing ${meta.previousEdition}`
    : meta.edition
      ? '\nPrevious edition: none'
      : '';
  return `# ${meta.title}

${meta.label}${editionLine}

## Notice

This edition could not be generated — the OpenRouter API key is not set or the LLM call failed. The regulatory monitor is running and storing new items; once the API connection is restored the next edition will be built from live content.

Check OPENROUTER_API_KEY in the Hub environment and retry via the admin resend action.`;
}

function briefingModelAttempts(primaryModelId) {
  const attempts = [
    {
      modelId: primaryModelId,
      timeout: Number.isFinite(MODEL_TIMEOUT_MS) ? MODEL_TIMEOUT_MS : 180000,
      role: 'primary',
    },
    {
      modelId: FALLBACK_MODEL_ID,
      timeout: Number.isFinite(FALLBACK_TIMEOUT_MS) ? FALLBACK_TIMEOUT_MS : 120000,
      role: 'fallback',
    },
  ];
  return attempts.filter((attempt, index) => (
    attempt.modelId && attempts.findIndex(candidate => candidate.modelId === attempt.modelId) === index
  ));
}

async function requestBriefingMarkdown({ prompt, userContent, primaryModelId }) {
  const failures = [];
  try {
    const local = await runSubscriptionText({ feature: 'nakai_daily_briefing', systemPrompt: prompt, userPrompt: userContent, timeoutMs: MODEL_TIMEOUT_MS });
    if (local) {
      if (!/^# Daily Briefing/m.test(local.text)) throw new Error('local Opus response did not contain a Daily Briefing');
      console.log(`[nakai-briefing] subscription generation succeeded (${local.runner}/${local.model}/${local.effort})`);
      return local.text;
    }
  } catch (err) {
    failures.push(`subscription: ${err.message}`);
    console.warn(`[nakai-briefing] subscription runner failed; using OpenRouter fallback: ${err.message}`);
  }
  for (const attempt of briefingModelAttempts(primaryModelId)) {
    try {
      const started = Date.now();
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        timeout: attempt.timeout,
        headers: openRouterHeaders(TASK_CODES.NAKAI_DAILY_BRIEFING),
        body: JSON.stringify({
          model: attempt.modelId,
          temperature: 0.2,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userContent },
          ],
        }),
      });
      if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
      const data = await r.json();
      logUsageFromResponse({
        user: 'nakai',
        feature: 'nakai-daily-briefing',
        modelKey: 'nakai_daily_briefing',
        fallbackModelId: attempt.modelId,
        data,
        durationMs: Date.now() - started,
        taskCode: TASK_CODES.NAKAI_DAILY_BRIEFING,
      });
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text || !/^# Daily Briefing/m.test(text)) {
        throw new Error('Model response did not contain a Daily Briefing');
      }
      if (attempt.role === 'fallback') {
        console.warn(`[nakai-briefing] recovered with fallback model ${attempt.modelId}`);
      }
      return text;
    } catch (err) {
      failures.push(`${attempt.modelId}: ${err.message}`);
      console.warn(`[nakai-briefing] ${attempt.role} model ${attempt.modelId} failed: ${err.message}`);
    }
  }
  throw new Error(`Briefing generation failed after model fallback (${failures.join('; ')})`);
}

async function generateMarkdown(meta = briefingMeta()) {
  loadDotEnv();
  if (process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD && fs.existsSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD)) {
    return { text: fs.readFileSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD, 'utf8'), liveIds: [] };
  }
  const prompt = getSystemPrompt('nakai_daily_briefing', 'system', PROMPTS.nakai_daily_briefing);
  const modelId = getSystemModelId('nakai_daily_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const editionContext = meta.edition
    ? `Briefing edition: ${meta.edition}\nPrevious edition: ${meta.previousEdition || 'none'}\nResend admin action: ${resendUrl(meta.edition)}\n`
    : '';
  const previousContext = previousEditionContext(meta);
  const pack = sourcePackMarkdown(meta.asOfEpoch);
  const fullPrompt = `${prompt}\n\nCurrent date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${pack.text}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md'), fullPrompt, 'utf8');

  if (process.env.NAKAI_DAILY_BRIEFING_FORCE_FALLBACK) return { text: fallbackBriefing(meta), liveIds: pack.liveIds };
  if (require('../lib/subscription-agent-jobs').enabled()) {
    const queued = require('../lib/subscription-agent-jobs').enqueue({
      feature: 'nakai_daily_briefing',
      dedupeKey: meta.edition || meta.iso,
      payload: {
        meta, liveIds: pack.liveIds, prompt,
        userPrompt: `Current date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${pack.text}`,
      },
    });
    return { queued: true, ...queued, liveIds: pack.liveIds };
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

  try {
    const text = await requestBriefingMarkdown({
      prompt,
      userContent: `Current date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${pack.text}`,
      primaryModelId: modelId,
    });
    return { text, liveIds: pack.liveIds };
  } catch (err) {
    if (process.env.NAKAI_DAILY_BRIEFING_ALLOW_STATIC_FALLBACK === '1') {
      console.warn(`[nakai-briefing] model generation failed, using fallback: ${err.message}`);
      return { text: fallbackBriefing(meta), liveIds: pack.liveIds };
    }
    throw err;
  }
}

async function renderPdf(markdown, meta = briefingMeta()) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const normalized = normalizeForBriefingPdf(stripEditorialLeakage(markdown), meta);
  const html = buildBriefingPdfHtml(normalized, meta.label, meta.title)
    .replace(/Douglas McLellan/g, 'Nakai McLellan')
    .replace(/Technology Leader/g, 'Block EU Intelligence')
    .replace(/douglas\.mclellan\.scot/g, 'Private briefing');

  const fileStem = meta.edition
    ? `nakai-daily-briefing-${meta.edition}-${meta.iso}`
    : `nakai-daily-briefing-${meta.iso}`;
  const htmlPath = path.join(OUT_DIR, `${fileStem}.html`);
  const mdPath = path.join(OUT_DIR, `${fileStem}.md`);
  const pdfPath = path.join(OUT_DIR, `${fileStem}.pdf`);
  fs.writeFileSync(mdPath, normalized, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(pdfPath, pdf);
    return { pdfPath, mdPath, htmlPath };
  } finally {
    await browser.close();
  }
}

function normalizeForBriefingPdf(markdown, meta = briefingMeta()) {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let skippedTitle = false;
  let skippedDate = false;

  for (let line of lines) {
    if (!skippedTitle && /^#\s+Daily Briefing(?:\s+\d{3})?\s*$/i.test(line.trim())) {
      skippedTitle = true;
      continue;
    }
    if (skippedTitle && !skippedDate && line.trim() === meta.label) {
      skippedDate = true;
      continue;
    }
    if (/^\s*\*\s+/.test(line)) line = line.replace(/^\s*\*\s+/, '- ');
    out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripEditorialLeakage(markdown) {
  return String(markdown || '')
    .replace(/;\s*ignore Irish-language duplicates when English versions exist/gi, '')
    .replace(/\bFor the briefing workflow,\s*English-language Central Bank items are enough;\s*Irish-language duplicates should be ignored\.?\s*/gi, '')
    .replace(/\bIrish-language duplicates should be ignored for this briefing workflow\.?\s*/gi, '')
    .replace(/\bThis is a source-selection rule only:.*?(?:\n|$)/gi, '');
}

function nakaiEmail() {
  const raw = process.env.NAKAI_GOOGLE_EMAILS || process.env.NAKAI_GOOGLE_EMAIL || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean)[0] || '';
}

function storedDir(edition) {
  if (!edition || !/^\d{3}$/.test(String(edition))) throw new Error(`Invalid edition: ${edition}`);
  return path.join(STORE_DIR, String(edition));
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function archiveBriefing(result, meta) {
  if (!meta.edition) return null;
  const dir = storedDir(meta.edition);
  fs.mkdirSync(dir, { recursive: true });
  const stored = {
    edition: meta.edition,
    date: meta.iso,
    label: meta.label,
    title: meta.title,
    previousEdition: meta.previousEdition,
    mdPath: path.join(dir, 'briefing.md'),
    htmlPath: path.join(dir, 'briefing.html'),
    pdfPath: path.join(dir, 'briefing.pdf'),
    promptPath: path.join(dir, 'prompt.md'),
    generatedAt: new Date().toISOString(),
    sentAt: null,
    to: null,
  };
  fs.writeFileSync(stored.mdPath, withArchiveMarkdownHeader(fs.readFileSync(result.mdPath, 'utf8'), meta), 'utf8');
  fs.copyFileSync(result.htmlPath, stored.htmlPath);
  fs.copyFileSync(result.pdfPath, stored.pdfPath);
  const promptPath = path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md');
  if (fs.existsSync(promptPath)) fs.copyFileSync(promptPath, stored.promptPath);
  const prior = readJson(path.join(dir, 'manifest.json'), {});
  const manifest = { ...prior, ...stored, sentAt: prior.sentAt || null, to: prior.to || null };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeBriefingIndex();
  return manifest;
}

function withArchiveMarkdownHeader(markdown, meta) {
  const text = String(markdown || '')
    .trim()
    .replace(/^(?:Previous edition:\s*(?:none|Daily Briefing \d{3})\s*\n+)+/i, '')
    .trim();
  if (/^#\s+Daily Briefing(?:\s+\d{3})?/i.test(text)) return `${text}\n`;
  const lines = [`# ${meta.title}`, '', meta.label];
  if (meta.previousEdition) lines.push('', `Previous edition: Daily Briefing ${meta.previousEdition}`);
  else if (meta.edition) lines.push('', 'Previous edition: none');
  lines.push('', text, '');
  return lines.join('\n');
}

function listStoredBriefings() {
  if (!fs.existsSync(STORE_DIR)) return [];
  return fs.readdirSync(STORE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map(entry => readJson(path.join(STORE_DIR, entry.name, 'manifest.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.edition).localeCompare(String(a.edition)));
}

function getStoredBriefing(edition) {
  const manifest = readJson(path.join(storedDir(edition), 'manifest.json'), null);
  if (!manifest) throw new Error(`Stored briefing ${edition} not found`);
  return manifest;
}

function previousEditionContext(meta) {
  if (!meta.previousEdition) return '';
  try {
    const prior = getStoredBriefing(meta.previousEdition);
    const markdown = fs.readFileSync(prior.mdPath, 'utf8').slice(0, 12000);
    return `Previous edition context for continuity (Daily Briefing ${meta.previousEdition}; use for cross-reference, do not repeat unchanged material):\n\n${markdown}\n\n`;
  } catch (_) {
    return `Previous edition context: Daily Briefing ${meta.previousEdition} is expected but no stored copy was found.\n`;
  }
}

function writeBriefingIndex() {
  const list = listStoredBriefings().sort((a, b) => String(a.edition).localeCompare(String(b.edition)));
  const lines = [
    '# Nakai Daily Briefing Archive',
    '',
    'Private operational archive. Use the Hub admin page to resend a stored briefing to Nakai.',
    '',
    ...list.map(item => `- Daily Briefing ${item.edition} - ${item.label} - ${item.sentAt ? `sent ${item.sentAt}` : 'not sent'}`),
    '',
  ];
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STORE_DIR, 'index.md'), lines.join('\n'), 'utf8');
}

function markSent(edition, to) {
  const manifest = getStoredBriefing(edition);
  const updated = { ...manifest, sentAt: new Date().toISOString(), to };
  writeJson(path.join(storedDir(edition), 'manifest.json'), updated);
  writeBriefingIndex();
  return updated;
}

function assertStoredBriefingPdf(manifest) {
  if (!manifest?.pdfPath) throw new Error(`Daily Briefing ${manifest?.edition || ''} has no stored PDF path`);
  if (!fs.existsSync(manifest.pdfPath)) {
    throw new Error(`Daily Briefing ${manifest.edition} PDF is missing: ${manifest.pdfPath}`);
  }
  const pdf = fs.readFileSync(manifest.pdfPath);
  if (pdf.length < 1024 || pdf.slice(0, 4).toString('utf8') !== '%PDF') {
    throw new Error(`Daily Briefing ${manifest.edition} PDF is not a valid PDF artifact`);
  }
  return pdf;
}

function buildStoredBriefingEmailPayload(manifest, pdfBuffer = assertStoredBriefingPdf(manifest)) {
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  const link = resendUrl(manifest.edition);
  const subject = `${manifest.title} - ${manifest.label}`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f5ff;">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px;font-family:Arial,sans-serif;color:#272432;">
    <div style="height:5px;background:#7c6af5;border-radius:6px 6px 0 0;"></div>
    <div style="background:#fff;border:1px solid #ece9fa;border-top:0;padding:24px 26px;border-radius:0 0 6px 6px;">
      <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#7c6af5;">McLellan Hub Intelligence</p>
      <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:28px;line-height:1.15;color:#15131e;">${escHtml(manifest.title)}</h1>
      <p style="margin:0 0 18px;font-size:15px;color:#6b6879;">${escHtml(manifest.label)}</p>
      <p style="margin:0 0 14px;font-size:14px;line-height:1.6;">The PDF report is attached.</p>
      <p style="margin:0;font-size:12px;color:#777381;">Stored private copy: Daily Briefing ${escHtml(manifest.edition)} · <a href="${link}" style="color:#5b4ac4;">resend</a></p>
    </div>
  </div>
</body></html>`;

  return {
    subject,
    text: [
      `${manifest.title} - ${manifest.label}`,
      '',
      'The PDF report is attached.',
      '',
      `Stored copy: Daily Briefing ${manifest.edition}`,
      `Resend: ${link}`,
      '',
      '---',
      markdown,
    ].join('\n'),
    html,
    attachments: [{
      filename: `Daily Briefing ${manifest.edition}.pdf`,
      content_type: 'application/pdf',
      content: pdfBuffer.toString('base64'),
    }],
  };
}

async function sendStoredBriefing(edition, { force = false } = {}) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  if (manifest.sentAt && !force) return { ok: true, skipped: true, manifest };
  const to = nakaiEmail();
  if (!to) throw new Error('No Nakai email configured. Set NAKAI_GOOGLE_EMAIL or NAKAI_GOOGLE_EMAILS.');
  const { sendEmail } = require('../lib/gmail');
  const fromUser = process.env.NAKAI_DAILY_BRIEFING_GMAIL_USER || 'douglas';
  const payload = buildStoredBriefingEmailPayload(manifest);
  await sendEmail(fromUser, to, payload.subject, payload);
  return { ok: true, skipped: false, manifest: markSent(edition, to) };
}

// Marks which checked items actually made it into the generated briefing by
// scanning for their [Lx] citation marker. Items that were relevant but not
// cited are left alone (audit email reports them as "relevant, not selected").
function markCitationInclusion(markdown, liveIds, edition) {
  if (!liveIds.length || !edition) return [];
  const hub = require('../lib/db').hub();
  const included = [];
  liveIds.forEach((id, i) => {
    const marker = `[L${i + 1}]`;
    if (markdown.includes(marker)) {
      hub.prepare('UPDATE reg_monitor_items SET included_in_briefing = ? WHERE id = ?').run(edition, id);
      included.push(id);
    }
  });
  return included;
}

async function buildNakaiDailyBriefing({ date = new Date() } = {}) {
  const meta = briefingMeta(date);
  const generated = await generateMarkdown(meta);
  if (generated.queued) return { queued: true, jobId: generated.jobId, meta };
  const { text: markdown, liveIds } = generated;
  return finalizeNakaiDailyBriefing({ meta, markdown, liveIds });
}

async function finalizeNakaiDailyBriefing({ meta, markdown, liveIds = [] }) {
  const result = await renderPdf(markdown, meta);
  result.includedItemIds = markCitationInclusion(markdown, liveIds, meta.edition);
  try {
    result.knowledgePath = captureNakaiDailyBriefing({
      markdown: fs.readFileSync(result.mdPath, 'utf8'),
      dateSlug: meta.iso,
      edition: meta.edition,
      htmlPath: result.htmlPath,
      pdfPath: result.pdfPath,
    });
  } catch (err) {
    console.warn(`[nakai-briefing] knowledge capture failed: ${err.message}`);
  }
  result.meta = meta;
  result.archive = archiveBriefing(result, meta);
  return result;
}

async function completeRemoteNakaiDailyBriefing(payload, markdown) {
  const text = String(markdown || '').trim();
  if (!/^# Daily Briefing/m.test(text)) throw new Error('remote Opus response did not contain a Daily Briefing');
  const result = await finalizeNakaiDailyBriefing({ meta: payload.meta, markdown: text, liveIds: payload.liveIds || [] });
  await sendStoredBriefing(payload.meta.edition, { force: false });
  return { edition: payload.meta.edition, archive: result.archive, execution: 'subscription_remote', runner: 'claude', model: 'opus', effort: 'high' };
}

async function sendTodayNakaiDailyBriefing({ force = false, date = new Date() } = {}) {
  const meta = briefingMeta(date);
  if (!meta.edition) {
    console.log(`[nakai-briefing] schedule not active before ${START_DATE} (${meta.iso})`);
    return { ok: true, skipped: true, reason: 'before-start-date', meta };
  }
  const existing = listStoredBriefings().find(item => item.edition === meta.edition);
  const built = existing ? null : await buildNakaiDailyBriefing({ date });
  if (built?.queued) return { ok: true, queued: true, jobId: built.jobId, meta };
  const manifest = existing || built?.archive;
  if (!manifest) throw new Error(`Could not build Daily Briefing ${meta.edition}`);
  return sendStoredBriefing(meta.edition, { force });
}

async function main() {
  const result = await buildNakaiDailyBriefing();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  START_DATE,
  briefingMeta,
  buildNakaiDailyBriefing,
  completeRemoteNakaiDailyBriefing,
  sendTodayNakaiDailyBriefing,
  sendStoredBriefing,
  listStoredBriefings,
  getStoredBriefing,
  assertStoredBriefingPdf,
  buildStoredBriefingEmailPayload,
  resendUrl,
  _test: {
    alertIntelMarkdown,
    sourcePackMarkdown,
    briefingModelAttempts,
  },
};
