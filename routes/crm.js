'use strict';

// Personal CRM at douglas.mclellan.scot/crm, behind the site admin's Google
// sign-in. Work and Personal are separate places; "Who is this?" is the only
// screen that shows both.

const express = require('express');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');
const views = require('../lib/crm/views');
const review = require('../lib/crm/review');
const identity = require('../lib/crm/identity');
const sources = require('../lib/crm/sources');
const atoms = require('../lib/crm/atoms');
const orgs = require('../lib/crm/orgs');
const tasks = require('../lib/crm/tasks');
const promises = require('../lib/crm/promises');
const speakerCorrection = require('../lib/crm/speaker-correction');
const wispr = require('../lib/crm/wispr');
const calendar = require('../lib/crm/calendar');
const planner = require('../lib/crm/planner');
const { crm } = require('../lib/crm/db');

const router = express.Router();
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, keyPrefix: 'crm-write' });
const SPACES = ['work', 'personal'];

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

function spaceParam(req, res, next) {
  if (!SPACES.includes(req.params.space)) return res.status(404).send('Not found');
  res.locals.space = req.params.space;
  next();
}

router.use('/crm', requireAuth, (req, res, next) => {
  res.locals.flash = req.session.crmFlash || null;
  delete req.session.crmFlash;
  res.locals.reviewAll = review.openCount();
  res.locals.krispWaiting = crm().prepare("SELECT count(*) n FROM krisp_intake WHERE status = 'pending'").get().n;
  res.locals.whatsappWaiting = require('../lib/crm/whatsapp').waitingCount();
  res.locals.ago = views.ago;
  res.locals.fmt = fmt;
  res.locals.hueStyle = hueStyle;
  res.locals.icon = require('../lib/crm/icons');
  res.locals.space = null;
  next();
});

function flash(req, text, level = 'ok') { req.session.crmFlash = { text, level }; }

function back(req, res, fallback) {
  const ref = req.get('referer');
  res.redirect(ref && new URL(ref, 'https://x').pathname.startsWith('/crm') ? ref : fallback);
}

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

function hueStyle(p) { return `--h:${Number(p?.hue) || 0}`; }

router.get('/crm/krisp', (req, res) => res.redirect('/crm/work/meetings'));
router.post('/crm/krisp/:id/classify', requireSameOrigin, writeLimiter, (req, res) => {
  try { require('../lib/crm/krisp').classify(req.params.id, req.body.choice, { revision: req.body.revision, names: typeof req.body.names === 'string' ? [req.body.names] : req.body.names }); res.redirect(`/crm/${req.body.returnSpace === 'personal' ? 'personal' : 'work'}/meetings`); }
  catch (err) { res.status(err.status || 500).send(err.status ? err.message : 'Classification failed; transcript remains pending'); }
});

router.get('/crm/messages', (req,res) => res.render('crm/messages', {page:'messages',title:'Messages',imessage:require('../lib/crm/imessage').status()}));
router.post('/crm/messages/pause', requireSameOrigin, writeLimiter, (req,res) => {
  require('../lib/crm/db').setSetting('imessage_paused',req.body.paused==='1'?'1':'0');res.redirect('/crm/messages');
});

router.get('/crm/notifications', (req, res) => res.render('crm/notifications', {
  page: 'notifications', title: 'Notifications', publicKey: require('../lib/crm/notifications').keys().publicKey,
  devices: require('../lib/crm/notifications').list(),
}));
router.post('/crm/notifications/subscribe', requireSameOrigin, writeLimiter, (req,res) => {
  try { res.json({ id: require('../lib/crm/notifications').subscribe(req.body.subscription,req.body.spaces) }); }
  catch(e) { res.status(400).json({error:e.message}); }
});
router.post('/crm/notifications/unsubscribe', requireSameOrigin, writeLimiter, (req,res) => {
  require('../lib/crm/notifications').remove(req.body.endpoint); res.json({ok:true});
});

router.get('/crm/imports', (req, res) => res.render('crm/imports', {
  page: 'imports', title: 'Contacts and LinkedIn', imports: require('../lib/crm/imports').list(),
  people: crm().prepare('SELECT id,name,space FROM people ORDER BY name').all(), connected: require('../lib/crm/imports').connected(),
  run: require('../lib/crm/runs').all().contacts_sync,
}));
router.get('/crm/imports/contacts/connect', (req, res) => require('../lib/crm/contacts-connect').start(req, res));
router.post('/crm/imports/:id/decide', requireSameOrigin, writeLimiter, (req, res) => {
  try { require('../lib/crm/imports').decide(req.params.id, req.body); flash(req, 'Contact reviewed.'); }
  catch(e) { flash(req,e.message,'bad'); }
  res.redirect('/crm/imports');
});
const identityUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } }).single('file');
router.post('/crm/imports/linkedin', requireSameOrigin, writeLimiter, (req, res) => identityUpload(req,res,err => {
  try { if(err) throw new Error('Choose a Connections.csv file under 2 MB'); if(!req.file || !/\.csv$/i.test(req.file.originalname)) throw new Error('Choose the LinkedIn Connections.csv export');
    const n = require('../lib/crm/imports').linkedin(req.file.buffer); flash(req, `${n} connections read. Unmatched people wait for review.`);
  } catch(e) { flash(req,e.message,'bad'); }
  res.redirect('/crm/imports');
}));

