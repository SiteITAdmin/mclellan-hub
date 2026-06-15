'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatStats, parseLines } = require('../lib/rh-stats');

const now = Date.now();
const logDate = new Date(now).toLocaleString('en-GB', {
  timeZone: 'UTC',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
}).replace(',', '').replace(/ /g, '/').replace(/^(\d{2})\/([A-Za-z]{3})\/(\d{4})\/(.+)$/, '$1/$2/$3:$4 +0000');

function line(ip, path, status, ua = 'Mozilla/5.0') {
  return `${ip} - - [${logDate}] "GET ${path} HTTP/1.1" ${status} 118 "-" "${ua}"`;
}

test('secret-file probes are excluded from visitor counts and reported as blocked', () => {
  const stats = parseLines([
    line('203.0.113.10', '/', '200'),
    line('198.51.100.20', '/.env', '404'),
    line('198.51.100.20', '/.git/config', '404'),
    line('198.51.100.20', '/service-account.json', '404'),
  ], now - 1000);

  assert.equal(stats.uniqueVisitors, 1);
  assert.equal(stats.pageViews, 1);
  assert.equal(stats.security.probes, 3);
  assert.equal(stats.security.blocked, 3);

  const report = formatStats(stats, 'Today');
  assert.match(report, /Security probes:\s+3 from 1 IP/);
  assert.match(report, /Sensitive-file access:\s+all blocked \(4xx\)/);
});

test('failed ordinary URLs are not counted as page views', () => {
  const stats = parseLines([
    line('203.0.113.10', '/missing-page', '404'),
    line('203.0.113.11', '/', '200'),
  ], now - 1000);

  assert.equal(stats.uniqueVisitors, 1);
  assert.equal(stats.pageViews, 1);
});
