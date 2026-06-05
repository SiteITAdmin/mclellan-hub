const multer = require('multer');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const chatLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 80, keyPrefix: 'hub-chat' });
const uploadLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'hub-upload' });
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40, keyPrefix: 'hub-write' });

function requireAuth(req, res, next) {
  if (req.session && req.session.hubUser === req.hubUser) return next();
  res.redirect('/login');
}

function validWorkdayWebhookAuth(req) {
  const secret = process.env.WORKDAY_WEBHOOK_SECRET;
  const mobileSecret = process.env.WORKDAY_MOBILE_TOKEN;
  if (!secret && !mobileSecret) return { ok: false, configured: false };
  const auth = req.headers.authorization || '';
  const token = req.headers['x-workday-token'];
  return {
    ok:
      (!!secret && auth === `Bearer ${secret}`) ||
      (!!mobileSecret && auth === `Bearer ${mobileSecret}`) ||
      (!!mobileSecret && token === mobileSecret),
    configured: true,
  };
}

function requireWorkdayWebhookAuth(req, res, next) {
  const auth = validWorkdayWebhookAuth(req);
  if (!auth.configured) return res.status(503).json({ error: 'Workday webhook not configured' });
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

function requireHermesAuth(req, res, next) {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Hermes auth not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

module.exports = {
  upload,
  audioUpload,
  chatLimiter,
  uploadLimiter,
  writeLimiter,
  requireAuth,
  requireSameOrigin,
  requireWorkdayWebhookAuth,
  requireHermesAuth,
  validWorkdayWebhookAuth,
};
