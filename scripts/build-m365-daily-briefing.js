#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const fetch = require('../lib/fetch');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { buildM365SourcePack } = require('../lib/m365-briefing-sources');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { PROMPTS } = require('../lib/prompts');
const { openRouterHeaders, TASK_CODES } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'data', 'm365-briefings');
const OUT_DIR = process.env.M365_DAILY_BRIEFING_WORK_DIR || path.join(STORE_DIR, '.work');
const START_DATE = process.env.M365_DAILY_BRIEFING_START_DATE || '2026-08-01';

const SYSTEM_PROMPT = PROMPTS.m365_daily_briefing;

function configuredPrompt() {
  return getSystemPrompt('m365_daily_briefing', 'system', SYSTEM_PROMPT);
}

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
  const start = Date.parse(`${START_DATE}T00:00:00Z`);
  const current = Date.parse(`${iso}T00:00:00Z`);
  const edition = Number.isFinite(start) && current >= start ? String(Math.floor((current - start) / 86400000) + 1).padStart(3, '0') : null;
  return { iso, label, edition, title: edition ? `M365 Operations & Security Brief ${edition}` : 'M365 Operations & Security Brief', asOfEpoch: Math.floor(now.getTime() / 1000) };
}

function storedDir(edition) {
  if (!/^\d{3}$/.test(String(edition || ''))) throw new Error(`Invalid M365 briefing edition: ${edition}`);
  return path.join(STORE_DIR, String(edition));
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function listStoredBriefings() {
  if (!fs.existsSync(STORE_DIR)) return [];
  return fs.readdirSync(STORE_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{3}$/.test(entry.name))
    .map(entry => readJson(path.join(STORE_DIR, entry.name, 'manifest.json')))
    .filter(Boolean)
    .sort((a, b) => String(b.edition).localeCompare(String(a.edition)));
}

function getStoredBriefing(edition) {
  const manifest = readJson(path.join(storedDir(edition), 'manifest.json'));
  if (!manifest) throw new Error(`Stored M365 briefing ${edition} not found`);
  return manifest;
}

function previousContext(meta) {
  const prior = String(Number(meta.edition || 1) - 1).padStart(3, '0');
  if (!meta.edition || Number(meta.edition) <= 1) return '';
  try {
    const manifest = getStoredBriefing(prior);
    return `Previous edition for continuity; carry forward only unresolved material:\n\n${fs.readFileSync(manifest.mdPath, 'utf8').slice(0, 10000)}\n\n`;
  } catch { return ''; }
}

async function requestOpenRouter(userPrompt) {
  const modelId = getSystemModelId('m365_daily_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const systemPrompt = configuredPrompt();
  const started = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', timeout: 180000,
    headers: openRouterHeaders(TASK_CODES.M365_DAILY_BRIEFING),
    body: JSON.stringify({ model: modelId, temperature: 0.2, messages: [
      { role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt },
    ] }),
  });
  if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
  const data = await r.json();
  logUsageFromResponse({ user: 'douglas', feature: 'm365-daily-briefing', modelKey: 'm365_daily_briefing', fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.M365_DAILY_BRIEFING });
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function generateMarkdown(meta) {
  const systemPrompt = configuredPrompt();
  const pack = await buildM365SourcePack({ asOfEpoch: meta.asOfEpoch });
  const userPrompt = `Current date: ${meta.label}\nEdition: ${meta.edition}\n\n${previousContext(meta)}Current source pack:\n\n${pack.text}\n\nSource retrieval warnings:\n${pack.warnings.join('\n') || 'none'}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'm365-daily-briefing-prompt.md'), `${systemPrompt}\n\n${userPrompt}`, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'm365-daily-briefing-source-pack.json'), JSON.stringify(pack, null, 2), 'utf8');

  const jobs = require('../lib/subscription-agent-jobs');
  if (jobs.enabled()) {
    const queued = jobs.enqueue({ feature: 'm365_daily_briefing', dedupeKey: meta.edition || meta.iso, payload: { meta, systemPrompt, userPrompt } });
    return { queued: true, ...queued };
  }
  if (!process.env.OPENROUTER_API_KEY) throw new Error('No subscription worker or OPENROUTER_API_KEY is configured');
  const markdown = await requestOpenRouter(userPrompt);
  return { markdown };
}

function validateMarkdown(markdown, meta) {
  const text = String(markdown || '').trim();
  if (!/^# M365 Operations & Security Brief/m.test(text)) throw new Error('M365 briefing response is missing the required title');
  for (const heading of ['Executive Readout', 'Coverage and Source Health', 'Sources']) {
    if (!new RegExp(`^## ${heading}$`, 'm').test(text)) throw new Error(`M365 briefing response is missing ${heading}`);
  }
  const promptPath = path.join(OUT_DIR, 'm365-daily-briefing-source-pack.json');
  const pack = readJson(promptPath, { items: [] });
  const valid = new Set((pack.items || []).map(item => item.marker));
  const cited = [...text.matchAll(/\[S(\d+)\]/g)].map(match => `S${match[1]}`);
  const invalid = [...new Set(cited.filter(marker => !valid.has(marker)))];
  if (invalid.length) throw new Error(`M365 briefing invented citation marker(s): ${invalid.join(', ')}`);
  if (meta.edition && !text.includes(meta.edition)) console.warn(`[m365-briefing] response title omitted edition ${meta.edition}`);
  return text;
}

