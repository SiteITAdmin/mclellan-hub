'use strict';

// Driving commute estimator between saved properties and Douglas's workplace
// (Beacon Hospital, Sandyford, Dublin 18) for a 07:00 outbound and 16:00 return.
// Uses Google Routes API (live/historical weekday traffic) when GOOGLE_MAPS_API_KEY
// is configured, otherwise OSRM road routing + Dublin weekday peak bands.

const { crm, now } = require('../db');

const WORKPLACE = Object.freeze({
  name: 'Beacon Hospital',
  shortName: 'Beacon Hospital, Sandyford',
  address: 'Beacon Hospital, Sandyford, Dublin 18, Ireland',
  lat: 53.2767042,
  lng: -6.2188689,
  departAm: '07:00',
  departPm: '16:00',
});

const UA = 'McLellanHub/1.0 (+https://douglas.mclellan.scot)';
const MAJOR_ROAD_RE = /^(?:M50|M1|M2|M3|M4|M7|M11|N2|N3|N4|N7|N11|N81)$/i;

function parseCommute(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// Compute next weekday (Tuesday) at a given Europe/Dublin hour in RFC3339 UTC.
function nextWeekdayDublinIso(hour, refMs = Date.now()) {
  const d = new Date(refMs);
  // Advance to the next Tuesday (day 2) strictly in the future so traffic model uses a typical weekday.
  const daysAhead = ((2 - d.getUTCDay() + 7) % 7) || 7;
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead, hour, 0, 0));
  // Adjust for Europe/Dublin UTC offset (0 in winter GMT, +1 in summer IST).
  const dublinHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', hourCycle: 'h23' }).format(target));
  const diffHours = dublinHour - hour;
  if (diffHours !== 0) target.setUTCHours(target.getUTCHours() - diffHours);
  return target.toISOString();
}

function extractMajorRoads(route) {
  const seen = [];
  for (const leg of route?.legs || []) {
    for (const step of leg?.steps || []) {
      for (const token of String(step?.ref || '').split(/[;,\s]+/)) {
        const clean = token.trim().toUpperCase();
        if (MAJOR_ROAD_RE.test(clean) && !seen.includes(clean)) seen.push(clean);
      }
    }
  }
  return seen.slice(0, 4);
}

// Calibrated Dublin weekday peak driving bands from OSRM free-flow durations:
// - 07:00 outbound to Sandyford beats the worst 08:15 gridlock, though M50
//   Southbound (especially crossing from North Dublin) starts slowing after 07:10.
// - 16:00 return from Sandyford hits Blackthorn Road / J14 exit + afternoon M50 buildup.
function estimateDublinPeak(freeAmMin, freePmMin, { roads = [], originLat = null } = {}) {
  const usesM50 = roads.includes('M50');
  const crossesLiffeyM50 = usesM50 && Number.isFinite(originLat) && originLat > 53.355;

  const amLowMult = crossesLiffeyM50 ? 1.25 : usesM50 ? 1.15 : 1.10;
  const amHighMult = crossesLiffeyM50 ? 1.55 : usesM50 ? 1.38 : 1.25;
  const amPad = crossesLiffeyM50 ? 5 : usesM50 ? 3 : 2;

  const pmLowMult = crossesLiffeyM50 ? 1.45 : usesM50 ? 1.35 : 1.25;
  const pmHighMult = crossesLiffeyM50 ? 1.85 : usesM50 ? 1.65 : 1.50;
  const pmPad = crossesLiffeyM50 ? 8 : usesM50 ? 6 : 4;

  const amBase = Math.max(1, Math.round(freeAmMin));
  const pmBase = Math.max(1, Math.round(freePmMin));

  const amMin = Math.max(amBase + 1, Math.round(amBase * amLowMult + amPad * 0.5));
  const amMax = Math.max(amMin + 3, Math.round(amBase * amHighMult + amPad));
  const pmMin = Math.max(pmBase + 2, Math.round(pmBase * pmLowMult + pmPad * 0.5));
  const pmMax = Math.max(pmMin + 4, Math.round(pmBase * pmHighMult + pmPad));

  return { am_min: amMin, am_max: amMax, pm_min: pmMin, pm_max: pmMax, m50_toll: crossesLiffeyM50 };
}

async function fetchOsrmLeg(fromLat, fromLng, toLat, toLng, { fetcher = fetch } = {}) {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false&steps=true`;
  const res = await fetcher(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Routing service returned HTTP ${res.status}`);
  const data = await res.json();
  const route = data?.routes?.[0];
  if (!route || !Number.isFinite(route.duration)) throw new Error('No driving route found for that address.');
  return {
    distanceKm: Math.round((route.distance / 1000) * 10) / 10,
    durationMin: Math.max(1, Math.round(route.duration / 60)),
    roads: extractMajorRoads(route),
  };
}

