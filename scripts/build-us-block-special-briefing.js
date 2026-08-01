#!/usr/bin/env node
'use strict';

// Scheduled US special edition for Nakai.  The run is deliberately two-stage:
// search results are retained as raw evidence, then a model proposes stories,
// and a deterministic gate decides whether anything is allowed into the
// publication/archive/email stage.  A no-story run is recorded but never sent.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('../lib/fetch');
const { currentInfoSearch } = require('../lib/current-info-search');
const {
  US_STATE_FINANCIAL_REGULATORS,
  US_STATE_AG_NEWSROOMS,
  NAAG_NEWSROOM,
} = require('../lib/us-regulatory-sources');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');
const { runSubscriptionText } = require('../lib/subscription-agent');
const { PROMPTS } = require('../lib/prompts');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'data', 'us-block-briefings');
const CHECK_DIR = path.join(STORE_DIR, 'checks');
const OUT_DIR = process.env.US_BLOCK_BRIEFING_WORK_DIR || path.join(STORE_DIR, '.work');
const SOURCE_SCAN_DAYS = Number(process.env.US_BLOCK_BRIEFING_SOURCE_DAYS || 8);
const SEARCH_CONCURRENCY = Number(process.env.US_BLOCK_BRIEFING_SEARCH_CONCURRENCY || 8);
const MODEL_TIMEOUT_MS = Number(process.env.US_BLOCK_BRIEFING_TIMEOUT_MS || 180000);
const PRODUCTS = ['Block Inc', 'Cash App', 'Square', 'Afterpay', 'Clearpay', 'Bitkey', 'Proto', 'TIDAL'];
const PRODUCT_RE = /\bBlock(?:,?\s+Inc(?:orporated)?\.?)?\b|Cash App|Square|Afterpay|Clearpay|Bitkey|Proto|TIDAL/i;
const SYSTEM_PROMPT = `You are the editor of a private US Block special edition for Nakai at Block.

Use only the supplied official US authority/newsroom search evidence. Decide whether there is at least one current, genuine government, regulator, or attorney-general story materially about Block Inc or one of its products: Cash App, Square, Afterpay/Clearpay, Bitkey, Proto, or TIDAL.

Do not publish for a generic crypto story, a story about another company, a source homepage, a search result whose snippet merely contains a broad keyword, or an item where the Block connection is speculative. Require a direct Block/product connection and high confidence. If no item clears that bar, set publish=false and return an empty stories array.

Return ONLY JSON with this shape:
{"publish":true|false,"decision_reason":"short evidence-based reason","stories":[{"title":"...","url":"...","block_product":"...","what_happened":"...","why_it_matters":"...","source_markers":["U1"],"confidence":"high|medium|low"}]}

Every source marker must refer to the supplied source pack. Never invent URLs, dates, actions, or source markers.`;

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function dateMeta(date = new Date()) {
  const now = date instanceof Date ? date : new Date(date);
  const iso = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const label = now.toLocaleDateString('en-GB', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'long', year: 'numeric' });
  return { iso, label, title: 'US Block Special Edition', asOfEpoch: Math.floor(now.getTime() / 1000) };
}

function allSources() {
  return [
    ...US_STATE_FINANCIAL_REGULATORS.map(source => ({ ...source, kind: 'financial-regulator' })),
    ...US_STATE_AG_NEWSROOMS.map(source => ({ ...source, kind: 'attorney-general-newsroom' })),
    { ...NAAG_NEWSROOM, kind: 'national-attorneys-general' },
  ];
}

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function sameHost(url, sourceUrl) {
  const host = hostname(url); const sourceHost = hostname(sourceUrl);
  return !!host && !!sourceHost && (host === sourceHost || host.endsWith(`.${sourceHost}`));
}

function searchQuery(source, meta) {
  const after = new Date((meta.asOfEpoch - SOURCE_SCAN_DAYS * 86400) * 1000).toISOString().slice(0, 10);
  return `site:${hostname(source.url)} ("Block Inc" OR "Block, Inc." OR "Cash App" OR Square OR Afterpay OR Clearpay OR Bitkey OR Proto OR TIDAL) after:${after}`;
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length); let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

async function scanSource(source, meta) {
  const query = searchQuery(source, meta);
  const result = await currentInfoSearch(query, { provider: 'auto', days: SOURCE_SCAN_DAYS, limit: 8 });
  return {
    source: source.name,
    sourceUrl: source.url,
    kind: source.kind,
    host: hostname(source.url),
    query,
    provider: result.provider,
    warning: result.warning || null,
    results: (result.sources || [])
      .filter(item => sameHost(item.url, source.url))
      .map(item => ({ ...item, source: source.name, sourceUrl: source.url, kind: source.kind })),
  };
}

