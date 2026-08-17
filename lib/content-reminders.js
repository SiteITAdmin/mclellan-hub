'use strict';

/**
 * Data-aware content cadence reminders — never a dumb timer.
 *
 * Each recurring 'content' reminder has a named check (keyed by dedup prefix).
 * At fire time the check inspects real pipeline state and returns either a
 * message to send or null to skip this occurrence silently. Content reminders
 * ping once per occurrence and reschedule — they never use the escalation
 * ladder.
 */

const db = require('./db');
const { weekKeyRange } = require('./newsletter-pipeline');
const { getContentCadencePolicy } = require('./content-cadence-policy');

function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const CHECKS = {
  'content-linkedin': (user, reminder) => {
    const policy = getContentCadencePolicy(user).linkedin;
    if (!policy.enabled) return null;
    // While overdue, nudge at most every 3 days — daily nagging gets tuned out
    if (reminder?.last_fired_at && Date.now() / 1000 - reminder.last_fired_at < 3 * 86400) return null;
    const hub = db.hub();
    const last = hub.prepare(
      `SELECT MAX(CASE
         WHEN status = 'published' THEN COALESCE(
           published_at,
           CASE
             WHEN scheduled_date IS NOT NULL AND scheduled_date != ''
             THEN CAST(strftime('%s', scheduled_date || 'T12:00:00Z') AS INTEGER)
           END,
           created_at
         )
         ELSE created_at
       END) AS ts
       FROM linkedin_posts
       WHERE user = ? AND status IN ('draft', 'scheduled', 'published')`
    ).get(user)?.ts;
    const daysSince = last ? Math.floor((Date.now() / 1000 - last) / 86400) : null;
    if (daysSince !== null && daysSince < policy.cadenceDays) return null;

    const sinceText = daysSince === null
      ? 'No LinkedIn posts in the pipeline yet'
      : `${daysSince} days since your last LinkedIn post`;
    return `🖊 ${sinceText}. Reply "linkedin <topic>" to draft one now, or use the LinkedIn Plan for researched topic ideas.`;
  },

  'content-nl-midweek': (user) => {
    const policy = getContentCadencePolicy(user).newsletter;
    if (!policy.enabled) return null;
    const week = isoWeekKey();
    const range = weekKeyRange(week);
    const fromTs = Date.parse(`${range.dateFrom}T00:00:00Z`) / 1000;
    const toTs = Date.parse(`${range.dateTo}T23:59:59Z`) / 1000;
    const topics = db.hub().prepare(
      'SELECT COUNT(*) AS n FROM intel_items WHERE user = ? AND published_at BETWEEN ? AND ? AND selected = 1'
    ).get(user, fromTs, toTs);
    if (topics.n >= policy.minTopics) return null;
    return `📰 Newsletter topics are thin for Saturday — ${topics.n} captured so far this week (aim for ${policy.minTopics}+). Forward interesting emails or they'll be picked up automatically.`;
  },
};

// Reminder rows carry the check name as the dedup_key prefix
function checkNameFor(reminder) {
  const key = String(reminder.dedup_key || '');
  return Object.keys(CHECKS).find(name => key.startsWith(name + ':')) || null;
}

// Returns { skip: true } or { message } — only for kind='content' reminders
function evaluateCheck(reminder) {
  const name = checkNameFor(reminder);
  if (!name) return { message: null };
  try {
    const message = CHECKS[name](reminder.user, reminder);
    return message ? { message } : { skip: true };
  } catch (err) {
    console.warn(`[content-reminders] check ${name} failed:`, err.message);
    return { skip: true };
  }
}

// Google Chat delivery never worked. Do not create Chat-bound cadence pings.
function seedContentReminders(user) {
  const { syncRecurringReminder } = require('./reminders');
  for (const key of [`content-linkedin:${user}`, `content-nl-midweek:${user}`]) {
    syncRecurringReminder(user, key, { enabled: false });
  }
}

module.exports = { evaluateCheck, seedContentReminders, CHECKS };
