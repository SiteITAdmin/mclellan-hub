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
const { captureNakaiDailyBriefing } = require('../lib/knowledge-format');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'data', 'nakai-briefings');
const OUT_DIR = process.env.NAKAI_DAILY_BRIEFING_WORK_DIR || path.join(STORE_DIR, '.work');
const START_DATE = process.env.NAKAI_DAILY_BRIEFING_START_DATE || '2026-06-19';
const MODEL_TIMEOUT_MS = parseInt(process.env.NAKAI_DAILY_BRIEFING_TIMEOUT_MS || '180000', 10);

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
  return { iso, label, edition, title, previousEdition };
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

// Audit-horizon standing context only — evergreen FCA/CBI/PRA/EBA guidance
// that defines the audit framework. NOT news. Live news comes from reg_monitor_items.
const sources = [
  {
    id: 'S16',
    title: 'FCA: Our Consumer Duty focus areas',
    date: 'Published 30 September 2025, updated 7 May 2026',
    url: 'https://www.fca.org.uk/publications/corporate-documents/consumer-duty-focus-areas',
    notes: [
      'The FCA says the Consumer Duty remains a priority under its 2025 to 2030 strategy to deepen trust, rebalance risk, support growth and improve lives.',
      'The page sets out 2025 to 2026 priorities for embedding the Duty, support for firms and sector-specific focus areas.',
      'This is a high-credibility audit-horizon source for Consumer Duty planning because it signals current FCA supervisory emphasis rather than only the original rules.',
    ],
  },
  {
    id: 'S17',
    title: 'FCA: Year 2 Consumer Duty Board Reports - progress and what comes next',
    date: 'April 2026',
    url: 'https://www.fca.org.uk/news/blogs/year-2-consumer-duty-board-reports-progress-and-what-comes-next',
    notes: [
      'The FCA says firms increasingly set out comprehensive action plans, with clear responsibilities, timelines and progress updates.',
      'The FCA says most reports now identify accountable owners for improvements and track delivery status so Boards can monitor progress more systematically.',
      'Audit relevance: board reporting should evidence ownership, outcome monitoring, action tracking, governance challenge and closure discipline.',
    ],
  },
  {
    id: 'S18',
    title: 'FCA: Consumer understanding - good practice and areas for improvement',
    date: 'March 2026',
    url: 'https://www.fca.org.uk/publications/good-and-poor-practice/consumer-understanding-good-practice-areas-improvement',
    notes: [
      'The FCA says firms should make communication design, testing, monitoring and governance a coherent end-to-end process.',
      'This is directly relevant to Consumer Duty audits of customer journeys, disclosures, fees, product terms, complaints and support channels.',
      'Audit relevance: test whether communications are designed, tested, monitored and escalated using evidence rather than assumed to be understandable.',
    ],
  },
  {
    id: 'S19',
    title: "FCA blog: What do we mean when we say 'fair value'?",
    date: 'February 2026',
    url: 'https://www.fca.org.uk/news/blogs/what-do-we-mean-when-we-say-fair-value',
    notes: [
      'The FCA frames fair value as whether customers are paying a reasonable price for a product compared with the benefits they get in return.',
      'The FCA says firms need evidence that customers are getting a fair deal; if they cannot provide it, they need to look again.',
      'Audit relevance: fair value work should connect pricing, fees, customer cohorts, benefits, outcomes data, complaints and remedial action.',
    ],
  },
  {
    id: 'S20',
    title: 'FCA: Operational resilience - insights and observations one year on',
    date: '27 March 2026',
    url: 'https://www.fca.org.uk/publications/good-and-poor-practice/operational-resilience-insights-observations-one-year',
    notes: [
      'The FCA tells firms to continue complying with operational resilience rules and to use observations from self-assessments to review and evolve their approach.',
      'The FCA highlights important business services, impact tolerances and the need for clear shared understanding of each service and how disruption could cause intolerable harm to consumers or threaten market integrity.',
      'Audit relevance: test service definitions, impact tolerances, mapping, scenario testing, vulnerabilities, remediation, self-assessment quality and senior ownership.',
    ],
  },
  {
    id: 'S21',
    title: 'FCA: Operational resilience',
    date: 'Updated June 2026',
    url: 'https://www.fca.org.uk/firms/operational-resilience',
    notes: [
      'The FCA says firms in scope had until 31 March 2025 to ensure they could operate important business services within impact tolerances.',
      'The page links the operational resilience regime to cyber resilience observations and incident reporting preparations.',
      'Audit relevance: the post-transition question is no longer whether mapping exists, but whether the firm can evidence operation within tolerances under severe but plausible scenarios.',
    ],
  },
  {
    id: 'S22',
    title: 'FCA: Reporting operational incidents',
    date: '18 March 2026',
    url: 'https://www.fca.org.uk/firms/operational-resilience/reporting-operational-incidents',
    notes: [
      'The FCA says firms should prepare for new reporting rules coming into force on 18 March 2027.',
      'The page is relevant to material operational incident governance, escalation thresholds, data capture and regulatory reporting readiness.',
      'Audit relevance: test whether incident taxonomy, escalation, MI, ownership and reporting playbooks are aligned to the forthcoming regime.',
    ],
  },
  {
    id: 'S23',
    title: 'Bank of England/PRA: PS7/26 Operational incident and third-party reporting',
    date: 'March 2026',
    url: 'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/march/operational-incident-and-third-party-reporting-policy-statement',
    notes: [
      'The PRA policy statement covers operational incident reporting and material third-party arrangement reporting.',
      'The PRA says flexibility is important because the same operational incident may have varying impacts across firms depending on size, business model, services or customer base.',
      'Audit relevance: test materiality judgements, third-party inventory completeness, incident severity assessment, governance challenge and reporting evidence.',
    ],
  },
  {
    id: 'S24',
    title: 'PRA Business Plan 2026/27',
    date: 'April 2026',
    url: 'https://www.bankofengland.co.uk/prudential-regulation/publication/2026/april/pra-business-plan-2026-27',
    notes: [
      'The PRA says its operational resilience policy was fully implemented in March 2025.',
      'During 2026/27 the PRA will continue robust supervisory standards through operational and cyber resilience assessments such as CBEST, working with the National Cyber Security Centre.',
      'Audit relevance: UK operational resilience audit work should consider cyber resilience, testing, remediation and evidence of senior-level oversight.',
    ],
  },
  {
    id: 'S25',
    title: 'Central Bank of Ireland: Digital Operational Resilience Act (DORA)',
    date: 'Updated 2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora',
    notes: [
      'The Central Bank says DORA has applied since 17 January 2025 and applies to a wide range of financial entities regulated by the Central Bank of Ireland.',
      'The Central Bank says DORA brings together provisions addressing digital operational risk in the financial sector in a consistent manner.',
      'Audit relevance: DORA audit work should cover ICT risk management, incident reporting, resilience testing, third-party ICT risk and governance ownership.',
    ],
  },
  {
    id: 'S26',
    title: 'Central Bank of Ireland: Operational Resilience',
    date: 'Updated July 2025',
    url: 'https://www.centralbank.ie/financial-system/operational-resilience-and-cyber/operational-resilience',
    notes: [
      'The Central Bank says it updated and republished its operational resilience guidance in July 2025 to align with DORA and withdrew its 2016 IT and cybersecurity risk guidance.',
      'The Central Bank says the guidance explains how to prepare for, respond to, recover and learn from operational disruptions affecting critical or important business services.',
      'Audit relevance: Irish operational resilience audit work should bridge DORA minimum standards with Central Bank expectations on important services and disruption response.',
    ],
  },
  {
    id: 'S27',
    title: 'Central Bank of Ireland: Reporting Registers of Information',
    date: '2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-registers-of-information',
    notes: [
      'The Central Bank says financial entities subject to DORA must submit Registers of Information on contractual arrangements for ICT third-party services.',
      'Audit relevance: test RoI completeness, data lineage, ownership, contract population, validation checks and reconciliation to vendor/outsourcing inventories.',
    ],
  },
  {
    id: 'S28',
    title: 'Central Bank of Ireland: Reporting major ICT-related incidents and significant cyber threats',
    date: '2026',
    url: 'https://www.centralbank.ie/regulation/digital-operational-resilience-act-dora/reporting-major-ict-related-incidents-and-significant-cyber-threats',
    notes: [
      'The Central Bank says financial entities subject to DORA have been obliged since 17 January 2025 to submit major ICT-related incident reports where criteria and thresholds are met.',
      'The page also covers significant cyber-threat submissions.',
      'Audit relevance: test threshold assessment, reporting workflow, incident evidence, cyber-threat escalation and post-incident lessons learned.',
    ],
  },
  {
    id: 'S29',
    title: 'Central Bank of Ireland: Regulatory and Supervisory Outlook 2026',
    date: 'February 2026',
    url: 'https://www.centralbank.ie/publication/regulatory---supervisory-outlook-report',
    notes: [
      'The Central Bank says its 2026 Outlook sets out key trends, risks and regulatory and supervisory priorities for the next two years.',
      'Search-result excerpts from the report highlight DORA, ICT risk management, and maintaining resilient financial services to consumers and investors.',
      'Audit relevance: use the Outlook to frame operational resilience as customer/investor service continuity, not only technology compliance.',
    ],
  },
];