router.get('/crm/notebooks', (req, res) => {
  const notebooks = require('../lib/crm/boox').list();
  const pages = crm().prepare(`SELECT p.id, p.page_no, p.text, p.uncertainty, p.error, p.status, n.name, n.space FROM notebook_pages p
    JOIN notebooks n ON n.id=p.notebook_id WHERE p.status IN ('review','failed') ORDER BY p.occurred_at DESC LIMIT 40`).all();
  res.render('crm/notebooks', { page: 'notebooks', title: 'Boox notebooks', notebooks, pages, run: require('../lib/crm/runs').all().boox_capture });
});
router.post('/crm/notebooks/:id/configure', requireSameOrigin, writeLimiter, (req, res) => {
  try { require('../lib/crm/boox').configure(req.params.id, req.body.space, req.body.kind); flash(req, 'Notebook set. Its pages will be read automatically.'); }
  catch (e) { flash(req, e.message, 'bad'); }
  res.redirect('/crm/notebooks');
});
router.get('/crm/notebook-pages/:id/pdf', (req, res) => {
  const p = crm().prepare('SELECT pdf FROM notebook_pages WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).send('Page not found');
  res.set('Cache-Control', 'no-store').type('pdf').send(p.pdf);
});
router.post('/crm/notebook-pages/:id/confirm', requireSameOrigin, writeLimiter, (req, res) => {
  try { require('../lib/crm/boox').confirm(req.params.id, req.body.text); flash(req, 'Corrected page saved as source evidence.'); }
  catch (e) { flash(req, e.message, 'bad'); }
  res.redirect('/crm/notebooks');
});
router.post('/crm/notebook-pages/:id/retry', requireSameOrigin, writeLimiter, (req, res) => {
  crm().prepare("UPDATE notebook_pages SET status='pending', error='', attempts=0 WHERE id=? AND status='failed' AND length(pdf)<=900000").run(req.params.id);
  res.redirect('/crm/notebooks');
});

router.get('/crm', (req, res) => res.redirect('/crm/work'));

// ── Who is this? ───────────────────────────────────────────────────────────
router.get('/crm/review', (req, res) => {
  const items = review.openItems();
  const selected = items.find(i => i.id === req.query.item) || items[0] || null;
  let detail = null;
  if (selected) {
    detail = { item: selected, evidence: review.evidenceFor(selected), count: review.evidenceCount(selected) };
    if (selected.kind === 'person') {
      detail.lookalikes = identity.lookalikes(selected.payload.name, selected.payload.value);
      detail.suggestedOrg = orgs.orgForEmail(selected.space, selected.payload.value);
      detail.vendorDomain = selected.payload.kind === 'email' ? require('../lib/crm/vendors').companyDomain(selected.payload.value) : '';
      detail.lookEmails = Object.fromEntries(detail.lookalikes.map(l => [l.id,
        crm().prepare('SELECT value FROM identifiers WHERE person_id = ? AND kind = ?').all(l.id, selected.payload.kind || 'email').map(r => r.value)]));
    }
    if (selected.kind === 'mention') {
      const db = crm();
      detail.candidates = selected.payload.candidateIds.map(id => db.prepare('SELECT * FROM people_v WHERE id = ?').get(id)).filter(Boolean)
        .map(p => ({ ...p, emails: db.prepare("SELECT value FROM identifiers WHERE person_id = ? AND kind = 'email'").all(p.id).map(r => r.value) }));
      detail.atom = views.source(db.prepare('SELECT source_id FROM atom_sources WHERE atom_id = ?').get(selected.payload.atomId)?.source_id || '')
        ?.atoms.find(a => a.id === selected.payload.atomId) || null;
    }
    if (selected.kind === 'project') {
      const db = crm();
      detail.atoms = selected.payload.atomIds.slice(0, 5).map(id => db.prepare('SELECT * FROM atoms WHERE id = ?').get(id)).filter(Boolean);
    }
  }
  const peopleBySpace = Object.fromEntries(SPACES.map(s => [s, crm().prepare('SELECT id, name, org FROM people_v WHERE space = ? ORDER BY name COLLATE NOCASE').all(s)]));
  const orgsBySpace = Object.fromEntries(SPACES.map(s => [s, orgs.list(s)]));
  res.render('crm/review', { page: 'review', space: null, items, selected, detail, peopleBySpace, orgsBySpace, vendorCount: require('../lib/crm/vendors').count(), title: 'Who is this?' });
});

router.post('/crm/review/:id', requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const body = {
      action: String(req.body.action || ''),
      name: req.body.name, space: req.body.space,
      orgId: req.body[`orgId_${req.body.space}`] || req.body.orgId, orgName: req.body.orgName,
      personId: req.body.personId,
      shownIds: [].concat(req.body.shownIds || []).map(String),
      wholeCompany: req.body.wholeCompany === '1',
    };
    const r = review.decide(req.params.id, body);
    const messages = { new: 'Added', same: 'Linked', ignore: 'Set aside for good', later: 'Moved to later', choose: 'Linked', none: 'Marked as nobody you know', add: 'Project added' };
    if (body.action === 'vendor') {
      const others = r.vendors - 1;
      flash(req, r.domain
        ? `Put in Vendors, with everyone at ${r.domain}${others ? ` (${others} more waiting)` : ''}. Nobody new from there will be asked about.`
        : 'Put in Vendors. Their mail won’t be read.');
    } else flash(req, messages[body.action] || 'Done');
    if (r.personId && req.body.open === '1') {
      const p = crm().prepare('SELECT space FROM people WHERE id = ?').get(r.personId);
      return res.redirect(`/crm/${p.space}/people/${r.personId}`);
    }
  } catch (err) {
    flash(req, err.message, 'bad');
    return res.redirect(`/crm/review?item=${encodeURIComponent(req.params.id)}`);
  }
  res.redirect('/crm/review');
});

