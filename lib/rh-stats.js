'use strict';

const fs     = require('fs');
const path   = require('path');
const geoip  = require('geoip-lite');
const db     = require('./db');
const { uuid } = require('./id');
const { sendEmail } = require('./gmail');

const LOG_FILE = '/var/log/nginx/rholdsworth.access.log';

// Bots to exclude from visitor counts
const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|curl|wget|python|go-http/i;

function parseLog() {
  if (!fs.existsSync(LOG_FILE)) return null;

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);

  const uniqueIps  = new Set();
  const pages      = {};
  const referrers  = {};
  const countries  = {};
  const statuses   = {};
  let pageViews    = 0;

  for (const line of lines) {
    // nginx combined log format
    const m = line.match(/^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) ([^"]*?) \S+" (\d+) \d+ "([^"]*)" "([^"]*)"/);
    if (!m) continue;

    const [, ip, timeStr, method, url, status, referer, ua] = m;

    // Parse log time — format: 02/Jun/2026:07:00:00 +0000
    const logTime = new Date(timeStr.replace(/(\d+)\/(\w+)\/(\d+):(\d+:\d+:\d+) ([+-]\d+)/, '$2 $1 $3 $4 $5'));
    if (logTime.getTime() < since) continue;

    if (BOT_RE.test(ua)) continue;
    if (method !== 'GET') continue;

    // Only count HTML page views, not assets
    const isPage = !url.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf)(\?|$)/i);

    if (isPage) {
      pageViews++;
      const isNew = !uniqueIps.has(ip);
      uniqueIps.add(ip);
      pages[url] = (pages[url] || 0) + 1;
      if (isNew) {
        const geo = geoip.lookup(ip);
        const country = geo?.country || 'Unknown';
        countries[country] = (countries[country] || 0) + 1;
      }
    }

    statuses[status] = (statuses[status] || 0) + 1;

    if (referer && referer !== '-' && !referer.includes('rholdsworthconsulting.com')) {
      try {
        const host = new URL(referer).hostname.replace(/^www\./, '');
        referrers[host] = (referrers[host] || 0) + 1;
      } catch {}
    }
  }

  return { uniqueVisitors: uniqueIps.size, pageViews, pages, referrers, countries, statuses };
}

function formatStats(stats, date) {
  if (!stats) return null;

  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

  const lines = [
    `rholdsworthconsulting.com — Daily Stats`,
    `${date}`,
    '',
    `Visitors (unique IPs):  ${stats.uniqueVisitors}`,
    `Page views:             ${stats.pageViews}`,
  ];

  if (Object.keys(stats.countries).length) {
    lines.push('', 'Visitors by country:');
    for (const [country, count] of top(stats.countries, 999)) {
      lines.push(`  ${country.padEnd(35)} ${count}`);
    }
  }

  if (Object.keys(stats.referrers).length) {
    lines.push('', 'Top referrers:');
    for (const [host, count] of top(stats.referrers, 5)) {
      lines.push(`  ${host.padEnd(35)} ${count}`);
    }
  } else {
    lines.push('', 'Referrers: none (all direct traffic)');
  }

  const topPages = top(stats.pages, 5).filter(([url]) => url !== '/');
  if (topPages.length) {
    lines.push('', 'Top pages:');
    for (const [url, count] of topPages) lines.push(`  ${url.padEnd(35)} ${count}`);
  }

  const notFound = stats.statuses['404'] || 0;
  if (notFound) lines.push('', `404 errors: ${notFound}`);

  if (stats.uniqueVisitors === 0) lines.push('', '(No visitors in the last 24 hours)');

  return lines.join('\n');
}

async function sendRhStats() {
  const date = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const dateKey = new Date().toISOString().slice(0, 10);
  const claimKey = `rh_stats_sent_${dateKey}`;

  try {
    const stats = parseLog();
    const body  = formatStats(stats, date);
    if (!body) { console.log('[rh-stats] log file not found yet'); return; }

    const claimed = db.hub().prepare(`
      INSERT OR IGNORE INTO crm_context (id, user, key, value)
      VALUES (?, 'system', ?, ?)
    `).run(uuid(), claimKey, String(Date.now()));
    if (claimed.changes === 0) {
      console.log(`[rh-stats] already sent for ${date}`);
      return;
    }

    await sendEmail('douglas', 'douglas@mclellan.scot', `rholdsworthconsulting.com — ${date}`, body);
    console.log(`[rh-stats] stats email sent for ${date}`);
  } catch (err) {
    console.error('[rh-stats] error:', err.message);
  }
}

module.exports = { sendRhStats };