// Standing audit-horizon context — evergreen FCA/CBI/PRA guidance that frames
// audit criteria. These are NOT dated news; they are the reference baseline.
const AUDIT_HORIZON_IDS = ['S16','S17','S18','S19','S20','S21','S22','S23','S24','S25','S26','S27','S28','S29'];

function standingContextMarkdown() {
  return sources
    .filter(s => AUDIT_HORIZON_IDS.includes(s.id))
    .map(s => [
      `[${s.id}] ${s.title}`,
      `Date: ${s.date}`,
      `URL: ${s.url}`,
      'Evidence:',
      ...s.notes.map(n => `- ${n}`),
    ].join('\n')).join('\n\n---\n\n');
}

// Live source pack — reads from reg_monitor_items (last 72 hours) so the
// briefing reflects what the regulatory monitor actually found overnight.
function liveSourcePackMarkdown() {
  const db = require('../lib/db');
  const hub = db.hub();
  // Primary window: 48h. If monitor hasn't run recently, fall back to last 100
  // items regardless of age so the briefing is never built from nothing.
  const since48h = Math.floor(Date.now() / 1000) - 48 * 3600;
  let items = hub.prepare(`
    SELECT site, title, url, synopsis, found_at
    FROM reg_monitor_items
    WHERE found_at >= ?
      AND title NOT LIKE '%View in Irish%'
      AND url NOT LIKE '%/ga/%'
    ORDER BY found_at DESC
    LIMIT 80
  `).all(since48h);

  let staleFallback = false;
  if (!items.length) {
    items = hub.prepare(`
      SELECT site, title, url, synopsis, found_at
      FROM reg_monitor_items
      WHERE title NOT LIKE '%View in Irish%'
        AND url NOT LIKE '%/ga/%'
      ORDER BY found_at DESC
      LIMIT 80
    `).all();
    staleFallback = true;
  }

  if (!items.length) return { text: '', staleFallback: false };

  const dateStr = d => new Date(d * 1000).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin',
  });

  const text = items.map((item, i) => {
    const lines = [
      `[L${i + 1}] ${item.title}`,
      `Source: ${item.site}`,
      `URL: ${item.url}`,
      `Found: ${dateStr(item.found_at)}`,
    ];
    if (item.synopsis) lines.push(`Synopsis: ${item.synopsis}`);
    return lines.join('\n');
  }).join('\n\n---\n\n');

  return { text, staleFallback };
}

