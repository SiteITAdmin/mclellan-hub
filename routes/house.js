'use strict';

// Standalone House Hunting tool at douglas.mclellan.scot/house, behind the
// site admin's Google sign-in.

const express = require('express');
const multer = require('multer');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');
const views = require('../lib/crm/views');
const house = require('../lib/crm/house');
const valuation = require('../lib/crm/house/valuation');
const listing = require('../lib/crm/house/listing');
const { counties } = require('../lib/crm/house/sales-register');

const router = express.Router();
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, keyPrefix: 'house-write' });
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2_400_000, files: 12 } });

const BASE = '/house';
const tabs = [
  ['summary', BASE, 'Overview'],
  ['properties', `${BASE}/properties`, 'Properties'],
  ['history', `${BASE}/history`, 'Area history'],
  ['viewings', `${BASE}/viewings-offers`, 'Viewings & offers'],
  ['purchase', `${BASE}/purchase`, 'Purchase plan'],
  ['mail', `${BASE}/mail`, 'Mail review'],
];
const tabPath = Object.fromEntries(tabs.map(([key, href]) => [key, href]));
const currency = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const dublinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateLabel = new Intl.DateTimeFormat('en-IE', { timeZone: 'Europe/Dublin', day: 'numeric', month: 'short', year: 'numeric', weekday: 'short' });
const ended = new Set(['cancelled', 'completed', 'declined', 'withdrawn', 'expired']);
const checklist = [
  { kind: 'mortgage', title: 'Obtain mortgage approval in principle' },
  { kind: 'legal', title: 'Appoint a solicitor' },
  { kind: 'milestone', title: 'Arrange a survey' },
  { kind: 'milestone', title: 'Arrange the lender valuation' },
  { kind: 'milestone', title: 'Review contracts with your solicitor' },
  { kind: 'milestone', title: 'Confirm drawdown and closing date' },
  { kind: 'milestone', title: 'Collect the keys' },
];

const cost = amount => amount == null || amount === '' ? '—' : currency.format(amount);
const label = value => String(value || '').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const entryDate = day => day ? dateLabel.format(new Date(`${day}T12:00:00Z`)) : '';
const propertyUrl = id => `${BASE}/properties/${encodeURIComponent(id)}`;
const entryUrl = id => `${BASE}/entry/${encodeURIComponent(id)}`;

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

function flash(req, text, level = 'ok') { req.session.crmFlash = { text, level }; }