// ── Vendors ────────────────────────────────────────────────────────────────
router.get('/crm/vendors', (req, res) => {
  const { people, domains } = require('../lib/crm/vendors').list();
  res.render('crm/vendors', { page: 'review', space: null, people, domains, title: 'Vendors' });
});

router.post('/crm/vendors/:action(unmark|domain-remove)', requireSameOrigin, writeLimiter, (req, res) => {
  const vendors = require('../lib/crm/vendors');
  try {
    if (req.params.action === 'unmark') {
      const r = vendors.unmark(req.body.kind === 'phone' ? 'phone' : 'email', String(req.body.value || ''));
      flash(req, `${r.name || r.value} is back in Who is this?${r.lifted ? ` Everyone at ${r.lifted} will be asked about again too.` : ''}`);
    } else {
      vendors.removeDomain(req.body.domain);
      flash(req, `New people at ${req.body.domain} will be asked about again.`);
    }
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect('/crm/vendors');
});

// ── WhatsApp (Hermes) ──────────────────────────────────────────────────────
router.get('/crm/whatsapp', (req, res) => {
  const whatsapp = require('../lib/crm/whatsapp');
  const { setting } = require('../lib/crm/db');
  res.render('crm/whatsapp', {
    page: 'whatsapp', space: null, title: 'WhatsApp',
    chats: whatsapp.list(), hb: whatsapp.lastHeartbeat(), paused: whatsapp.isPaused(),
    projectsBySpace: Object.fromEntries(SPACES.map(sp => [sp, crm().prepare('SELECT id, name FROM projects WHERE space = ? ORDER BY name COLLATE NOCASE').all(sp)])),
    lastMessage: Number(setting('whatsapp_last_message_at')) || null,
  });
});

router.post('/crm/whatsapp/chats/:id', requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const whatsapp = require('../lib/crm/whatsapp');
    const action = String(req.body.action || '');
    // One select per space; the chosen space's select carries the project.
    const projectId = req.body[`project_${req.body.space}`] || req.body.project || null;
    if (action === 'project') {
      const p = whatsapp.setChatProject(req.params.id, projectId);
      flash(req, p ? `New messages from this chat are filed under ${p.name}.` : 'This chat no longer has a project.');
      return res.redirect('/crm/whatsapp');
    }
    const c = whatsapp.decide(req.params.id, { action, space: req.body.space, projectId });
    const name = c.is_self ? 'Your own chat' : (c.name || c.peer_phone || 'The chat');
    flash(req, { approve: `${name} is approved for ${c.space === 'work' ? 'Work' : 'Personal'}. New messages are stored from now on.`, ignore: `${name} is ignored.`, waiting: `${name} is back in the waiting list.` }[req.body.action] || 'Done');
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect('/crm/whatsapp');
});

router.post('/crm/whatsapp/:action(pause|resume)', requireSameOrigin, writeLimiter, (req, res) => {
  require('../lib/crm/whatsapp').setPaused(req.params.action === 'pause');
  flash(req, req.params.action === 'pause' ? 'WhatsApp capture is paused. The Hub refuses everything from Hermes until you resume.' : 'WhatsApp capture resumed.');
  res.redirect('/crm/whatsapp');
});

// ── Space screens ──────────────────────────────────────────────────────────
router.get('/crm/:space', spaceParam, (req, res) => {
  const space = req.params.space;
  const data = views.today(space);
  res.render('crm/today', { page: 'today', data, greeting: views.greeting(), title: space === 'work' ? 'Work' : 'Personal' });
});

router.get('/crm/:space/people', spaceParam, (req, res) => {
  res.render('crm/people', { page: 'people', list: views.people(req.params.space, req.query.q), orgList: orgs.list(req.params.space), q: req.query.q || '', title: 'People' });
});

router.post('/crm/:space/people', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const space = req.params.space;
  try {
    const email = String(req.body.email || '').trim();
    if (email && identity.identifierRow('email', email)?.person_id) throw new Error(`${email} already belongs to someone`);
    const org = orgs.resolveChoice(space, { orgId: req.body.orgId, orgName: req.body.orgName })
      || (email ? orgs.orgForEmail(space, email) : null);
    const p = identity.createPerson({ space, name: req.body.name, orgId: org ? org.id : null });
    if (email) {
      identity.linkIdentifier(p.id, 'email', email);
      sources.releaseHeld(email, 'linked');
      crm().prepare("UPDATE review_items SET status = 'decided', decision = ?, decided_at = unixepoch() WHERE item_key = ? AND status = 'open'")
        .run(JSON.stringify({ action: 'new', personId: p.id, via: 'manual' }), sources.proposalKey('email', identity.identifierRow('email', email).value));
    }
    atoms.reresolveMentions(space);
    flash(req, `Added ${p.name}`);
    res.redirect(`/crm/${space}/people/${p.id}`);
  } catch (err) {
    flash(req, err.message, 'bad');
    res.redirect(`/crm/${space}/people`);
  }
});

router.get('/crm/:space/people/:id', spaceParam, (req, res) => {
  const p = views.person(req.params.id);
  if (!p) return res.status(404).send('Not found');
  if (p.space !== req.params.space) return res.redirect(`/crm/${p.space}/people/${p.id}`);
  res.render('crm/person', { page: 'people', p, orgList: orgs.list(p.space), unitChoices: p.org_id ? orgs.unitChoices(p.org_id) : [], title: p.name });
});

