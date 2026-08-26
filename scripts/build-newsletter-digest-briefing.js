#!/usr/bin/env node
'use strict';

// Newsletter Intelligence Brief — daily PDF from the Douglas Newsletters
// digest account (douglasnewsletters@agentmail.to). Source of truth is the
// captured digest email in email_summaries; synthesis runs on the Mac
// subscription worker (Sonnet slot); PDF render and send happen hub-side.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { buildBriefingPdfHtml } = require('../lib/newsletter-pipeline');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { PROMPTS } = require('../lib/prompts');
const { openRouterHeaders, TASK_CODES } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'data', 'newsletter-briefings');
const OUT_DIR = process.env.NEWSLETTER_BRIEFING_WORK_DIR || path.join(STORE_DIR, '.work');
const START_DATE = process.env.NEWSLETTER_BRIEFING_START_DATE || '2026-08-25';
const DIGEST_SENDER = process.env.NEWSLETTER_DIGEST_SENDER || 'douglasnewsletters@agentmail.to';

const SYSTEM_PROMPT = PROMPTS.newsletter_digest_briefing;
const REQUIRED_HEADINGS = ['Executive Readout', 'Coverage and Source Health', 'Sources'];

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

function isoInDublin(date) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function labelInDublin(date) {
  return new Date(date).toLocaleDateString('en-GB', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'long', year: 'numeric' });
}

// Edition is anchored to the coverage date (the newsletters' own day), not the
// build date, so a digest that lands late still files under its correct day.
function editionForCoverageDate(iso) {
  const start = Date.parse(`${START_DATE}T00:00:00Z`);
  const current = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start) return null;
  return String(Math.floor((current - start) / 86400000) + 1).padStart(3, '0');
}

// "Newsletter digest — Tuesday 25 August 2026 (10 emails)" → coverage ISO date.
function parseDigestSubject(subject) {
  const match = String(subject || '').match(/^Newsletter digest\s+—\s+(.+?)\s*\((\d+)\s+emails?\)\s*$/i);
  if (!match) return null;
  const withoutWeekday = match[1].replace(/^[A-Za-z]+,?\s+/, '');
  const parsed = Date.parse(`${withoutWeekday} 12:00:00 UTC`);
  if (!Number.isFinite(parsed)) return null;
  return { coverageIso: new Date(parsed).toISOString().slice(0, 10), emailCount: Number(match[2]) };
}

function findDigestRows(hub) {
  return hub.prepare(`
    SELECT id, subject, body_text, received_at, gmail_message_id
      FROM email_summaries
     WHERE from_email = ? AND subject LIKE 'Newsletter digest%'
       AND ingestion_status IN ('processed', 'promotion_processed')
     ORDER BY received_at ASC
  `).all(DIGEST_SENDER);
}

// Oldest unbuilt digest first — self-heals days that were missed. A digest is
// built once; identity is the edition derived from its coverage date.
function nextUnbuiltDigest(hub) {
  for (const row of findDigestRows(hub)) {
    const parsed = parseDigestSubject(row.subject);
    if (!parsed) continue;
    const edition = editionForCoverageDate(parsed.coverageIso);
    if (!edition) continue;
    const manifestPath = path.join(storedDir(edition), 'manifest.json');
    if (fs.existsSync(manifestPath)) continue;
    if (!String(row.body_text || '').trim()) continue;
    const meta = {
      edition,
      iso: parsed.coverageIso,
      label: labelInDublin(`${parsed.coverageIso}T12:00:00Z`),
      title: `Newsletter Intelligence Brief ${edition}`,
      emailCount: parsed.emailCount,
      sourceDigestId: row.id,
      sourceSubject: row.subject,
      asOfEpoch: Math.floor(Date.now() / 1000),
    };
    return { meta, text: String(row.body_text), receivedAt: row.received_at };
  }
  return null;
}

function storedDir(edition) {
  if (!/^\d{3}$/.test(String(edition || ''))) throw new Error(`Invalid newsletter briefing edition: ${edition}`);
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
  if (!manifest) throw new Error(`Stored newsletter briefing ${edition} not found`);
  return manifest;
}