function fmt(ts, style = 'short') {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const tz = { timeZone: 'Europe/Dublin' };
  const todayKey = new Date().toLocaleDateString('en-GB', tz);
  const key = d.toLocaleDateString('en-GB', tz);
  const time = d.toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
  if (style === 'time') return time;
  if (key === todayKey) return style === 'date' ? 'Today' : `Today ${time}`;
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', tz);
  if (key === yesterday) return style === 'date' ? 'Yesterday' : `Yesterday ${time}`;
  if (style === 'date') return d.toLocaleDateString('en-IE', { ...tz, weekday: 'short', day: 'numeric', month: 'short' });
  return `${d.toLocaleDateString('en-IE', { ...tz, weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function linkUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {}
  return '';
}

function newEntry(query = {}) {
  return `${BASE}/entry/new?${new URLSearchParams(query)}`;
}

function returnPath({ from, property_id } = {}) {
  if (from === 'property' && property_id) return propertyUrl(property_id);
  return typeof from === 'string' && Object.hasOwn(tabPath, from) ? tabPath[from] : BASE;
}

function byDay(a, b) {
  return `${a.day || '9999'} ${a.time || ''}`.localeCompare(`${b.day || '9999'} ${b.time || ''}`);
}

function model(screen, filter = {}) {
  const data = house.dashboard();
  const today = dublinDay.format(new Date());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const propertiesById = new Map(data.properties.map(p => [p.id, p]));
  const activeProperties = data.properties.filter(p => !['passed', 'closed'].includes(p.status));
  const events = [...data.events].sort((a, b) => (b.occurred_at || 0) - (a.occurred_at || 0));
  const archived = (data.history || []).filter(e => e.superseded_at);
  const future = e => !ended.has(e.status) && e.day && (e.day > today || (e.day === today && (!e.time || e.time >= time)));
  const viewings = events.filter(e => e.kind === 'viewing');
  const upcoming = viewings.filter(future).sort(byDay);
  const offers = events.filter(e => e.kind === 'offer');
  const deadlines = events.filter(e => ['task', 'milestone', 'legal', 'mortgage'].includes(e.kind));
  const overdue = deadlines.filter(e => e.day && e.day < today && ['pending', 'scheduled', 'confirmed', 'requested', 'in_progress'].includes(e.status)).sort(byDay);
  const nextActions = [...upcoming, ...deadlines.filter(future)].sort(byDay);
  const stage = typeof filter.stage === 'string' && Object.hasOwn(data.stages, filter.stage) ? filter.stage : '';
  const search = typeof filter.q === 'string' ? filter.q.trim().slice(0, 200) : '';
  const parseFilterInt = val => (typeof val === 'string' && /^\d+$/.test(val.trim()) ? Number(val.trim()) : null);
  const minPrice = parseFilterInt(filter.minPrice);
  const maxPrice = parseFilterInt(filter.maxPrice);
  const minBeds = parseFilterInt(filter.minBeds);
  const minBaths = parseFilterInt(filter.minBaths);
  const visibleProperties = data.properties.filter(p => {
    if (stage && p.status !== stage) return false;
    if (search && ![p.title, p.address, p.area].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase())) return false;
    if (minPrice != null && (p.asking_price == null || p.asking_price < minPrice)) return false;
    if (maxPrice != null && (p.asking_price == null || p.asking_price > maxPrice)) return false;
    if (minBeds != null && (p.beds == null || p.beds < minBeds)) return false;
    if (minBaths != null && (p.baths == null || p.baths < minBaths)) return false;
    return true;
  });
  const comparisonIds = [...new Set([filter.compare].flat().filter(id => propertiesById.has(id)))];
  const comparison = comparisonIds.map(id => propertiesById.get(id));

  return {
    ...data, screen, tabs, base: BASE, today, propertiesById, events, archived, activeProperties, viewings, upcoming, offers,
    nextActions, overdue, checklist, stage, search, minPrice, maxPrice, minBeds, minBaths, visibleProperties, comparison, cost, label, entryDate, gmailUrl: house.getGmailUrl, propertyUrl,
    entryUrl, linkUrl, newEntry, byDay,
  };
}

router.use(BASE, requireAuth, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.locals.flash = req.session.crmFlash || null;
  delete req.session.crmFlash;
  res.locals.ago = views.ago;
  res.locals.fmt = fmt;
  res.locals.icon = require('../lib/crm/icons');
  res.locals.space = 'personal';
  res.locals.toolSpace = 'house';
  next();
});

function show(res, screen, data = model(screen)) {
  res.render('crm/house', { page: 'house', title: 'House hunting', ...data });
}

router.get(BASE, (req, res) => show(res, 'summary'));
router.get(`${BASE}/properties`, (req, res) => show(res, 'properties', model('properties', req.query)));
router.get(`${BASE}/properties/new`, (req, res) => show(res, 'property-editor', { ...model('property-editor'), record: {} }));
function showProperty(req, res, locals = {}) {
  const data = model('property');
  const property = data.propertiesById.get(req.params.id);
  if (!property) return res.status(404).send('Property not found');
  const listingAnalysis = listing.get(property);
  show(res, 'property', {
    ...data,
    property,
    listingAnalysis,
    valuation: valuation.get(property, undefined, { listing: listingAnalysis }),
    manualComps: valuation.listComparables(property),
    counties,
    ...locals,
  });
}
router.get(`${BASE}/properties/:id`, (req, res) => showProperty(req, res));
router.get(`${BASE}/properties/:id/edit`, (req, res) => {
  const data = model('property-editor');
  const record = data.propertiesById.get(req.params.id);
  if (!record) return res.status(404).send('Property not found');
  show(res, 'property-editor', { ...data, record });
});
router.get(`${BASE}/history`, (req, res) => {
  show(res, 'history', {
    ...model('history'),
    counties,
    historyData: valuation.areaHistory({
      county: req.query.county,
      locality: req.query.locality,
      propertyType: req.query.type,
      beds: req.query.beds,
    }),
  });
});
router.post(`${BASE}/history/refresh`, requireSameOrigin, writeLimiter, async (req, res) => {
  const county = String(req.body.county || '').trim();
  const locality = String(req.body.locality || '').trim();
  try {
    const r = await valuation.refreshAreaHistory({ county, locality });
    flash(req, `Loaded ${r.saved} recent Daft sold records for ${locality ? `${locality}, ` : ''}${county}.`);
  } catch (err) {
    flash(req, err.message, 'bad');
  }
  const qs = new URLSearchParams();
  if (county) qs.set('county', county);
  if (locality) qs.set('locality', locality);
  res.redirect(`${BASE}/history${qs.toString() ? `?${qs}` : ''}`);
});
router.get(`${BASE}/viewings-offers`, (req, res) => show(res, 'viewings'));
router.get(`${BASE}/purchase`, (req, res) => show(res, 'purchase'));
router.get(`${BASE}/mail`, (req, res) => show(res, 'mail'));
router.get(`${BASE}/entry/new`, (req, res) => {
  const data = model('entry-editor');
  const { kind, property_id, title } = req.query;
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  show(res, 'entry-editor', {
    ...data, from,
    record: {
      kind: typeof kind === 'string' && Object.hasOwn(data.kinds, kind) ? kind : 'note',
      property_id: data.propertiesById.has(property_id) ? property_id : null,
      title: typeof title === 'string' ? title.slice(0, 200) : '',
    },
    cancel: returnPath({ from, property_id: data.propertiesById.has(property_id) ? property_id : null }),
  });
});
router.get(`${BASE}/entry/:id`, (req, res) => {
  const data = model('entry-editor');
  const current = data.events.find(e => e.id === req.params.id);
  const record = current || data.archived.find(e => e.id === req.params.id);
  if (!record) return res.status(404).send('Entry not found');
  const from = typeof req.query.from === 'string' ? req.query.from : '';
  show(res, 'entry-editor', { ...data, record, from, cancel: returnPath({ from, property_id: record.property_id }) });
});

function post(path, handler, failed) {
  router.post(`${BASE}${path}`, requireSameOrigin, writeLimiter, async (req, res) => {
    try { await handler(req, res); }
    catch (err) { failed(req, res, err.message); }
  });
}

const propertyFailure = (req, res, message) => {
  res.locals.flash = { text: message, level: 'bad' };
  show(res.status(400), 'property-editor', { ...model('property-editor'), record: { ...req.body, id: req.params.id } });
};
function saveProperty(req, res) {
  const property = house.saveProperty(req.body, req.params.id);
  flash(req, req.params.id ? 'Property updated.' : 'Property added.');
  res.redirect(propertyUrl(property.id));
}
post('/properties', saveProperty, propertyFailure);
post('/properties/:id', saveProperty, propertyFailure);

function comparablePost(path, action) {
  post(`/properties/:id/${path}`, async (req, res) => {
    const property = house.dashboard().properties.find(p => p.id === req.params.id);
    if (!property) return res.status(404).send('Property not found');
    const message = await action(property, req);
    if (message) flash(req, message);
    res.redirect(`${propertyUrl(property.id)}#sold-price-estimate`);
  }, (req, res, message) => {
    showProperty(req, res.status(400), {
      valuationError: message,
      ...(path === 'comparables' ? { comparableForm: req.body } : {}),
    });
  });
}