router.post('/crm/:space/people/:id/:action', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { id, action, space } = req.params;
  const to = `/crm/${space}/people/${id}`;
  try {
    if (action === 'alias') { identity.addAlias(id, req.body.alias); atoms.reresolveMentions(space); flash(req, 'Alias added'); }
    else if (action === 'detach') {
      const value = String(req.body.value || '');
      const label = crm().prepare('SELECT label FROM identifiers WHERE kind = ? AND value = ?').get(req.body.kind || 'email', value)?.label || '';
      if (identity.detachIdentifier(id, req.body.kind || 'email', value)) {
        sources.proposePerson({ kind: req.body.kind || 'email', value, name: label, space, reason: 'Unlinked from a person' });
        flash(req, `${value} unlinked and sent back to Who is this?`);
      }
    } else if (action === 'edit') {
      const name = String(req.body.name || '').trim();
      if (!name) throw new Error('A person needs a name');
      crm().prepare('UPDATE people SET name = ?, role = ?, updated_at = unixepoch() WHERE id = ?')
        .run(name, String(req.body.role || '').trim(), id);
      const org = orgs.resolveChoice(space, { orgId: req.body.orgId, orgName: req.body.orgName });
      if (org !== undefined) orgs.setPersonOrg(id, org);
      const unitId = String(req.body.unitId || '');
      if (unitId && org === undefined) orgs.setPersonUnit(id, unitId === 'none' ? null : unitId);
      identity.log('edit_person', id, { name });
      atoms.reresolveMentions(space);
      flash(req, 'Saved');
    } else if (action === 'join' || action === 'leave') {
      const facts = require('../lib/crm/facts');
      const { project } = facts[action === 'join' ? 'addMember' : 'removeMember'](req.body.projectId, id, space);
      flash(req, action === 'join' ? `Added to ${project.name}` : `Taken off ${project.name}`);
    } else if (action === 'cadence') {
      require('../lib/crm/keepintouch').setCadence(id, req.body.days);
      flash(req, Number(req.body.days) ? 'Keep-in-touch saved' : 'No keep-in-touch for this person');
    } else if (action === 'email') {
      const email = String(req.body.email || '').trim();
      identity.linkIdentifier(id, 'email', email);
      sources.releaseHeld(email, 'linked');
      flash(req, 'Email added');
    } else return res.status(404).send('Not found');
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(String(req.body.back || '') === `/crm/${space}` ? `/crm/${space}` : to);
});

// ── Organisations ──────────────────────────────────────────────────────────
router.get('/crm/:space/organisations', spaceParam, (req, res) => {
  res.render('crm/organisations', { page: 'organisations', list: orgs.list(req.params.space), title: 'Organisations' });
});

router.post('/crm/:space/organisations', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const space = req.params.space;
  try {
    const org = orgs.createOrg(space, req.body.name);
    if (String(req.body.domain || '').trim()) orgs.addDomain(org.id, req.body.domain);
    flash(req, `Added ${org.name}`);
    return res.redirect(`/crm/${space}/organisations/${org.id}`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(`/crm/${space}/organisations`);
});

function renderOrg(req, res, unitId) {
  const o = views.organisation(req.params.id, unitId);
  if (!o) return res.status(404).send('Not found');
  if (o.space !== req.params.space) return res.redirect(`/crm/${o.space}/organisations/${o.id}`);
  const others = unitId
    ? crm().prepare("SELECT id, name, org, dept, team FROM people_v WHERE org_id = ? AND COALESCE(unit_id, '') != ? ORDER BY name COLLATE NOCASE").all(o.id, unitId)
    : crm().prepare('SELECT id, name, org FROM people_v WHERE space = ? AND (org_id IS NULL OR org_id != ?) ORDER BY name COLLATE NOCASE').all(o.space, o.id);
  res.render('crm/organisation', { page: 'organisations', o, others, unitChoices: orgs.unitChoices(o.id), title: o.unit ? o.unit.name : o.name });
}

router.get('/crm/:space/organisations/:id', spaceParam, (req, res) => renderOrg(req, res, null));
router.get('/crm/:space/organisations/:id/units/:unitId', spaceParam, (req, res) => renderOrg(req, res, req.params.unitId));

router.post('/crm/:space/organisations/:id/:action', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { id, action, space } = req.params;
  try {
    const org = orgs.get(id);
    if (!org || org.space !== space) return res.status(404).send('Not found');
    if (action === 'rename') { orgs.rename(id, req.body.name); flash(req, 'Saved'); }
    else if (action === 'domain') { const d = orgs.addDomain(id, req.body.domain); flash(req, `${d} added. New people from it will be suggested for ${org.name}.`); }
    else if (action === 'undomain') { orgs.removeDomain(id, req.body.domain); flash(req, 'Domain removed'); }
    else if (action === 'member') {
      const pid = String(req.body.personId || '');
      const current = crm().prepare('SELECT org_id FROM people WHERE id = ?').get(pid);
      if (!current || current.org_id !== org.id) orgs.setPersonOrg(pid, org);
      if (req.body.unitId) orgs.setPersonUnit(pid, String(req.body.unitId));
      flash(req, 'Linked');
    }
    else if (action === 'unmember') { orgs.setPersonOrg(String(req.body.personId || ''), null); flash(req, 'Unlinked'); }
    else if (action === 'person-unit') {
      orgs.setPersonUnit(String(req.body.personId || ''), req.body.unitId === 'none' ? null : String(req.body.unitId || ''));
      flash(req, 'Moved');
    }
    else if (action === 'unit') {
      const u = orgs.addUnit(id, { name: req.body.name, parentId: req.body.parentId || null });
      flash(req, `${u.kind === 'team' ? 'Team' : 'Department'} ${u.name} added`);
    }
    else if (action === 'unit-rename') { orgs.renameUnit(String(req.body.unitId || ''), req.body.name); flash(req, 'Saved'); }
    else if (action === 'unit-remove') {
      const u = orgs.getUnit(String(req.body.unitId || ''));
      if (!u || u.org_id !== id) throw new Error('No such department or team');
      const moved = orgs.removeUnit(u.id);
      flash(req, `${u.name} removed${moved ? `; ${moved} ${moved === 1 ? 'person' : 'people'} moved up a level` : ''}`);
      return res.redirect(`/crm/${space}/organisations/${id}`);
    }
    else return res.status(404).send('Not found');
  } catch (err) { flash(req, err.message, 'bad'); }
  const back = String(req.body.back || '');
  res.redirect(back.startsWith(`/crm/${space}/organisations/${id}`) ? back : `/crm/${space}/organisations/${id}`);
});

