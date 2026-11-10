'use strict';

// The signed-in landing page at douglas.mclellan.scot/home: links to everything
// private on the site, and nothing else. It reads no data.

const express = require('express');
const views = require('../lib/crm/views');

const router = express.Router();

// Change Desk runs on the dev server at home and listens on the home network
// only, so this link opens nothing from anywhere else. The page says so.
const CHANGE_DESK_URL = process.env.CHANGE_DESK_URL || 'http://192.168.0.3:3780/';

function requireAuth(req, res, next) {
  if (req.portfolioUser === 'douglas' && req.session?.adminUser === 'douglas') return next();
  res.redirect('/admin/login');
}

router.get('/home', requireAuth, (req, res) => {
  const dateLine = new Date().toLocaleDateString('en-IE', { timeZone: 'Europe/Dublin', weekday: 'long', day: 'numeric', month: 'long' });
  res.render('home', { icon: require('../lib/crm/icons'), greeting: views.greeting(), dateLine, changeDesk: CHANGE_DESK_URL });
});

module.exports = router;
