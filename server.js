require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const BetterSqliteSessionStore = require('./lib/session-store');

const hubRouter = require('./routes/hub');
const hubAdminRouter = require('./routes/hub-admin');
const portfolioRouter = require('./routes/portfolio');
const adminRouter = require('./routes/admin');
const wikiRouter = require('./routes/wiki');
const promptRouter = require('./routes/prompt');
const { syncCalendarMeetings } = require('./lib/crm');
const { runRegulatoryMonitor } = require('./lib/regulatory-monitor');
const { sendWeeklyDigest } = require('./lib/weekly-digest');
const { sendRhStats } = require('./lib/rh-stats');
const { sendWeeklyReminder } = require('./lib/newsletter-pipeline');
const { ingestAllFeeds } = require('./lib/rss-ingest');
const { sendSystemReport } = require('./lib/system-report');
const { processJobs, seedJobs } = require('./lib/job-queue');
const { sendTodayNakaiDailyBriefing } = require('./scripts/build-nakai-daily-briefing');

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
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

// ── Hostname router ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const host = req.hostname;

  if (host === 'wiki.mclellan.scot') {
    return wikiRouter(req, res, next);
  }

  if (host === 'prompt.mclellan.scot') {
    return promptRouter(req, res, next);
  }

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
  if (allowDevQueryRouting && !req.query.prompt && !req.query.portfolio) {
    req.hubUser = 'douglas';
    if (req.path.startsWith('/admin') || req.path.startsWith('/mcp')) {
      return hubAdminRouter(req, res, next);
    }
    return hubRouter(req, res, next);
  }
  if (allowDevQueryRouting && req.query.prompt) {
    return promptRouter(req, res, next);
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

app.listen(PORT, HOST, () => {
  console.log(`mclellan-hub listening on ${HOST}:${PORT}`);
});

// ── Scheduler helpers ─────────────────────────────────────────────────────────

function nowIn(tz) {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

const BRIEFING_USERS = (process.env.BRIEFING_USERS || 'douglas,nakai').split(',').map(u => u.trim()).filter(Boolean);

// ── CRM calendar sync (06:45 Europe/Dublin) ──────────────────────────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 6 || now.getMinutes() !== 45) return;
  for (const user of BRIEFING_USERS) {
    syncCalendarMeetings(user).catch(err => console.error(`[crm] calendar sync error for ${user}:`, err));
  }
}, 60 * 1000);

// ── rholdsworthconsulting.com daily stats (07:00 Europe/Dublin) ──────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 7 || now.getMinutes() !== 0) return;
  sendRhStats().catch(err => console.error('[rh-stats] error:', err));
}, 60 * 1000);

// ── Email + AgentMail: now handled by job queue (see lib/job-queue.js) ────────

// ── Weekly digest (Sunday 14:00 Europe/Dublin) ───────────────────────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getDay() !== 0 || now.getHours() !== 14 || now.getMinutes() !== 0) return;
  for (const user of BRIEFING_USERS) {
    sendWeeklyDigest(user).catch(err => console.error(`[weekly] digest error for ${user}:`, err));
  }
}, 60 * 1000);

// ── RSS feed ingest (09:30 Europe/Dublin, daily) ──────────────────────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 9 || now.getMinutes() !== 30) return;
  for (const user of BRIEFING_USERS) {
    ingestAllFeeds(user).catch(err => console.error(`[rss] ingest error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Newsletter Saturday reminder (09:00 Europe/Dublin, Saturday) ─────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getDay() !== 6 || now.getHours() !== 9 || now.getMinutes() !== 0) return;
  for (const user of BRIEFING_USERS) {
    sendWeeklyReminder(user).catch(err => console.error(`[newsletter] reminder error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Regulatory monitor (08:00 Europe/Dublin, daily) ───────────────────────────
const REG_MONITOR_ENABLED = process.env.REG_MONITOR_ENABLED === '1';
const REG_MONITOR_HOUR   = parseInt(process.env.REG_MONITOR_HOUR   || '8');
const REG_MONITOR_MINUTE = parseInt(process.env.REG_MONITOR_MINUTE || '0');

setInterval(() => {
  if (!REG_MONITOR_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== REG_MONITOR_HOUR || now.getMinutes() !== REG_MONITOR_MINUTE) return;
  runRegulatoryMonitor().catch(err => console.error('[reg-monitor] error:', err));
}, 60 * 1000);

// ── Nakai Daily Briefing (07:30 Europe/Dublin, daily; Edition 001 starts 2026-06-19) ──
const NAKAI_DAILY_BRIEFING_HOUR = parseInt(process.env.NAKAI_DAILY_BRIEFING_HOUR || '7');
const NAKAI_DAILY_BRIEFING_MINUTE = parseInt(process.env.NAKAI_DAILY_BRIEFING_MINUTE || '30');
let nakaiDailyBriefingAttemptDate = '';

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  const dateKey = now.toLocaleDateString('sv-SE');
  const dueMinute = (NAKAI_DAILY_BRIEFING_HOUR * 60) + NAKAI_DAILY_BRIEFING_MINUTE;
  const currentMinute = (now.getHours() * 60) + now.getMinutes();
  if (currentMinute < dueMinute || nakaiDailyBriefingAttemptDate === dateKey) return;
  nakaiDailyBriefingAttemptDate = dateKey;
  sendTodayNakaiDailyBriefing().catch(err => {
    nakaiDailyBriefingAttemptDate = '';
    console.error('[nakai-briefing] scheduled send error:', err);
  });
}, 60 * 1000);

// ── Daily system report (21:00 Europe/Dublin) ─────────────────────────────────
const SYSTEM_REPORT_HOUR   = parseInt(process.env.SYSTEM_REPORT_HOUR   || '21');
const SYSTEM_REPORT_MINUTE = parseInt(process.env.SYSTEM_REPORT_MINUTE || '0');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== SYSTEM_REPORT_HOUR || now.getMinutes() !== SYSTEM_REPORT_MINUTE) return;
  sendSystemReport().catch(err => console.error('[system-report] error:', err));
}, 60 * 1000);

// ── Job queue — single tick drives all polling (email, agentmail, mycelium, flights) ──
setInterval(() => processJobs().catch(err => console.error('[jobs] tick error:', err)), 60 * 1000);
seedJobs(); // seed pending jobs on startup; idempotent