comparablePost('valuation', async (property, req) => {
  const analysis = listing.get(property);
  const result = await valuation.refresh(property, { county: req.body.county, locality: req.body.locality, listing: analysis });
  if (['unavailable', 'needs_location'].includes(result.status)) throw new Error(result.reason);
  return 'Comparable sales refreshed.';
});
comparablePost('comparables', (property, req) => {
  valuation.addComparable(property, req.body);
  return 'Daft sale added.';
});
comparablePost('comparables/:compId/remove', (property, req) => {
  valuation.removeComparable(property, req.params.compId);
  return 'Daft sale removed.';
});

post('/properties/:id/inspect', async (req, res) => {
  const property = house.dashboard().properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).send('Property not found');
  const wantPhotos = req.body.photos !== '0';
  const result = await listing.inspect(property, { analyzePhotos: wantPhotos });
  if (wantPhotos && result.photo_status === 'waiting') {
    flash(req, 'Listing keywords extracted. Photo heating & condition analysis queued — this page updates automatically.');
  } else {
    flash(req, 'Listing details and keywords updated.');
  }
  res.redirect(`${propertyUrl(property.id)}#listing-analysis`);
}, (req, res, message) => {
  showProperty(req, res.status(400), { listingError: message });
});

router.post(`${BASE}/properties/:id/photos`, requireSameOrigin, writeLimiter, (req, res, next) => {
  photoUpload.array('photos', 12)(req, res, err => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 2.4 MB.' : 'Choose up to 12 JPEG, PNG or WebP photos.';
    showProperty(req, res.status(400), { listingError: msg });
  });
}, (req, res) => {
  const property = house.dashboard().properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).send('Property not found');
  try {
    listing.analyzeUploadedPhotos(property, req.files);
    flash(req, 'Photo heating & condition analysis queued — this page updates automatically.');
    res.redirect(`${propertyUrl(property.id)}#listing-analysis`);
  } catch (err) {
    showProperty(req, res.status(400), { listingError: err.message });
  }
});

const entryFailure = (req, res, message) => {
  const data = model('entry-editor');
  const prior = data.events.find(e => e.id === req.params.id);
  res.locals.flash = { text: message, level: 'bad' };
  show(res.status(400), 'entry-editor', {
    ...data, record: { ...prior, ...req.body, id: req.params.id }, from: req.body.from, cancel: returnPath(req.body),
  });
};
function saveEntry(req, res) {
  const entry = house.saveEvent(req.body, req.params.id);
  flash(req, req.params.id ? 'Entry updated.' : 'Entry added.');
  const from = req.body.from || (entry.property_id ? 'property' : null);
  res.redirect(returnPath({ from, property_id: entry.property_id }));
}
post('/entry', saveEntry, entryFailure);
post('/entry/:id', saveEntry, entryFailure);

function mailPost(path, action, notice) {
  post(`/mail${path}`, (req, res) => {
    action(req);
    flash(req, notice);
    res.redirect(tabPath.mail);
  }, (req, res, message) => {
    flash(req, message, 'bad');
    res.redirect(tabPath.mail);
  });
}
mailPost('/:id/accept', req => house.accept(req.params.id, {
  property_id: req.body.property_id, replace_id: req.body.replace_id,
}), 'Update added to your tracker.');
mailPost('/:id/dismiss', req => house.dismiss(req.params.id), 'Update dismissed.');
mailPost('/retry', () => house.retryMail(), 'Failed emails queued for another reading.');
mailPost('/scan', () => house.requestScan(), 'Gmail scan requested.');

module.exports = router;
