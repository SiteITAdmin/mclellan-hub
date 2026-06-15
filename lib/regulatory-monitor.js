'use strict';

const fetch      = require('./fetch');
const fs         = require('fs');
const db         = require('./db');
const { randomUUID } = require('crypto');
const { sendEmail }  = require('./gmail');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Sites to monitor ──────────────────────────────────────────────────────────
// Add or remove entries here. url should be the publications/news listing page.
const SITES = [
  { id: 'cbi',  name: 'Central Bank of Ireland',    url: 'https://www.centralbank.ie/news/article' },
  { id: 'fca',  name: 'FCA',                        url: 'https://www.fca.org.uk/news' },
  { id: 'eba',  name: 'EBA',  url: 'https://www.eba.europa.eu/news-press',          browser: true },
  { id: 'esma', name: 'ESMA', url: 'https://www.esma.europa.eu/press-news/esma-news', browser: true },
  { id: 'dof',  name: 'Dept of Finance Ireland',    url: 'https://www.gov.ie/en/news/?from_date=&to_date=&organisation%5B%5D=department-of-finance' },
  // FATF blocks plain HTTP — use Puppeteer, checked monthly only
  { id: 'fatf', name: 'FATF', url: 'https://www.fatf-gafi.org/en/publications.html', browser: true, fortnightly: true },
];

