'use strict';

const fetch      = require('node-fetch');
const db         = require('./db');
const { randomUUID } = require('crypto');
const { sendEmail }  = require('./gmail');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Sites to monitor ──────────────────────────────────────────────────────────
// Add or remove entries here. url should be the publications/news listing page.
const SITES = [
  { id: 'cbi',  name: 'Central Bank of Ireland',    url: 'https://www.centralbank.ie/news/article' },
  { id: 'fca',  name: 'FCA',                        url: 'https://www.fca.org.uk/news' },
  { id: 'eba',  name: 'EBA',                        url: 'https://www.eba.europa.eu/news-press' },
  { id: 'esma', name: 'ESMA',                       url: 'https://www.esma.europa.eu/press-news/esma-news' },
  { id: 'dof',  name: 'Dept of Finance Ireland',    url: 'https://www.gov.ie/en/news/?from_date=&to_date=&organisation%5B%5D=department-of-finance' },
  // FATF blocks plain HTTP — use Puppeteer, checked monthly only
  { id: 'fatf', name: 'FATF', url: 'https://www.fatf-gafi.org/en/publications.html', browser: true, monthly: true },
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
      .filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; })
      .map(l => ({ url: l.href, title: l.title }));
  } finally {
    await browser.close();
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function getSeenUrls(siteId) {
  const row = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = 'system' AND key = ?"
  ).get(`reg_seen_${siteId}`);
  if (!row) return null; // null = first run, not empty
  try { return new Set(JSON.parse(row.value)); } catch { return new Set(); }
}

function storeSeenUrls(siteId, urls) {
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, 'system', ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(randomUUID(), `reg_seen_${siteId}`, JSON.stringify([...urls]));
}

// ── Synopsis ──────────────────────────────────────────────────────────────────
async function synopsis(regulator, title, url) {
  const r = await fetch(OR_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'You are a compliance analyst. Given a regulator name, publication title, and URL, write exactly 2 sentences: (1) what this publication is about based on its title, (2) which types of firm are most likely affected. Be specific. No filler. No em dashes.',
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
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ── Nakai's email (from NAKAI_GOOGLE_EMAILS / NAKAI_GOOGLE_EMAIL env) ─────────
function nakaiEmail() {
  const raw = process.env.NAKAI_GOOGLE_EMAILS || process.env.NAKAI_GOOGLE_EMAIL || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean)[0] || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function runRegulatoryMonitor() {
  const now       = new Date();
  const date      = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const isFirst   = now.getDate() === 1;
  const toEmail   = nakaiEmail();
  const allNew    = []; // { site, title, url, synopsis }
  const baselines = []; // site names that were seeded this run

  for (const site of SITES) {
    if (site.monthly && !isFirst) continue; // monthly sites only run on 1st of month
    try {
      console.log(`[reg-monitor] checking ${site.name}${site.monthly ? ' (monthly)' : ''}…`);
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
        console.log(`[reg-monitor] ${site.name}: baseline set (${allUrls.size} URLs)`);
        continue;
      }

      const newLinks = links.filter(l => !seen.has(l.url)).slice(0, 8); // cap 8/site/run
      storeSeenUrls(site.id, new Set([...seen, ...allUrls]));
      console.log(`[reg-monitor] ${site.name}: ${newLinks.length} new`);

      for (const link of newLinks) {
        const text = await synopsis(site.name, link.title, link.url);
        allNew.push({ site: site.name, title: link.title, url: link.url, synopsis: text });
      }
    } catch (err) {
      console.error(`[reg-monitor] ${site.name} error:`, err.message);
    }
  }

  if (baselines.length) {
    console.log(`[reg-monitor] baselines set for: ${baselines.join(', ')}`);
  }

  if (allNew.length === 0) {
    console.log('[reg-monitor] no new content found');
    return;
  }

  // Build plain-text digest grouped by regulator
  const lines = [`Regulatory Monitor — ${date}`, ''];
  let current = '';
  for (const item of allNew) {
    if (item.site !== current) {
      if (current) lines.push('');
      current = item.site;
      lines.push(`── ${item.site} ──`);
    }
    lines.push('');
    lines.push(item.title);
    if (item.synopsis) lines.push(item.synopsis);
    lines.push(item.url);
  }
  const body = lines.join('\n');

  if (toEmail) {
    await sendEmail('douglas', toEmail, `Regulatory Monitor — ${date}`, body);
    console.log(`[reg-monitor] email sent to ${toEmail} — ${allNew.length} items`);
  } else {
    console.log('[reg-monitor] no Nakai email configured (set NAKAI_GOOGLE_EMAIL) — digest:\n', body);
  }

  return allNew;
}

module.exports = { runRegulatoryMonitor };
