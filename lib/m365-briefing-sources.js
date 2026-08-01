'use strict';

const db = require('./db');
const fetch = require('./fetch');
const { currentInfoSearch } = require('./current-info-search');

const OFFICIAL_HOSTS = [
  'microsoft.com',
  'learn.microsoft.com',
  'msrc.microsoft.com',
  'techcommunity.microsoft.com',
  'cisa.gov',
  'sentinelone.com',
  'manageengine.com',
];

const SEARCH_QUERIES = [
  'site:learn.microsoft.com Microsoft 365 Message center Intune Entra latest changes',
  'site:msrc.microsoft.com/update-guide Microsoft security update Windows Office Active Directory',
  'site:learn.microsoft.com/windows/release-health Windows release health known issues enterprise',
  'site:learn.microsoft.com/microsoft-365-apps/updates Microsoft 365 Apps release notes',
  'site:sentinelone.com latest security advisory Windows Active Directory Microsoft 365',
  'site:manageengine.com/products/desktop-central Endpoint Central security advisory release notes',
  'site:manageengine.com/privileged-access-management PAM360 security advisory release notes',
];

const RSS_SLUGS = [
  'office-365', 'roadmap', 'entra', 'm365-admin', 'practical-365',
  'lazyadmin', 'mcbride-m365', 'teams-blog', 'joanne-c-klein', 'sharepoint',
];

function officialSourceUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return OFFICIAL_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}

function relevantText(value) {
  return /microsoft|m365|office 365|entra|azure ad|active directory|windows|intune|endpoint central|desktop central|sentinelone|pam360|manageengine|exchange|teams|sharepoint/i.test(String(value || ''));
}

function recentIntel(asOfEpoch, days = 7) {
  const since = asOfEpoch - days * 86400;
  const rows = db.hub().prepare(`
    SELECT i.title, i.summary, i.content_text, i.source_url, i.published_at,
           i.category, d.source_kind, s.name AS source_name
      FROM intel_items i
      JOIN intel_documents d ON d.id = i.document_id
      LEFT JOIN intel_sources s ON s.id = d.source_id
     WHERE i.user = 'douglas' AND i.selected = 1
       AND COALESCE(i.published_at, i.created_at) BETWEEN ? AND ?
     ORDER BY COALESCE(i.published_at, i.created_at) DESC
     LIMIT 160
  `).all(since, asOfEpoch);
  return rows.filter(row => relevantText(`${row.title} ${row.summary} ${row.content_text} ${row.category}`)).slice(0, 25);
}

function recentRss(asOfEpoch, days = 7) {
  const since = asOfEpoch - days * 86400;
  const placeholders = RSS_SLUGS.map(() => '?').join(',');
  const rows = db.hub().prepare(`
    SELECT a.title, a.url, a.published_at, a.content_markdown, f.name AS source_name
      FROM rss_articles a
      JOIN rss_feeds f ON f.id = a.feed_id
     WHERE a.user = 'douglas' AND a.creator_slug IN (${placeholders})
       AND a.published_at BETWEEN ? AND ?
     ORDER BY a.published_at DESC
     LIMIT 80
  `).all(...RSS_SLUGS, since, asOfEpoch);
  return rows.filter(row => relevantText(`${row.title} ${row.content_markdown}`)).slice(0, 25);
}

