'use strict';

const fetch      = require('./fetch');
const fs         = require('fs');
const db         = require('./db');
const { sendEmail }  = require('./gmail');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ── Sites to monitor — loaded from DB ────────────────────────────────────────
// Managed via /admin/nakai-briefings. Hardcoded list removed; DB is seeded on
// first startup from the original values if no rows exist.
function getMonitorSites() {
  return db.hub().prepare(
    `SELECT id, name, url, browser, cadence FROM nakai_reg_monitor_sites WHERE active = 1 ORDER BY name`
  ).all();
}

function markSiteChecked(siteId) {
  db.hub().prepare(
    `UPDATE nakai_reg_monitor_sites SET last_checked_at = unixepoch() WHERE id = ?`
  ).run(siteId);
}

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

function isJunkAssessment(item) {
  if (!item) return true;
  const text = [
    item.summary,
    item.why_it_matters,
    item.ireland_eu_relevance,
    ...(Array.isArray(item.source_evidence) ? item.source_evidence : []),
  ].filter(Boolean).join(' ');
  return item.is_regulatory_publication === false
    || /email.{0,40}protection page|not.{0,30}regulatory document|technical email|email address rather than|cookie.{0,40}(policy|consent|banner)|consent.{0,40}cookie/i.test(text);
}

// ── Page content + assessment ─────────────────────────────────────────────────
async function fetchPublicationContent(url) {
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      if (r.ok) {
        const data = await r.json();
        const markdown = data?.data?.markdown || '';
        if (markdown.trim()) {
          return {
            status: 'firecrawl',
            text: markdown.replace(/\s+\n/g, '\n').trim().slice(0, 12000),
          };
        }
      }
      console.warn(`[reg-monitor] Firecrawl failed for ${url}: HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[reg-monitor] Firecrawl error for ${url}: ${err.message}`);
    }
  }

  try {
    const r = await fetch(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; McLellan-RegMonitor/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
    });
    if (!r.ok) return { status: `fallback-http-${r.status}`, text: '' };
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 8000);
    return { status: 'fallback-fetch', text };
  } catch (err) {
    return { status: `fetch-error: ${err.message}`, text: '' };
  }
}

function parseAssessment(content, regulator, title, url, source) {
  const raw = String(content || '').trim();
  const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const truncate = (value, max = 260) => {
    const text = clean(value);
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  };
  const confidenceValue = value => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.5;
    const decimal = n > 1 && n <= 100 ? n / 100 : n;
    return Math.max(0, Math.min(1, decimal));
  };
  try {
    const parsed = JSON.parse(jsonText);
    return {
      is_regulatory_publication: parsed.is_regulatory_publication !== false,
      confidence: confidenceValue(parsed.confidence),
      publication_type: clean(parsed.publication_type || 'other') || 'other',
      summary: truncate(parsed.summary, 420),
      affected_firms: Array.isArray(parsed.affected_firms) ? parsed.affected_firms.map(f => truncate(f, 80)).filter(Boolean).slice(0, 6) : [],
      why_it_matters: truncate(parsed.why_it_matters, 320),
      ireland_eu_relevance: parsed.ireland_eu_relevance ? truncate(parsed.ireland_eu_relevance, 260) : '',
      priority: ['high', 'medium', 'low'].includes(String(parsed.priority || '').toLowerCase())
        ? String(parsed.priority).toLowerCase()
        : 'medium',
      source_evidence: Array.isArray(parsed.source_evidence) ? parsed.source_evidence.map(e => truncate(e, 180)).filter(Boolean).slice(0, 3) : [],
      human_check_needed: !!parsed.human_check_needed,
      regulator,
      title,
      url,
      fetch_status: source.status,
    };
  } catch (_) {
    return {
      is_regulatory_publication: true,
      confidence: source.text ? 0.35 : 0.2,
      publication_type: 'other',
      summary: truncate(raw || `Possible regulatory update from ${regulator}: ${title}`, 420),
      affected_firms: [],
      why_it_matters: '',
      ireland_eu_relevance: '',
      priority: 'medium',
      source_evidence: source.text ? ['Model returned unstructured text; manual review recommended.'] : ['No page text was available; manual review recommended.'],
      human_check_needed: true,
      regulator,
      title,
      url,
      fetch_status: source.status,
    };
  }
}