async function renderArtifacts(markdown, meta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = buildBriefingPdfHtml(markdown, meta.label, meta.title);
  const stem = `m365-operations-security-brief-${meta.edition}-${meta.iso}`;
  const mdPath = path.join(OUT_DIR, `${stem}.md`);
  const htmlPath = path.join(OUT_DIR, `${stem}.html`);
  const pdfPath = path.join(OUT_DIR, `${stem}.pdf`);
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    fs.writeFileSync(pdfPath, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally { await browser.close(); }
  return { mdPath, htmlPath, pdfPath };
}

function archiveBriefing(artifacts, meta) {
  const dir = storedDir(meta.edition);
  fs.mkdirSync(dir, { recursive: true });
  const paths = { mdPath: path.join(dir, 'briefing.md'), htmlPath: path.join(dir, 'briefing.html'), pdfPath: path.join(dir, 'briefing.pdf'), promptPath: path.join(dir, 'prompt.md'), sourcePackPath: path.join(dir, 'source-pack.json') };
  fs.copyFileSync(artifacts.mdPath, paths.mdPath);
  fs.copyFileSync(artifacts.htmlPath, paths.htmlPath);
  fs.copyFileSync(artifacts.pdfPath, paths.pdfPath);
  fs.copyFileSync(path.join(OUT_DIR, 'm365-daily-briefing-prompt.md'), paths.promptPath);
  fs.copyFileSync(path.join(OUT_DIR, 'm365-daily-briefing-source-pack.json'), paths.sourcePackPath);
  const prior = readJson(path.join(dir, 'manifest.json'), {});
  const manifest = { ...prior, edition: meta.edition, date: meta.iso, label: meta.label, title: meta.title, ...paths, generatedAt: new Date().toISOString(), sentAt: prior.sentAt || null, to: prior.to || null };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

async function finalizeBriefing({ meta, markdown }) {
  const text = validateMarkdown(markdown, meta);
  const artifacts = await renderArtifacts(text, meta);
  const manifest = archiveBriefing(artifacts, meta);
  try {
    require('../lib/knowledge-format').captureM365DailyBriefing({ markdown: text, dateSlug: meta.iso, edition: meta.edition, htmlPath: manifest.htmlPath, pdfPath: manifest.pdfPath });
  } catch (err) { console.warn(`[m365-briefing] knowledge capture failed: ${err.message}`); }
  return manifest;
}

async function rerenderStoredBriefing(edition) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  const meta = { edition: manifest.edition, iso: manifest.date, label: manifest.label, title: manifest.title };
  const artifacts = await renderArtifacts(markdown, meta);
  fs.copyFileSync(artifacts.mdPath, manifest.mdPath);
  fs.copyFileSync(artifacts.htmlPath, manifest.htmlPath);
  fs.copyFileSync(artifacts.pdfPath, manifest.pdfPath);
  const updated = { ...manifest, rerenderedAt: new Date().toISOString() };
  writeJson(path.join(storedDir(edition), 'manifest.json'), updated);
  return updated;
}

function recipient() {
  const raw = process.env.DOUGLAS_GOOGLE_EMAILS || process.env.DOUGLAS_GOOGLE_EMAIL || process.env.GOOGLE_EMAIL || 'douglas@mclellan.scot';
  return raw.split(',').map(value => value.trim()).filter(Boolean)[0];
}

function assertPdf(manifest) {
  const pdf = fs.readFileSync(manifest.pdfPath);
  if (pdf.length < 1024 || pdf.slice(0, 4).toString() !== '%PDF') throw new Error('Stored M365 briefing PDF is invalid');
  return pdf;
}

// Pulls the "## Rolling Watchlist" markdown table into structured rows. That
// table is already exactly the set of open items the report itself considers
// worth tracking, so it doubles as the source for the one consolidated task's
// subtasks instead of re-deriving "asks" from the narrative prose.
function extractRollingWatchlistItems(markdown) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex(l => l.trim().toLowerCase() === '## rolling watchlist');
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^##\s/.test(l.trim()));
  const body = rest.slice(0, end === -1 ? rest.length : end);
  const rows = [];
  for (const line of body) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || /^\|?\s*-+\s*\|/.test(trimmed)) continue;
    const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.replace(/\*\*/g, '').trim());
    if (cells.length < 2 || cells[0].toLowerCase() === 'item') continue;
    rows.push({ item: cells[0], status: cells[1] || '', why: cells[2] || '' });
  }
  return rows;
}