async function buildSourcePack(meta = dateMeta()) {
  loadDotEnv();
  const scans = await mapLimit(allSources(), SEARCH_CONCURRENCY, source => scanSource(source, meta));
  const byUrl = new Map();
  for (const scan of scans) {
    for (const item of scan.results) {
      const text = `${item.title || ''} ${item.snippet || ''}`;
      if (!PRODUCT_RE.test(text) || byUrl.has(item.url)) continue;
      byUrl.set(item.url, item);
    }
  }
  const items = [...byUrl.values()].slice(0, 120).map((item, index) => ({ ...item, marker: `U${index + 1}` }));
  const text = items.length
    ? items.map(item => [
      `[${item.marker}] ${String(item.title || '').slice(0, 280)}`,
      `Source: ${item.source}`,
      `Source kind: ${item.kind}`,
      `URL: ${item.url}`,
      item.publishedAt ? `Published: ${item.publishedAt}` : '',
      `Provider: ${item.provider || 'search'}`,
      item.snippet ? `Evidence: ${String(item.snippet).replace(/\s+/g, ' ').slice(0, 900)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n---\n\n')
    : 'No same-domain candidate stories matched the Block/product terms in the scan window.';
  return {
    checkedAt: new Date().toISOString(),
    windowDays: SOURCE_SCAN_DAYS,
    sourceCount: scans.length,
    sourceScans: scans.map(scan => ({ source: scan.source, sourceUrl: scan.sourceUrl, kind: scan.kind, provider: scan.provider, resultCount: scan.results.length, warning: scan.warning })),
    items,
    text,
  };
}

function checkPath(meta) { return path.join(CHECK_DIR, `${meta.iso}.json`); }
function readJson(filePath, fallback = null) { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; } }
function writeJson(filePath, value) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8'); }

function parseDecision(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch { return { publish: false, decision_reason: 'Model returned invalid JSON; publication suppressed.', stories: [] }; }
}

function gateDecision(decision, pack) {
  const validMarkers = new Set(pack.items.map(item => item.marker));
  const itemsByUrl = new Map(pack.items.map(item => [item.url, item]));
  const stories = Array.isArray(decision?.stories) ? decision.stories : [];
  const validStories = stories.filter(story => {
    const sourceMarkers = Array.isArray(story.source_markers) ? story.source_markers.filter(marker => validMarkers.has(marker)) : [];
    const evidence = sourceMarkers.map(marker => pack.items.find(item => item.marker === marker)).filter(Boolean).map(item => `${item.title} ${item.snippet}`).join(' ');
    const product = String(story.block_product || '').trim();
    return String(story.title || '').trim()
      && itemsByUrl.has(story.url)
      && sourceMarkers.length > 0
      && String(story.confidence || '').toLowerCase() === 'high'
      && PRODUCTS.some(name => product.toLowerCase().includes(name.toLowerCase()))
      // The published headline itself must name Block/a product. A separate
      // source snippet cannot rescue a generic headline selected by the model.
      && PRODUCT_RE.test(story.title)
      && PRODUCT_RE.test(evidence);
  }).map(story => ({
    title: String(story.title).trim().slice(0, 280),
    url: story.url,
    block_product: String(story.block_product).trim().slice(0, 100),
    what_happened: String(story.what_happened || '').trim().slice(0, 900),
    why_it_matters: String(story.why_it_matters || '').trim().slice(0, 900),
    source_markers: [...new Set(story.source_markers.filter(marker => validMarkers.has(marker)))],
    confidence: 'high',
  }));
  const publish = decision?.publish === true && validStories.length > 0;
  return {
    publish,
    stories: publish ? validStories : [],
    decision_reason: publish
      ? String(decision.decision_reason || 'A high-confidence Block-related US story cleared the publication gate.').trim().slice(0, 500)
      : (String(decision?.decision_reason || 'No high-confidence direct Block story cleared the publication gate.').trim().slice(0, 500)),
  };
}

function renderMarkdown(meta, decision, pack) {
  const lines = [`# ${meta.title}`, '', meta.label, '', '## Executive Readout', '', decision.decision_reason, '', '## Block-related US developments', ''];
  for (const story of decision.stories) {
    lines.push(`### ${story.title}`, '', `**Product:** ${story.block_product}`, '', story.what_happened || 'No additional event detail was supplied.', '', `**Why it matters:** ${story.why_it_matters || 'Assess the operational, product, legal, and control implications for Block.'}`, '', `**Source:** ${story.source_markers.map(marker => `[${marker}]`).join(' ')}`, '');
  }
  lines.push('## Sources', '');
  const used = new Set(decision.stories.flatMap(story => story.source_markers));
  for (const item of pack.items.filter(item => used.has(item.marker))) lines.push(`- [${item.marker}] [${item.title}](${item.url}) — ${item.source}`);
  return lines.join('\n').trim() + '\n';
}

async function requestOpenRouter(userPrompt) {
  const modelId = getSystemModelId('us_block_special_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', timeout: MODEL_TIMEOUT_MS, headers: openRouterHeaders(TASK_CODES.US_BLOCK_SPECIAL_BRIEFING),
    body: JSON.stringify({ model: modelId, temperature: 0.1, messages: [{ role: 'system', content: getSystemPrompt('us_block_special_briefing', 'system', SYSTEM_PROMPT) }, { role: 'user', content: userPrompt }] }),
  });
  if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
  const data = await response.json();
  logUsageFromResponse({ user: 'nakai', feature: 'us-block-special-briefing', modelKey: 'us_block_special_briefing', fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.US_BLOCK_SPECIAL_BRIEFING });
  return String(data.choices?.[0]?.message?.content || '').trim();
}

function storedDir(meta) { return path.join(STORE_DIR, meta.iso); }

async function renderArtifacts(markdown, meta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = buildBriefingPdfHtml(markdown, meta.label, meta.title);
  const mdPath = path.join(OUT_DIR, `us-block-special-${meta.iso}.md`);
  const htmlPath = path.join(OUT_DIR, `us-block-special-${meta.iso}.html`);
  const pdfPath = path.join(OUT_DIR, `us-block-special-${meta.iso}.pdf`);
  fs.writeFileSync(mdPath, markdown, 'utf8'); fs.writeFileSync(htmlPath, html, 'utf8');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try { const page = await browser.newPage(); await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 }); fs.writeFileSync(pdfPath, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })); }
  finally { await browser.close(); }
  return { mdPath, htmlPath, pdfPath };
}