router.get('/crm/:space/captured', spaceParam, (req, res) => {
  const filter = req.query.filter === 'attention' ? 'attention' : '';
  res.render('crm/captured', { page: 'captured', list: views.captured(req.params.space, { limit: 200, filter }), filter, title: 'Captured' });
});

router.get('/crm/:space/sources/:id', spaceParam, (req, res) => {
  const s = views.source(req.params.id);
  if (!s || s.space !== req.params.space) return res.status(404).send('Not found');
  res.render('crm/source', { krispRaw: s.origin === 'krisp' ? require('../lib/crm/krisp').rawForSource(s) : null, speakers: speakerCorrection.review(s.id), page: 'captured', s, title: s.title });
});

router.post('/crm/:space/sources/:id/speaker-names', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const fallback = `/crm/${req.params.space}/sources/${encodeURIComponent(req.params.id)}`;
  try {
    const s = crm().prepare('SELECT id, space FROM sources WHERE id = ?').get(req.params.id);
    if (!s || s.space !== req.params.space) throw new Error('Source not found');
    const labels = [].concat(req.body.label || []);
    const names = [].concat(req.body.name || []);
    if (labels.length !== names.length) throw new Error('Reload the page and name the speakers again');
    const mapping = labels.map((label, i) => ({ label: String(label), name: String(names[i] || '') }))
      .filter(x => x.name.trim() !== x.label);
    if (!mapping.length) { flash(req, 'No speaker name was changed'); return res.redirect(fallback); }
    const done = speakerCorrection.correct(s.id, mapping);
    const changed = done.mapping.map(x => `${x.label} is ${x.name}`).join('; ');
    const shared = done.skippedAtoms.length
      ? ` ${done.skippedAtoms.length} fact${done.skippedAtoms.length === 1 ? ' is' : 's are'} shared with other evidence and left unchanged.` : '';
    const elsewhere = done.otherSpaceParts
      ? ` ${done.otherSpaceParts === 1 ? 'One part' : `${done.otherSpaceParts} parts`} of this meeting in the other space ${done.otherSpaceParts === 1 ? 'was' : 'were'} left unchanged.` : '';
    flash(req, `${changed}. Existing facts and tasks were updated; the original recording is unchanged.${shared}${elsewhere}`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(fallback);
});

router.post('/crm/:space/sources/:id/move-space', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const spaces = require('../lib/crm/spaces');
  const to = spaces.other(req.params.space);
  try {
    const s = crm().prepare('SELECT space FROM sources WHERE id = ?').get(req.params.id);
    if (!s || s.space !== req.params.space) throw new Error('Source not found');
    spaces.moveSource(req.params.id, to, 'you', 'You moved it');
    flash(req, `Moved to ${spaces.label(to)}. It will be read again there in a minute or two.`);
    return res.redirect(`/crm/${to}/sources/${encodeURIComponent(req.params.id)}`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(`/crm/${req.params.space}/sources/${encodeURIComponent(req.params.id)}`);
});

router.post('/crm/:space/sources/:id/retry', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  flash(req, atoms.retrySource(req.params.id) ? 'Queued to read again' : 'Nothing to retry');
  back(req, res, `/crm/${req.params.space}/captured`);
});

router.get('/crm/:space/promises', spaceParam, (req, res) => {
  res.render('crm/promises', { page: 'today', ledger: promises.ledger(req.params.space), closed: promises.closed(req.params.space), title: 'Promises' });
});

router.post('/crm/:space/promises/:atomId/:action', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { space, atomId, action } = req.params;
  try {
    const p = promises.get(atomId);
    if (!p || p.space !== space) return res.status(404).send('Not found');
    if (action === 'task') { promises.makeTask(atomId); flash(req, 'Task created. It reaches Google at the next sync.'); }
    else if (action === 'kept') { promises.close(atomId, 'kept', 'douglas'); flash(req, 'Marked as done'); }
    else if (action === 'dismiss') { promises.close(atomId, 'dismissed', 'douglas'); flash(req, 'Taken off the list'); }
    else if (action === 'notdone') { promises.notDone(atomId); flash(req, "Kept open. That email won't be raised again."); }
    else if (action === 'confirm') { promises.close(atomId, 'kept', p.looks_done_source_id ? `source:${p.looks_done_source_id}` : 'douglas'); flash(req, 'Marked as done'); }
    else if (action === 'reopen') { promises.reopen(atomId); flash(req, 'Back on the list'); }
    else return res.status(404).send('Not found');
  } catch (err) { flash(req, err.message, 'bad'); }
  const next = String(req.body.back || '');
  res.redirect(next.startsWith(`/crm/${space}`) && !next.includes('\\') ? next : `/crm/${space}`);
});

