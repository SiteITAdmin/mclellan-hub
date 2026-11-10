'use strict';

// The signed-in landing page at douglas.mclellan.scot/home: links to everything
// private on the site, and nothing else. It reads no data.

const express = require('express');
const views = require('../lib/crm/views');

const router = express.Router();

// Change Desk runs on the dev server at home and is reached by its Tailscale
// name, so the link opens only on a device signed in to Tailscale. The page says so.
const CHANGE_DESK_URL = process.env.CHANGE_DESK_URL || 'https://dev-server.tailc6e5c3.ts.net/';

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

router.get('/home', requireAuth, (req, res) => {
  const dateLine = new Date().toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long' });
  res.render('home', { icon: require('../lib/crm/icons'), greeting: views.greeting(), dateLine, changeDesk: CHANGE_DESK_URL });
});

module.exports = router;
