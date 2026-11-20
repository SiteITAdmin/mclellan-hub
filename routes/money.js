'use strict';

// Standalone Personal Money tool at douglas.mclellan.scot/money, behind the
// site admin's Google sign-in.

const express = require('express');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');
const views = require('../lib/crm/views');
const money = require('../lib/crm/money');

const router = express.Router();
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, keyPrefix: 'money-write' });

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

function flash(req, text, level = 'ok') { req.session.crmFlash = { text, level }; }

function back(req, res, fallback) {
  const ref = req.get('referer');
  res.redirect(ref && new URL(ref, 'https://x').pathname.startsWith('/money') ? ref : fallback);
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

router.use('/money', requireAuth, (req, res, next) => {
  res.locals.flash = req.session.crmFlash || null;
  delete req.session.crmFlash;
  res.locals.ago = views.ago;
  res.locals.fmt = fmt;
  res.locals.icon = require('../lib/crm/icons');
  res.locals.space = 'personal';
  res.locals.toolSpace = 'personal';
  res.locals.base = '/money';
  next();
});

money.mount(router, { requireSameOrigin, writeLimiter, flash, back, base: '/money' });

module.exports = router;