function taskForm(req, res, t, error = null) {
  res.render('crm/task', { page: 'tasks', t, error, choices: tasks.choices(req.params.space), blocks: t.id ? calendar.blocksFor(t.id) : [], title: t.id ? t.title : 'Add a task' });
}

router.get('/crm/:space/tasks', spaceParam, (req, res) => {
  const status = ['completed', 'deleted'].includes(req.query.status) ? req.query.status : 'needsAction';
  res.render('crm/tasks', { page: 'tasks', list: tasks.list(req.params.space, { status }), status,
    sync: require('../lib/crm/runs').all().tasks_sync, title: 'Tasks' });
});

router.get('/crm/:space/tasks/new', spaceParam, (req, res) => {
  taskForm(req, res, { title: '', notes: '', due: '', status: 'needsAction', context: {
    personId: req.query.personId || '', orgId: req.query.orgId || '', projectId: req.query.projectId || '', sourceId: req.query.sourceId || '' } });
});

router.post('/crm/:space/tasks', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const t = tasks.create(req.params.space, req.body);
    tasks.setMinutes(t.id, req.body.minutes);
    replanned();
    flash(req, 'Task saved and planned into your calendar.');
    res.redirect(`/crm/${req.params.space}/tasks/${t.id}`);
  } catch (err) {
    res.status(400);
    taskForm(req, res, { ...req.body, context: req.body }, err.message);
  }
});

router.post('/crm/:space/tasks/sync', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const jobs = require('../lib/jobs');
  const hub = require('../lib/db').hub();
  if (jobs.hasPending('crm_tasks_sync')) hub.prepare("UPDATE system_jobs SET run_at = unixepoch() WHERE type = 'crm_tasks_sync' AND status = 'pending'").run();
  else jobs.scheduleJob('crm_tasks_sync', {}, null, 'crm_tasks_ui');
  flash(req, 'Sync queued. It will run on the next minute tick.');
  res.redirect(`/crm/${req.params.space}/tasks`);
});

router.get('/crm/:space/tasks/:id', spaceParam, (req, res) => {
  const t = tasks.detail(tasks.get(req.params.id));
  if (!t || t.space !== req.params.space) return res.status(404).send('Not found');
  taskForm(req, res, t);
});

router.post('/crm/:space/tasks/:id/:action', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t || t.space !== req.params.space) return res.status(404).send('Not found');
  try {
    if (req.params.action === 'edit') { tasks.edit(t.id, { ...req.body, context: req.body }); tasks.setMinutes(t.id, req.body.minutes); }
    else if (req.params.action === 'unpin') calendar.unpin(t.id);
    else if (req.params.action === 'complete') tasks.edit(t.id, { status: 'completed', revision: req.body.revision });
    else if (req.params.action === 'reopen') tasks.edit(t.id, { status: 'needsAction', revision: req.body.revision });
    else if (req.params.action === 'resolve') crm().prepare("UPDATE tasks SET conflict = '' WHERE id = ?").run(t.id);
    else if (req.params.action === 'delete') tasks.edit(t.id, { status: 'deleted', revision: req.body.revision });
    else return res.status(404).send('Not found');
    replanned();
    flash(req, 'Saved. Your calendar has been replanned.');
  } catch (err) {
    if (req.params.action === 'edit') {
      res.status(400);
      return taskForm(req, res, { ...tasks.detail(t), ...req.body, context: req.body }, err.message);
    }
    flash(req, err.message, 'bad');
  }
  const next = String(req.body.back || '');
  res.redirect(next.startsWith(`/crm/${t.space}/`) && !next.includes('\\') ? next : `/crm/${t.space}/tasks/${t.id}`);
});

// ── Calendar ───────────────────────────────────────────────────────────────
// Replans from what the Hub holds now, then asks the job to carry it to Google.
function replanned() {
  calendar.replan();
  calendar.soon();
}

router.get('/crm/:space/calendar', spaceParam, (req, res) => {
  const today = planner.local(Math.floor(Date.now() / 1000)).date;
  const first = planner.addDays(today, -calendar.HISTORY_DAYS);
  const last = planner.addDays(today, planner.HORIZON_DAYS - 7);
  let from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  if (from < first) from = first;
  if (from > last) from = last;
  res.render('crm/calendar', { page: 'calendar', title: 'Calendar', today, from,
    earlier: from > first ? planner.addDays(from, -7) < first ? first : planner.addDays(from, -7) : null,
    later: from < last ? planner.addDays(from, 7) > last ? last : planner.addDays(from, 7) : null,
    days: calendar.week(req.params.space, from), state: calendar.state(req.params.space), hours: calendar.hours() });
});

router.post('/crm/:space/calendar/:action', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  try {
    if (req.params.action === 'hours') { calendar.saveHours(req.body); flash(req, 'Hours saved. Your calendar has been replanned.'); }
    else if (req.params.action === 'flexible') {
      if (!calendar.setFlexible(String(req.body.event || ''), req.body.on === '1')) throw new Error('Only an appointment you made for yourself, with nobody else invited, can be flexible');
      flash(req, req.body.on === '1' ? 'The Hub may now move that appointment when something lands on it.' : 'That appointment now stays where it is.');
    } else if (req.params.action === 'replan') { calendar.replan(); flash(req, 'Replanned. Google Calendar follows within a minute.'); }
    else return res.status(404).send('Not found');
    calendar.soon();
  } catch (err) { flash(req, err.message, 'bad'); }
  back(req, res, `/crm/${req.params.space}/calendar`);
});

