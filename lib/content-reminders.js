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

const LINKEDIN_CADENCE_DAYS = parseInt(process.env.LINKEDIN_CADENCE_DAYS || '7');
const NL_MIN_TOPICS = parseInt(process.env.NL_MIN_TOPICS || '3');

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
    // While overdue, nudge at most every 3 days — daily nagging gets tuned out
    if (reminder?.last_fired_at && Date.now() / 1000 - reminder.last_fired_at < 3 * 86400) return null;
    const hub = db.hub();
    const last = hub.prepare(
      'SELECT MAX(created_at) AS ts FROM linkedin_posts WHERE user = ?'
    ).get(user)?.ts;
    const daysSince = last ? Math.floor((Date.now() / 1000 - last) / 86400) : null;
    if (daysSince !== null && daysSince < LINKEDIN_CADENCE_DAYS) return null;

    const suggestions = hub.prepare(`
      SELECT short_code, title FROM suggestions
      WHERE user = ? AND domain = 'content' AND status = 'open'
      ORDER BY created_at DESC LIMIT 2
    `).all(user);
    const sinceText = daysSince === null
      ? 'No LinkedIn posts in the pipeline yet'
      : `${daysSince} days since your last LinkedIn post`;
    const suggestText = suggestions.length
      ? '\n' + suggestions.map(s => `💡 Suggestion #${s.short_code}: ${s.title}`).join('\n')
      : '';
    return `🖊 ${sinceText}. Reply "linkedin <topic>" to draft one now.${suggestText}`;
  },

  'content-nl-midweek': (user) => {
    const week = isoWeekKey();
    const range = weekKeyRange(week);
    const fromTs = Date.parse(`${range.dateFrom}T00:00:00Z`) / 1000;
    const toTs = Date.parse(`${range.dateTo}T23:59:59Z`) / 1000;
    const topics = db.hub().prepare(
      'SELECT COUNT(*) AS n FROM intel_items WHERE user = ? AND published_at BETWEEN ? AND ? AND selected = 1'
    ).get(user, fromTs, toTs);
    if (topics.n >= NL_MIN_TOPICS) return null;
    return `📰 Newsletter topics are thin for Saturday — ${topics.n} captured so far this week (aim for ${NL_MIN_TOPICS}+). Forward interesting emails or they'll be picked up automatically.`;
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

// Idempotent — called from the reminder sweep
function seedContentReminders(user) {
  const { createReminder, nextRecurOccurrence } = require('./reminders');
  const seeds = [
    { key: `content-linkedin:${user}`, title: 'LinkedIn posting cadence', recur: 'daily:10:00' },
    { key: `content-nl-midweek:${user}`, title: 'Newsletter topic health', recur: 'weekly:wed:10:00' },
  ];
  for (const seed of seeds) {
    createReminder(user, {
      kind: 'content',
      title: seed.title,
      remindAt: nextRecurOccurrence(seed.recur),
      source: 'content-cadence',
      dedupKey: seed.key,
      recur: seed.recur,
    });
  }
}

module.exports = { evaluateCheck, seedContentReminders, CHECKS };