async function assessPublication(regulator, title, url, source) {
  const started = Date.now();
  const modelId = getSystemModelId('reg_synopsis', 'system', 'google/gemini-2.5-pro-preview');
  const systemPrompt = `${getSystemPrompt('reg_synopsis', 'system', PROMPTS.reg_synopsis)}

Implementation output contract: return ONLY valid JSON with keys is_regulatory_publication, confidence, publication_type, summary, affected_firms, why_it_matters, ireland_eu_relevance, priority, source_evidence, and human_check_needed. Do not return prose outside the JSON object.`;
  const r = await fetch(OR_URL, {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.REGULATORY_MONITOR),
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: [
            `Regulator: ${regulator}`,
            `Title: ${title}`,
            `URL: ${url}`,
            `Fetch status: ${source.status}`,
            '',
            'Extracted page text:',
            source.text || '(No page text available. Assess from the title and URL only, and lower confidence.)',
          ].join('\n'),
        },
      ],
    }),
  });
  if (!r.ok) {
    return parseAssessment('', regulator, title, url, {
      ...source,
      status: `${source.status}; model-http-${r.status}`,
    });
  }
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
  return parseAssessment(data.choices?.[0]?.message?.content, regulator, title, url, source);
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
  const allNew         = []; // assessed regulatory items for Nakai's email only
  const baselines      = []; // site names that were seeded this run
  const sourceSummary  = []; // { name, newLinks, relevantCount, baselined, error }

  for (const site of getMonitorSites()) {
    if (site.cadence === 'monthly'      && !isFirst)       continue;
    if (site.cadence === 'fortnightly'  && !isFortnightly) continue;
    markSiteChecked(site.id);
    try {
      console.log(`[reg-monitor] checking ${site.name}${site.cadence !== 'daily' ? ` (${site.cadence})` : ''}…`);
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
        sourceSummary.push({ name: site.name, newLinks: 0, relevantCount: 0, baselined: true });
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

      let relevantCount = 0;
      for (const link of newLinks) {
        let item;
        try {
          const source = await fetchPublicationContent(link.url);
          item = await assessPublication(site.name, link.title, link.url, source);
        } catch (err) {
          console.warn(`[reg-monitor] ${site.name}: item assessment failed for ${link.url}: ${err.message}`);
          item = parseAssessment('', site.name, link.title, link.url, {
            status: `assessment-error: ${err.message}`,
            text: '',
          });
        }
        if (isJunkAssessment(item)) {
          console.log(`[reg-monitor] ${site.name}: skipping junk item — ${link.title.slice(0, 60)}`);
          continue;
        }
        allNew.push(item);
        relevantCount++;
      }
      sourceSummary.push({ name: site.name, newLinks: newLinks.length, relevantCount });
    } catch (err) {
      console.error(`[reg-monitor] ${site.name} error:`, err.message);
      sourceSummary.push({ name: site.name, newLinks: 0, relevantCount: 0, error: true });
    }
  }

  if (baselines.length) {
    console.log(`[reg-monitor] baselines set for: ${baselines.join(', ')}`);
  }

  allNew.sort((a, b) => {
    const weight = { high: 0, medium: 1, low: 2 };
    return (weight[a.priority] ?? 1) - (weight[b.priority] ?? 1)
      || String(a.regulator).localeCompare(String(b.regulator));
  });

  // Build Nakai-only email body. No Hub records or chat notifications are created.
  const summaryLines = [`Regulatory Monitor - ${date}`, ''];
  summaryLines.push(`Relevant items: ${allNew.length}`);
  summaryLines.push('');
  summaryLines.push('Sources checked:');
  for (const s of sourceSummary) {
    const tag = s.baselined
      ? 'baselined'
      : s.error
        ? 'error'
        : s.newLinks > 0
          ? `${s.newLinks} new link(s), ${s.relevantCount} relevant`
          : 'no new links';
    summaryLines.push(`  ${s.name}: ${tag}`);
  }

  if (allNew.length) {
    summaryLines.push('', 'Items:', '');
    let current = null;
    for (const item of allNew) {
      if (item.priority !== current) {
        if (current) summaryLines.push('');
        current = item.priority;
        summaryLines.push(`${item.priority.toUpperCase()} PRIORITY`);
      }
      summaryLines.push(`- [${item.regulator}] ${item.title}`);
      if (item.publication_type) summaryLines.push(`  Type: ${item.publication_type}`);
      if (item.summary) summaryLines.push(`  Summary: ${item.summary}`);
      if (item.affected_firms.length) summaryLines.push(`  Affected firms: ${item.affected_firms.join(', ')}`);
      if (item.why_it_matters) summaryLines.push(`  Why it matters: ${item.why_it_matters}`);
      if (item.ireland_eu_relevance) summaryLines.push(`  Ireland/EU relevance: ${item.ireland_eu_relevance}`);
      if (item.source_evidence.length) summaryLines.push(`  Evidence: ${item.source_evidence.join(' | ')}`);
      summaryLines.push(`  Confidence: ${Math.round(item.confidence * 100)}%${item.human_check_needed ? ' (manual check recommended)' : ''}`);
      summaryLines.push(`  Fetch: ${item.fetch_status}`);
      summaryLines.push(`  Source: ${item.url}`);
    }
  } else {
    summaryLines.push('', 'No relevant new regulatory publications found.');
  }

  const body = summaryLines.join('\n');

  if (toEmail) {
    await sendEmail('douglas', toEmail, `Regulatory Monitor - ${date}`, body);
    console.log(`[reg-monitor] email sent to ${toEmail} — ${allNew.length} relevant items across ${sourceSummary.length} sources`);
  } else {
    console.log('[reg-monitor] no Nakai email configured (set NAKAI_GOOGLE_EMAIL) — digest:\n', body);
  }

  return allNew;
}

module.exports = { runRegulatoryMonitor };