async function requestModel(userPrompt) {
  const modelId = getSystemModelId('newsletter_digest_briefing', 'system', 'anthropic/claude-sonnet-4-6');
  const started = Date.now();
  const r = await fetch('hub-model://v1/chat/completions', {
    method: 'POST', timeout: 300000,
    headers: openRouterHeaders(TASK_CODES.NEWSLETTER_BRIEFING),
    body: JSON.stringify({ model: modelId, temperature: 0.2, messages: [
      { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt },
    ] }),
  });
  if (!r.ok) throw new Error(`hub-model HTTP ${r.status}`);
  const data = await r.json();
  logUsageFromResponse({ user: 'douglas', feature: 'newsletter_digest_briefing', modelKey: 'newsletter_digest_briefing', fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.NEWSLETTER_BRIEFING });
  return String(data.choices?.[0]?.message?.content || '').trim();
}

function buildUserPrompt(meta, digestText) {
  return `Current date: ${labelInDublin(Date.now())}
Edition: ${meta.edition}
Coverage date: ${meta.label}
Source emails: ${meta.emailCount}

Complete digest text follows. It has already had sponsor-labelled blocks removed by capture, but tracking links, referral prompts, subscription housekeeping and advertising remain — strip those per your rules.

${digestText}`;
}

async function generateMarkdown({ meta, text }) {
  const userPrompt = buildUserPrompt(meta, text);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `newsletter-briefing-${meta.edition}-prompt.md`), `${SYSTEM_PROMPT}\n\n${userPrompt}`, 'utf8');

  const jobs = require('../lib/subscription-agent-jobs');
  if (jobs.enabled()) {
    const queued = jobs.enqueue({ feature: 'newsletter_digest_briefing', dedupeKey: meta.edition, payload: { meta, systemPrompt: configuredPrompt(), userPrompt } });
    return { queued: true, ...queued };
  }
  if (process.platform !== 'darwin' && process.env.SUBSCRIPTION_AGENT_LOCAL !== '1') throw new Error('No subscription worker configured (SUBSCRIPTION_AGENT_WORKER_ENABLED=1)');
  const markdown = await requestModel(userPrompt);
  return { markdown };
}

function configuredPrompt() {
  return getSystemPrompt('newsletter_digest_briefing', 'system', SYSTEM_PROMPT);
}

