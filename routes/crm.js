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
  if (key === todayKey) return `Today ${time}`;
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-GB', tz);
  if (key === yesterday) return `Yesterday ${time}`;
  if (style === 'date') return d.toLocaleDateString('en-IE', { ...tz, weekday: 'short', day: 'numeric', month: 'short' });
  return `${d.toLocaleDateString('en-IE', { ...tz, weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function hueStyle(p) { return `--h:${Number(p?.hue) || 0}`; }

function greeting() {
  const h = Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', hour12: false }));
  if (h < 12) return 'Morning';
  if (h < 18) return 'Afternoon';
  return 'Evening';
}

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
      detail.lookEmails = Object.fromEntries(detail.lookalikes.map(l => [l.id,
        crm().prepare("SELECT value FROM identifiers WHERE person_id = ? AND kind = 'email'").all(l.id).map(r => r.value)]));
    }
    if (selected.kind === 'mention') {
      const db = crm();
      detail.candidates = selected.payload.candidateIds.map(id => db.prepare('SELECT * FROM people WHERE id = ?').get(id)).filter(Boolean)
        .map(p => ({ ...p, emails: db.prepare("SELECT value FROM identifiers WHERE person_id = ? AND kind = 'email'").all(p.id).map(r => r.value) }));
      detail.atom = views.source(db.prepare('SELECT source_id FROM atom_sources WHERE atom_id = ?').get(selected.payload.atomId)?.source_id || '')
        ?.atoms.find(a => a.id === selected.payload.atomId) || null;
    }
    if (selected.kind === 'project') {
      const db = crm();
      detail.atoms = selected.payload.atomIds.slice(0, 5).map(id => db.prepare('SELECT * FROM atoms WHERE id = ?').get(id)).filter(Boolean);
    }
  }
  const peopleBySpace = Object.fromEntries(SPACES.map(s => [s, crm().prepare('SELECT id, name, org FROM people WHERE space = ? ORDER BY name COLLATE NOCASE').all(s)]));
  res.render('crm/review', { page: 'review', space: null, items, selected, detail, peopleBySpace, title: 'Who is this?' });
});

router.post('/crm/review/:id', requireSameOrigin, writeLimiter, (req, res) => {
  try {
    const body = {
      action: String(req.body.action || ''),
      name: req.body.name, space: req.body.space, org: req.body.org,
      personId: req.body.personId,
      shownIds: [].concat(req.body.shownIds || []).map(String),
    };
    const r = review.decide(req.params.id, body);
    const messages = { new: 'Added', same: 'Linked', ignore: 'Set aside for good', later: 'Moved to later', choose: 'Linked', none: 'Marked as nobody you know', add: 'Project added' };
    flash(req, messages[body.action] || 'Done');
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

// ── Space screens ──────────────────────────────────────────────────────────
router.get('/crm/:space', spaceParam, (req, res) => {
  const space = req.params.space;
  const data = views.today(space);
  res.render('crm/today', { page: 'today', data, greeting: greeting(), title: space === 'work' ? 'Work' : 'Personal' });
});

router.get('/crm/:space/people', spaceParam, (req, res) => {
  res.render('crm/people', { page: 'people', list: views.people(req.params.space, req.query.q), q: req.query.q || '', title: 'People' });
});

router.post('/crm/:space/people', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  const space = req.params.space;
  try {
    const email = String(req.body.email || '').trim();
    if (email && identity.identifierRow('email', email)?.person_id) throw new Error(`${email} already belongs to someone`);
    const p = identity.createPerson({ space, name: req.body.name, org: req.body.org });
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
  res.render('crm/person', { page: 'people', p, title: p.name });
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
      crm().prepare('UPDATE people SET name = ?, org = ?, role = ?, updated_at = unixepoch() WHERE id = ?')
        .run(name, String(req.body.org || '').trim(), String(req.body.role || '').trim(), id);
      identity.log('edit_person', id, { name });
      atoms.reresolveMentions(space);
      flash(req, 'Saved');
    } else if (action === 'email') {
      const email = String(req.body.email || '').trim();
      identity.linkIdentifier(id, 'email', email);
      sources.releaseHeld(email, 'linked');
      flash(req, 'Email added');
    } else return res.status(404).send('Not found');
  } catch (err) { flash(req, err.message, 'bad'); }
  res.redirect(to);
});

router.get('/crm/:space/captured', spaceParam, (req, res) => {
  const filter = req.query.filter === 'attention' ? 'attention' : '';
  res.render('crm/captured', { page: 'captured', list: views.captured(req.params.space, { limit: 200, filter }), filter, title: 'Captured' });
});

router.get('/crm/:space/sources/:id', spaceParam, (req, res) => {
  const s = views.source(req.params.id);
  if (!s || s.space !== req.params.space) return res.status(404).send('Not found');
  res.render('crm/source', { page: 'captured', s, title: s.title });
});

router.post('/crm/:space/sources/:id/retry', spaceParam, requireSameOrigin, writeLimiter, (req, res) => {
  flash(req, atoms.retrySource(req.params.id) ? 'Queued to read again' : 'Nothing to retry');
  back(req, res, `/crm/${req.params.space}/captured`);
});

router.get('/crm/:space/projects', spaceParam, (req, res) => {
  res.render('crm/projects', { page: 'projects', list: views.projects(req.params.space), title: 'Projects' });
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

router.get('/crm/:space/topics/:id', spaceParam, (req, res) => {
  const t = views.topic(req.params.id);
  if (!t || t.space !== req.params.space) return res.status(404).send('Not found');
  res.render('crm/topic', { page: 'projects', t, title: t.name });
});

router.get('/crm/:space/search', spaceParam, (req, res) => {
  const q = String(req.query.q || '');
  res.render('crm/search', { page: 'search', q, results: views.search(req.params.space, q), title: 'Search' });
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