function recipient() {
  const raw = process.env.US_BLOCK_BRIEFING_TO || process.env.NAKAI_GOOGLE_EMAILS || process.env.NAKAI_GOOGLE_EMAIL || '';
  return raw.split(',').map(value => value.trim()).filter(Boolean)[0] || '';
}

async function finalizeBriefing({ meta, pack, rawDecision }) {
  const decision = gateDecision(parseDecision(rawDecision), pack);
  const check = { status: decision.publish ? 'published' : 'suppressed', checkedAt: pack.checkedAt, sourceCount: pack.sourceCount, candidateCount: pack.items.length, decision };
  writeJson(checkPath(meta), check);
  if (!decision.publish) return { published: false, decision, checkPath: checkPath(meta) };
  const markdown = renderMarkdown(meta, decision, pack);
  const artifacts = await renderArtifacts(markdown, meta);
  const dir = storedDir(meta); fs.mkdirSync(dir, { recursive: true });
  const manifest = { title: meta.title, date: meta.iso, label: meta.label, generatedAt: new Date().toISOString(), sentAt: null, to: null, ...Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, path.join(dir, path.basename(value))])), sourcePackPath: path.join(dir, 'source-pack.json'), decisionPath: path.join(dir, 'decision.json') };
  fs.copyFileSync(artifacts.mdPath, manifest.mdPath); fs.copyFileSync(artifacts.htmlPath, manifest.htmlPath); fs.copyFileSync(artifacts.pdfPath, manifest.pdfPath);
  writeJson(manifest.sourcePackPath, pack); writeJson(manifest.decisionPath, decision); writeJson(path.join(dir, 'manifest.json'), manifest);
  try { manifest.knowledgePath = require('../lib/knowledge-format').captureUSBlockSpecialBriefing({ markdown, dateSlug: meta.iso, htmlPath: manifest.htmlPath, pdfPath: manifest.pdfPath }); writeJson(path.join(dir, 'manifest.json'), manifest); } catch (err) { console.warn(`[us-block-briefing] knowledge capture failed: ${err.message}`); }
  return { published: true, decision, manifest };
}

