'use strict';

// The Boox app's two calls (boox-app/). Bearer HUB_BOOX_TOKEN is provisioned into the
// app’s private storage by scripts/install-boox-app.sh.

const express = require('express');
const app = require('../lib/crm/boox-app');
const { createRateLimiter } = require('../lib/security');

const router = express.Router();

// The app asks every ten minutes while it is open; auth is the real gate.
const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 300, keyPrefix: 'boox-app' });

function requireDevice(req, res, next) {
  if (!process.env.HUB_BOOX_TOKEN) return res.status(503).json({ error: 'HUB_BOOX_TOKEN is not set on the Hub' });
  if (!app.secretOk(req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.get('/api/crm/boox/sync', limiter, requireDevice, (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(app.sync({ app: req.query.app })); }
  catch (err) { console.error('[boox-app] sync failed:', err); res.status(500).json({ error: err.message }); }
});

router.post('/api/crm/boox/note', limiter, requireDevice, (req, res) => {
  try { res.json(app.opened(req.body || {})); } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
