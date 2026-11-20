'use strict';

// /models: which AI model does each function, with two stand-ins, and what
// actually ran where in the last 7 days.

const express = require('express');
const routes = require('../lib/model-routes');
const { requireSameOrigin } = require('../lib/security');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

function ago(t, now) {
  const s = Math.max(0, now - t);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function page(res, { picked = null, errors = [], saved = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const workers = routes.workers(now);
  const activity = routes.activity(now);
  const groups = [];
  for (const def of routes.FUNCTIONS) {
    let g = groups.find(x => x.name === def.group);
    if (!g) groups.push(g = { name: def.group, rows: [] });
    const lanes = picked?.[def.fn] || routes.laneKeys(def.fn);
    // A choice whose CLI a live machine lacks is still allowed: that machine passes it over.
    const missing = [...new Set(lanes.filter(Boolean))].flatMap(k => {
      const runner = routes.MODELS[k]?.runner;
      const lacking = workers.filter(w => w.live && w.available[runner] === false).map(w => w.machine);
      return lacking.length ? [`${routes.MODELS[k].label} isn’t set up on ${[...new Set(lacking)].join(' or ')}; jobs there go to the next choice.`] : [];
    });
    g.rows.push({ ...def, lanes, choices: routes.choices(def.fn), activity: activity[def.fn] || null, missing });
  }
  res.render('models', { icon: require('../lib/crm/icons'), groups, workers, models: routes.MODELS, runnerNames: routes.RUNNER_NAMES, errors, saved, ago: t => ago(t, now) });
}

router.get('/models', requireAuth, (req, res) => page(res, { saved: req.query.saved === '1' }));

router.post('/models', requireAuth, requireSameOrigin, (req, res) => {
  const body = req.body?.lanes && typeof req.body.lanes === 'object' ? req.body.lanes : {};
  const picked = {}, errors = [];
  for (const def of routes.FUNCTIONS) {
    const raw = body[def.fn];
    if (!raw) continue;
    const keys = [0, 1, 2].map(i => String((Array.isArray(raw) ? raw[i] : raw[i]) || '').trim() || null);
    picked[def.fn] = keys;
    const list = keys.filter(Boolean);
    const gap = keys.findIndex(k => !k) !== -1 && keys.slice(keys.findIndex(k => !k)).some(Boolean);
    if (!keys[0]) errors.push(`${def.label}: choose a main model.`);
    else if (gap) errors.push(`${def.label}: fill Backup 1 before Backup 2.`);
    else if (new Set(list).size !== list.length) errors.push(`${def.label}: use each model once.`);
    else if (list.some(k => !routes.choices(def.fn).includes(k))) errors.push(`${def.label}: that model can’t do this job.`);
  }
  if (errors.length) return page(res.status(400), { picked, errors });
  for (const [fn, keys] of Object.entries(picked)) routes.save(fn, keys);
  res.redirect('/models?saved=1');
});

module.exports = router;
