'use strict';

const { createHash } = require('node:crypto');
const { crm, now } = require('../db');
const { uuid } = require('../../id');
const register = require('./sales-register');
const MIN_SALES = 3;
const MAX_SALES = 9;
const ROUND = 5000;
const REGISTER_HOME = 'https://www.propertypriceregister.ie/website/npsra/ppr-home-en.html';

const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const norm = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^co(?:unty)? /, '');
const contains = (address, phrase) => phrase && ` ${address} `.includes(` ${phrase} `);
const fingerprint = p => createHash('sha256').update(JSON.stringify([p.address, p.title, p.beds, p.area])).digest('hex');
const unit = address => /\b(?:apartment|apt|flat|studio|duplex)\b/i.test(address);
const eircodeRe = /\b(?:D6W|[A-Z]\d{2})\s?[A-Z0-9]{4}\b/i;
const routing = address => address?.match(eircodeRe)?.[0].slice(0, 3).toUpperCase() || '';
const groupAddress = address => norm(String(address).replace(eircodeRe, '')).replace(/\b(?:co|county) /g, '')
  .replace(/\bapt\b/g, 'apartment').replace(/^no /, '');
const countyName = name => register.counties.find(county => norm(county) === norm(name)) || '';

function inferred(property) {
  const address = property.address || property.title || '';
  const sections = address.replace(eircodeRe, '').split(',').map(part => part.trim()).filter(Boolean);
  let county = '', locality = '';
  const last = sections.at(-1);
  const district = last?.match(/^dublin\s+(\d{1,2}w?)$/i);
  if (district) {
    county = 'Dublin';
    locality = last;
  } else if (countyName(last)) {
    county = countyName(last);
    locality = sections.at(-2) || '';
  }
  if (/\d/.test(locality) && !/^dublin\s+\d{1,2}w?$/i.test(locality)) locality = '';
  if (sections.length < 3 && locality && /\b(road|street|avenue|drive|court|park|wood|lane|view|place|terrace|rise|grove)\b/i.test(locality)) locality = '';
  return { county, locality };
}

function streetFor(property, locality) {
  const parts = (property.address || property.title || '').split(',');
  const street = norm(parts[0]?.replace(/^(?:(?:apartment|apt|flat|no)\.?\s*)?\d+[a-z]?\s*/i, ''));
  if (street.length < 5 || street === norm(locality) || countyName(street)) return '';
  return street;
}

function validDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return false;
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

function recent(day, t) {
  const date = new Date(t * 1000);
  const today = date.toISOString().slice(0, 10);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 18);
  return validDay(day) && day >= date.toISOString().slice(0, 10) && day <= today;
}

function matchesLocality(address, locality, county) {
  const segments = address.replace(eircodeRe, '').split(',').map(norm);
  if (segments.some(segment => segment === locality || segment.endsWith(` ${locality}`))) return true;
  const full = norm(address.replace(eircodeRe, '')).replace(/\b(?:co|county) /g, '').replace(/ ireland$/, '');
  return full.endsWith(` ${locality} ${norm(county)}`) || full.endsWith(` ${locality}`);
}

function candidates(property, rows, county, locality, t) {
  const query = norm(locality), street = streetFor(property, locality), target = property.address || property.title || '';
  const apartment = unit(`${target} ${property.title || ''}`) || property.beds === 0;
  const targetRouting = routing(target);
  return rows.filter(row => countyName(row.county) === county && !row.newBuild &&
    Number.isFinite(row.sold) && row.sold > 0 && recent(row.day, t) &&
    !/\b(?:units?|apartments?|houses?)\s+(?:nos?\.?\s+)?\d+\s*(?:to|&|-)\s*\d+\b/i.test(row.address))
    .flatMap(row => {
      const address = norm(row.address);
      const streetMatch = contains(address, street);
      const localMatch = matchesLocality(row.address, query, county) || (county === 'Dublin' && query.startsWith('dublin ') &&
        matchesLocality(row.address, query.replace(/^dublin /, 'd '), county));
      const rowRouting = routing(row.eircode) || routing(row.address);
      // A short address may omit the locality. A shared routing key corroborates the same street.
      if (!localMatch && !(streetMatch && targetRouting && targetRouting === rowRouting)) return [];
      if (unit(row.address) !== apartment) return [];
      return [{ address: row.address, day: row.day, sold: row.sold, url: row.url || REGISTER_HOME, eircode: row.eircode || '',
        source: 'psra', match: streetMatch ? 'Same street or estate' : 'Same locality',
        score: (streetMatch ? 4 : 0) + (targetRouting && rowRouting === targetRouting ? 1 : 0) }];
    }).sort((a, b) => b.score - a.score || b.day.localeCompare(a.day)).slice(0, 80);
}

function quantile(values, rank) {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * rank;
  const start = Math.floor(index);
  return sorted[start] + (sorted[Math.ceil(index)] - sorted[start]) * (index - start);
}