router.get('/crm/:space/projects', spaceParam, (req, res) => {
  res.render('crm/projects', { page: 'projects', list: views.projects(req.params.space), unfiled: require('../lib/crm/facts').unfiled(req.params.space, { limit: 0 }).total, title: 'Projects' });
});

router.post('/crm/:space/projects', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  try { const p = review.createProject(req.params.space, req.body.name); flash(req, `Added ${p.name}`); }
  catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(`/crm/${req.params.space}/projects`);
});

router.get('/crm/:space/projects/:id', spaceParam, (req, res) => {
  const p = views.project(req.params.id);
  if (!p || p.space !== req.params.space) return res.status(404).send('Not found');
  res.render('crm/project', { page: 'projects', p, title: p.name });
});

router.post('/crm/:space/projects/:id/:action(about|remove|putback|member-add|member-remove)', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { space, id, action } = req.params;
  const p = crm().prepare('SELECT * FROM projects WHERE id = ? AND space = ?').get(id, space);
  if (!p) return res.status(404).send('Not found');
  const check = require('../lib/crm/project-check');
  try {
    if (action === 'member-add' || action === 'member-remove') {
      const facts = require('../lib/crm/facts');
      const { person } = facts[action === 'member-add' ? 'addMember' : 'removeMember'](id, req.body.personId, space);
      flash(req, action === 'member-add' ? `${person.name} added to ${p.name}. Their facts are not filed here unless they are about it.` : `${person.name} is no longer on ${p.name}.`);
    } else if (action === 'about') {
      check.setAbout(id, { about: req.body.about, personId: req.body.personId });
      flash(req, `Saved. Claude will re-check the facts filed under ${p.name} against this.`);
    } else {
      const atomId = String(req.body.atomId || '');
      if (!crm().prepare('SELECT 1 FROM atoms WHERE id = ? AND space = ?').get(atomId, space)) throw new Error('Fact not found');
      if (action === 'remove') { check.remove(atomId, id, 'you', 'You took it off'); flash(req, `Taken off ${p.name}. You can put it back below.`); }
      else { check.putBack(atomId, id); flash(req, `Put back on ${p.name}.`); }
    }
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(`/crm/${space}/projects/${id}`);
});

// ── Facts ──────────────────────────────────────────────────────────────────
function factBack(req, space, fallback) {
  const b = String(req.body?.back || req.query?.back || '');
  return b.startsWith(`/crm/${space}/`) && !b.includes('\\') && !b.startsWith('//') ? b : fallback;
}

router.get('/crm/:space/facts', spaceParam, (req, res) => {
  const facts = require('../lib/crm/facts');
  const page = Math.max(0, Number(req.query.page) || 0);
  const { total, rows } = facts.unfiled(req.params.space, { limit: 50, offset: page * 50 });
  res.render('crm/facts', { page: 'projects', title: 'Facts not in a project', total, list: views.withDetail(rows), pageNo: page,
    projectChoices: crm().prepare('SELECT id, name FROM projects WHERE space = ? ORDER BY name COLLATE NOCASE').all(req.params.space) });
});