async function sendStoredBriefing(meta, { force = false } = {}) {
  const manifest = readJson(path.join(storedDir(meta), 'manifest.json'));
  if (!manifest) return { sent: false, reason: 'not-published' };
  if (manifest.sentAt && !force) return { sent: false, skipped: true, manifest };
  const to = recipient(); if (!to) throw new Error('No US Block briefing recipient configured');
  const pdf = fs.readFileSync(manifest.pdfPath); const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  const payload = { subject: `${manifest.title} - ${manifest.label}`, text: `${manifest.title} - ${manifest.label}\n\n${markdown}`, html: `<p><strong>${manifest.title}</strong></p><p>${manifest.label}</p><p>The PDF report is attached.</p>`, attachments: [{ filename: `${manifest.title}.pdf`, content_type: 'application/pdf', content: pdf.toString('base64') }] };
  await require('../lib/gmail').sendEmail(process.env.NAKAI_DAILY_BRIEFING_GMAIL_USER || 'douglas', to, payload.subject, payload);
  const updated = { ...manifest, sentAt: new Date().toISOString(), to }; writeJson(path.join(storedDir(meta), 'manifest.json'), updated);
  return { sent: true, manifest: updated };
}

async function buildUSBlockSpecialBriefing({ date = new Date() } = {}) {
  loadDotEnv();
  const meta = dateMeta(date); const existing = readJson(checkPath(meta));
  if (existing && ['no-candidates', 'suppressed', 'published', 'queued'].includes(existing.status)) return { skipped: true, reason: existing.status, meta, checkPath: checkPath(meta) };
  const pack = await buildSourcePack(meta);
  if (!pack.items.length) {
    writeJson(checkPath(meta), { status: 'no-candidates', checkedAt: pack.checkedAt, sourceCount: pack.sourceCount, candidateCount: 0, decision: { publish: false, stories: [], decision_reason: 'No same-domain candidate stories matched the Block/product terms.' } });
    return { published: false, reason: 'no-candidates', meta, checkPath: checkPath(meta) };
  }
  const systemPrompt = getSystemPrompt('us_block_special_briefing', 'system', SYSTEM_PROMPT);
  const userPrompt = `Current date: ${meta.label}\n\nSource pack from the last ${SOURCE_SCAN_DAYS} days:\n\n${pack.text}`;
  if (require('../lib/subscription-agent-jobs').enabled()) {
    const queued = require('../lib/subscription-agent-jobs').enqueue({ feature: 'us_block_special_briefing', dedupeKey: meta.iso, payload: { meta, pack, systemPrompt, userPrompt } });
    writeJson(checkPath(meta), { status: 'queued', checkedAt: pack.checkedAt, sourceCount: pack.sourceCount, candidateCount: pack.items.length, jobId: queued.jobId });
    return { queued: true, jobId: queued.jobId, meta };
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error('No subscription worker or OPENROUTER_API_KEY is configured');
  const rawDecision = await requestOpenRouter(userPrompt);
  const finalised = await finalizeBriefing({ meta, pack, rawDecision });
  if (finalised.published) await sendStoredBriefing(meta);
  return { ...finalised, meta };
}

async function sendTodayUSBlockBriefing({ date = new Date(), force = false } = {}) {
  const meta = dateMeta(date); const existing = readJson(checkPath(meta));
  if (!existing || !['published', 'suppressed', 'no-candidates', 'queued'].includes(existing.status)) {
    const built = await buildUSBlockSpecialBriefing({ date });
    if (built.queued || built.reason === 'no-candidates' || built.skipped) return built;
  }
  if (existing?.status !== 'published' && !readJson(path.join(storedDir(meta), 'manifest.json'))) return { published: false, reason: existing?.status || 'not-published', meta };
  return sendStoredBriefing(meta, { force });
}

async function completeRemoteUSBlockSpecialBriefing(payload, rawDecision) {
  const finalised = await finalizeBriefing({ meta: payload.meta, pack: payload.pack, rawDecision });
  if (!finalised.published) return { published: false, decision: finalised.decision, checkPath: finalised.checkPath };
  const sent = await sendStoredBriefing(payload.meta);
  return { published: true, sentAt: sent.manifest?.sentAt || null, to: sent.manifest?.to || null, manifest: finalised.manifest, execution: 'subscription_remote' };
}

if (require.main === module) {
  buildUSBlockSpecialBriefing().then(result => console.log(JSON.stringify(result, null, 2))).catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  SYSTEM_PROMPT,
  dateMeta,
  buildUSBlockSpecialBriefing,
  sendTodayUSBlockBriefing,
  completeRemoteUSBlockSpecialBriefing,
  _test: { parseDecision, gateDecision, renderMarkdown, searchQuery, sameHost, PRODUCT_RE, allSources },
};