function summarize(property, saved, manual, t) {
  const address = property.address || property.title || '';
  const currentEircode = address.match(eircodeRe)?.[0].replace(/\s/g, '').toUpperCase();
  const addressKey = groupAddress(address);
  const seen = new Set();
  const seenCodes = new Set();
  const manualRows = manual.filter(row => recent(row.day, t) &&
    (property.beds == null || row.beds == null || Math.abs(property.beds - row.beds) <= 1) &&
    (!property.area || !row.area || Math.abs(row.area / property.area - 1) <= 0.3))
    .map(row => ({ ...row, source: 'daft', match: 'Daft comparable you added' }));
  const matched = [...manualRows, ...(saved?.candidates || [])].filter(row => {
    if (!recent(row.day, t)) return false;
    const key = groupAddress(row.address);
    const code = String(row.eircode || row.address.match(eircodeRe)?.[0] || '').replace(/\s/g, '').toUpperCase();
    if (!key || key === addressKey || (code && code === currentEircode) || seen.has(key) || (code && seenCodes.has(code))) return false;
    seen.add(key);
    if (code) seenCodes.add(code);
    return true;
  });
  const closest = matched.filter(row => row.source === 'daft' || row.score >= 4);
  const comparisons = (closest.length >= MIN_SALES ? closest : matched).slice(0, MAX_SALES);
  const paired = comparisons.filter(row => row.asking > 0).map(row => (row.sold - row.asking) / row.asking);
  const result = {
    county: saved?.county || '', locality: saved?.locality || '', asOf: saved?.asOf || 0,
    comparisons, pairCount: paired.length, medianGap: paired.length >= MIN_SALES ? quantile(paired, 0.5) : null,
  };
  if (comparisons.length < MIN_SALES) {
    return { ...result, status: saved?.status === 'unavailable' ? 'unavailable' : saved?.asOf ? 'thin' : 'idle',
      low: null, mid: null, high: null,
      reason: saved?.reason || (saved?.asOf ? 'Fewer than three comparable sales were found in the last 18 months.' : '') };
  }
  const prices = comparisons.map(row => row.sold);
  const low = Math.floor(quantile(prices, prices.length < 5 ? 0 : 0.25) / ROUND) * ROUND;
  const high = Math.ceil(quantile(prices, prices.length < 5 ? 1 : 0.75) / ROUND) * ROUND;
  return { ...result, status: 'ready', low, mid: Math.round(quantile(prices, 0.5) / ROUND) * ROUND, high };
}

function listComparables(property) {
  return crm().prepare('SELECT * FROM house_sale_comparables WHERE property_id = ? ORDER BY day DESC, rowid DESC').all(property.id);
}

function get(property, t = now()) {
  const row = crm().prepare('SELECT * FROM house_valuations WHERE property_id = ? AND fingerprint = ?').get(property.id, fingerprint(property));
  const saved = row ? { ...JSON.parse(row.snapshot), county: row.county, locality: row.locality } : inferred(property);
  return summarize(property, saved, listComparables(property), t);
}

function persist(property, county, locality, snapshot) {
  crm().prepare(`INSERT INTO house_valuations (property_id,fingerprint,county,locality,snapshot) VALUES (?,?,?,?,?)
    ON CONFLICT(property_id) DO UPDATE SET fingerprint=excluded.fingerprint,county=excluded.county,
    locality=excluded.locality,snapshot=excluded.snapshot`).run(property.id, fingerprint(property), county, locality, JSON.stringify(snapshot));
}

async function refresh(property, { county, locality, salesFor = register.salesFor, t = now() } = {}) {
  const prior = get(property, t);
  const picked = countyName(clean(county, 40) || prior.county);
  const area = clean(locality, 100) || prior.locality;
  if (!picked || norm(area).length < 3 || countyName(area) || norm(area) === 'ireland') {
    return { ...prior, status: 'needs_location', reason: 'Choose a county and enter the town, neighbourhood or estate.' };
  }
  let evidence;
  try {
    evidence = await salesFor(picked, { t });
  } catch {
    const reason = 'The Property Price Register could not be reached. Try again shortly.';
    if (!prior.asOf) persist(property, picked, area, { status: 'unavailable', reason });
    return { ...prior, status: 'unavailable', reason };
  }
  persist(property, picked, area, { asOf: evidence.asOf || t, candidates: candidates(property, evidence.rows, picked, area, t) });
  return get(property, t);
}

function soldLink(value) {
  const url = new URL(clean(value, 2000));
  if (url.protocol !== 'https:' || !['www.daft.ie', 'daft.ie'].includes(url.hostname) || url.port || url.username || url.password ||
      !/^\/sold\/[a-z0-9-]+\/[a-z0-9]+\/?$/i.test(url.pathname)) throw new Error('Enter a Daft Sold property link.');
  return { url: `https://www.daft.ie${url.pathname.replace(/\/$/, '')}`, source_id: url.pathname.split('/').filter(Boolean).at(-1).toLowerCase() };
}

function formNumber(value, label, max, integer, min = 1) {
  if (value == null || value === '') return null;
  const n = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`Enter a valid ${label}.`);
  return n;
}

function addComparable(property, input) {
  const address = clean(input.address, 300), day = clean(input.day, 10);
  if (!address || !validDay(day) || day > new Date().toISOString().slice(0, 10)) throw new Error('Enter the address and a valid sale date.');
  let source;
  try { source = soldLink(input.url); } catch { throw new Error('Enter a Daft Sold property link.'); }
  const sold = formNumber(input.sold, 'sale price in whole euros', 100_000_000, true);
  if (!sold) throw new Error('Enter the sale price.');
  const row = { id: uuid(), property_id: property.id, address, day, sold, ...source,
    asking: formNumber(input.asking, 'asking price in whole euros', 100_000_000, true),
    beds: formNumber(input.beds, 'bedroom count', 100, true, 0),
    area: formNumber(input.area, 'floor area', 100_000, false) };
  const db = crm();
  const result = db.prepare(`INSERT INTO house_sale_comparables (id,property_id,address,day,sold,asking,beds,area,url,source_id)
    VALUES (@id,@property_id,@address,@day,@sold,@asking,@beds,@area,@url,@source_id)
    ON CONFLICT(property_id,source_id) DO NOTHING`).run(row);
  if (!result.changes) throw new Error('That Daft sale is already saved for this property.');
  return row;
}

function removeComparable(property, id) {
  return crm().prepare('DELETE FROM house_sale_comparables WHERE property_id = ? AND id = ?').run(property.id, id).changes;
}

module.exports = { get, refresh, listComparables, addComparable, removeComparable };
