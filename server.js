require('dotenv').config();
// Fail closed: no OpenRouter hostname may be contacted by this process.
require('./lib/openrouter-guard').installOpenRouterNetworkGuard();
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
const { reflowPlannerConflicts } = require('./lib/task-calendar-planner');
const {
  runDailyIntelligencePipeline,
  retryDailyBriefing,
  getDailyPipelineRunState,
} = require('./lib/nakai-intelligence-pipeline');
const { sendWeeklyDigest } = require('./lib/weekly-digest');
const { sendRhStats } = require('./lib/rh-stats');
const { ingestAllFeeds } = require('./lib/rss-ingest');
const { sendSystemReport } = require('./lib/system-report');
const { processJobs, seedJobs } = require('./lib/job-queue');
const { sendTodayM365DailyBriefing } = require('./scripts/build-m365-daily-briefing');
const { sendTodayNewsletterDigestBriefing } = require('./scripts/build-newsletter-digest-briefing');
const { sendTodayUSBlockBriefing } = require('./scripts/build-us-block-special-briefing');
const {
  readGovernanceReport,
  isWeeklyReviewDue,
  runGovernanceReview,
} = require('./lib/model-governance-review');
const {
  readEffectivenessReport,
  readEffectivenessProgress,
  isMonthlyEffectivenessReviewDue,
  runModelEffectivenessReview,
} = require('./lib/model-effectiveness-review');

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

// Native iOS apps authenticate with a bearer token on every host (see
// routes/hub-shared.js). Must run before the hostname router dispatches.
app.use(require('./routes/hub-shared').mobileBearerBridge);

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
    // Mobile bearer tokens are Douglas's identity regardless of host.
    if (!req.mobileAuth) req.hubUser = host.startsWith('d') ? 'douglas' : 'nakai';
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
const BACKGROUND_JOBS_ENABLED = process.env.HUB_DISABLE_JOBS !== '1';