// One task per edition — "Read M365 Operations & Security Brief NNN" — with
// the Rolling Watchlist rows as subtasks and in the notes, instead of the
// generic CRM sent-mail path turning every open item into its own top-level
// task. sourceId is the edition, so a resend never creates a duplicate.
async function createM365BriefingReadTask(manifest, markdown) {
  try {
    const { createTask, createSubtask } = require('../lib/google-tasks');
    const items = extractRollingWatchlistItems(markdown);
    const notes = items.length
      ? items.map(row => `- ${row.item} (${row.status})${row.why ? `: ${row.why}` : ''}`).join('\n')
      : 'No open Rolling Watchlist items this edition.';
    const created = await createTask('douglas', {
      title: `Read ${manifest.title}`,
      notes: `${notes}\n\nFull report: data/m365-briefings/${manifest.edition}/briefing.pdf`,
      source: 'm365-briefing',
      origin: 'm365-briefing:read-task',
      sourceId: manifest.edition,
    });
    if (!created) return; // already exists for this edition — resend, not a fresh task
    for (const row of items) {
      await createSubtask('douglas', created.localId, `${row.item} (${row.status})`);
    }
  } catch (err) {
    console.warn(`[m365-briefing] read-task creation failed: ${err.message}`);
  }
}

function emailPayload(manifest) {
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  return {
    subject: `${manifest.title} - ${manifest.label}`,
    text: `${manifest.title} - ${manifest.label}\n\nThe PDF report is attached.\n\n---\n${markdown}`,
    html: `<div style="max-width:600px;margin:auto;font-family:Arial,sans-serif;color:#1d2433"><div style="height:6px;background:#2563eb"></div><div style="padding:24px;border:1px solid #dbe4f0;border-top:0"><p style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#2563eb">MCLELLAN HUB · PRIVATE OPERATIONS INTELLIGENCE</p><h1 style="font-family:Georgia,serif">${manifest.title}</h1><p>${manifest.label}</p><p>The PDF report is attached.</p></div></div>`,
    attachments: [{ filename: `${manifest.title}.pdf`, content_type: 'application/pdf', content: assertPdf(manifest).toString('base64') }],
  };
}

async function sendStoredBriefing(edition, { force = false } = {}) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  if (manifest.sentAt && !force) return { ok: true, skipped: true, manifest };
  const to = recipient();
  await require('../lib/gmail').sendEmail('douglas', to, `${manifest.title} - ${manifest.label}`, emailPayload(manifest));
  const updated = { ...manifest, sentAt: new Date().toISOString(), to };
  writeJson(path.join(storedDir(edition), 'manifest.json'), updated);
  await createM365BriefingReadTask(updated, fs.readFileSync(updated.mdPath, 'utf8'));
  return { ok: true, skipped: false, manifest: updated };
}

async function buildM365DailyBriefing({ date = new Date() } = {}) {
  loadDotEnv();
  const meta = dateMeta(date);
  if (!meta.edition) throw new Error(`M365 briefing schedule is not active before ${START_DATE}`);
  const generated = await generateMarkdown(meta);
  if (generated.queued) return { queued: true, jobId: generated.jobId, meta };
  return { manifest: await finalizeBriefing({ meta, markdown: generated.markdown }), meta };
}

async function sendTodayM365DailyBriefing({ force = false, date = new Date() } = {}) {
  const meta = dateMeta(date);
  const existing = listStoredBriefings().find(item => item.edition === meta.edition);
  const built = existing ? null : await buildM365DailyBriefing({ date });
  if (built?.queued) return { ok: true, queued: true, jobId: built.jobId, meta };
  return sendStoredBriefing(meta.edition, { force });
}

async function completeRemoteM365DailyBriefing(payload, markdown) {
  const manifest = await finalizeBriefing({ meta: payload.meta, markdown });
  const sent = await sendStoredBriefing(payload.meta.edition);
  return { edition: payload.meta.edition, sentAt: sent.manifest.sentAt, to: sent.manifest.to, pdfPath: manifest.pdfPath, execution: 'subscription_remote' };
}

async function main() {
  const send = process.argv.includes('--send');
  const force = process.argv.includes('--force');
  const result = send ? await sendTodayM365DailyBriefing({ force }) : await buildM365DailyBriefing();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = { START_DATE, SYSTEM_PROMPT, dateMeta, listStoredBriefings, getStoredBriefing, validateMarkdown, emailPayload, buildM365DailyBriefing, sendTodayM365DailyBriefing, sendStoredBriefing, rerenderStoredBriefing, completeRemoteM365DailyBriefing, _test: { extractRollingWatchlistItems } };
