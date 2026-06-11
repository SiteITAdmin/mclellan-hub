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
const { sendDailyBriefing, sendEmailBriefing, syncCalendarMeetings } = require('./lib/crm');
const { processNewEmails } = require('./lib/email-processor');
const { processAgentMail } = require('./lib/agentmail-processor');
const { runRegulatoryMonitor } = require('./lib/regulatory-monitor');
const { sendWeeklyDigest } = require('./lib/weekly-digest');
const { sendRhStats } = require('./lib/rh-stats');
const { sendWeeklyReminder } = require('./lib/newsletter-pipeline');
const { ingestAllFeeds } = require('./lib/rss-ingest');
const { sendSystemReport } = require('./lib/system-report');

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

// ── Morning CRM briefing (07:30 Europe/London) ────────────────────────────────
const BRIEFING_HOUR = parseInt(process.env.BRIEFING_HOUR || '7');
const BRIEFING_MINUTE = parseInt(process.env.BRIEFING_MINUTE || '30');

setInterval(() => {
  const now = nowIn('Europe/London');
  if (now.getHours() !== BRIEFING_HOUR || now.getMinutes() !== BRIEFING_MINUTE) return;
  for (const user of BRIEFING_USERS) {
    sendDailyBriefing(user).catch(err => console.error(`[crm] morning briefing error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Email digest (16:00 Europe/Dublin) ───────────────────────────────────────
const EMAIL_BRIEFING_HOUR = parseInt(process.env.EMAIL_BRIEFING_HOUR || '16');
const EMAIL_BRIEFING_MINUTE = parseInt(process.env.EMAIL_BRIEFING_MINUTE || '0');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== EMAIL_BRIEFING_HOUR || now.getMinutes() !== EMAIL_BRIEFING_MINUTE) return;
  for (const user of BRIEFING_USERS) {
    sendEmailBriefing(user).catch(err => console.error(`[email] digest error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Email processing (every 15 minutes) ──────────────────────────────────────
setInterval(() => {
  for (const user of BRIEFING_USERS) {
    processNewEmails(user).catch(err => console.error(`[email] process error for ${user}:`, err));
  }
}, 15 * 60 * 1000);

// ── AgentMail ingestion (every 15 minutes) ───────────────────────────────────
setInterval(() => {
  if (!process.env.AGENTMAIL_API_KEY || !process.env.AGENTMAIL_INBOX_ID) return;
  processAgentMail('douglas')
    .catch(err => console.error('[agentmail] process error:', err));
}, 15 * 60 * 1000);

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
const REG_MONITOR_HOUR   = parseInt(process.env.REG_MONITOR_HOUR   || '8');
const REG_MONITOR_MINUTE = parseInt(process.env.REG_MONITOR_MINUTE || '0');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== REG_MONITOR_HOUR || now.getMinutes() !== REG_MONITOR_MINUTE) return;
  runRegulatoryMonitor().catch(err => console.error('[reg-monitor] error:', err));
}, 60 * 1000);

// ── Daily system report (21:00 Europe/Dublin) ─────────────────────────────────
const SYSTEM_REPORT_HOUR   = parseInt(process.env.SYSTEM_REPORT_HOUR   || '21');
const SYSTEM_REPORT_MINUTE = parseInt(process.env.SYSTEM_REPORT_MINUTE || '0');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== SYSTEM_REPORT_HOUR || now.getMinutes() !== SYSTEM_REPORT_MINUTE) return;
  sendSystemReport().catch(err => console.error('[system-report] error:', err));
}, 60 * 1000);

// ── Mycelium cross-node connector (on boot + every 6 hours) ──────────────────
const { runMycelium } = require('./lib/mycelium');
let lastMyceliumHour = -1;
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  const h = now.getHours();
  // Run at 06:00, 12:00, 18:00, 00:00
  if (h % 6 !== 0 || now.getMinutes() !== 0) return;
  if (h === lastMyceliumHour) return;
  lastMyceliumHour = h;
  runMycelium('douglas').catch(err => console.error('[mycelium] error:', err));
}, 60 * 1000);

