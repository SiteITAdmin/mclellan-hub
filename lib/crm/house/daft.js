'use strict';

// Modest, on-demand reader for public Daft.ie Sold search pages and For-Sale
// listings, plus deterministic Irish property keyword & price-factor analysis.
// Only runs on explicit user refresh — never on a background crawl schedule.

const UA = 'Mozilla/5.0 (compatible; McLellanHub/1.0)';
const MAX_HTML_BYTES = 4_000_000;
const MAX_IMAGE_BYTES = 600_000;

const slug = value => String(value || '')
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .toLowerCase()
  .replace(/^co(?:unty)?\.?\s+/, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

function parseEuros(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  const m = String(value || '').match(/€\s*([\d,]+)(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[1].replaceAll(',', ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseBeds(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const s = String(value || '').trim();
  if (/studio/i.test(s)) return 0;
  const m = s.match(/(\d+)\s*bed/i) || s.match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseBaths(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  const m = String(value || '').match(/(\d+)\s*bath/i) || String(value || '').match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseArea(propertySize, floorArea) {
  if (floorArea && typeof floorArea === 'object' && floorArea.value != null) {
    const v = Number(String(floorArea.value).replaceAll(',', ''));
    if (Number.isFinite(v) && v > 5 && v < 100_000) {
      return /FEET|SQ_FT|FT/i.test(String(floorArea.unit || '')) ? Math.round(v * 0.092903 * 10) / 10 : Math.round(v * 10) / 10;
    }
  }
  const s = String(propertySize || '').trim();
  const m2 = s.match(/([\d,.]+)\s*(?:m²|m2|sq\.?\s*m)/i);
  if (m2) {
    const v = Number(m2[1].replaceAll(',', ''));
    return Number.isFinite(v) && v > 5 && v < 100_000 ? Math.round(v * 10) / 10 : null;
  }
  const ft = s.match(/([\d,.]+)\s*(?:sq\.?\s*ft|ft²)/i);
  if (ft) {
    const v = Number(ft[1].replaceAll(',', ''));
    return Number.isFinite(v) && v > 50 ? Math.round(v * 0.092903 * 10) / 10 : null;
  }
  return null;
}

function parseSoldDay(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!dmy) return '';
  const iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : '';
}

function typeFamily(raw, address = '') {
  const s = `${raw || ''} ${address || ''}`.toLowerCase();
  if (/\b(?:apartment|apt|flat|studio|penthouse)\b/.test(s)) return 'apartment';
  if (/\bduplex\b/.test(s)) return 'duplex';
  if (/\bbungalow\b/.test(s)) return 'bungalow';
  if (/\bsemi[\s-]?d(?:etached)?\b/.test(s)) return 'semi-d';
  if (/\b(?:end of terrace|terraced?|townhouse)\b/.test(s)) return 'terraced';
  if (/\bdetached\b/.test(s)) return 'detached';
  if (/\bhouse\b/.test(s)) return 'house';
  if (/\bsite\b/.test(s)) return 'site';
  return 'house';
}

function extractNextData(html) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function slugsFor(county, locality, extraLocality = '') {
  const cSlug = slug(county);
  const out = [];
  const add = s => { if (s && !out.includes(s)) out.push(s); };
  for (const loc of [locality, extraLocality]) {
    const lSlug = slug(loc);
    if (!lSlug || lSlug === cSlug) continue;
    if (cSlug === 'dublin' && /^dublin-\d{1,2}w?$/.test(lSlug)) {
      add(`${lSlug}-dublin`);
      add(lSlug);
    } else if (cSlug) {
      add(`${lSlug}-${cSlug}`);
    } else {
      add(lSlug);
    }
  }
  if (cSlug) add(cSlug);
  return out;
}

function normalizeAgencyKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseSeller(seller) {
  if (!seller || typeof seller !== 'object') {
    return { seller_agency: '', seller_agent: '', seller_licence: '', seller_key: '' };
  }
  const branch = String(seller.branch || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const name = String(seller.name || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const sellerType = String(seller.sellerType || '').trim();
  const agency = branch || (sellerType === 'PRIVATE_USER' ? 'Private Seller' : name);
  const licence = String(seller.licenceNumber || '').trim().slice(0, 40);
  return {
    seller_agency: agency,
    seller_agent: name,
    seller_licence: licence,
    seller_key: normalizeAgencyKey(agency),
  };
}

function parseSoldListings(html, { county = '', locality = '' } = {}) {
  const data = extractNextData(html);
  const raw = data?.props?.pageProps?.listings;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const l = entry?.listing || entry;
    if (!l || typeof l !== 'object') continue;
    const sold = parseEuros(l.soldPrice);
    const day = parseSoldDay(l.soldDate);
    const address = String(l.title || l.seoTitle || '').trim();
    const pathPart = String(l.seoFriendlyPath || '').trim();
    if (!sold || !day || !address || !/^\/sold\//i.test(pathPart)) continue;
    const sourceId = (String(l.adId || '').trim() || pathPart.split('/').filter(Boolean).at(-1) || '').toLowerCase();
    if (!sourceId) continue;
    const coords = Array.isArray(l.point?.coordinates) && l.point.coordinates.length >= 2 ? l.point.coordinates : null;
    out.push({
      source_id: sourceId,
      county,
      locality,
      address,
      day,
      sold,
      asking: parseEuros(l.price),
      beds: parseBeds(l.numBedrooms),
      baths: parseBaths(l.numBathrooms),
      area: parseArea(l.propertySize, l.floorArea),
      property_type: String(l.propertyType || '').trim(),
      ber: String(l.ber?.rating || '').trim().toUpperCase(),
      lat: coords && Number.isFinite(Number(coords[1])) ? Number(coords[1]) : null,
      lng: coords && Number.isFinite(Number(coords[0])) ? Number(coords[0]) : null,
      ...parseSeller(l.seller),
      url: `https://www.daft.ie${pathPart.replace(/\/$/, '')}`,
    });
  }
  return out;
}

async function fetchHtml(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.daft.ie', 'daft.ie'].includes(parsed.hostname)) {
    throw new Error('Only Daft.ie HTTPS links can be inspected.');
  }
  const res = await fetcher(parsed.href, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Daft returned HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_HTML_BYTES) throw new Error('Daft page exceeded size limit');
  if (/Security Check \| Daft/i.test(text) && !text.includes('__NEXT_DATA__')) {
    throw new Error('Daft blocked automated access to that page.');
  }
  return text;
}

async function fetchSoldArea(county, locality, { extraLocality = '', pages = 2, fetcher = fetch } = {}) {
  const candidates = slugsFor(county, locality, extraLocality);
  const collected = new Map();
  let usedSlug = '';
  let lastError = '';
  for (const areaSlug of candidates) {
    let foundHere = 0;
    for (let page = 0; page < pages; page++) {
      const from = page * 20;
      const url = `https://www.daft.ie/sold-properties/${encodeURIComponent(areaSlug)}?sort=publishDateDesc${from ? `&from=${from}` : ''}`;
      try {
        const html = await fetchHtml(url, fetcher);
        const rows = parseSoldListings(html, { county, locality: locality || extraLocality || county });
        for (const r of rows) {
          if (!collected.has(r.source_id)) {
            collected.set(r.source_id, r);
            foundHere += 1;
          }
        }
        if (rows.length < 20) break;
      } catch (err) {
        lastError = err.message;
        break;
      }
    }
    if (foundHere > 0 && !usedSlug) usedSlug = areaSlug;
    // Stop once we have plenty of local sales from the tightest matching area.
    if (collected.size >= 25) break;
  }
  return {
    rows: [...collected.values()],
    areaSlug: usedSlug,
    error: collected.size ? '' : lastError,
  };
}

function parseListingHtml(html, fallbackUrl = '') {
  const data = extractNextData(html);
  const l = data?.props?.pageProps?.listing;
  if (!l || typeof l !== 'object') throw new Error('Could not read the listing details from that Daft page.');
  const features = Array.isArray(l.features) ? l.features.map(x => String(x || '').trim()).filter(Boolean) : [];
  const facilities = Array.isArray(l.facilities)
    ? l.facilities.map(x => (typeof x === 'string' ? x : x?.name || x?.key || '')).map(s => String(s).trim()).filter(Boolean)
    : [];
  const images = Array.isArray(l.media?.images)
    ? l.media.images.map(img => ({
      url: img?.size1200x1200 || img?.size1440x960 || img?.size720x480 || img?.size360x240 || '',
      thumb: img?.size360x240 || img?.size720x480 || img?.size1200x1200 || '',
    })).filter(i => i.url && /^https:\/\/media\.daft\.ie\//i.test(i.url))
    : [];
  const coords = Array.isArray(l.point?.coordinates) && l.point.coordinates.length >= 2 ? l.point.coordinates : null;
  return {
    id: l.id ? String(l.id) : '',
    url: l.seoFriendlyPath ? `https://www.daft.ie${l.seoFriendlyPath}` : fallbackUrl,
    title: String(l.title || '').trim(),
    asking_price: parseEuros(l.price),
    property_type: String(l.propertyType || '').trim(),
    beds: parseBeds(l.numBedrooms),
    baths: parseBaths(l.numBathrooms),
    area: parseArea(l.propertySize, l.floorArea),
    ber: String(l.ber?.rating || '').trim().toUpperCase(),
    selling_type: String(l.sellingType || '').trim(),
    date_of_construction: String(l.dateOfConstruction || '').trim(),
    area_name: String(l.areaName || '').trim(),
    description: String(l.description || '').trim(),
    features,
    facilities,
    images,
    lat: coords && Number.isFinite(Number(coords[1])) ? Number(coords[1]) : null,
    lng: coords && Number.isFinite(Number(coords[0])) ? Number(coords[0]) : null,
    ...parseSeller(l.seller),
  };
}

async function fetchListing(url, { fetcher = fetch } = {}) {
  const html = await fetchHtml(url, fetcher);
  return parseListingHtml(html, url);
}

async function fetchImageBuffer(url, { fetcher = fetch } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/^media\.daft\.ie$/i.test(parsed.hostname)) {
    throw new Error('Only media.daft.ie image links are allowed.');
  }
  const res = await fetcher(parsed.href, {
    headers: { 'user-agent': UA, accept: 'image/jpeg,image/png,image/webp,image/*' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Image returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('Image empty or too large');
  return buf;
}

function snippetAround(text, match) {
  if (!match) return '';
  const idx = match.index;
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + match[0].length + 90);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// Deterministic keyword & price-driver extractor for Irish property listings.
// Every flag carries a verbatim snippet from the listing so Douglas can verify it.
const KEYWORD_RULES = [
  {
    key: 'vacant_grant',
    label: 'Vacant Home / Derelict Grant',
    impact: 'price_down',
    note: 'Listing mentions the Vacant Property Refurbishment / Derelict Grant — usually signals work needed, pulling the asking price below turnkey comparables.',
    re: /\b(?:vacant\s+(?:home|property|house)\s+(?:refurbishment\s+)?grant|cro[ií]\s+c[oó]naithe|derelict\s+(?:property\s+)?grant|vacant\s+for\s+(?:over\s+)?(?:2|two)\s+years|qualif(?:y|ies)\s+for\s+(?:the\s+)?(?:vacant|derelict|€?50,?000|€?70,?000))\b/i,
  },
  {
    key: 'needs_work',
    label: 'Needs renovation / modernisation',
    impact: 'price_down',
    note: 'Listing indicates refurbishment or modernisation is needed — expect a discount compared to renovated sales.',
    re: /\b(?:requires?\s+(?:full\s+|complete\s+|some\s+|modernisation|refurbishment|renovation|upgrading|repair|tlc)|in\s+need\s+of\s+(?:modernisation|refurbishment|renovation|upgrading|repair|tlc)|renovation\s+project|fixer[\s-]upper|shell\s+and\s+core|builder'?s\s+finish|derelict|uninhabitable)\b/i,
  },
  {
    key: 'auction_amv',
    label: 'Auction / AMV guide price',
    impact: 'price_down',
    note: 'Auction / Advised Minimum Value (AMV) guide prices are commonly set well below the final hammer price to attract bidders.',
    re: /\b(?:online\s+auction|public\s+auction|for\s+sale\s+by\s+auction|advised\s+minimum\s+value|\bamv\b|reserve\s+range|bidding\s+starts)\b/i,
  },
  {
    key: 'cash_only',
    label: 'Cash buyers / mortgageability warning',
    impact: 'price_down',
    note: 'Cash-only or mortgageability issues narrow the buyer pool and typically depress the price.',
    re: /\b(?:cash\s+buyers?\s+only|not\s+mortgageable|non[\s-]mortgageable|defective\s+concrete|pyrite|mica|structural\s+(?:issues?|defects?|damage)|fire\s+safety\s+(?:remediation|defects?|works)|cladding\s+remediation)\b/i,
  },
  {
    key: 'sitting_tenant',
    label: 'Tenant in situ / sitting tenant',
    impact: 'price_down',
    note: 'Sold with a sitting tenant — limits owner-occupier buyers and normally sells below vacant-possession comparables.',
    re: /\b(?:tenant\s+in\s+situ|sitting\s+tenant|sold\s+with\s+(?:a\s+)?tenant|tenanted\s+investment)\b/i,
  },
  {
    key: 'probate_short_lease',
    label: 'Probate / title / lease note',
    impact: 'caution',
    note: 'Probate or lease conditions can add months to closing or affect lender valuation.',
    re: /\b(?:subject\s+to\s+probate|grant\s+of\s+probate|probate\s+sale|short\s+lease|rent\s+pressure\s+zone|\brpz\b)\b/i,
  },
  {
    key: 'turnkey',
    label: 'Turnkey / recently upgraded',
    impact: 'price_up',
    note: 'Presented as turnkey / recently renovated — can justify a premium over older unmodernised sales.',
    re: /\b(?:turn[\s-]?key|walk[\s-]in\s+condition|newly\s+renovated|recently\s+renovated|fully\s+refurbished|architect[\s-]designed|extended\s+to\s+the\s+rear|attic\s+conversion|showhouse\s+condition)\b/i,
  },
  {
    key: 'chain_free',
    label: 'Chain-free sale',
    impact: 'info',
    note: 'Chain-free — cleaner closing timeline, no onward purchase delay.',
    re: /\b(?:chain[\s-]free|no\s+onward\s+chain|vacant\s+possession)\b/i,
  },
  {
    key: 'parking',
    label: 'Parking included',
    impact: 'info',
    note: 'Includes parking / driveway.',
    re: /\b(?:allocated\s+(?:car\s+)?parking|designated\s+(?:car\s+)?parking|underground\s+parking|off[\s-]street\s+parking|private\s+driveway)\b/i,
  },
  {
    key: 'south_west',
    label: 'South / west aspect',
    impact: 'price_up',
    note: 'South- or west-facing garden/balcony/patio is a sought-after sun aspect.',
    re: /\b(?:south[\s-]facing|west[\s-]facing|south[\s-]?west[\s-]facing|sunny\s+(?:rear\s+)?(?:garden|balcony|patio))\b/i,
  },
];

function extractSignals(listing) {
  const pieces = [
    listing.title || '',
    listing.selling_type || '',
    ...(listing.features || []),
    ...(listing.facilities || []),
    listing.description || '',
  ].filter(Boolean);
  const full = pieces.join('\n');
  const signals = [];

  for (const rule of KEYWORD_RULES) {
    const m = rule.re.exec(full);
    if (m) {
      signals.push({
        key: rule.key,
        label: rule.label,
        impact: rule.impact,
        note: rule.note,
        quote: snippetAround(full, m),
      });
    }
  }

  // Management / service fee (important on apartments & managed estates).
  const mgmt = full.match(/(?:management|service)\s+(?:fee|charge)s?[^.\n€]{0,45}€\s*([\d,]+(?:\.\d{2})?)/i)
    || full.match(/€\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+annum|p\.?a\.?|yearly|annual)[^.\n]{0,35}(?:management|service)/i);
  if (mgmt) {
    const fee = Number(mgmt[1].replaceAll(',', ''));
    if (Number.isFinite(fee) && fee >= 200 && fee <= 25000) {
      signals.push({
        key: 'management_fee',
        label: `Management fee ~€${Math.round(fee).toLocaleString('en-IE')}/yr`,
        impact: fee >= 2500 ? 'price_down' : 'info',
        note: fee >= 2500
          ? 'High annual management fee — reduces what buyers pay for an apartment.'
          : 'Annual management/service fee noted in the listing.',
        quote: snippetAround(full, mgmt),
      });
    }
  }

  // BER rating price-factor flag.
  const ber = String(listing.ber || '').trim().toUpperCase();
  if (/^[EFG]\d?$/.test(ber)) {
    signals.push({
      key: 'ber_low',
      label: `Low BER (${ber})`,
      impact: 'price_down',
      note: `BER ${ber} signals higher heating bills and retrofit cost — often explains a lower price than B/C-rated comparables.`,
      quote: `BER ${ber}`,
    });
  } else if (/^(?:A[1-3]|B[1-2])$/.test(ber)) {
    signals.push({
      key: 'ber_high',
      label: `Strong BER (${ber})`,
      impact: 'price_up',
      note: `BER ${ber} qualifies for green mortgage rates and lower running costs.`,
      quote: `BER ${ber}`,
    });
  }

  // Heating detection from facilities, features, and description text.
  let heating = { kind: 'unlisted', label: 'Heating not stated in listing text', quote: '' };
  const heatingChecks = [
    { kind: 'gas', label: 'Gas central heating (stated in listing)', re: /\b(?:gas[\s-]fired\s+central\s+heating|gas\s+central\s+heating|\bgfch\b|gas\s+(?:combi\s+)?boiler|natural\s+gas\s+heating|gas\s+heating)\b/i },
    { kind: 'heat_pump', label: 'Air-to-water / heat pump (stated in listing)', re: /\b(?:air[\s-]to[\s-]water|heat\s+pump|geothermal\s+heating)\b/i },
    { kind: 'oil', label: 'Oil central heating (stated in listing)', re: /\b(?:oil[\s-]fired\s+central\s+heating|oil\s+central\s+heating|\bofch\b|oil\s+boiler|oil\s+heating)\b/i },
    { kind: 'electric', label: 'Electric heating (stated in listing)', re: /\b(?:electric\s+(?:storage\s+|panel\s+|central\s+)?heating|storage\s+heaters?|electric\s+radiators?|farho)\b/i },
    { kind: 'district', label: 'District / communal heating (stated in listing)', re: /\b(?:district\s+heating|communal\s+(?:gas\s+|central\s+)?heating)\b/i },
  ];
  for (const h of heatingChecks) {
    const m = h.re.exec(full);
    if (m) {
      heating = { kind: h.kind, label: h.label, quote: snippetAround(full, m) };
      break;
    }
  }

  // Bathroom vs Guest WC / Cloakroom check in listing text.
  const wcMatch = /\b(?:guest\s+(?:w\.?c\.?|toilet)|downstairs\s+(?:w\.?c\.?|toilet)|cloakroom|powder\s+room|under[\s-]?stairs?\s+(?:w\.?c\.?|toilet))\b/i.exec(full);
  const ensuiteMatch = /\b(?:en[\s-]?suite|shower\s+room|wet\s+room|two\s+(?:full\s+)?bathrooms|2\s+full\s+bathrooms|second\s+shower)\b/i.exec(full);
  const listedBaths = Number.isFinite(Number(listing.baths)) ? Number(listing.baths) : null;
  if (wcMatch && !ensuiteMatch && (listedBaths == null || listedBaths === 2)) {
    signals.push({
      key: 'bathroom_wc_only',
      label: '2nd "bathroom" may be WC / cloakroom only',
      impact: 'caution',
      note: 'Listing mentions a guest/downstairs WC or cloakroom with no en-suite or second shower room mentioned — check photos to confirm whether there are two real bathing/showering rooms.',
      quote: snippetAround(full, wcMatch),
    });
  } else if (ensuiteMatch && (listedBaths == null || listedBaths >= 2)) {
    signals.push({
      key: 'bathroom_ensuite',
      label: 'En-suite / shower room mentioned',
      impact: 'info',
      note: 'Listing mentions an en-suite or shower room alongside the main bathroom — check photos to confirm fixtures.',
      quote: snippetAround(full, ensuiteMatch),
    });
  }

  return { signals, heating };
}

module.exports = {
  slug,
  slugsFor,
  typeFamily,
  normalizeAgencyKey,
  parseSeller,
  parseEuros,
  parseBeds,
  parseBaths,
  parseArea,
  parseSoldDay,
  parseSoldListings,
  parseListingHtml,
  extractSignals,
  fetchSoldArea,
  fetchListing,
  fetchImageBuffer,
};
