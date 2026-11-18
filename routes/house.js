'use strict';

const house = require('../lib/crm/house');

const BASE = '/crm/personal/house';
const tabs = [
  ['summary', BASE, 'Overview'],
  ['properties', `${BASE}/properties`, 'Properties'],
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
  const visibleProperties = data.properties.filter(p =>
    (!stage || p.status === stage) && (!search || [p.title, p.address, p.area].filter(Boolean).join(' ').toLowerCase().includes(search.toLowerCase())));
  const comparisonIds = [...new Set([filter.compare].flat().filter(id => propertiesById.has(id)))];
  const comparison = comparisonIds.map(id => propertiesById.get(id));

  return {
    ...data, screen, tabs, base: BASE, today, propertiesById, events, archived, activeProperties, viewings, upcoming, offers,
    nextActions, overdue, checklist, stage, search, visibleProperties, comparison, cost, label, entryDate, gmailUrl: house.getGmailUrl, propertyUrl,
    entryUrl, linkUrl, newEntry, byDay,
  };
}

module.exports = function mountHouse(router, { spaceParam, requireSameOrigin, writeLimiter, flash }) {
  const prefix = '/crm/:space/house';
  router.use(prefix, spaceParam, (req, res, next) => {
    if (req.params.space !== 'personal') return res.status(404).send('Not found');
    res.set('Cache-Control', 'no-store');
    next();
  });

  function show(res, screen, data = model(screen)) {
    res.render('crm/house', { page: 'house', title: 'House hunting', ...data });
  }

  router.get(prefix, (req, res) => show(res, 'summary'));
  router.get(`${prefix}/properties`, (req, res) => show(res, 'properties', model('properties', req.query)));
  router.get(`${prefix}/properties/new`, (req, res) => show(res, 'property-editor', { ...model('property-editor'), record: {} }));
  router.get(`${prefix}/properties/:id`, (req, res) => {
    const data = model('property');
    const property = data.propertiesById.get(req.params.id);
    if (!property) return res.status(404).send('Property not found');
    show(res, 'property', { ...data, property });
  });
  router.get(`${prefix}/properties/:id/edit`, (req, res) => {
    const data = model('property-editor');
    const record = data.propertiesById.get(req.params.id);
    if (!record) return res.status(404).send('Property not found');
    show(res, 'property-editor', { ...data, record });
  });
  router.get(`${prefix}/viewings-offers`, (req, res) => show(res, 'viewings'));
  router.get(`${prefix}/purchase`, (req, res) => show(res, 'purchase'));
  router.get(`${prefix}/mail`, (req, res) => show(res, 'mail'));
  router.get(`${prefix}/entry/new`, (req, res) => {
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
  router.get(`${prefix}/entry/:id`, (req, res) => {
    const data = model('entry-editor');
    const current = data.events.find(e => e.id === req.params.id);
    const record = current || data.archived.find(e => e.id === req.params.id);
    if (!record) return res.status(404).send('Entry not found');
    const from = typeof req.query.from === 'string' ? req.query.from : '';
    show(res, 'entry-editor', { ...data, record, from, cancel: returnPath({ from, property_id: record.property_id }) });
  });

  function post(path, handler, failed) {
    router.post(`${prefix}${path}`, requireSameOrigin, writeLimiter, (req, res) => {
      try { handler(req, res); }
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
};