// ── Direct page fetch + link extraction ───────────────────────────────────────
async function scrapeLinks(siteUrl) {
  const r = await fetch(siteUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; McLellan-RegMonitor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 20000,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${siteUrl}`);
  const html   = await r.text();
  const domain = new URL(siteUrl).hostname;
  const links  = new Map(); // url → title

  // Match <a href="...">title</a> — handles both absolute and relative hrefs
  const re = /<a[^>]+href=["']([^"'#?][^"']*?)["'][^>]*>([\s\S]{4,160}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw   = m[1].trim();
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 8) continue;
    try {
      const full = new URL(raw, siteUrl).href;
      if (new URL(full).hostname === domain && !links.has(full)) {
        links.set(full, title);
      }
    } catch { /* skip malformed */ }
  }
  return [...links.entries()].map(([url, title]) => ({ url, title }));
}

// ── Browser scrape (Puppeteer — for sites that block plain HTTP) ──────────────
async function browserScrapeLinks(siteUrl) {
  const puppeteer = require('puppeteer');
  const domain    = new URL(siteUrl).hostname;
  const browser   = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        href: a.href,
        title: a.textContent.replace(/\s+/g, ' ').trim(),
      }))
    );
    const seen = new Set();
    return raw
      .filter(l => l.title.length >= 8 && new URL(l.href).hostname === domain)
      .filter(l => new URL(l.href).hash === '')          // drop fragment-only anchors (#accept, #refuse, etc.)
      .filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; })
      .map(l => ({ url: l.href, title: l.title }));
  } finally {
    await browser.close();
  }
}

// ── Baseline persistence — file-based so DB swaps don't wipe state ────────────
const BASELINE_FILE = process.env.REG_BASELINE_FILE
  || '/var/lib/mclellan-hub/reg-baselines.json';

function loadBaselines() {
  try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch { return {}; }
}

function saveBaselines(data) {
  fs.mkdirSync(require('path').dirname(BASELINE_FILE), { recursive: true });
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getSeenUrls(siteId) {
  // File-based baseline takes precedence; fall back to DB for migration
  const baselines = loadBaselines();
  if (baselines[siteId]) return new Set(baselines[siteId]);

  // Legacy DB fallback — migrate on first read
  const row = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = 'system' AND key = ?"
  ).get(`reg_seen_${siteId}`);
  if (!row) return null;
  try {
    const urls = JSON.parse(row.value);
    // Migrate to file immediately
    baselines[siteId] = urls;
    saveBaselines(baselines);
    return new Set(urls);
  } catch { return new Set(); }
}

function storeSeenUrls(siteId, urls) {
  const baselines = loadBaselines();
  baselines[siteId] = [...urls];
  saveBaselines(baselines);
  // Keep DB in sync for visibility
  try {
    db.hub().prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, 'system', ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(randomUUID(), `reg_seen_${siteId}`, JSON.stringify([...urls]));
  } catch {}
}

// ── Junk filter ───────────────────────────────────────────────────────────────
// Cloudflare and other services replace emails in page text with obfuscated
// spans that scrape as titles like "Email: [email protected]" or "[email protected]".
// The AI synopsis then recognises these as email protection pages, not publications.
function isJunkTitle(title) {
  if (!title || title.length < 8) return true;
  const t = title.trim();
  // Cloudflare email obfuscation
  if (/^\[email[^\]]*protected\]/i.test(t)) return true;
  if (/^email:\s*/i.test(t)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return true;
  // Cookie consent banners and navigation chrome
  if (/^accept\s+(all|only|essential)\s+cook/i.test(t)) return true;
  if (/^(reject|decline|refuse)\s+(all\s+)?cook/i.test(t)) return true;
  if (/^cookie[s]?\s+(policy|consent|notice|settings|prefer)/i.test(t)) return true;
  if (/^(manage|change)\s+(cookie|consent|prefer)/i.test(t)) return true;
  if (/^skip\s+to\s+(main\s+)?(content|navigation)/i.test(t)) return true;
  if (/^(back to top|scroll to top|go to top)$/i.test(t)) return true;
  if (/^(home|contact us|search|sitemap|accessibility)$/i.test(t)) return true;
  return false;
}

function isJunkUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    // Cookie / privacy policy pages by path
    if (/cookie[s]?[-_]?polic|privacy[-_]?polic|legal[-_]?notice/i.test(u.pathname)) return true;
    return false;
  } catch { return true; }
}

function isJunkSynopsis(text) {
  if (!text) return false;
  return /email.{0,40}protection page|not.{0,30}regulatory document|technical email|email address rather than|cookie.{0,40}(policy|consent|banner)|consent.{0,40}cookie/i.test(text);
}

// ── Synopsis ──────────────────────────────────────────────────────────────────
async function synopsis(regulator, title, url) {
  const started = Date.now();
  const modelId = getSystemModelId('reg_synopsis', 'system', 'google/gemini-2.5-pro-preview');
  const r = await fetch(OR_URL, {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.REGULATORY_MONITOR),
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: getSystemPrompt('reg_synopsis', 'system', PROMPTS.reg_synopsis),
        },
        {
          role: 'user',
          content: `Regulator: ${regulator}\nTitle: ${title}\nURL: ${url}`,
        },
      ],
    }),
  });
  if (!r.ok) return null;
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'regulatory-monitor',
    modelKey: 'regulatory-monitor',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.REGULATORY_MONITOR,
  });
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── Nakai's email (from NAKAI_GOOGLE_EMAILS / NAKAI_GOOGLE_EMAIL env) ─────────
function nakaiEmail() {
  const raw = process.env.NAKAI_GOOGLE_EMAILS || process.env.NAKAI_GOOGLE_EMAIL || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean)[0] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runRegulatoryMonitor() {
  const now            = new Date();
  const date           = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const isFirst        = now.getDate() === 1;
  const isFortnightly  = now.getDate() === 1 || now.getDate() === 15;
  const toEmail        = nakaiEmail();
  const allNew         = []; // { site, title, url, synopsis }
  const baselines      = []; // site names that were seeded this run
  const sourceSummary  = []; // { name, newCount, baselined, skipped }

  for (const site of SITES) {
    if (site.monthly      && !isFirst)       continue;
    if (site.fortnightly  && !isFortnightly) continue;
    try {
      console.log(`[reg-monitor] checking ${site.name}${site.fortnightly ? ' (fortnightly)' : ''}…`);
      const links = site.browser
        ? await browserScrapeLinks(site.url)
        : await scrapeLinks(site.url);
      console.log(`[reg-monitor] ${site.name}: ${links.length} links extracted`);

      const seen    = getSeenUrls(site.id);
      const allUrls = new Set(links.map(l => l.url));

      // First run — just baseline, don't flood with existing content
      if (seen === null) {
        storeSeenUrls(site.id, allUrls);
        baselines.push(site.name);
        sourceSummary.push({ name: site.name, newCount: 0, baselined: true });
        console.log(`[reg-monitor] ${site.name}: baseline set (${allUrls.size} URLs)`);
        continue;
      }

      const newLinks = links
        .filter(l => !seen.has(l.url))
        .filter(l => !isJunkTitle(l.title))
        .filter(l => !isJunkUrl(l.url))
        .slice(0, 8); // cap 8/site/run
      storeSeenUrls(site.id, new Set([...seen, ...allUrls]));
      console.log(`[reg-monitor] ${site.name}: ${newLinks.length} new`);

      let siteNewCount = 0;
      for (const link of newLinks) {
        const text = await synopsis(site.name, link.title, link.url);
        if (isJunkSynopsis(text)) {
          console.log(`[reg-monitor] ${site.name}: skipping junk item — ${link.title.slice(0, 60)}`);
          continue;
        }
        allNew.push({ site: site.name, title: link.title, url: link.url, synopsis: text });
        siteNewCount++;
      }
      sourceSummary.push({ name: site.name, newCount: siteNewCount });
    } catch (err) {
      console.error(`[reg-monitor] ${site.name} error:`, err.message);
      sourceSummary.push({ name: site.name, newCount: 0, error: true });
    }
  }

  if (baselines.length) {
    console.log(`[reg-monitor] baselines set for: ${baselines.join(', ')}`);
  }

  // Build sources-checked summary block (always included)
  const summaryLines = [`Regulatory Monitor - ${date}`, '', 'Sources checked:', ''];
  for (const s of sourceSummary) {
    const tag = s.baselined ? '(baselined)' : s.error ? '(error)' : s.newCount > 0 ? `${s.newCount} new` : 'no new';
    summaryLines.push(`  ${s.name}: ${tag}`);
  }

  // Append new-item details if any
  if (allNew.length) {
    summaryLines.push('', '─'.repeat(40), '');
    let current = '';
    for (const item of allNew) {
      if (item.site !== current) {
        if (current) summaryLines.push('');
        current = item.site;
        summaryLines.push(`── ${item.site} ──`);
      }
      summaryLines.push('', item.title);
      if (item.synopsis) summaryLines.push(item.synopsis);
      summaryLines.push(item.url);
    }
  }

  const body = summaryLines.join('\n');

  // Store new findings in DB for weekly digest
  if (allNew.length) {
    const hub = db.hub();
    const seenItem = hub.prepare('SELECT 1 FROM reg_monitor_items WHERE site = ? AND url = ?');
    const insert = hub.prepare(
      'INSERT OR IGNORE INTO reg_monitor_items (id, site, title, url, synopsis) VALUES (?, ?, ?, ?, ?)'
    );
    let stored = 0;
    for (const item of allNew) {
      if (seenItem.get(item.site, item.url)) continue;
      const result = insert.run(randomUUID(), item.site, item.title, item.url, item.synopsis || '');
      stored += result.changes;
    }
    console.log(`[reg-monitor] stored ${stored} findings in DB`);
  }

  if (toEmail) {
    await sendEmail('douglas', toEmail, `Regulatory Monitor - ${date}`, body);
    console.log(`[reg-monitor] email sent to ${toEmail} — ${allNew.length} new items across ${sourceSummary.length} sources`);
  } else {
    console.log('[reg-monitor] no Nakai email configured (set NAKAI_GOOGLE_EMAIL) — digest:\n', body);
  }

  return allNew;
}

module.exports = { runRegulatoryMonitor };
