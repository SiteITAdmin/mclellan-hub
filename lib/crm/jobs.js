'use strict';

// CRM job handlers for the shared SQLite queue (lib/jobs.js). Each one
// re-schedules itself. Capture jobs look back over a fixed 7-day window, so a
// long outage never turns into weeks of catch-up.

function now() { return Math.floor(Date.now() / 1000); }

function every(type, seconds, fn) {
  return async function handler(payload = {}) {
    const { scheduleJob, hasPending } = require('../jobs');
    try {
      await fn(payload);
    } finally {
      if (!hasPending(type)) scheduleJob(type, {}, now() + seconds, 'self');
    }
  };
}

const handlers = {
  crm_tasks_sync: every('crm_tasks_sync', 15 * 60, async () => {
    // A promise failure is recorded on its own run and must not hold up Google.
    await require('./promises').run().catch(() => {});
    return require('./tasks-sync').run();
  }),
  crm_gmail_capture: every('crm_gmail_capture', 15 * 60, () => require('./gmail').runAllGmailCapture()),
  crm_outlook_capture: every('crm_outlook_capture', 15 * 60, () => require('./outlook').runOutlookCapture()),
  crm_atomise_tick: every('crm_atomise_tick', 60, () => require('./atoms').runAtomiseTick()),
  // Plans the current 14 days only and replaces the plan each time, so a missed run leaves nothing to catch up.
  crm_calendar_sync: every('crm_calendar_sync', 5 * 60, () => require('./calendar').run()),
  // Sent once a morning; a run that starts late in the day sends nothing (lib/crm/digest.js).
  crm_morning_digest: async () => {
    const { scheduleJob, hasPending } = require('../jobs');
    try { await require('./digest').run(); }
    finally { if (!hasPending('crm_morning_digest')) scheduleJob('crm_morning_digest', {}, require('./digest').nextRun(), 'self'); }
  },
  crm_whatsapp_settle: every('crm_whatsapp_settle', 60, () => require('./runs').track('whatsapp_settle', async () => require('./whatsapp').settle())),
  // A failed look-back tries again hourly; it is one-off, so nothing else would.
  crm_gmail_bootstrap: () => require('./gmail').runAllGmailBootstraps()
    .catch(err => { scheduleBootstrap(3600, 'retry'); throw err; }),
};

function seed() {
  const { scheduleJob, hasPending } = require('../jobs');
  if (!hasPending('crm_tasks_sync')) scheduleJob('crm_tasks_sync', {}, now() + 45, 'seed');
  if (!hasPending('crm_gmail_capture')) scheduleJob('crm_gmail_capture', {}, now() + 60, 'seed');
  if (!hasPending('crm_outlook_capture')) scheduleJob('crm_outlook_capture', {}, now() + 90, 'seed');
  if (!hasPending('crm_atomise_tick')) scheduleJob('crm_atomise_tick', {}, now() + 120, 'seed');
  if (!hasPending('crm_whatsapp_settle')) scheduleJob('crm_whatsapp_settle', {}, now() + 75, 'seed');
  if (!hasPending('crm_morning_digest')) scheduleJob('crm_morning_digest', {}, require('./digest').nextRun(), 'seed');
  if (!hasPending('crm_calendar_sync')) scheduleJob('crm_calendar_sync', {}, now() + 105, 'seed');
  const { setting, setSetting } = require('./db');
  if (!setting('starting_projects_done')) {
    require('./review').createProject('work', 'M365 Rollout');
    setSetting('starting_projects_done', String(now()));
  }
  require('./channels').seedOnce();
  require('./cleanup').removeNakaiReports();
  require('./promises').recheckOnce();
  scheduleBootstrap(300, 'seed');
}

// Runs once per mailbox: at first start, and again whenever a new one is connected.
function scheduleBootstrap(delay = 30, source = 'connect') {
  const { scheduleJob, hasPending } = require('../jobs');
  if (require('./gmail').bootstrapPending().length && !hasPending('crm_gmail_bootstrap')) {
    scheduleJob('crm_gmail_bootstrap', {}, now() + delay, source);
  }
}

module.exports = { handlers, seed, scheduleBootstrap };
