'use strict';

const { createHash } = require('node:crypto');
const { crm, now } = require('../db');
const { uuid } = require('../../id');
const register = require('./sales-register');
const daft = require('./daft');
const MIN_SALES = 3;
const MAX_SALES = 12;
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

const STREET_WORD_RE = /\b(road|street|avenue|ave|drive|court|park|wood|lane|view|place|terrace|rise|grove|close|way|square|sq|crescent|row|walk|green|gardens|quay|hall|house|lodge|mews|manor|court)\b/i;

function inferred(property) {
  const address = property.address || property.title || '';
  const sections = address.replace(eircodeRe, '').split(',').map(part => part.trim()).filter(Boolean);
  let county = '', locality = '', district = '';
  const last = sections.at(-1);
  const dMatch = last?.match(/^dublin\s+(\d{1,2}w?)$/i);
  if (dMatch) {
    county = 'Dublin';
    district = last;
    // Prefer the specific neighbourhood before "Dublin 9" (e.g. "Santry") over the whole postal district.
    const prev = sections.length >= 3 ? sections.at(-2) : '';
    const prevIsArea = prev && !/\d/.test(prev) && !STREET_WORD_RE.test(prev) && norm(prev).length >= 3 && !countyName(prev);
    locality = prevIsArea ? prev : last;
  } else if (countyName(last)) {
    county = countyName(last);
    locality = sections.at(-2) || '';
  }
  if (/\d/.test(locality) && !/^dublin\s+\d{1,2}w?$/i.test(locality)) locality = district || '';
  if (sections.length < 3 && locality && STREET_WORD_RE.test(locality)) locality = district || '';
  return { county, locality, district };
}