function sourcePackMarkdown() {
  const { text: live, staleFallback } = liveSourcePackMarkdown();
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
  parts.push('## AUDIT HORIZON — STANDING CONTEXT (evergreen reference, not today\'s news)\n\n' + standing);
  return parts.join('\n\n═══\n\n');
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

async function generateMarkdown(meta = briefingMeta()) {
  loadDotEnv();
  if (process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD && fs.existsSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD)) {
    return fs.readFileSync(process.env.NAKAI_DAILY_BRIEFING_SOURCE_MD, 'utf8');
  }
  const prompt = getSystemPrompt('nakai_daily_briefing', 'system', PROMPTS.nakai_daily_briefing);
  const modelId = getSystemModelId('nakai_daily_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const editionContext = meta.edition
    ? `Briefing edition: ${meta.edition}\nPrevious edition: ${meta.previousEdition || 'none'}\nResend admin action: ${resendUrl(meta.edition)}\n`
    : '';
  const previousContext = previousEditionContext(meta);
  const fullPrompt = `${prompt}\n\nCurrent date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${sourcePackMarkdown()}`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'nakai-daily-briefing-prompt.md'), fullPrompt, 'utf8');

  if (process.env.NAKAI_DAILY_BRIEFING_FORCE_FALLBACK) return fallbackBriefing(meta);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

  try {
    const started = Date.now();
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      timeout: Number.isFinite(MODEL_TIMEOUT_MS) ? MODEL_TIMEOUT_MS : 180000,
      headers: openRouterHeaders(TASK_CODES.NAKAI_DAILY_BRIEFING),
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Current date: ${meta.label}\n${editionContext}${previousContext}\nSource pack:\n\n${sourcePackMarkdown()}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
    const data = await r.json();
    logUsageFromResponse({
      user: 'nakai',
      feature: 'nakai-daily-briefing',
      modelKey: 'nakai_daily_briefing',
      fallbackModelId: modelId,
      data,
      durationMs: Date.now() - started,
      taskCode: TASK_CODES.NAKAI_DAILY_BRIEFING,
    });
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || !/^# Daily Briefing/m.test(text)) throw new Error('Model response did not contain a Daily Briefing');
    return text;
  } catch (err) {
    if (process.env.NAKAI_DAILY_BRIEFING_ALLOW_STATIC_FALLBACK === '1') {
      console.warn(`[nakai-briefing] model generation failed, using fallback: ${err.message}`);
      return fallbackBriefing(meta);
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

function emailHtml(manifest) {
  const html = fs.readFileSync(manifest.htmlPath, 'utf8');
  const link = resendUrl(manifest.edition);
  const footer = `
<div style="font:13px system-ui,-apple-system,Segoe UI,sans-serif;color:#666;margin:32px 0 0;padding-top:16px;border-top:1px solid #ddd;">
  Daily Briefing ${manifest.edition} · stored private copy.
  <a href="${link}" style="color:#5b4ac4;">Click here to send this briefing to Nakai again</a>.
</div>`;
  return html.includes('</body>') ? html.replace('</body>', `${footer}</body>`) : `${html}${footer}`;
}

async function sendStoredBriefing(edition, { force = false } = {}) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  if (manifest.sentAt && !force) return { ok: true, skipped: true, manifest };
  const to = nakaiEmail();
  if (!to) throw new Error('No Nakai email configured. Set NAKAI_GOOGLE_EMAIL or NAKAI_GOOGLE_EMAILS.');
  const { sendEmail } = require('../lib/gmail');
  const fromUser = process.env.NAKAI_DAILY_BRIEFING_GMAIL_USER || 'douglas';
  const pdf = fs.readFileSync(manifest.pdfPath);
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  const subject = `${manifest.title} - ${manifest.label}`;
  await sendEmail(fromUser, to, subject, {
    text: `${markdown}\n\n---\nStored copy: Daily Briefing ${manifest.edition}\nResend: ${resendUrl(manifest.edition)}`,
    html: emailHtml(manifest),
    attachments: [{
      filename: `Daily Briefing ${manifest.edition}.pdf`,
      content_type: 'application/pdf',
      content: pdf.toString('base64'),
    }],
  });
  return { ok: true, skipped: false, manifest: markSent(edition, to) };
}

async function buildNakaiDailyBriefing({ date = new Date() } = {}) {
  const meta = briefingMeta(date);
  const markdown = await generateMarkdown(meta);
  const result = await renderPdf(markdown, meta);
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

async function sendTodayNakaiDailyBriefing({ force = false, date = new Date() } = {}) {
  const meta = briefingMeta(date);
  if (!meta.edition) {
    console.log(`[nakai-briefing] schedule not active before ${START_DATE} (${meta.iso})`);
    return { ok: true, skipped: true, reason: 'before-start-date', meta };
  }
  const existing = listStoredBriefings().find(item => item.edition === meta.edition);
  const manifest = existing || (await buildNakaiDailyBriefing({ date })).archive;
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
  sendTodayNakaiDailyBriefing,
  sendStoredBriefing,
  listStoredBriefings,
  getStoredBriefing,
  resendUrl,
};
