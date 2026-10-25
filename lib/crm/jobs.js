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
  crm_tasks_sync: every('crm_tasks_sync', 15 * 60, () => require('./tasks-sync').run()),
  crm_gmail_capture: every('crm_gmail_capture', 15 * 60, () => require('./gmail').runGmailCapture()),
  crm_outlook_capture: every('crm_outlook_capture', 15 * 60, () => require('./outlook').runOutlookCapture()),
  crm_atomise_tick: every('crm_atomise_tick', 60, () => require('./atoms').runAtomiseTick()),
  crm_gmail_bootstrap: () => require('./gmail').runGmailBootstrap(),
};

function seed() {
  const { scheduleJob, hasPending } = require('../jobs');
  if (!hasPending('crm_tasks_sync')) scheduleJob('crm_tasks_sync', {}, now() + 45, 'seed');
  if (!hasPending('crm_gmail_capture')) scheduleJob('crm_gmail_capture', {}, now() + 60, 'seed');
  if (!hasPending('crm_outlook_capture')) scheduleJob('crm_outlook_capture', {}, now() + 90, 'seed');
  if (!hasPending('crm_atomise_tick')) scheduleJob('crm_atomise_tick', {}, now() + 120, 'seed');
  const { setting, setSetting } = require('./db');
  if (!setting('starting_projects_done')) {
    require('./review').createProject('work', 'M365 Rollout');
    setSetting('starting_projects_done', String(now()));
  }
  if (!setting('gmail_bootstrap_done') && !hasPending('crm_gmail_bootstrap')) scheduleJob('crm_gmail_bootstrap', {}, now() + 300, 'seed');
}

module.exports = { handlers, seed };
