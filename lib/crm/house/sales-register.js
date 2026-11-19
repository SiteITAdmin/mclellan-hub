'use strict';

const { csvRecords } = require('../money/files');

const counties = Object.freeze([
  'Carlow', 'Cavan', 'Clare', 'Cork', 'Donegal', 'Dublin', 'Galway', 'Kerry', 'Kildare',
  'Kilkenny', 'Laois', 'Leitrim', 'Limerick', 'Longford', 'Louth', 'Mayo', 'Meath',
  'Monaghan', 'Offaly', 'Roscommon', 'Sligo', 'Tipperary', 'Waterford', 'Westmeath',
  'Wexford', 'Wicklow',
]);
const SITE = 'https://www.propertypriceregister.ie/website/npsra/ppr/npsra-ppr.nsf/Downloads';
const DAY = 86400;
const MAX_BYTES = 8_000_000;
const MAX_CACHE_FILES = 12;
const caches = new WeakMap();

function registerUrl(county, year) {
  const name = counties.find(c => c.toLowerCase() === String(county || '').trim().toLowerCase());
  if (!name || !Number.isInteger(year) || year < 2010 || year > 2099) throw new Error('Choose a county and sale year in the Property Price Register.');
  const file = `PPR-${year}-${name}.csv`;
  return `${SITE}/${file}/$FILE/${file}`;
}

function fields(record) {
  return Array.from(record.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^",]*))(?=,|$)/g),
    match => (match[1]?.replace(/""/g, '"') ?? match[2]).trim());
}

function saleDay(value, year) {
  const parts = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!parts || Number(parts[3]) !== year) return '';
  const day = `${year}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : '';
}

function parseCsv(buffer, county, year, url) {
  let csv;
  try { csv = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { csv = new TextDecoder('windows-1252').decode(buffer); }
  const [header, ...records] = csvRecords(csv);
  const columns = fields(header || '').map(column => column.toLowerCase());
  const dateAt = columns.findIndex(c => c.startsWith('date of sale'));
  const priceAt = columns.findIndex(c => /^price\b/.test(c));
  const addressAt = columns.indexOf('address');
  const countyAt = columns.indexOf('county');
  const eircodeAt = columns.indexOf('eircode');
  const marketAt = columns.indexOf('not full market price');
  const vatAt = columns.indexOf('vat exclusive');
  const descriptionAt = columns.indexOf('description of property');
  if ([dateAt, priceAt, addressAt, countyAt, marketAt, vatAt, descriptionAt].includes(-1)) {
    throw new Error('The Property Price Register returned an unexpected CSV format.');
  }

  const rows = [];
  const seen = new Set();
  let hasCounty = false, wrongCounty = false;
  for (const record of records) {
    const row = fields(record);
    if (row.length !== columns.length) continue;
    if (row[countyAt] && row[countyAt].toLowerCase() !== county.toLowerCase()) {
      wrongCounty = true;
      continue;
    }
    if (row[countyAt]) hasCounty = true;
    if (row[marketAt].toLowerCase() !== 'no') continue;
    const day = saleDay(row[dateAt], year);
    const address = row[addressAt].replace(/\s+/g, ' ');
    const amount = row[priceAt].replace(/^€\s*/, '');
    if (!day || !address || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount)) continue;
    const sold = Number(amount.replaceAll(',', ''));
    if (!Number.isFinite(sold) || sold <= 0) continue;
    const code = (row[eircodeAt] || '').replace(/\s+/g, '').toUpperCase();
    const eircode = /^[A-Z0-9]{7}$/.test(code) ? code : '';
    const newBuild = /^new\b/i.test(row[descriptionAt]) || /^yes$/i.test(row[vatAt]);
    const key = JSON.stringify([address.toLowerCase(), eircode, day, sold, newBuild]);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ address, county, eircode, day, sold, newBuild, url });
  }
  if (wrongCounty && !hasCounty) throw new Error('The Property Price Register returned a different county.');
  return rows;
}

async function load(fetcher, county, year, url) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`The Property Price Register returned HTTP ${response.status} for ${county} ${year}.`);
  if (response.url && response.url !== url) throw new Error('The Property Price Register response URL did not match the requested file.');
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('The Property Price Register file was too large.');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) throw new Error('The Property Price Register file was too large.');
  return parseCsv(buffer, county, year, url);
}

function getFile(cache, fetcher, county, year, t) {
  const url = registerUrl(county, year);
  const old = cache.files.get(url);
  if (old && (t - old.asOf < DAY || t < old.retryAfter)) {
    cache.files.delete(url);
    cache.files.set(url, old);
    return Promise.resolve(old);
  }
  if (cache.pending.has(url)) return cache.pending.get(url);

  const pending = load(fetcher, county, year, url).then(rows => {
    const file = { rows, asOf: t, retryAfter: 0 };
    cache.files.delete(url);
    cache.files.set(url, file);
    if (cache.files.size > MAX_CACHE_FILES) cache.files.delete(cache.files.keys().next().value);
    return file;
  }).catch(error => {
    if (old && t - old.asOf < 7 * DAY) {
      old.retryAfter = t + 15 * 60;
      return old;
    }
    throw error;
  }).finally(() => cache.pending.delete(url));
  cache.pending.set(url, pending);
  return pending;
}

async function salesFor(county, { fetcher = fetch, t = Math.floor(Date.now() / 1000) } = {}) {
  const name = counties.find(c => c.toLowerCase() === String(county || '').trim().toLowerCase());
  if (!name) throw new Error('Choose a county in the Property Price Register.');
  const year = new Date(t * 1000).getUTCFullYear();
  if (!caches.has(fetcher)) caches.set(fetcher, { files: new Map(), pending: new Map() });
  const cache = caches.get(fetcher);
  const files = await Promise.all([year, year - 1, year - 2].map(y => getFile(cache, fetcher, name, y, t)));
  const today = new Date(t * 1000).toISOString().slice(0, 10);
  const rows = files.flatMap(file => file.rows).filter(row => row.day <= today);
  return { rows, asOf: Math.min(...files.map(file => file.asOf)) };
}

module.exports = { counties, salesFor, registerUrl };