// Run once on startup so a fresh deploy doesn't wait up to 6h for first pass
setTimeout(() => {
  runMycelium('douglas').catch(err => console.error('[mycelium] startup error:', err));
}, 15 * 1000);

// ── Live flight status refresh (every 30 min, only if AERODATABOX_KEY set) ───
// Polls today's + tomorrow's scheduled flights and updates actual dep/arr times.
if (process.env.AERODATABOX_KEY) {
  async function refreshActiveFlights() {
    const db = require('./lib/db');
    const hub = db.hub();
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });

    const flights = hub.prepare(`
      SELECT id, user, flight_number, flight_date, direction FROM flights
      WHERE status = 'scheduled' AND flight_date BETWEEN ? AND ?
        AND flight_number != ''
    `).all(today, tomorrow);

    if (!flights.length) return;
    console.log(`[flights] refreshing ${flights.length} active flight(s)`);

    // aerodataboxLookup is not exported — call the bulk-lookup logic inline
    const fetch = require('node-fetch');
    for (const f of flights) {
      await new Promise(r => setTimeout(r, 500)); // rate limit
      try {
        const key = process.env.AERODATABOX_KEY;
        const resp = await fetch(
          `https://aerodatabox.p.rapidapi.com/flights/number/${f.flight_number}/${f.flight_date}?withAircraftImage=false&withLocation=false`,
          { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' } }
        );
        if (!resp.ok) continue;
        const json = await resp.json();
        const records = Array.isArray(json) ? json : (json.items || []);
        if (!records.length) continue;

        const [fromIata, toIata] = (f.direction || '').split('-');
        let rec = null;
        if (fromIata && toIata) {
          rec = records.find(r => r.departure?.airport?.iata === fromIata && r.arrival?.airport?.iata === toIata)
             || records.find(r => r.departure?.airport?.iata === fromIata)
             || records[0];
        } else { rec = records[0]; }
        if (!rec) continue;

        function hhmm(t) {
          const s = t?.local || t?.utc || ''; const p = s.split(' ');
          return p[1] ? p[1].slice(0, 5) : '';
        }
        const rawStatus = (rec.status || '').toLowerCase();
        const status = rawStatus.includes('landed') || rawStatus.includes('arrived') ? 'completed'
          : rawStatus.includes('cancel') ? 'cancelled'
          : rawStatus.includes('diverted') ? 'diverted'
          : 'scheduled';

        const actualDep = hhmm(rec.departure?.actualTime || rec.departure?.runway?.actualTime);
        const actualArr = hhmm(rec.arrival?.actualTime || rec.arrival?.runway?.actualTime);
        const scheduledDep = hhmm(rec.departure?.scheduledTime);
        const scheduledArr = hhmm(rec.arrival?.scheduledTime);

        hub.prepare(`
          UPDATE flights SET
            status        = ?,
            actual_dep    = CASE WHEN actual_dep    = '' AND ? != '' THEN ? ELSE actual_dep    END,
            actual_arr    = CASE WHEN actual_arr    = '' AND ? != '' THEN ? ELSE actual_arr    END,
            scheduled_dep = CASE WHEN scheduled_dep = '' AND ? != '' THEN ? ELSE scheduled_dep END,
            scheduled_arr = CASE WHEN scheduled_arr = '' AND ? != '' THEN ? ELSE scheduled_arr END
          WHERE id = ?
        `).run(
          status,
          actualDep, actualDep,
          actualArr, actualArr,
          scheduledDep, scheduledDep,
          scheduledArr, scheduledArr,
          f.id
        );

        if (actualDep) console.log(`[flights] ${f.flight_number} ${f.flight_date}: departed ${actualDep}, status=${status}`);
        if (actualArr) console.log(`[flights] ${f.flight_number} ${f.flight_date}: arrived ${actualArr}`);
      } catch (err) {
        console.warn(`[flights] refresh error for ${f.flight_number}:`, err.message);
      }
    }
  }

  // Run every 30 minutes
  setInterval(refreshActiveFlights, 30 * 60 * 1000);
  // Also run shortly after startup
  setTimeout(refreshActiveFlights, 30 * 1000);
}