if (!BACKGROUND_JOBS_ENABLED) {
  console.log('[scheduler] background jobs disabled by HUB_DISABLE_JOBS=1');
} else {

// ── CRM calendar sync (06:45 Europe/Dublin) ──────────────────────────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 6 || now.getMinutes() !== 45) return;
  for (const user of BRIEFING_USERS) {
    syncCalendarMeetings(user).catch(err => console.error(`[crm] calendar sync error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Planner conflict reflow (every 5 minutes) ────────────────────────────────
// Google Calendar appointments are fixed evidence; task-backed blocks yield
// and cascade forward while retaining their existing event identity.
const PLANNER_REFLOW_ENABLED = process.env.PLANNER_REFLOW_ENABLED !== '0';
const plannerReflowMinutesValue = parseInt(process.env.PLANNER_REFLOW_MINUTES || '5');
const PLANNER_REFLOW_MINUTES = Number.isFinite(plannerReflowMinutesValue) ? Math.max(1, plannerReflowMinutesValue) : 5;
const PLANNER_REFLOW_USERS = (process.env.PLANNER_USERS || 'douglas').split(',').map(user => user.trim()).filter(Boolean);
let plannerReflowRunning = false;

setInterval(() => {
  if (!PLANNER_REFLOW_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  if (now.getMinutes() % PLANNER_REFLOW_MINUTES !== 0 || plannerReflowRunning) return;
  plannerReflowRunning = true;
  Promise.allSettled(PLANNER_REFLOW_USERS.map(user => reflowPlannerConflicts(user)))
    .then(results => results.forEach((result, index) => {
      const user = PLANNER_REFLOW_USERS[index];
      if (result.status === 'rejected') {
        console.error(`[task-planner] automatic reflow failed for ${user}:`, result.reason);
      } else if (result.value.moved.length || result.value.unplaced.length || result.value.failed.length) {
        console.log(`[task-planner] automatic reflow for ${user}: ${result.value.moved.length} moved, ${result.value.unplaced.length} unplaced, ${result.value.failed.length} failed`);
      }
    }))
    .finally(() => { plannerReflowRunning = false; });
}, 60 * 1000);

// ── US Block Special Edition (07:30 Europe/Dublin, Mon/Wed/Fri) ─────────────
// The source scan runs on the three configured days.  The publication gate in
// build-us-block-special-briefing.js suppresses the archive/email entirely
// unless a high-confidence direct Block/product story is evidenced.
const US_BLOCK_BRIEFING_ENABLED = process.env.US_BLOCK_BRIEFING_ENABLED !== '0';
const US_BLOCK_BRIEF_HOUR = parseInt(process.env.US_BLOCK_BRIEF_HOUR || '7');
const US_BLOCK_BRIEF_MINUTE = parseInt(process.env.US_BLOCK_BRIEF_MINUTE || '30');
const US_BLOCK_BRIEF_DAYS = new Set((process.env.US_BLOCK_BRIEF_DAYS || 'mon,wed,fri').split(',').map(day => day.trim().toLowerCase()).filter(Boolean));
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

setInterval(() => {
  if (!US_BLOCK_BRIEFING_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  if (!US_BLOCK_BRIEF_DAYS.has(DAY_NAMES[now.getDay()])) return;
  if (now.getHours() !== US_BLOCK_BRIEF_HOUR || now.getMinutes() !== US_BLOCK_BRIEF_MINUTE) return;
  sendTodayUSBlockBriefing().then(result => console.log('[us-block-briefing] scheduled run:', result.reason || (result.queued ? `queued ${result.jobId}` : result.sent ? 'sent' : result.published ? 'published' : 'suppressed')))
    .catch(err => console.error('[us-block-briefing] error:', err));
}, 60 * 1000);

// ── M365 Operations & Security Brief (07:15 Europe/Dublin, Mon–Fri) ─────────
const M365_BRIEF_HOUR = parseInt(process.env.M365_BRIEF_HOUR || '7');
const M365_BRIEF_MINUTE = parseInt(process.env.M365_BRIEF_MINUTE || '15');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  const day = now.getDay();
  if (day === 0 || day === 6) return;
  if (now.getHours() !== M365_BRIEF_HOUR || now.getMinutes() !== M365_BRIEF_MINUTE) return;
  sendTodayM365DailyBriefing().catch(err => console.error('[m365-briefing] error:', err));
}, 60 * 1000);

// ── Newsletter Intelligence Brief (hourly catch-up 11:00–22:00 Europe/Dublin) ─
// The newsletter digest from the home server lands at variable times, so this
// polls hourly and builds+sends only digests not already filed (edition-keyed).
// Minute-zero only: a failed edition must not re-queue a model every 60 seconds.
const NEWSLETTER_BRIEF_START_HOUR = parseInt(process.env.NEWSLETTER_BRIEF_START_HOUR || '11');
const NEWSLETTER_BRIEF_END_HOUR = parseInt(process.env.NEWSLETTER_BRIEF_END_HOUR || '22');
let newsletterBriefRunning = false;
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() < NEWSLETTER_BRIEF_START_HOUR || now.getHours() > NEWSLETTER_BRIEF_END_HOUR) return;
  if (now.getMinutes() !== 0) return;
  if (newsletterBriefRunning) return;
  newsletterBriefRunning = true;
  sendTodayNewsletterDigestBriefing()
    .then(result => {
      if (!result.skipped) console.log('[newsletter-briefing] scheduled run:', result.queued ? `queued ${result.jobId}` : `sent edition ${result.manifest?.edition}`);
    })
    .catch(err => console.error('[newsletter-briefing] error:', err.message))
    .finally(() => { newsletterBriefRunning = false; });
}, 60 * 1000);

// ── rholdsworthconsulting.com daily stats (07:00 Europe/Dublin) ──────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 7 || now.getMinutes() !== 0) return;
  sendRhStats().catch(err => console.error('[rh-stats] error:', err));
}, 60 * 1000);

// ── Email + AgentMail: now handled by job queue (see lib/job-queue.js) ────────

// ── Weekly digest (Sunday 14:00 Europe/Dublin) ───────────────────────────────
// Disabled 6 Aug 2026 pending a full retool of the briefing function.
// Set WEEKLY_DIGEST_ENABLED=1 to re-enable the existing implementation.
const WEEKLY_DIGEST_ENABLED = process.env.WEEKLY_DIGEST_ENABLED === '1';
setInterval(() => {
  if (!WEEKLY_DIGEST_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  if (now.getDay() !== 0 || now.getHours() !== 14 || now.getMinutes() !== 0) return;
  for (const user of BRIEFING_USERS) {
    sendWeeklyDigest(user).catch(err => console.error(`[weekly] digest error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Prompt/model governance review (Sunday 04:15 Europe/Dublin) ──────────────
// Produces a compiled admin report and stages only high-confidence catalogue
// candidates as disabled. It never changes a live slot assignment or prompt.
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  const { report } = readGovernanceReport();
  if (!isWeeklyReviewDue(now, report)) return;
  runGovernanceReview({ reason: 'scheduled' })
    .then(result => console.log('[model-governance] weekly review complete:', result))
    .catch(err => console.error('[model-governance] weekly review error:', err.message));
}, 60 * 1000);

// ── Prompt/model effectiveness board (18th 05:00 Europe/Dublin) ─────────────
// Retired 21 Aug 2026 — the monthly panel was built for the OpenRouter era and
// production no longer calls OpenRouter. Off by default; set
// MODEL_EFFECTIVENESS_ENABLED=1 to restore the schedule. Manual runs via the
// admin route and scripts/run-model-effectiveness-review.js still work.
const MODEL_EFFECTIVENESS_ENABLED = process.env.MODEL_EFFECTIVENESS_ENABLED === '1';
setInterval(() => {
  if (!MODEL_EFFECTIVENESS_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  const { report } = readEffectivenessReport();
  const { progress } = readEffectivenessProgress();
  if (!isMonthlyEffectivenessReviewDue(now, report, progress)) return;
  runModelEffectivenessReview({ reason: 'scheduled', now })
    .then(result => console.log('[model-effectiveness] monthly review complete:', result.summary))
    .catch(err => console.error('[model-effectiveness] monthly review error:', err.message));
}, 60 * 1000);

// ── RSS feed ingest (09:30 Europe/Dublin, daily) ──────────────────────────────
setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== 9 || now.getMinutes() !== 30) return;
  for (const user of BRIEFING_USERS) {
    ingestAllFeeds(user).catch(err => console.error(`[rss] ingest error for ${user}:`, err));
  }
}, 60 * 1000);

