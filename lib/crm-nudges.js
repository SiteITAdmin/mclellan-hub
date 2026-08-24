'use strict';

/**
 * CRM nudges: last-contacted tracking, keep-warm cadence, birthdays,
 * overdue follow-ups.
 *
 * last_contacted_at is a cached column recomputed wholesale each night
 * rather than maintained by every ingestion path — one self-healing query
 * instead of four paths that can silently drift.
 *
 * Keep-warm nudges are briefing-only and never escalate; birthdays create
 * a single morning reminder per contact per year.
 */

const db = require('./db');
const { crmMeetingSql } = require('./meeting-kind');

function now() { return Math.floor(Date.now() / 1000); }

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function recomputeLastContacted(user) {
  const result = db.hub().prepare(`
    UPDATE contacts SET last_contacted_at = (
      SELECT MAX(ts) FROM (
        SELECT MAX(CAST(strftime('%s', m.meeting_date) AS INTEGER)) AS ts
        FROM meetings m JOIN meeting_attendees ma ON ma.meeting_id = m.id
        WHERE ma.contact_id = contacts.id AND m.meeting_date <= date('now')
          AND ${crmMeetingSql('m')}
        UNION ALL
        SELECT MAX(received_at) FROM email_summaries WHERE contact_id = contacts.id
        UNION ALL
        SELECT MAX(created_at) FROM crm_facts WHERE contact_id = contacts.id AND status != 'wrong'
      )
    )
    WHERE user = ?
  `).run(user);
  return result.changes;
}

// 'MM-DD' from either 'MM-DD' or 'YYYY-MM-DD'
function birthdayMonthDay(value) {
  const s = String(value || '').trim();
  const m = s.match(/(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function upcomingBirthdays(user, daysAhead = 7) {
  const contacts = db.hub().prepare(
    "SELECT id, name, birthday FROM contacts WHERE user = ? AND birthday IS NOT NULL AND birthday != ''"
  ).all(user);
  const out = [];
  for (const c of contacts) {
    const md = birthdayMonthDay(c.birthday);
    if (!md) continue;
    for (let d = 0; d <= daysAhead; d++) {
      const probe = new Date(Date.now() + d * 86400000)
        .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
      if (probe.slice(5) === md) { out.push({ ...c, inDays: d, onDate: probe }); break; }
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

function keepWarmDue(user) {
  return db.hub().prepare(`
    SELECT id, name, keep_warm_days, last_contacted_at,
      CAST((unixepoch() - COALESCE(last_contacted_at, created_at)) / 86400 AS INTEGER) AS days_since
    FROM contacts
    WHERE user = ? AND keep_warm_days IS NOT NULL AND keep_warm_days > 0
      AND COALESCE(last_contacted_at, created_at) < unixepoch() - keep_warm_days * 86400
      AND COALESCE(curation_flags, '[]') NOT LIKE '%"quiet_nudges"%'
    ORDER BY days_since DESC
  `).all(user);
}

function overdueFollowUps(user) {
  return db.hub().prepare(`
    SELECT f.id, f.fact, f.due_date, c.name AS contact_name
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status = 'follow_up'
      AND f.due_date IS NOT NULL AND f.due_date != '' AND f.due_date <= ?
    ORDER BY f.due_date ASC
  `).all(user, dublinTodayIso());
}

// Briefing sections — returns an array of lines (empty when nothing to say)
function buildNudgeLines(user) {
  const lines = [];

  const birthdays = upcomingBirthdays(user);
  if (birthdays.length) {
    lines.push('', '*Birthdays:*');
    for (const b of birthdays) {
      const when = b.inDays === 0 ? '🎂 today' : b.inDays === 1 ? 'tomorrow' : `in ${b.inDays} days`;
      lines.push(`• ${b.name} — ${when}`);
    }
  }

  const due = overdueFollowUps(user);
  if (due.length) {
    lines.push('', '*Overdue follow-ups:*');
    for (const f of due.slice(0, 8)) {
      lines.push(`• ${f.contact_name}: ${f.fact} _(due ${f.due_date})_`);
    }
  }

  const warm = keepWarmDue(user);
  if (warm.length) {
    lines.push('', '*Keep in touch:*');
    for (const c of warm.slice(0, 6)) {
      lines.push(`• ${c.name} — ${c.days_since} days since last contact (cadence ${c.keep_warm_days}d)`);
    }
  }

  return lines;
}

// Nightly job body: recompute cache, create today's birthday reminders
function runNightlyNudges(user) {
  const updated = recomputeLastContacted(user);
  console.log(`[crm-nudges] recomputed last_contacted_at for ${user} (${updated} contacts)`);

  const { createReminder, epochAtNextDublin } = require('./reminders');
  const year = dublinTodayIso().slice(0, 4);
  for (const b of upcomingBirthdays(user, 0)) {
    createReminder(user, {
      kind: 'birthday',
      targetId: b.id,
      title: `🎂 It's ${b.name}'s birthday today`,
      remindAt: epochAtNextDublin(9, 0, { allowNow: true }),
      source: 'birthday',
      dedupKey: `birthday:${b.id}:${year}`,
    });
  }
}

module.exports = {
  recomputeLastContacted,
  upcomingBirthdays,
  keepWarmDue,
  overdueFollowUps,
  buildNudgeLines,
  runNightlyNudges,
};
