'use strict';

const fetch      = require('./fetch');
const fs         = require('fs');
const db         = require('./db');
const { randomUUID } = require('crypto');
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

// Returns null if the item is a genuine relevant regulatory item, or a
// human-readable reason string if it should be excluded — this reason is
// what shows up in the daily audit email so exclusions are explainable
// ("Minister opening a swimming pool", not just a silent drop).
function exclusionReason(item) {
  if (!item) return 'Assessment returned no data.';
  const text = [
    item.summary,
    item.why_it_matters,
    item.ireland_eu_relevance,
    ...(Array.isArray(item.source_evidence) ? item.source_evidence : []),
  ].filter(Boolean).join(' ');
  if (item.is_regulatory_publication === false) {
    return item.summary
      ? `Not a regulatory publication: ${item.summary}`
      : 'Model assessed this as not a regulatory publication.';
  }
  if (/email.{0,40}protection page|not.{0,30}regulatory document|technical email|email address rather than|cookie.{0,40}(policy|consent|banner)|consent.{0,40}cookie/i.test(text)) {
    return 'Flagged as page furniture (cookie banner / email-protection page), not real content.';
  }
  return null;
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

// ── Storage ────────────────────────────────────────────────────────────────
// Stores every assessed item — relevant or not — so the daily audit email can
// explain exclusions instead of just dropping them silently.
function storeAssessedItem(item, runId, relevant, reason) {
  const hub = db.hub();
  const existing = hub.prepare('SELECT id FROM reg_monitor_items WHERE site = ? AND url = ?').get(item.regulator, item.url);
  if (existing) return existing.id;
  const id = randomUUID();
  hub.prepare(`
    INSERT INTO reg_monitor_items (
      id, site, title, url, synopsis, found_at,
      publication_type, priority, why_it_matters, affected_firms, ireland_eu_relevance,
      confidence, source_evidence, fetch_status, human_check_needed,
      is_relevant, exclusion_reason, run_id
    ) VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, item.regulator, item.title, item.url, item.summary || '',
    item.publication_type || '', item.priority || 'medium', item.why_it_matters || '',
    JSON.stringify(item.affected_firms || []), item.ireland_eu_relevance || '',
    item.confidence ?? null, JSON.stringify(item.source_evidence || []), item.fetch_status || '',
    item.human_check_needed ? 1 : 0,
    relevant ? 1 : 0, relevant ? null : reason,
    runId
  );
  return id;
}

function recordRun(run) {
  db.hub().prepare(`
    INSERT INTO reg_monitor_runs (
      id, run_date, started_at, finished_at,
      sources_total, sources_ok, sources_error, sources_zero_links,
      items_checked, items_relevant, items_excluded,
      panic, panic_reasons
    ) VALUES (?, ?, ?, unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id, run.runDate, run.startedAt,
    run.sourcesTotal, run.sourcesOk, run.sourcesError, run.sourcesZeroLinks,
    run.itemsChecked, run.itemsRelevant, run.itemsExcluded,
    run.panic ? 1 : 0, JSON.stringify(run.panicReasons || [])
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
// No longer sends its own email — returns a structured report. The daily
// pipeline (lib/nakai-intelligence-pipeline.js) consumes this, feeds the
// briefing builder, and sends Douglas a single audit email at the end.
async function runRegulatoryMonitor() {
  const runId           = randomUUID();
  const startedAt        = Math.floor(Date.now() / 1000);
  const now            = new Date();
  const runDate        = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const isFirst        = now.getDate() === 1;
  const isFortnightly  = now.getDate() === 1 || now.getDate() === 15;
  const allItems       = []; // every assessed item, relevant or not — { ...item, relevant, reason, id }
  const baselines      = []; // site names that were seeded this run
  const sourceSummary  = []; // { name, newLinks, relevantCount, baselined, error, zeroLinks }

  const sites = getMonitorSites();
  const panicReasons = [];
  if (!sites.length) panicReasons.push('No active monitor sites are configured in nakai_reg_monitor_sites.');

  for (const site of sites) {
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
        sourceSummary.push({ name: site.name, newLinks: 0, relevantCount: 0, baselined: true, linksExtracted: links.length });
        console.log(`[reg-monitor] ${site.name}: baseline set (${allUrls.size} URLs)`);
        continue;
      }

      if (links.length === 0) {
        sourceSummary.push({ name: site.name, newLinks: 0, relevantCount: 0, zeroLinks: true, linksExtracted: 0 });
        console.warn(`[reg-monitor] ${site.name}: 0 links extracted — scraper may be broken for this site`);
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
        const reason = exclusionReason(item);
        const relevant = reason === null;
        if (relevant) relevantCount++;
        else console.log(`[reg-monitor] ${site.name}: excluding — ${link.title.slice(0, 60)} (${reason})`);
        const id = storeAssessedItem(item, runId, relevant, reason);
        allItems.push({ ...item, id, relevant, reason });
      }
      sourceSummary.push({ name: site.name, newLinks: newLinks.length, relevantCount, linksExtracted: links.length });
    } catch (err) {
      console.error(`[reg-monitor] ${site.name} error:`, err.message);
      sourceSummary.push({ name: site.name, newLinks: 0, relevantCount: 0, error: true, errorMessage: err.message });
    }
  }

  if (baselines.length) {
    console.log(`[reg-monitor] baselines set for: ${baselines.join(', ')}`);
  }

  allItems.sort((a, b) => {
    const weight = { high: 0, medium: 1, low: 2 };
    return (weight[a.priority] ?? 1) - (weight[b.priority] ?? 1)
      || String(a.regulator).localeCompare(String(b.regulator));
  });

  // ── Panic detection ──────────────────────────────────────────────────────
  const checkedSources = sourceSummary.filter(s => !s.baselined);
  if (checkedSources.length && checkedSources.every(s => s.error)) {
    panicReasons.push('Every monitored source errored — nothing was actually checked today.');
  }
  const zeroLinkSources = sourceSummary.filter(s => s.zeroLinks);
  if (zeroLinkSources.length) {
    panicReasons.push(`${zeroLinkSources.map(s => s.name).join(', ')} returned 0 links — scraper likely broken for ${zeroLinkSources.length > 1 ? 'these sites' : 'this site'}.`);
  }
  if (checkedSources.length && zeroLinkSources.length === checkedSources.length) {
    panicReasons.push('All non-baselined sources returned 0 links this run.');
  }

  const relevantItems = allItems.filter(i => i.relevant);
  const excludedItems = allItems.filter(i => !i.relevant);

  recordRun({
    id: runId,
    runDate,
    startedAt,
    sourcesTotal: sites.length,
    sourcesOk: sourceSummary.filter(s => !s.error && !s.zeroLinks).length,
    sourcesError: sourceSummary.filter(s => s.error).length,
    sourcesZeroLinks: zeroLinkSources.length,
    itemsChecked: allItems.length,
    itemsRelevant: relevantItems.length,
    itemsExcluded: excludedItems.length,
    panic: panicReasons.length > 0,
    panicReasons,
  });

  return {
    runId,
    runDate,
    sourceSummary,
    allItems,
    relevantItems,
    excludedItems,
    panic: panicReasons.length > 0,
    panicReasons,
  };
}

module.exports = { runRegulatoryMonitor };