async function fetchGoogleRoutesLeg(fromLat, fromLng, toLat, toLng, departureTime, apiKey, { fetcher = fetch } = {}) {
  const res = await fetcher('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
      'x-goog-fieldmask': 'routes.duration,routes.staticDuration,routes.distanceMeters,routes.description',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: fromLat, longitude: fromLng } } },
      destination: { location: { latLng: { latitude: toLat, longitude: toLng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
      departureTime,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google Routes returned HTTP ${res.status}`);
  const data = await res.json();
  const route = data?.routes?.[0];
  const sec = Number(String(route?.duration || '').replace(/s$/, ''));
  const staticSec = Number(String(route?.staticDuration || '').replace(/s$/, ''));
  if (!Number.isFinite(sec)) throw new Error('Google Routes returned no route duration.');
  const roads = [...new Set(String(route?.description || '').toUpperCase().match(/\b(?:M50|M1|M2|M3|M4|M7|M11|N2|N3|N4|N7|N11|N81)\b/g) || [])];
  return {
    distanceKm: Math.round(((route.distanceMeters || 0) / 1000) * 10) / 10,
    durationMin: Math.max(1, Math.round(sec / 60)),
    staticMin: Number.isFinite(staticSec) ? Math.max(1, Math.round(staticSec / 60)) : Math.max(1, Math.round(sec / 60)),
    roads,
  };
}

async function calculateForProperty(property, {
  fetcher = fetch,
  geocode = null,
  googleApiKey = process.env.GOOGLE_MAPS_API_KEY || '',
  t = now(),
} = {}) {
  if (!property?.id) throw new Error('Property not found.');
  let lat = property.listing_lat ?? property.lat ?? null;
  let lng = property.listing_lng ?? property.lng ?? null;

  if (lat == null || lng == null) {
    const house = require('./index');
    const addr = String(property.address || property.title || '').trim();
    if (!addr) throw new Error('Add an address on this property to estimate commute time.');
    const hit = await (geocode ? geocode(addr) : house.geocodeAddress(addr, { fetcher }));
    if (!hit) throw new Error(`Could not locate "${addr}" on the map to calculate commute.`);
    lat = hit.lat;
    lng = hit.lng;
    house.saveCoordinates(property.id, lat, lng);
  }

  let result;
  if (googleApiKey) {
    const [am, pm] = await Promise.all([
      fetchGoogleRoutesLeg(lat, lng, WORKPLACE.lat, WORKPLACE.lng, nextWeekdayDublinIso(7), googleApiKey, { fetcher }),
      fetchGoogleRoutesLeg(WORKPLACE.lat, WORKPLACE.lng, lat, lng, nextWeekdayDublinIso(16), googleApiKey, { fetcher }),
    ]);
    const roads = [...new Set([...am.roads, ...pm.roads])].slice(0, 4);
    result = {
      workplace: WORKPLACE.shortName,
      source: 'google_routes',
      distance_km: am.distanceKm,
      free_flow_am_min: am.staticMin,
      free_flow_pm_min: pm.staticMin,
      am_min: am.durationMin,
      am_max: am.durationMin,
      pm_min: pm.durationMin,
      pm_max: pm.durationMin,
      roads,
      m50_toll: roads.includes('M50') && lat > 53.355,
      origin_lat: lat,
      origin_lng: lng,
      fetched_at: t,
    };
  } else {
    const [am, pm] = await Promise.all([
      fetchOsrmLeg(lat, lng, WORKPLACE.lat, WORKPLACE.lng, { fetcher }),
      fetchOsrmLeg(WORKPLACE.lat, WORKPLACE.lng, lat, lng, { fetcher }),
    ]);
    const roads = [...new Set([...am.roads, ...pm.roads])].slice(0, 4);
    const peak = estimateDublinPeak(am.durationMin, pm.durationMin, { roads, originLat: lat });
    result = {
      workplace: WORKPLACE.shortName,
      source: 'osrm_peak',
      distance_km: am.distanceKm,
      free_flow_am_min: am.durationMin,
      free_flow_pm_min: pm.durationMin,
      ...peak,
      roads,
      origin_lat: lat,
      origin_lng: lng,
      fetched_at: t,
    };
  }

  crm().prepare('UPDATE house_properties SET commute_json = ? WHERE id = ?').run(JSON.stringify(result), property.id);
  return result;
}

function directionsUrl(property, { direction = 'to', mode = 'driving' } = {}) {
  if (!property) return '';
  const lat = property.listing_lat ?? property.lat ?? property.commute?.origin_lat;
  const lng = property.listing_lng ?? property.lng ?? property.commute?.origin_lng;
  const origin = (lat != null && lng != null)
    ? `${lat},${lng}`
    : (() => {
      const raw = String(property.address || property.title || '').trim();
      if (!raw) return '';
      return /\bireland\b/i.test(raw) ? raw : `${raw}, Ireland`;
    })();
  if (!origin) return '';
  const dest = `${WORKPLACE.lat},${WORKPLACE.lng}`;
  const from = direction === 'from' ? dest : origin;
  const to = direction === 'from' ? origin : dest;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=${encodeURIComponent(mode)}`;
}

function formatRange(min, max) {
  if (!Number.isFinite(min)) return '—';
  if (!Number.isFinite(max) || max === min) return `${min} min`;
  return `${min}–${max} min`;
}

module.exports = {
  WORKPLACE,
  parseCommute,
  estimateDublinPeak,
  calculateForProperty,
  directionsUrl,
  formatRange,
  nextWeekdayDublinIso,
};
