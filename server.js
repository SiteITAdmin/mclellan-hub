require('dotenv').config();
// Fail closed: no OpenRouter hostname may be contacted by this process.
require('./lib/openrouter-guard').installOpenRouterNetworkGuard();
const express = require('express');
const session = require('express-session');
const path = require('path');
const BetterSqliteSessionStore = require('./lib/session-store');

const portfolioRouter = require('./routes/portfolio');
const adminRouter = require('./routes/admin');
const flightsRouter = require('./routes/flights');
const workerRouter = require('./routes/worker');
const { processJobs, seedJobs } = require('./lib/jobs');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (isProduction ? '127.0.0.1' : '0.0.0.0');
const sessionSecret = process.env.SESSION_SECRET || (!isProduction ? 'local-dev-session-secret' : null);

if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "font-src 'self' https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
      "connect-src 'self'",
    ].join('; ')
  );
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new BetterSqliteSessionStore(),
  name: 'mclellan.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction ? 'auto' : false,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

// ── Hostname router ───────────────────────────────────────────────────────────
// douglas.mclellan.scot: portfolio, its admin, the flight tracker, and the Mac
// worker API. nakai.mclellan.scot: portfolio and its admin.
// rholdsworthconsulting.com is static and served by nginx directly.
function portfolioHost(req, res, next, user) {
  req.portfolioUser = user;
  if (user === 'douglas') {
    if (req.path.startsWith('/api/subscription-agent/')) return workerRouter(req, res, next);
    if (req.path === '/flights' || req.path.startsWith('/api/flights')) return flightsRouter(req, res, next);
  }
  if (req.path.startsWith('/admin')) return adminRouter(req, res, next);
  return portfolioRouter(req, res, next);
}

app.use((req, res, next) => {
  const host = req.hostname;
  if (host === 'douglas.mclellan.scot') return portfolioHost(req, res, next, 'douglas');
  if (host === 'nakai.mclellan.scot') return portfolioHost(req, res, next, 'nakai');

  // Local dev: ?portfolio=nakai picks the site; douglas otherwise.
  if (!isProduction && ['localhost', '127.0.0.1'].includes(host)) {
    if (req.query.portfolio) req.session.devPortfolio = req.query.portfolio === 'nakai' ? 'nakai' : 'douglas';
    return portfolioHost(req, res, next, req.session.devPortfolio || 'douglas');
  }
  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  res.status(500).send('Internal server error');
});

if (process.env.HUB_DISABLE_JOBS !== '1') {
  setInterval(() => processJobs().catch(err => console.error('[jobs] tick error:', err)), 60 * 1000);
  seedJobs();
} else {
  console.log('[scheduler] background jobs disabled by HUB_DISABLE_JOBS=1');
}

app.listen(PORT, HOST, () => {
  console.log(`mclellan-hub listening on ${HOST}:${PORT}`);
});