// ── Nakai Daily Intelligence Pipeline (07:00 Europe/Dublin, daily) ────────────
// Single ordered run: regulatory monitor (scrape + assess + store) THEN the
// daily briefing (builds from what the monitor just stored) THEN an audit
// email to Douglas confirming what was checked, what was used, and why not
// if it wasn't. Previously these were two independent, unordered triggers —
// the monitor ran *after* the briefing it was meant to feed, and it sent its
// own separate email whose findings were never persisted to the DB at all.
const REG_MONITOR_ENABLED = process.env.REG_MONITOR_ENABLED === '1';
const NAKAI_PIPELINE_HOUR   = parseInt(process.env.NAKAI_PIPELINE_HOUR   || '7');
const NAKAI_PIPELINE_MINUTE = parseInt(process.env.NAKAI_PIPELINE_MINUTE || '0');
const NAKAI_BRIEFING_RETRY_MS = parseInt(process.env.NAKAI_BRIEFING_RETRY_MINUTES || '60') * 60 * 1000;
let nakaiPipelineAttemptDate = '';
let nakaiBriefingRetryAt = 0; // epoch ms of next briefing-only retry; 0 = none pending

setInterval(() => {
  if (!REG_MONITOR_ENABLED) return;
  const now = nowIn('Europe/Dublin');
  const dateKey = now.toLocaleDateString('sv-SE');
  const dueMinute = (NAKAI_PIPELINE_HOUR * 60) + NAKAI_PIPELINE_MINUTE;
  const currentMinute = (now.getHours() * 60) + now.getMinutes();

  // Retries never cross Dublin midnight — the next scheduled run owns the new day.
  if (nakaiBriefingRetryAt && nakaiPipelineAttemptDate !== dateKey) nakaiBriefingRetryAt = 0;

  if (currentMinute >= dueMinute && nakaiPipelineAttemptDate !== dateKey) {
    const runState = getDailyPipelineRunState(dateKey);
    if (runState.reported) {
      nakaiPipelineAttemptDate = dateKey;
      if (!runState.briefingOk && !nakaiBriefingRetryAt) {
        nakaiBriefingRetryAt = Date.now();
        console.error(`[intelligence-pipeline] ${dateKey} already reported but briefing failed — resuming briefing retry`);
      } else {
        console.log(`[intelligence-pipeline] ${dateKey} already reported — skipping restart-triggered run`);
      }
      return;
    }

    nakaiPipelineAttemptDate = dateKey;
    runDailyIntelligencePipeline().then(result => {
      if (!result.briefingOk) {
        nakaiBriefingRetryAt = Date.now() + NAKAI_BRIEFING_RETRY_MS;
        console.error(`[intelligence-pipeline] briefing failed — retrying at ${new Date(nakaiBriefingRetryAt).toISOString()}`);
      }
    }).catch(err => {
      console.error('[intelligence-pipeline] scheduled run error:', err);
      nakaiBriefingRetryAt = Date.now() + NAKAI_BRIEFING_RETRY_MS;
    });
    return;
  }

  if (nakaiBriefingRetryAt && Date.now() >= nakaiBriefingRetryAt) {
    nakaiBriefingRetryAt = 0; // cleared while in flight so ticks don't stack retries
    retryDailyBriefing().then(result => {
      if (result.ok) {
        console.log('[intelligence-pipeline] briefing retry succeeded');
      } else {
        nakaiBriefingRetryAt = Date.now() + NAKAI_BRIEFING_RETRY_MS;
        console.error(`[intelligence-pipeline] briefing retry failed — next attempt at ${new Date(nakaiBriefingRetryAt).toISOString()}`);
      }
    }).catch(err => {
      console.error('[intelligence-pipeline] briefing retry crashed:', err);
      nakaiBriefingRetryAt = Date.now() + NAKAI_BRIEFING_RETRY_MS;
    });
  }
}, 60 * 1000);

// ── Daily system report (06:00 Europe/Dublin) ─────────────────────────────────
const SYSTEM_REPORT_HOUR   = parseInt(process.env.SYSTEM_REPORT_HOUR   || '6');
const SYSTEM_REPORT_MINUTE = parseInt(process.env.SYSTEM_REPORT_MINUTE || '0');

setInterval(() => {
  const now = nowIn('Europe/Dublin');
  if (now.getHours() !== SYSTEM_REPORT_HOUR || now.getMinutes() !== SYSTEM_REPORT_MINUTE) return;
  sendSystemReport().catch(err => console.error('[system-report] error:', err));
}, 60 * 1000);

// ── Job queue — single tick drives all polling (email, agentmail, mycelium, flights) ──
setInterval(() => processJobs().catch(err => console.error('[jobs] tick error:', err)), 60 * 1000);
seedJobs(); // seed pending jobs on startup; idempotent
}
