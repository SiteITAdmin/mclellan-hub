'use strict';
const router = require('express').Router();
const krisp = require('../lib/crm/krisp');
const { createRateLimiter } = require('../lib/security');
router.post('/api/krisp/webhook', createRateLimiter({ windowMs: 15 * 60000, max: 300, keyPrefix: 'krisp' }), (req, res) => {
  const auth = krisp.authenticate(req.headers.authorization);
  if (auth.status) return res.status(auth.status).json({ error: auth.status === 503 ? 'Krisp intake requires secret and explicit space configuration' : 'Unauthorized' });
  try { res.json(krisp.receive(req.body, auth.space)); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : 'Krisp capture failed' }); }
});
module.exports = router;
