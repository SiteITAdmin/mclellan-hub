'use strict';

// Capture endpoints for the Hermes WhatsApp tap on the Mac
// (integrations/hermes-whatsapp/hub-tap.mjs). Bearer HERMES_WEBHOOK_SECRET.

const express = require('express');
const whatsapp = require('../lib/crm/whatsapp');
const { createRateLimiter } = require('../lib/security');

const router = express.Router();

// A busy group can send bursts; auth is the real gate, this is a ceiling.
const tapLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 3000, keyPrefix: 'hermes-tap' });

function requireTapAuth(req, res, next) {
  if (!process.env.HERMES_WEBHOOK_SECRET) return res.status(503).json({ error: 'HERMES_WEBHOOK_SECRET is not set on the Hub' });
  if (!whatsapp.secretOk(req.headers.authorization)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.post('/api/crm/whatsapp/heartbeat', tapLimiter, requireTapAuth, (req, res) => {
  try { res.json(whatsapp.heartbeat(req.body || {})); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/crm/whatsapp/message', tapLimiter, requireTapAuth, (req, res) => {
  try { res.json(whatsapp.receive(req.body || {})); } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/api/crm/whatsapp/outbox/claim', tapLimiter, requireTapAuth, (req,res) => res.json({messages:require('../lib/crm/self-chat').claim(req.body.self_chat_ids)}));
router.post('/api/crm/whatsapp/outbox/complete', tapLimiter, requireTapAuth, (req,res) => {
  require('../lib/crm/self-chat').complete(req.body.id,req.body);res.json({ok:true});
});
module.exports = router;