async function recentKev(asOfEpoch, days = 45) {
  const url = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
  try {
    const r = await fetch(url, { timeout: 30000, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const cutoff = new Date((asOfEpoch - days * 86400) * 1000).toISOString().slice(0, 10);
    const vulnerabilities = (data.vulnerabilities || [])
      .filter(item => /microsoft|manageengine|zoho|sentinelone/i.test(`${item.vendorProject} ${item.product}`))
      .filter(item => !item.dateAdded || item.dateAdded >= cutoff)
      .slice(0, 25);
    return { url, checkedAt: new Date().toISOString(), vulnerabilities, error: null };
  } catch (err) {
    return { url, checkedAt: new Date().toISOString(), vulnerabilities: [], error: err.message };
  }
}

async function officialSearch() {
  const results = await Promise.all(SEARCH_QUERIES.map(query =>
    currentInfoSearch(query, { provider: 'auto', days: 21, limit: 8 })
  ));
  const seen = new Set();
  const sources = [];
  const warnings = [];
  for (const result of results) {
    if (result.warning) warnings.push(`${result.query}: ${result.warning}`);
    for (const source of result.sources || []) {
      if (!officialSourceUrl(source.url) || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push({ ...source, query: result.query, provider: result.provider });
    }
  }
  return { sources: sources.slice(0, 35), warnings };
}

function connectionStatus() {
  return [
    ['Microsoft 365 Message center', 'not connected', 'Requires tenant service-communications/Graph collection.'],
    ['Microsoft 365 Service health', 'not connected', 'Requires tenant service-communications/Graph collection.'],
    ['Endpoint Central', 'not connected', 'API or scheduled report intake not configured.'],
    ['SentinelOne', 'not connected', 'Console/API evidence adapter not configured.'],
    ['PAM360', 'not connected', 'API or scheduled report intake not configured.'],
    ['CloudWave', 'not connected', 'Exact service and evidence channel not yet recorded.'],
    ['Artemis', 'not connected', 'Exact product and evidence channel not yet recorded.'],
  ].map(([source, status, note]) => ({ source, status, note }));
}

function clean(value, max = 900) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function buildM365SourcePack({ asOfEpoch = Math.floor(Date.now() / 1000) } = {}) {
  const [search, kev] = await Promise.all([officialSearch(), recentKev(asOfEpoch)]);
  const candidates = [];
  for (const row of recentIntel(asOfEpoch)) candidates.push({
    kind: 'existing-intelligence', source: row.source_name || row.source_kind || 'Intelligence inbox',
    title: row.title, url: row.source_url || '', publishedAt: row.published_at,
    text: row.summary || row.content_text || '',
  });
  for (const row of recentRss(asOfEpoch)) candidates.push({
    kind: 'rss', source: row.source_name || 'RSS', title: row.title, url: row.url,
    publishedAt: row.published_at, text: row.content_markdown || '',
  });
  for (const row of search.sources) candidates.push({
    kind: 'official-search', source: new URL(row.url).hostname, title: row.title, url: row.url,
    publishedAt: row.publishedAt || null, text: row.snippet || '', checkedAt: row.checkedAt,
  });
  for (const item of kev.vulnerabilities) candidates.push({
    kind: 'cisa-kev', source: 'CISA Known Exploited Vulnerabilities',
    title: `${item.cveID}: ${item.vulnerabilityName || `${item.vendorProject} ${item.product}`}`,
    url: kev.url, publishedAt: item.dateAdded || null,
    text: `${item.shortDescription || ''} Required action: ${item.requiredAction || ''} Due: ${item.dueDate || 'not stated'}`,
  });

  const seen = new Set();
  const unique = candidates.filter(item => {
    const key = item.url || `${item.source}:${item.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 80);
  const items = unique.map((item, index) => ({ ...item, marker: `S${index + 1}` }));
  const text = items.map(item => [
    `[${item.marker}] ${clean(item.title, 260)}`,
    `Source: ${clean(item.source, 160)}`,
    `Source kind: ${item.kind}`,
    item.url ? `URL: ${item.url}` : '',
    item.publishedAt ? `Published/added: ${typeof item.publishedAt === 'number' ? new Date(item.publishedAt * 1000).toISOString() : item.publishedAt}` : '',
    item.checkedAt ? `Checked: ${item.checkedAt}` : '',
    item.text ? `Evidence: ${clean(item.text)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n---\n\n');

  const statusText = connectionStatus().map(row =>
    `- ${row.source}: ${row.status}. ${row.note}`
  ).join('\n');
  const warnings = [...search.warnings, kev.error ? `CISA KEV: ${kev.error}` : ''].filter(Boolean);
  return {
    items,
    connections: connectionStatus(),
    warnings,
    text: `${text || 'No candidate evidence was retrieved.'}\n\n## Connection status\n${statusText}`,
  };
}

module.exports = {
  OFFICIAL_HOSTS,
  SEARCH_QUERIES,
  officialSourceUrl,
  relevantText,
  recentIntel,
  recentRss,
  recentKev,
  officialSearch,
  connectionStatus,
  buildM365SourcePack,
};