router.post('/crm/:space/facts/bulk-move', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { space } = req.params;
  try {
    const r = require('../lib/crm/facts').moveMany(req.body.atomIds, req.body.projectId, space, { from: req.body.from || null });
    const n = `${r.count} ${r.count === 1 ? 'fact' : 'facts'}`;
    flash(req, r.to && r.from ? `Moved ${n} from ${r.from.name} to ${r.to.name}.` : r.to ? `Filed ${n} under ${r.to.name}.` : `Took ${n} off ${r.from.name}. They are listed at the bottom of its page.`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(factBack(req, space, `/crm/${space}/facts`));
});

router.post('/crm/:space/facts/bulk-delete', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { space } = req.params;
  try {
    const { count } = require('../lib/crm/facts').deleteMany(req.body.atomIds, space);
    flash(req, `Deleted ${count} ${count === 1 ? 'fact' : 'facts'}. The emails and notes they came from are kept, and re-reading them won't bring these back.`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(factBack(req, space, `/crm/${space}/facts`));
});

router.get('/crm/:space/facts/:id', spaceParam, (req, res) => {
  try {
    const a = require('../lib/crm/facts').detail(req.params.id, req.params.space);
    res.render('crm/fact', { page: 'projects', title: 'Fact', a, back: factBack(req, req.params.space, '') });
  } catch (_) { res.status(404).send('Not found'); }
});

router.post('/crm/:space/facts/:id/:action(project-add|project-remove|person-add|person-remove|delete)', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const { space, id, action } = req.params;
  const facts = require('../lib/crm/facts');
  try {
    if (action === 'delete') {
      const a = facts.deleteFact(id, space);
      flash(req, `Deleted: “${a.statement.slice(0, 120)}”`);
      let ref = '';
      try { ref = new URL(req.get('referer') || '', 'https://x').pathname + new URL(req.get('referer') || '', 'https://x').search; } catch (_) {}
      const back = factBack(req, space, '') || (ref.startsWith(`/crm/${space}/`) || ref === '/crm/review' ? ref : `/crm/${space}/facts`);
      return res.redirect(back.startsWith(`/crm/${space}/facts/${id}`) ? `/crm/${space}/facts` : back);
    }
    if (action === 'project-add') flash(req, `Filed under ${facts.addProject(id, req.body.projectId, space).name}`);
    else if (action === 'project-remove') flash(req, `Taken off ${facts.removeProject(id, req.body.projectId, space).name}. It is listed on that project's page if you want it back.`);
    else if (action === 'person-add') flash(req, `Linked to ${facts.addPerson(id, req.body.personId, space).name}`);
    else flash(req, `No longer linked to ${facts.removePerson(id, req.body.personId, space).name}`);
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(factBack(req, space, `/crm/${space}/facts/${id}`));
});

router.get('/crm/:space/topics/:id', spaceParam, (req, res) => {
  const t = views.topic(req.params.id);
  if (!t || t.space !== req.params.space) return res.status(404).send('Not found');
  res.render('crm/topic', { page: 'projects', t, title: t.name });
});

router.get('/crm/:space/search', spaceParam, (req, res) => {
  const q = String(req.query.q || '');
  const ask = require('../lib/crm/ask');
  let question = null;
  try {
    if (req.query.ask) question = ask.get(String(req.query.ask));
    else if (ask.looksLikeQuestion(q)) question = ask.ask(req.params.space, q);
    if (question && question.space !== req.params.space) question = null;
    question = ask.shown(ask.collect(question));
  } catch (err) { res.locals.flash = { text: err.message, level: 'bad' }; }
  res.render('crm/search', { page: 'search', q: q || question?.question || '', results: views.search(req.params.space, q || question?.question || ''), question, asked: ask.recent(req.params.space), title: 'Search' });
});

router.get('/crm/personal/mailboxes/connect', (req, res) => {
  require('../lib/crm/gmail-connect').start(req, res, req.query.account);
});

router.get('/crm/wispr/callback', async (req, res) => {
  const text = v => (typeof v === 'string' ? v : '');
  let space = 'work';
  try {
    const done = await wispr.finishConnect({ state: text(req.query.state), code: text(req.query.code), error: text(req.query.error), iss: text(req.query.iss) });
    space = done.space;
    if (done.result === 'connected') flash(req, 'Wispr Flow connected for Work and Personal.');
    else if (done.result === 'stale') flash(req, 'That Wispr sign-in is no longer the current one. Choose Connect Wispr Flow again.', 'bad');
    else flash(req, wispr.status(space).error || 'Wispr could not finish sign-in. Connect again to retry.', 'bad');
  } catch (err) {
    flash(req, err.message, 'bad');
  }
  res.redirect(`/crm/${space}/meetings`);
});

router.get('/crm/:space/meetings', spaceParam, async (req, res) => {
  const space = req.params.space;
  res.render('crm/meetings', { page: 'meetings', title: 'Meetings', w: wispr.status(space), meetings: require('../lib/crm/meetings').today(space),
    configured: !!process.env.KRISP_WEBHOOK_SECRET,
    deliveries: require('../lib/crm/krisp').list().filter(d => d.status === 'pending' || d.sources.some(s => s.space === space)).map(d => ({ ...d, sources: d.sources.filter(s => s.space === space) })),
  });
});

router.post('/crm/:space/meetings/:action', spaceParam, requireSameOrigin, writeLimiter, async (req, res) => {
  const space = req.params.space;
  try {
    if (req.params.action === 'connect') {
      const url = await wispr.startConnect(space);
      if (url) return res.redirect(url);
    }
    else if (req.params.action === 'disconnect') { wispr.disconnect(space); flash(req, 'Wispr Flow disconnected for Work and Personal. Remove the Hub in your Wispr account too if you want it fully cut off.'); }
    else if (req.params.action === 'check') { await wispr.afterConnect(space); flash(req, 'The connection works.'); }
    else return res.status(404).send('Not found');
  } catch (err) {
    flash(req, err.message, 'bad');
  }
  res.redirect(`/crm/${space}/meetings`);
});

const upload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 5 } });
router.post('/crm/:space/upload', spaceParam, requireSameOrigin, writeLimiter, (req, res, next) => upload.array('files', 5)(req, res, err => {
  if (!err) return next();
  flash(req, err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 20 MB.' : 'Upload failed: choose at most five files.', 'bad');
  res.redirect(`/crm/${req.params.space}/note`);
}), async (req, res) => {
  const { space } = req.params;
  try {
    if (!req.files?.length) throw new Error('Choose a file to upload');
    const notes = [];
    let first = null;
    for (const f of req.files) {
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const r = await require('../lib/crm/documents').admitFile({ space, buffer: f.buffer, name });
      first = first || r.sources[0];
      if (!r.readable) notes.push(`${name}: ${r.reason}`);
      else if (!r.created) notes.push(`${name} was already here`);
      else notes.push(`${name} saved${r.sources.length > 1 ? ` in ${r.sources.length} parts` : ''}${r.unread ? `; the last ${r.unread.toLocaleString()} characters were too many to read` : ''}`);
    }
    flash(req, `${notes.join('. ')}. Readable files go to the Mac for reading.`, notes.some(n => /can't|Couldn't|No text|Almost/.test(n)) ? 'bad' : 'ok');
    res.redirect(req.files.length === 1 && first ? `/crm/${space}/sources/${first.id}` : `/crm/${space}/captured`);
  } catch (err) { flash(req, err.message, 'bad'); res.redirect(`/crm/${space}/note`); }
});

router.get('/crm/:space/note', spaceParam, (req, res) => {
  res.render('crm/note', { page: 'note', title: 'Add a note' });
});

router.post('/crm/:space/note', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  try {
    sources.addNote({ space: req.params.space, text: req.body.text });
    flash(req, 'Note saved. Its facts appear once the Mac has read it.');
    res.redirect(`/crm/${req.params.space}`);
  } catch (err) {
    flash(req, err.message, 'bad');
    res.redirect(`/crm/${req.params.space}/note`);
  }
});

module.exports = router;
