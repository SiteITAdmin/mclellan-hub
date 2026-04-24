require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const BetterSqliteSessionStore = require('./lib/session-store');

const hubRouter = require('./routes/hub');
const hubAdminRouter = require('./routes/hub-admin');
const portfolioRouter = require('./routes/portfolio');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || (!isProduction ? 'local-dev-session-secret' : null);

if (!sessionSecret) {
  throw new Error('SESSION_SECRET must be set in production');
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

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
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// ── Hostname router ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const host = req.hostname;

  if (host === 'dchat.mclellan.scot' || host === 'nchat.mclellan.scot') {
    req.hubUser = host.startsWith('d') ? 'douglas' : 'nakai';
    if (req.path.startsWith('/admin') || req.path.startsWith('/mcp')) {
      return hubAdminRouter(req, res, next);
    }
    return hubRouter(req, res, next);
  }

  if (host === 'douglas.mclellan.scot' || host === 'nakai.mclellan.scot') {
    req.portfolioUser = host.startsWith('d') ? 'douglas' : 'nakai';
    if (req.path.startsWith('/admin')) return adminRouter(req, res, next);
    return portfolioRouter(req, res, next);
  }

  const allowDevQueryRouting = !isProduction && (host === 'localhost' || host === '127.0.0.1');

  // Local dev fallback — use ?hub=douglas / ?portfolio=nakai
  if (allowDevQueryRouting && req.query.hub) {
    req.hubUser = req.query.hub;
    if (req.path.startsWith('/admin') || req.path.startsWith('/mcp')) {
      return hubAdminRouter(req, res, next);
    }
    return hubRouter(req, res, next);
  }
  if (allowDevQueryRouting && req.query.portfolio) {
    req.portfolioUser = req.query.portfolio;
    if (req.path.startsWith('/admin')) return adminRouter(req, res, next);
    return portfolioRouter(req, res, next);
  }

  res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
  console.error('[error]', err.stack || err);
  res.status(500).send('Internal server error');
});

app.listen(PORT, () => {
  console.log(`mclellan-hub listening on port ${PORT}`);
});