function estateOrStreetParts(property, locality) {
  const parts = (property.address || property.title || '').replace(eircodeRe, '').split(',').map(p => p.trim()).filter(Boolean);
  const locNorm = norm(locality);
  const out = [];
  for (let i = 0; i < Math.min(parts.length, 3); i++) {
    const cleaned = norm(parts[i].replace(/^(?:(?:apartment|apt|flat|no|unit)\.?\s*)?\d+[a-z]?\s*/i, ''));
    if (cleaned.length < 4 || cleaned === locNorm || countyName(cleaned) || /^dublin\s+\d{1,2}w?$/.test(cleaned)) continue;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
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

function recent(day, t, months = 18) {
  const date = new Date(t * 1000);
  const today = date.toISOString().slice(0, 10);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  return validDay(day) && day >= date.toISOString().slice(0, 10) && day <= today;
}

function matchesLocality(address, locality, county) {
  const segments = address.replace(eircodeRe, '').split(',').map(norm);
  if (segments.some(segment => segment === locality || segment.endsWith(` ${locality}`) || segment.startsWith(`${locality} `))) return true;
  const full = norm(address.replace(eircodeRe, '')).replace(/\b(?:co|county) /g, '').replace(/ ireland$/, '');
  return full.endsWith(` ${locality} ${norm(county)}`) || full.endsWith(` ${locality}`);
}

const MULTI_UNIT_RE = /\b(?:units?|apartments?|apts?|flats?|houses?|blocks?)\s+(?:nos?\.?\s+)?\d+\s*(?:to|&|-|and)\s*\d+\b|\b(?:entire|whole)\s+(?:block|building|development)\b|\b\d+\s+(?:apartments|flats|units)\b/i;

function candidates(property, rows, county, locality, t) {
  const query = norm(locality);
  const inf = inferred(property);
  const district = inf.district && norm(inf.district) !== query ? norm(inf.district) : '';
  const street = streetFor(property, locality);
  const estateParts = estateOrStreetParts(property, locality);
  const target = property.address || property.title || '';
  const apartment = unit(`${target} ${property.title || ''}`) || property.beds === 0;
  const targetRouting = routing(target);

  return rows.filter(row => countyName(row.county) === county && !row.newBuild &&
    Number.isFinite(row.sold) && row.sold > 0 && recent(row.day, t) &&
    !MULTI_UNIT_RE.test(row.address))
    .flatMap(row => {
      const address = norm(row.address);
      const streetMatch = contains(address, street) || estateParts.some(p => contains(address, p));
      const localMatch = matchesLocality(row.address, query, county) || (county === 'Dublin' && query.startsWith('dublin ') &&
        matchesLocality(row.address, query.replace(/^dublin /, 'd '), county));
      const districtMatch = !localMatch && district && (
        matchesLocality(row.address, district, county) || matchesLocality(row.address, district.replace(/^dublin /, 'd '), county)
      );
      const rowRouting = routing(row.eircode) || routing(row.address);
      // A short address may omit the locality. A shared routing key corroborates the same street.
      if (!localMatch && !districtMatch && !(streetMatch && targetRouting && targetRouting === rowRouting)) return [];
      if (unit(row.address) !== apartment) return [];
      const match = streetMatch ? 'Same street or estate' : localMatch ? 'Same locality' : `Wider area (${inf.district})`;
      const score = (streetMatch ? 4 : 0) + (localMatch ? 2 : 0) + (targetRouting && rowRouting === targetRouting ? 1 : 0);
      return [{
        address: row.address, day: row.day, sold: row.sold, url: row.url || REGISTER_HOME, eircode: row.eircode || '',
        source: 'psra', match, score,
      }];
    }).sort((a, b) => b.score - a.score || b.day.localeCompare(a.day)).slice(0, 80);
}

function quantile(values, rank) {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * rank;
  const start = Math.floor(index);
  return sorted[start] + (sorted[Math.ceil(index)] - sorted[start]) * (index - start);
}

// Drop obvious multi-unit / whole-building PPR outliers (e.g. a €1.4M whole
// house of flats recorded under "Apt 1" against €350k apartments).
function filterOutliers(rows) {
  if (rows.length < 4) return { kept: rows, removed: [] };
  const med = quantile(rows.map(r => r.sold), 0.5);
  if (!med || med <= 0) return { kept: rows, removed: [] };
  const kept = [], removed = [];
  for (const r of rows) {
    // Only strip extreme PPR outliers (no beds/area metadata) that exceed 2.1x median or fall below 0.35x median.
    const isPprExtreme = r.source === 'psra' && (r.sold > med * 2.1 || r.sold < med * 0.35);
    if (isPprExtreme) removed.push(r);
    else kept.push(r);
  }
  return kept.length >= MIN_SALES ? { kept, removed } : { kept: rows, removed: [] };
}

function similarityScore(property, row, { locality = '', district = '', targetType = '', targetBer = '', estateParts = [], t = now() } = {}) {
  let score = 0;
  const reasons = [];
  const addr = norm(row.address);
  const locNorm = norm(locality);
  const distNorm = norm(district);

  if (row.source === 'daft_manual' || row.match === 'Daft comparable you added') {
    score += 18;
  }

  // 1. Location proximity (up to 40 pts)
  const sameEstate = estateParts.some(p => contains(addr, p));
  const sameNeighbourhood = locNorm && (contains(addr, locNorm) || matchesLocality(row.address, locNorm, ''));
  const sameDistrict = distNorm && (contains(addr, distNorm) || matchesLocality(row.address, distNorm, ''));
  if (sameEstate) { score += 40; reasons.push('Same estate/street'); }
  else if (sameNeighbourhood) { score += 28; reasons.push(`Same area (${locality})`); }
  else if (sameDistrict) { score += 14; reasons.push(`Same district (${district})`); }
  else if (row.score >= 4) { score += 35; reasons.push('Same street or estate'); }
  else { score += 8; }

  // 2. Property type (up to 20 pts)
  const compType = row.property_type ? daft.typeFamily(row.property_type, row.address) : (unit(row.address) ? 'apartment' : 'house');
  if (targetType && compType === targetType) {
    score += 20;
    if (row.property_type) reasons.push(row.property_type);
  } else if (targetType && compType !== 'apartment' && targetType !== 'apartment') {
    score += 10;
  }

  // 3. Bedrooms (up to 18 pts)
  if (property.beds != null && row.beds != null) {
    const diff = Math.abs(property.beds - row.beds);
    if (diff === 0) { score += 18; reasons.push(`Exact ${row.beds} bed`); }
    else if (diff === 1) { score += 9; reasons.push(`${row.beds} bed`); }
  }

  // 4. Floor area closeness (up to 16 pts)
  if (property.area > 0 && row.area > 0) {
    const ratio = Math.abs(row.area / property.area - 1);
    if (ratio <= 0.12) { score += 16; reasons.push(`Very close size (${row.area} m²)`); }
    else if (ratio <= 0.25) { score += 10; reasons.push(`Similar size (${row.area} m²)`); }
    else if (ratio <= 0.38) { score += 4; }
  }

  // 5. Asking + sold pair & recency bonus (up to 10 pts)
  if (row.asking > 0) score += 5;
  if (recent(row.day, t, 6)) score += 5;
  else if (recent(row.day, t, 12)) score += 3;

  // 6. BER closeness (up to 4 pts)
  if (targetBer && row.ber && targetBer[0] === row.ber[0]) score += 4;

  return {
    similarity: Math.min(100, score),
    reasons,
  };
}

function saveDaftSoldRows(rows, t = now()) {
  if (!rows.length) return 0;
  const db = crm();
  const stmt = db.prepare(`INSERT INTO house_daft_sold
    (source_id, county, locality, address, day, sold, asking, beds, baths, area, property_type, ber, lat, lng,
     seller_agency, seller_agent, seller_licence, seller_key, url, fetched_at)
    VALUES (@source_id, @county, @locality, @address, @day, @sold, @asking, @beds, @baths, @area, @property_type, @ber, @lat, @lng,
     @seller_agency, @seller_agent, @seller_licence, @seller_key, @url, @fetched_at)
    ON CONFLICT(source_id) DO UPDATE SET
      county=excluded.county, locality=excluded.locality, address=excluded.address, day=excluded.day,
      sold=excluded.sold, asking=COALESCE(excluded.asking, house_daft_sold.asking),
      beds=COALESCE(excluded.beds, house_daft_sold.beds), baths=COALESCE(excluded.baths, house_daft_sold.baths),
      area=COALESCE(excluded.area, house_daft_sold.area), property_type=CASE WHEN excluded.property_type != '' THEN excluded.property_type ELSE house_daft_sold.property_type END,
      ber=CASE WHEN excluded.ber != '' THEN excluded.ber ELSE house_daft_sold.ber END,
      lat=COALESCE(excluded.lat, house_daft_sold.lat), lng=COALESCE(excluded.lng, house_daft_sold.lng),
      seller_agency=CASE WHEN excluded.seller_agency != '' THEN excluded.seller_agency ELSE house_daft_sold.seller_agency END,
      seller_agent=CASE WHEN excluded.seller_agent != '' THEN excluded.seller_agent ELSE house_daft_sold.seller_agent END,
      seller_licence=CASE WHEN excluded.seller_licence != '' THEN excluded.seller_licence ELSE house_daft_sold.seller_licence END,
      seller_key=CASE WHEN excluded.seller_key != '' THEN excluded.seller_key ELSE house_daft_sold.seller_key END,
      url=excluded.url, fetched_at=excluded.fetched_at`);
  let count = 0;
  db.transaction(() => {
    for (const r of rows) {
      const agency = String(r.seller_agency || '').trim();
      stmt.run({
        ...r,
        seller_agency: agency,
        seller_agent: String(r.seller_agent || '').trim(),
        seller_licence: String(r.seller_licence || '').trim(),
        seller_key: String(r.seller_key || daft.normalizeAgencyKey(agency)).trim(),
        fetched_at: t,
      });
      count += 1;
    }
  })();
  return count;
}

function sellerStatsFromPaired(paired) {
  if (!paired.length) return null;
  const gaps = paired.map(r => (r.sold - r.asking) / r.asking);
  const euroDiffs = paired.map(r => r.sold - r.asking);
  const overCount = paired.filter(r => r.sold > r.asking).length;
  return {
    pairedCount: paired.length,
    medianGap: quantile(gaps, 0.5),
    meanGap: gaps.reduce((s, v) => s + v, 0) / gaps.length,
    minGap: Math.min(...gaps),
    maxGap: Math.max(...gaps),
    p25Gap: paired.length >= 4 ? quantile(gaps, 0.25) : Math.min(...gaps),
    p75Gap: paired.length >= 4 ? quantile(gaps, 0.75) : Math.max(...gaps),
    medianEuroDiff: Math.round(quantile(euroDiffs, 0.5) / 1000) * 1000,
    overAskingPct: Math.round((overCount / paired.length) * 100),
  };
}

function sellerProfile({ agency = '', agent = '', licence = '', sellerKey = '', askingPrice = null } = {}) {
  const cleanAgency = String(agency || '').trim();
  const cleanLicence = String(licence || '').trim();
  const key = String(sellerKey || daft.normalizeAgencyKey(cleanAgency)).trim();
  if (!key && !cleanLicence) return null;

  const db = crm();
  const rows = cleanLicence
    ? db.prepare(`SELECT * FROM house_daft_sold
        WHERE (seller_key != '' AND seller_key = ?) OR (seller_licence != '' AND seller_licence = ?)
        ORDER BY day DESC LIMIT 300`).all(key, cleanLicence)
    : db.prepare(`SELECT * FROM house_daft_sold
        WHERE seller_key != '' AND seller_key = ?
        ORDER BY day DESC LIMIT 300`).all(key);

  const paired = rows.filter(r => r.asking > 0 && r.sold > 0);
  const stats = sellerStatsFromPaired(paired);
  const displayAgency = cleanAgency || rows.find(r => r.seller_agency)?.seller_agency || '';
  const displayLicence = cleanLicence || rows.find(r => r.seller_licence)?.seller_licence || '';

  let expectedMid = null, expectedLow = null, expectedHigh = null;
  if (stats && askingPrice > 0) {
    expectedMid = Math.round((askingPrice * (1 + stats.medianGap)) / ROUND) * ROUND;
    expectedLow = Math.floor((askingPrice * (1 + stats.p25Gap)) / ROUND) * ROUND;
    expectedHigh = Math.ceil((askingPrice * (1 + stats.p75Gap)) / ROUND) * ROUND;
  }

  return {
    agency: displayAgency,
    agent: String(agent || '').trim(),
    licence: displayLicence,
    sellerKey: key,
    totalSales: rows.length,
    pairedCount: paired.length,
    ...(stats || { medianGap: null, meanGap: null, minGap: null, maxGap: null, p25Gap: null, p75Gap: null, medianEuroDiff: null, overAskingPct: null }),
    expectedMid,
    expectedLow,
    expectedHigh,
    confidence: paired.length >= 8 ? 'high' : paired.length >= 3 ? 'medium' : paired.length >= 1 ? 'early' : 'none',
    examples: paired.slice(0, 8),
  };
}

function sellerLeaderboard({ county = '', locality = '' } = {}) {
  const db = crm();
  const c = countyName(clean(county, 40));
  const locNorm = norm(clean(locality, 100));
  const raw = c
    ? db.prepare("SELECT * FROM house_daft_sold WHERE seller_key != '' AND lower(county) = lower(?) ORDER BY day DESC LIMIT 2000").all(c)
    : db.prepare("SELECT * FROM house_daft_sold WHERE seller_key != '' ORDER BY day DESC LIMIT 2000").all();

  const filtered = locNorm
    ? raw.filter(r => norm(r.locality) === locNorm || matchesLocality(r.address, locNorm, c || r.county))
    : raw;

  const groups = new Map();
  for (const r of filtered) {
    const k = r.seller_key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const board = [];
  for (const [sellerKey, list] of groups.entries()) {
    const paired = list.filter(r => r.asking > 0 && r.sold > 0);
    if (!paired.length) continue;
    const stats = sellerStatsFromPaired(paired);
    const agencyCounts = new Map();
    const areaCounts = new Map();
    for (const r of list) {
      if (r.seller_agency) agencyCounts.set(r.seller_agency, (agencyCounts.get(r.seller_agency) || 0) + 1);
      const areaLabel = r.locality || r.county;
      if (areaLabel) areaCounts.set(areaLabel, (areaCounts.get(areaLabel) || 0) + 1);
    }
    const agency = [...agencyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || sellerKey;
    const areas = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    const licence = list.find(r => r.seller_licence)?.seller_licence || '';
    board.push({
      sellerKey,
      agency,
      licence,
      totalSales: list.length,
      ...stats,
      areas,
      latestDay: list[0]?.day || '',
    });
  }

  return board.sort((a, b) => b.pairedCount - a.pairedCount || b.medianGap - a.medianGap || a.agency.localeCompare(b.agency));
}

function daftSoldForArea(county, locality, district = '') {
  if (!county) return [];
  const db = crm();
  const rows = db.prepare('SELECT * FROM house_daft_sold WHERE lower(county) = lower(?) ORDER BY day DESC LIMIT 400').all(county);
  const locNorm = norm(locality);
  const distNorm = norm(district);
  if (!locNorm && !distNorm) return rows;
  return rows.filter(r => {
    const rl = norm(r.locality);
    if (locNorm && (rl === locNorm || matchesLocality(r.address, locNorm, county))) return true;
    if (distNorm && (rl === distNorm || matchesLocality(r.address, distNorm, county) || matchesLocality(r.address, distNorm.replace(/^dublin /, 'd '), county))) return true;
    return false;
  });
}

function buildGapExplanation(property, { mid, sqmEstimate, askEstimate, medianGap, pairCount, comparisons, locality, signals, outliersRemoved, sellerStats }) {
  const parts = [];
  if (property.asking_price > 0 && mid > 0) {
    const diff = property.asking_price - mid;
    const pct = Math.round(Math.abs(diff / mid) * 100);
    if (pct >= 12) {
      parts.push(diff < 0
        ? `Asking (${eur(property.asking_price)}) is ${pct}% below the similar-sales median (${eur(mid)}).`
        : `Asking (${eur(property.asking_price)}) is ${pct}% above the similar-sales median (${eur(mid)}).`);
    } else if (pct >= 3) {
      parts.push(`Asking (${eur(property.asking_price)}) sits close to similar sales (${pct}% ${diff < 0 ? 'below' : 'above'} the ${eur(mid)} median).`);
    } else {
      parts.push(`Asking (${eur(property.asking_price)}) is right in line with similar recent sales.`);
    }
  }

  if (sqmEstimate && property.asking_price > 0) {
    parts.push(`On a floor-area basis, similar homes sold at ${eur(sqmEstimate.perSqm)}/m² (implying ~${eur(sqmEstimate.estimate)} for ${property.area} m²).`);
  }

  if (askEstimate && pairCount >= MIN_SALES) {
    const pct = Math.round(Math.abs(medianGap) * 1000) / 10;
    parts.push(medianGap === 0
      ? `Across ${pairCount} paired Daft sales, similar homes sold right at asking.`
      : `Across ${pairCount} paired Daft sales, similar homes sold a median ${pct}% ${medianGap > 0 ? 'over' : 'under'} asking (implying ~${eur(askEstimate)} from this asking price).`);
  }

  if (sellerStats?.agency && sellerStats.pairedCount >= 2 && Number.isFinite(sellerStats.medianGap)) {
    const sPct = Math.round(Math.abs(sellerStats.medianGap) * 1000) / 10;
    const dir = sellerStats.medianGap === 0 ? 'right at asking' : `${sPct}% ${sellerStats.medianGap > 0 ? 'over' : 'under'} asking`;
    const implied = sellerStats.expectedMid ? ` (pointing toward ~${eur(sellerStats.expectedMid)} from this asking price)` : '';
    parts.push(`Selling agent ${sellerStats.agency}: across ${sellerStats.pairedCount} tracked sales, their listings sold a median ${dir}${implied}.`);
  }

  const downSignals = (signals || []).filter(s => s.impact === 'price_down');
  const upSignals = (signals || []).filter(s => s.impact === 'price_up');
  if (downSignals.length) {
    parts.push(`Listing price-down factors: ${downSignals.map(s => s.label).join(', ')}.`);
  }
  if (upSignals.length) {
    parts.push(`Listing value-add factors: ${upSignals.map(s => s.label).join(', ')}.`);
  }

  const sameEstateCount = comparisons.filter(c => c.match === 'Same street or estate' || (c.reasons || []).includes('Same estate/street')).length;
  const daftCount = comparisons.filter(c => c.source === 'daft' || c.source === 'daft_auto').length;
  if (!sameEstateCount && locality) {
    parts.push(`None of the ${comparisons.length} comparables are in the exact same development/street — check whether the matched streets are dearer or cheaper than ${locality}.`);
  } else if (daftCount === 0 && comparisons.length) {
    parts.push('Only Property Price Register rows were matched (no bedrooms or floor area). Refresh to include Daft Sold data where available.');
  }
  if (outliersRemoved > 0) {
    parts.push(`Excluded ${outliersRemoved} extreme register outlier${outliersRemoved === 1 ? '' : 's'} (likely whole-building or multi-unit sales).`);
  }
  return parts.join(' ');
}

function eur(n) {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}

function summarize(property, saved, manual, t, { daftAuto = [], listing = null, sellerStats = null } = {}) {
  const address = property.address || property.title || '';
  const inf = inferred(property);
  const locality = saved?.locality || inf.locality || '';
  const county = saved?.county || inf.county || '';
  const district = inf.district || '';
  const targetType = daft.typeFamily(listing?.property_type || '', `${address} ${property.title || ''}`);
  const targetIsApt = targetType === 'apartment' || targetType === 'duplex' || property.beds === 0;
  const targetBer = listing?.ber || '';
  const targetSellerKey = listing?.seller_key || property.seller_key || daft.normalizeAgencyKey(listing?.seller_agency || property.seller_agency || '');
  const targetSellerLicence = listing?.seller_licence || property.seller_licence || '';
  const estateParts = estateOrStreetParts(property, locality);

  const currentEircode = address.match(eircodeRe)?.[0].replace(/\s/g, '').toUpperCase();
  const addressKey = groupAddress(address);
  const seen = new Set();
  const seenCodes = new Set();

  const fitsSpecs = row => {
    if (property.beds != null && row.beds != null && Math.abs(property.beds - row.beds) > 1) return false;
    if (property.area > 0 && row.area > 0 && Math.abs(row.area / property.area - 1) > 0.35) return false;
    if (row.property_type) {
      const f = daft.typeFamily(row.property_type, row.address);
      if ((f === 'apartment') !== targetIsApt && !(f === 'duplex' && targetIsApt)) return false;
      if (f === 'site') return false;
    }
    return true;
  };

  const manualRows = manual.filter(row => recent(row.day, t) &&
    (property.beds == null || row.beds == null || Math.abs(property.beds - row.beds) <= 1) &&
    (!property.area || !row.area || Math.abs(row.area / property.area - 1) <= 0.3))
    .map(row => ({ ...row, source: 'daft', match: 'Daft comparable you added', priorityTier: 0 }));

  const autoDaftRows = daftAuto
    .filter(row => recent(row.day, t) && fitsSpecs(row))
    .map(row => ({ ...row, source: 'daft_auto', match: 'Daft Sold (similar)', priorityTier: 1 }));

  const pprRows = (saved?.candidates || []).map(row => ({ ...row, source: 'psra', priorityTier: 2 }));

  const rawMatched = [...manualRows, ...autoDaftRows, ...pprRows].filter(row => {
    if (!recent(row.day, t)) return false;
    const key = groupAddress(row.address);
    const code = String(row.eircode || row.address.match(eircodeRe)?.[0] || '').replace(/\s/g, '').toUpperCase();
    if (!key || key === addressKey || (code && code === currentEircode) || seen.has(key) || (code && seenCodes.has(code))) return false;
    seen.add(key);
    if (code) seenCodes.add(code);
    return true;
  });

  const { kept: cleanRows, removed: outlierRows } = filterOutliers(rawMatched);

  const scored = cleanRows.map(row => {
    const { similarity, reasons } = similarityScore(property, row, { locality, district, targetType, targetBer, estateParts, t });
    const match = row.source === 'daft'
      ? 'Daft comparable you added'
      : row.source === 'daft_auto'
        ? (reasons.slice(0, 3).join(' · ') || 'Daft Sold (similar)')
        : row.match;
    return { ...row, similarity, reasons, match };
  });

  // Prefer Daft comparables (manual + auto-matched with beds/size/type) or exact street/estate PPR rows
  // whenever at least MIN_SALES exist; otherwise include wider PPR rows sorted by similarity.
  const daftOnly = scored.filter(r => r.source === 'daft' || r.source === 'daft_auto');
  const tightSet = scored.filter(r => r.source === 'daft' || r.source === 'daft_auto' || r.score >= 4);
  const localOnly = scored.filter(r => r.source === 'daft' || r.source === 'daft_auto' || r.score >= 2);
  let pool;
  if (manualRows.length && scored.filter(r => r.source === 'daft' || r.score >= 4).length >= MIN_SALES && !autoDaftRows.length) {
    pool = scored.filter(r => r.source === 'daft' || r.score >= 4);
  } else if (daftOnly.length >= MIN_SALES) {
    pool = [...daftOnly].sort((a, b) => (a.source === 'daft' ? -1 : 0) - (b.source === 'daft' ? -1 : 0) || b.similarity - a.similarity || b.day.localeCompare(a.day));
  } else if (tightSet.length >= MIN_SALES) {
    pool = [...tightSet].sort((a, b) => a.priorityTier - b.priorityTier || b.similarity - a.similarity || b.day.localeCompare(a.day));
  } else if (localOnly.length >= MIN_SALES) {
    pool = [...localOnly].sort((a, b) => a.priorityTier - b.priorityTier || b.similarity - a.similarity || b.day.localeCompare(a.day));
  } else {
    pool = [...scored].sort((a, b) => a.priorityTier - b.priorityTier || b.similarity - a.similarity || b.day.localeCompare(a.day));
  }

  const comparisons = pool.slice(0, MAX_SALES).map(row => {
    const rowKey = row.seller_key || daft.normalizeAgencyKey(row.seller_agency || '');
    const sameSeller = Boolean(
      (targetSellerKey && rowKey && rowKey === targetSellerKey)
      || (targetSellerLicence && row.seller_licence && row.seller_licence === targetSellerLicence)
    );
    return { ...row, sameSeller };
  });
  const paired = comparisons.filter(row => row.asking > 0).map(row => (row.sold - row.asking) / row.asking);
  const medianGap = paired.length >= MIN_SALES ? quantile(paired, 0.5) : null;

  // Size-adjusted (€/m²) estimate from comparables with floor area.
  const areaComps = comparisons.filter(r => r.area > 0 && r.sold > 0);
  let sqmEstimate = null;
  if (property.area > 0 && areaComps.length >= 2) {
    const perSqm = Math.round(quantile(areaComps.map(r => r.sold / r.area), 0.5));
    const est = Math.round((perSqm * property.area) / ROUND) * ROUND;
    sqmEstimate = { perSqm, estimate: est, count: areaComps.length };
  }

  // Asking-trend estimate from paired Daft sales applied to this property's asking price.
  const askEstimate = medianGap != null && property.asking_price > 0
    ? Math.round((property.asking_price * (1 + medianGap)) / ROUND) * ROUND
    : null;

  const result = {
    county, locality, district, asOf: saved?.asOf || 0,
    daftCount: comparisons.filter(c => c.source === 'daft' || c.source === 'daft_auto').length,
    outliersRemoved: outlierRows.length,
    comparisons, pairCount: paired.length, medianGap, sqmEstimate, askEstimate,
    gapExplanation: '',
  };

  if (comparisons.length < MIN_SALES) {
    return {
      ...result,
      status: saved?.status === 'unavailable' ? 'unavailable' : (saved?.asOf || autoDaftRows.length) ? 'thin' : 'idle',
      low: null, mid: null, high: null,
      reason: saved?.reason || ((saved?.asOf || autoDaftRows.length) ? 'Fewer than three comparable sales were found in the last 18 months.' : ''),
    };
  }

  const prices = comparisons.map(row => row.sold);
  const low = Math.floor(quantile(prices, prices.length < 5 ? 0 : 0.25) / ROUND) * ROUND;
  const high = Math.ceil(quantile(prices, prices.length < 5 ? 1 : 0.75) / ROUND) * ROUND;
  const mid = Math.round(quantile(prices, 0.5) / ROUND) * ROUND;
  const gapExplanation = buildGapExplanation(property, {
    mid, sqmEstimate, askEstimate, medianGap, pairCount: paired.length, comparisons, locality,
    signals: listing?.signals || [], outliersRemoved: outlierRows.length, sellerStats,
  });

  return { ...result, status: 'ready', low, mid, high, gapExplanation, sellerStats };
}

function listComparables(property) {
  return crm().prepare('SELECT * FROM house_sale_comparables WHERE property_id = ? ORDER BY day DESC, rowid DESC').all(property.id);
}

function get(property, t = now(), { listing = null } = {}) {
  const row = crm().prepare('SELECT * FROM house_valuations WHERE property_id = ? AND fingerprint = ?').get(property.id, fingerprint(property));
  const saved = row ? { ...JSON.parse(row.snapshot), county: row.county, locality: row.locality } : inferred(property);
  const inf = inferred(property);
  const daftAuto = daftSoldForArea(saved.county, saved.locality, inf.district);
  const agency = listing?.seller_agency || property.seller_agency || '';
  const agent = listing?.seller_agent || property.seller_agent || '';
  const licence = listing?.seller_licence || property.seller_licence || '';
  const sellerKey = listing?.seller_key || property.seller_key || daft.normalizeAgencyKey(agency);
  const sellerStats = (sellerKey || licence)
    ? sellerProfile({ agency, agent, licence, sellerKey, askingPrice: property.asking_price })
    : null;
  const out = summarize(property, saved, listComparables(property), t, { daftAuto, listing, sellerStats });
  return { ...out, sellerStats };
}

function persist(property, county, locality, snapshot) {
  crm().prepare(`INSERT INTO house_valuations (property_id,fingerprint,county,locality,snapshot) VALUES (?,?,?,?,?)
    ON CONFLICT(property_id) DO UPDATE SET fingerprint=excluded.fingerprint,county=excluded.county,
    locality=excluded.locality,snapshot=excluded.snapshot`).run(property.id, fingerprint(property), county, locality, JSON.stringify(snapshot));
}

async function fetchSoldViaWorker(county, locality, {
  extraLocality = '',
  pages = 2,
  jobs = require('../../subscription-agent-jobs'),
  timeoutMs = 35000,
} = {}) {
  const res = await jobs.enqueueWorkerTask({
    feature: 'crm_house_daft_sold',
    dedupeKey: `house-daft-sold:${norm(county)}:${norm(locality)}:${Date.now()}`,
    timeoutMs,
    payload: {
      task: 'daft_sold',
      requiresWorkerCapability: 'daft',
      maxAttempts: 1,
      county,
      locality,
      extraLocality,
      pages,
    },
  });
  const parsed = JSON.parse(res.output || '{}');
  return {
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    areaSlug: parsed.areaSlug || '',
    error: parsed.error || '',
  };
}

async function refresh(property, { county, locality, salesFor = register.salesFor, fetchSold = null, jobs = require('../../subscription-agent-jobs'), useWorker = null, t = now(), listing = null } = {}) {
  const prior = get(property, t, { listing });
  const inf = inferred(property);
  const picked = countyName(clean(county, 40) || prior.county || inf.county);
  const area = clean(locality, 100) || prior.locality || inf.locality;
  if (!picked || norm(area).length < 3 || countyName(area) || norm(area) === 'ireland') {
    return { ...prior, status: 'needs_location', reason: 'Choose a county and enter the town, neighbourhood or estate.' };
  }

  // Only hit live Daft Sold when running against real register (or explicit fetchSold stub).
  // Route live Daft Sold through the home dev-server worker when worker mode is enabled.
  const viaWorker = useWorker !== null ? Boolean(useWorker) : (!fetchSold && salesFor === register.salesFor && typeof jobs.enabled === 'function' && jobs.enabled());
  const daftFn = fetchSold
    || (viaWorker ? ((c, l, opts) => fetchSoldViaWorker(c, l, { ...opts, jobs }))
      : (salesFor === register.salesFor ? daft.fetchSoldArea : null));
  let daftNote = '';
  let daftLoaded = 0;
  if (daftFn) {
    try {
      const daftRes = await daftFn(picked, area, { extraLocality: inf.district, pages: 2 });
      if (daftRes?.rows?.length) daftLoaded = saveDaftSoldRows(daftRes.rows, t);
      else if (daftRes?.error) daftNote = `Daft Sold could not be reached (${daftRes.error}); using Property Price Register.`;
    } catch (err) {
      daftNote = `Daft Sold could not be reached (${err.message}); using Property Price Register.`;
    }
  }

  let evidence;
  try {
    evidence = await salesFor(picked, { t });
  } catch {
    if (daftLoaded > 0) {
      // Daft Sold succeeded even though PPR was temporarily unreachable.
      persist(property, picked, area, { asOf: t, candidates: prior.comparisons.filter(c => c.source === 'psra'), reason: 'Property Price Register was unreachable; showing Daft Sold comparables.' });
      return get(property, t, { listing });
    }
    const reason = 'The Property Price Register could not be reached. Try again shortly.';
    if (!prior.asOf) persist(property, picked, area, { status: 'unavailable', reason });
    return { ...prior, status: 'unavailable', reason };
  }

  persist(property, picked, area, {
    asOf: evidence.asOf || t,
    candidates: candidates(property, evidence.rows, picked, area, t),
    ...(daftNote ? { reason: daftNote } : {}),
  });
  return get(property, t, { listing });
}

// Historical area analysis across cached + on-demand Daft Sold data.
function areaHistory({ county = '', locality = '', propertyType = '', beds = '' } = {}) {
  const db = crm();
  const c = countyName(clean(county, 40));
  const loc = clean(locality, 100);
  const locNorm = norm(loc);
  const typeFilter = clean(propertyType, 40).toLowerCase();
  const bedsFilter = beds !== '' && beds != null && /^\d+$/.test(String(beds)) ? Number(beds) : null;

  const areas = db.prepare(`SELECT county, locality, COUNT(*) AS n, MAX(fetched_at) AS fetched_at
    FROM house_daft_sold GROUP BY lower(county), lower(locality) ORDER BY n DESC, locality`).all();

  const raw = c
    ? db.prepare('SELECT * FROM house_daft_sold WHERE lower(county) = lower(?) ORDER BY day DESC LIMIT 600').all(c)
    : db.prepare('SELECT * FROM house_daft_sold ORDER BY day DESC LIMIT 600').all();

  const filtered = raw.filter(r => {
    if (locNorm && norm(r.locality) !== locNorm && !matchesLocality(r.address, locNorm, c || r.county)) return false;
    if (typeFilter && daft.typeFamily(r.property_type, r.address) !== typeFilter) return false;
    if (bedsFilter != null && r.beds !== bedsFilter) return false;
    return true;
  });

  // Quarterly breakdown
  const byQuarter = new Map();
  for (const r of filtered) {
    const y = r.day.slice(0, 4);
    const m = Number(r.day.slice(5, 7));
    if (!y || !m) continue;
    const qKey = `${y} Q${Math.ceil(m / 3)}`;
    if (!byQuarter.has(qKey)) byQuarter.set(qKey, []);
    byQuarter.get(qKey).push(r);
  }
  const quarters = [...byQuarter.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([quarter, list]) => {
      const prices = list.map(x => x.sold);
      const sqm = list.filter(x => x.area > 0).map(x => x.sold / x.area);
      const gaps = list.filter(x => x.asking > 0).map(x => (x.sold - x.asking) / x.asking);
      return {
        quarter,
        count: list.length,
        medianSold: Math.round(quantile(prices, 0.5) / 1000) * 1000,
        minSold: Math.min(...prices),
        maxSold: Math.max(...prices),
        medianSqm: sqm.length ? Math.round(quantile(sqm, 0.5)) : null,
        medianGap: gaps.length ? quantile(gaps, 0.5) : null,
        paired: gaps.length,
      };
    });

  const prices = filtered.map(x => x.sold);
  const sqm = filtered.filter(x => x.area > 0).map(x => x.sold / x.area);
  const gaps = filtered.filter(x => x.asking > 0).map(x => (x.sold - x.asking) / x.asking);

  return {
    county: c,
    locality: loc,
    propertyType: typeFilter,
    beds: bedsFilter,
    areas,
    count: filtered.length,
    medianSold: prices.length ? Math.round(quantile(prices, 0.5) / 1000) * 1000 : null,
    medianSqm: sqm.length ? Math.round(quantile(sqm, 0.5)) : null,
    medianGap: gaps.length >= 2 ? quantile(gaps, 0.5) : null,
    paired: gaps.length,
    quarters,
    sellers: sellerLeaderboard({ county: c, locality: loc }),
    allSellers: (c || loc) ? sellerLeaderboard() : null,
    sales: filtered.slice(0, 60),
  };
}

async function refreshAreaHistory({ county, locality, pages = 2, fetchSold = null, jobs = require('../../subscription-agent-jobs'), useWorker = null, t = now() } = {}) {
  const c = countyName(clean(county, 40));
  const loc = clean(locality, 100);
  if (!c) throw new Error('Choose a county.');
  const viaWorker = useWorker !== null ? Boolean(useWorker) : (!fetchSold && typeof jobs.enabled === 'function' && jobs.enabled());
  const fn = fetchSold || (viaWorker ? ((cn, lc, opts) => fetchSoldViaWorker(cn, lc, { ...opts, jobs })) : daft.fetchSoldArea);
  const res = await fn(c, loc, { pages });
  if (!res.rows.length) throw new Error(res.error || `No recent Daft Sold records found for ${loc ? `${loc}, ` : ''}${c}.`);
  const saved = saveDaftSoldRows(res.rows, t);
  return { saved, areaSlug: res.areaSlug };
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

module.exports = {
  get,
  refresh,
  listComparables,
  addComparable,
  removeComparable,
  saveDaftSoldRows,
  sellerProfile,
  sellerLeaderboard,
  areaHistory,
  refreshAreaHistory,
  inferred,
  filterOutliers,
  similarityScore,
};