function validateMarkdown(markdown, meta) {
  const text = String(markdown || '').trim();
  if (!/^# Newsletter Intelligence Brief/m.test(text)) throw new Error('Newsletter briefing response is missing the required title');
  for (const heading of REQUIRED_HEADINGS) {
    if (!new RegExp(`^## ${heading}$`, 'm').test(text)) throw new Error(`Newsletter briefing response is missing ${heading}`);
  }
  return text;
}

async function renderArtifacts(markdown, meta) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = buildBriefingPdfHtml(markdown, meta.label, meta.title);
  const stem = `newsletter-intelligence-brief-${meta.edition}-${meta.iso}`;
  const mdPath = path.join(OUT_DIR, `${stem}.md`);
  const htmlPath = path.join(OUT_DIR, `${stem}.html`);
  const pdfPath = path.join(OUT_DIR, `${stem}.pdf`);
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(htmlPath, html, 'utf8');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    fs.writeFileSync(pdfPath, await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally { await browser.close(); }
  return { mdPath, htmlPath, pdfPath };
}

function archiveBriefing(artifacts, meta) {
  const dir = storedDir(meta.edition);
  fs.mkdirSync(dir, { recursive: true });
  const paths = { mdPath: path.join(dir, 'briefing.md'), htmlPath: path.join(dir, 'briefing.html'), pdfPath: path.join(dir, 'briefing.pdf'), promptPath: path.join(dir, 'prompt.md') };
  fs.copyFileSync(artifacts.mdPath, paths.mdPath);
  fs.copyFileSync(artifacts.htmlPath, paths.htmlPath);
  fs.copyFileSync(artifacts.pdfPath, paths.pdfPath);
  fs.copyFileSync(path.join(OUT_DIR, `newsletter-briefing-${meta.edition}-prompt.md`), paths.promptPath);
  const prior = readJson(path.join(dir, 'manifest.json'), {});
  const manifest = {
    ...prior, edition: meta.edition, date: meta.iso, label: meta.label, title: meta.title,
    emailCount: meta.emailCount, sourceDigestId: meta.sourceDigestId, sourceSubject: meta.sourceSubject,
    ...paths, generatedAt: new Date().toISOString(), sentAt: prior.sentAt || null, to: prior.to || null,
  };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

async function finalizeBriefing({ meta, markdown }) {
  const text = validateMarkdown(markdown, meta);
  const artifacts = await renderArtifacts(text, meta);
  return archiveBriefing(artifacts, meta);
}

function assertPdf(manifest) {
  const pdf = fs.readFileSync(manifest.pdfPath);
  if (pdf.length < 1024 || pdf.slice(0, 4).toString() !== '%PDF') throw new Error('Stored newsletter briefing PDF is invalid');
  return pdf;
}

function recipient() {
  return String(process.env.NEWSLETTER_BRIEF_TO || 'douglas@mclellan.scot').split(',')[0].trim();
}

function emailPayload(manifest) {
  const markdown = fs.readFileSync(manifest.mdPath, 'utf8');
  return {
    subject: `${manifest.title} - ${manifest.label}`,
    text: `${manifest.title} - ${manifest.label}\n\nThe PDF report is attached.\n\n---\n${markdown}`,
    html: `<div style="max-width:600px;margin:auto;font-family:Arial,sans-serif;color:#1d2433"><div style="height:6px;background:#7c6af5"></div><div style="padding:24px;border:1px solid #dbe4f0;border-top:0"><p style="font-size:11px;font-weight:700;letter-spacing:.12em;color:#7c6af5">MCLELLAN HUB · NEWSLETTER INTELLIGENCE</p><h1 style="font-family:Georgia,serif">${manifest.title}</h1><p>${manifest.label}</p><p>The PDF report is attached.</p></div></div>`,
    attachments: [{ filename: `${manifest.title}.pdf`, content_type: 'application/pdf', content: assertPdf(manifest).toString('base64') }],
  };
}

async function sendStoredBriefing(edition, { force = false } = {}) {
  loadDotEnv();
  const manifest = getStoredBriefing(edition);
  if (manifest.sentAt && !force) return { ok: true, skipped: true, manifest };
  const to = recipient();
  // Sent through AgentMail like the Consigliere report — the newsletter brief
  // is a Hub-generated intelligence product, so it uses the Hub sender.
  await require('../lib/agentmail').sendEmail({ to, ...emailPayload(manifest) });
  const updated = { ...manifest, sentAt: new Date().toISOString(), to };
  writeJson(path.join(storedDir(edition), 'manifest.json'), updated);
  return { ok: true, skipped: false, manifest: updated };
}

async function buildNewsletterDigestBriefing() {
  loadDotEnv();
  const db = require('../lib/db');
  const found = nextUnbuiltDigest(db.hub());
  if (!found) return { skipped: true, reason: 'no unbuilt newsletter digest' };
  const generated = await generateMarkdown(found);
  if (generated.queued) return { queued: true, jobId: generated.jobId, meta: found.meta };
  return { manifest: await finalizeBriefing({ meta: found.meta, markdown: generated.markdown }), meta: found.meta };
}

async function sendTodayNewsletterDigestBriefing({ force = false } = {}) {
  const built = await buildNewsletterDigestBriefing();
  if (built.skipped || built.queued) return built;
  return sendStoredBriefing(built.meta.edition, { force });
}

async function completeRemoteNewsletterDigestBriefing(payload, markdown) {
  const manifest = await finalizeBriefing({ meta: payload.meta, markdown });
  const sent = await sendStoredBriefing(payload.meta.edition);
  return { edition: payload.meta.edition, sentAt: sent.manifest.sentAt, to: sent.manifest.to, pdfPath: manifest.pdfPath, execution: 'subscription_remote' };
}

async function main() {
  const send = process.argv.includes('--send');
  const force = process.argv.includes('--force');
  const result = send ? await sendTodayNewsletterDigestBriefing({ force }) : await buildNewsletterDigestBriefing();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(err => { console.error(err); process.exit(1); });

module.exports = {
  START_DATE, DIGEST_SENDER, parseDigestSubject, editionForCoverageDate, listStoredBriefings,
  getStoredBriefing, validateMarkdown, emailPayload, buildNewsletterDigestBriefing,
  sendTodayNewsletterDigestBriefing, sendStoredBriefing, completeRemoteNewsletterDigestBriefing,
  _test: { nextUnbuiltDigest },
};
