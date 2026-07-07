const multer = require('multer');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const chatLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 80, keyPrefix: 'hub-chat' });
const uploadLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'hub-upload' });
const writeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40, keyPrefix: 'hub-write' });

// ── Mobile bearer bridge ──────────────────────────────────────────────────────
// The native iOS element apps (chat, tasks, CRM, flights, …) authenticate the
// same way the debrief app does: a bearer token baked in at build time, because
// a raw URLSession holds no Google-OAuth session cookie. Mounted in server.js
// before the hostname router. A valid token marks the request mobile-authed;
// requireAuth and requireSameOrigin then let it through, so the apps reuse the
// exact endpoints the web UI uses. No new production secret: the same tokens
// the debrief/workday apps already accept, plus HUB_MOBILE_TOKEN if ever set.
// The tokens are Douglas's, so a token request is always user douglas.
function mobileBearerBridge(req, res, next) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const tokens = [
      process.env.HUB_MOBILE_TOKEN,
      process.env.DEBRIEF_MOBILE_TOKEN,
      process.env.WORKDAY_MOBILE_TOKEN,
      process.env.WORKDAY_WEBHOOK_SECRET,
    ].filter(Boolean);
    if (tokens.some(t => auth === `Bearer ${t}`)) {
      req.mobileAuth = true;
      req.hubUser = 'douglas';
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.mobileAuth) return next();
  const localDev = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '::1'].includes(req.hostname);
  if (localDev && req.hubUser) {
    if (req.session) req.session.hubUser = req.hubUser;
    return next();
  }
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
  mobileBearerBridge,
  requireAuth,
  requireSameOrigin,
  requireWorkdayWebhookAuth,
  requireHermesAuth,
  validWorkdayWebhookAuth,
};
