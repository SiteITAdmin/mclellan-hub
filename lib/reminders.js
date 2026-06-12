'use strict';

/**
 * Escalating reminders, delivered via Google Chat.
 *
 * The reminders table is the source of truth; system_jobs entries are only
 * wake-ups that re-check row state before acting (same pattern as
 * flight_refresh). Snooze/ack are therefore pure row updates.
 *
 * Escalation ladder: fire at remind_at, then +30min, +3h, +24h, then stop —
 * status 'stale', surfaced only in the morning briefing. Four pings maximum.
 * Quiet hours 22:00–07:30 Europe/Dublin defer fires to 07:35.
 */

const db = require('./db');
const { uuid } = require('./id');
const { scheduleJob } = require('./job-queue');
const { postToGoogleChatSpace } = require('./google-chat');

const ESCALATION_OFFSETS = [30 * 60, 3 * 3600, 24 * 3600]; // gaps after fires 1, 2, 3
const MAX_FIRES = ESCALATION_OFFSETS.length + 1;
const TERMINAL = ['done', 'cancelled'];

function now() { return Math.floor(Date.now() / 1000); }

function dublinParts(ms = Date.now()) {
  const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
  return { hours: d.getHours(), minutes: d.getMinutes(), day: d.getDay() };
}

function inQuietHours(ms = Date.now()) {
  const { hours, minutes } = dublinParts(ms);
  const mins = hours * 60 + minutes;
  return mins >= 22 * 60 || mins < 7 * 60 + 30;
}

// Epoch of the next time the Dublin wall clock reads hh:mm (minute-walk: DST-safe)
function epochAtNextDublin(hour, minute, { allowNow = false } = {}) {
  const nowMs = Date.now();
  for (let m = allowNow ? 0 : 1; m <= 24 * 60; m++) {
    const probe = nowMs + m * 60000;
    const { hours, minutes } = dublinParts(probe);
    if (hours === hour && minutes === minute) return Math.floor(probe / 60000) * 60;
  }
  return Math.floor(nowMs / 1000) + 3600;
}

// Parse an ISO datetime; a string without a zone offset is Dublin wall time
function dublinIsoToEpoch(iso) {
  if (!iso) return null;
  const s = String(iso).trim();
  if (/(?:[+-]\d{2}:?\d{2}|Z)$/.test(s)) {
    const t = new Date(s).getTime();
    return isNaN(t) ? null : Math.floor(t / 1000);
  }
  const asUtc = new Date(s.length === 10 ? `${s}T09:00:00Z` : `${s}Z`);
  if (isNaN(asUtc.getTime())) return null;
  const wall = new Date(asUtc.toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
  const utcWall = new Date(asUtc.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.floor((asUtc.getTime() - (wall.getTime() - utcWall.getTime())) / 1000);
}

// Recurrence spec: 'daily:HH:MM' or 'weekly:mon..sun:HH:MM'
function nextRecurOccurrence(spec) {
  const parts = String(spec || '').split(':');
  if (parts[0] === 'daily' && parts.length >= 3) {
    return epochAtNextDublin(parseInt(parts[1], 10), parseInt(parts[2], 10));
  }
  if (parts[0] === 'weekly' && parts.length >= 4) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wantDay = days.indexOf(parts[1].toLowerCase());
    const hour = parseInt(parts[2], 10);
    const minute = parseInt(parts[3], 10);
    if (wantDay < 0) return null;
    const nowMs = Date.now();
    for (let m = 1; m <= 8 * 24 * 60; m++) {
      const probe = nowMs + m * 60000;
      const { hours, minutes, day } = dublinParts(probe);
      if (day === wantDay && hours === hour && minutes === minute) return Math.floor(probe / 60000) * 60;
    }
  }
  return null;
}

// ── Delivery ──────────────────────────────────────────────────────────────────

async function deliverChat(user, text) {
  const space = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_hermes_space'"
  ).get(user)?.value;
  if (space) {
    const ok = await postToGoogleChatSpace(space, text);
    if (ok) { console.log(`[reminders] delivered via hermes space for ${user}`); return true; }
  }
  const { pushGoogleChatBriefing } = require('./crm');
  const ok = await pushGoogleChatBriefing(user, text);
  console.log(`[reminders] delivered via webhook for ${user}: ${ok}`);
  return ok;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function nextShortCode(user) {
  const row = db.hub().prepare(
    "SELECT MAX(short_code) AS max FROM reminders WHERE user = ? AND status NOT IN ('done','cancelled')"
  ).get(user);
  return (row?.max || 0) + 1;
}

function createReminder(user, { kind = 'adhoc', targetId = null, title, remindAt, source = 'manual', dedupKey = null, recur = null }) {
  if (!title || !remindAt) return null;
  const hub = db.hub();
  const id = uuid();
  const ts = Math.floor(remindAt);
  const code = nextShortCode(user);
  const result = hub.prepare(`
    INSERT OR IGNORE INTO reminders
      (id, user, kind, target_id, title, remind_at, next_fire_at, status, short_code, dedup_key, recur, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)
  `).run(id, user, kind, targetId, String(title).slice(0, 300), ts, ts, code, dedupKey, recur, source);
  if (!result.changes) return null; // dedup_key already present
  scheduleJob('reminder_fire', { reminderId: id }, ts, 'reminder');
  return hub.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
}

function listOpenReminders(user) {
  return db.hub().prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND status NOT IN ('done','cancelled')
    ORDER BY COALESCE(next_fire_at, remind_at) ASC
  `).all(user);
}

function findByShortCode(user, code) {
  return db.hub().prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND short_code = ? AND status NOT IN ('done','cancelled')
    ORDER BY created_at DESC LIMIT 1
  `).get(user, parseInt(code, 10));
}

function touch(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  db.hub().prepare(`UPDATE reminders SET ${sets}, updated_at = unixepoch() WHERE id = ?`)
    .run(...Object.values(fields), id);
}

function ackReminder(user, code) {
  const r = findByShortCode(user, code);
  if (!r) return { ok: false, message: `No open reminder #${code}.` };
  touch(r.id, { status: 'acked', next_fire_at: null });
  return { ok: true, message: `👍 #${r.short_code} acknowledged — no more pings. It stays in your morning briefing until done.` };
}

function snoozeReminder(user, code, durationText) {
  const r = findByShortCode(user, code);
  if (!r) return { ok: false, message: `No open reminder #${code}.` };
  const secs = parseSnoozeDuration(durationText);
  const until = secs === 'tomorrow' ? epochAtNextDublin(9, 0) : now() + secs;
  // A snooze is a deliberate ack — restart the ladder gently from the new time
  touch(r.id, { status: 'snoozed', next_fire_at: until, escalation_level: 0 });
  scheduleJob('reminder_fire', { reminderId: r.id }, until, 'reminder');
  const when = new Date(until * 1000).toLocaleString('en-GB', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  });
  return { ok: true, message: `😴 #${r.short_code} snoozed until ${when}.` };
}

function parseSnoozeDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return 3600;
  if (t === 'tomorrow') return 'tomorrow';
  const m = t.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (!m) return 3600;
  const n = parseInt(m[1], 10);
  if (m[2].startsWith('m')) return n * 60;
  if (m[2].startsWith('h')) return n * 3600;
  return n * 86400;
}

async function doneReminder(user, code) {
  const r = findByShortCode(user, code);
  if (!r) return { ok: false, message: `No open reminder #${code}.` };
  touch(r.id, { status: 'done', next_fire_at: null });
  let extra = '';

  if (r.kind === 'task' && r.target_id) {
    const task = db.hub().prepare('SELECT * FROM google_tasks WHERE id = ?').get(r.target_id);
    if (task && task.status !== 'completed' && !task.deleted_at) {
      try {
        const { completeTask } = require('./google-tasks');
        await completeTask(user, task.google_task_id);
        extra = ` Task "${task.title}" completed.`;
      } catch (err) {
        extra = ` (Could not complete the linked task: ${err.message})`;
      }
    }
  }
  if (r.kind === 'fact' && r.target_id) {
    db.hub().prepare(`
      UPDATE crm_facts SET status = CASE WHEN status = 'follow_up' THEN 'closed' ELSE 'done' END,
        updated_at = unixepoch()
      WHERE id = ? AND user = ? AND status IN ('active','follow_up')
    `).run(r.target_id, user);
    extra = ' Linked CRM item closed.';
  }
  if (r.recur) {
    const next = nextRecurOccurrence(r.recur);
    if (next) {
      touch(r.id, { status: 'scheduled', remind_at: next, next_fire_at: next, escalation_level: 0 });
      scheduleJob('reminder_fire', { reminderId: r.id }, next, 'reminder');
      extra += ' (Recurring — rescheduled.)';
    }
  }
  return { ok: true, message: `✅ #${r.short_code} done: ${r.title}.${extra}` };
}

function cancelReminder(user, code) {
  const r = findByShortCode(user, code);
  if (!r) return { ok: false, message: `No open reminder #${code}.` };
  touch(r.id, { status: 'cancelled', next_fire_at: null });
  return { ok: true, message: `🗑 #${r.short_code} cancelled: ${r.title}` };
}

// ── Firing ────────────────────────────────────────────────────────────────────

function fireMessage(r) {
  const n = r.short_code;
  const openers = [
    `🔔 Reminder #${n} — ${r.title}`,
    `⏰ Still open #${n} — ${r.title}`,
    `🔴 Third nudge #${n} — ${r.title}`,
    `⚠️ Last ping #${n} — ${r.title} — moving this to your morning briefing.`,
  ];
  const opener = openers[Math.min(r.escalation_level, openers.length - 1)];
  return `${opener}\nReply: done ${n} · snooze ${n} 2h · ok ${n}`;
}

async function fireReminder(reminderId) {
  const hub = db.hub();
  const r = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId);
  if (!r) return;
  if (TERMINAL.includes(r.status) || r.status === 'acked' || r.status === 'stale') return;

  // Snoozed or rescheduled since this job was enqueued — wake up at the new time
  if (r.next_fire_at && r.next_fire_at > now() + 30) {
    scheduleJob('reminder_fire', { reminderId: r.id }, r.next_fire_at, 'reminder');
    return;
  }

  if (inQuietHours()) {
    const deferTo = epochAtNextDublin(7, 35);
    touch(r.id, { next_fire_at: deferTo });
    scheduleJob('reminder_fire', { reminderId: r.id }, deferTo, 'reminder');
    console.log(`[reminders] #${r.short_code} deferred past quiet hours`);
    return;
  }

  // Content cadence reminders consult real pipeline state: ping once per
  // occurrence (or skip silently when healthy), then reschedule — no ladder
  if (r.kind === 'content' && r.recur) {
    const { evaluateCheck } = require('./content-reminders');
    const result = evaluateCheck(r);
    const next = nextRecurOccurrence(r.recur);
    if (!result.skip && result.message) {
      await deliverChat(r.user, result.message);
      touch(r.id, { last_fired_at: now() });
      console.log(`[reminders] content nudge sent: ${r.dedup_key}`);
    }
    if (next) {
      touch(r.id, { status: 'scheduled', remind_at: next, next_fire_at: next, escalation_level: 0 });
      scheduleJob('reminder_fire', { reminderId: r.id }, next, 'reminder');
    } else {
      touch(r.id, { status: 'stale', next_fire_at: null });
    }
    return;
  }

  await deliverChat(r.user, fireMessage(r));

  const fired = r.escalation_level + 1;
  if (fired >= MAX_FIRES) {
    if (r.recur) {
      const next = nextRecurOccurrence(r.recur);
      if (next) {
        touch(r.id, { status: 'scheduled', remind_at: next, next_fire_at: next, escalation_level: 0, last_fired_at: now() });
        scheduleJob('reminder_fire', { reminderId: r.id }, next, 'reminder');
        return;
      }
    }
    touch(r.id, { status: 'stale', next_fire_at: null, escalation_level: fired, last_fired_at: now() });
    return;
  }
  const nextAt = now() + ESCALATION_OFFSETS[r.escalation_level];
  touch(r.id, { status: 'scheduled', next_fire_at: nextAt, escalation_level: fired, last_fired_at: now() });
  scheduleJob('reminder_fire', { reminderId: r.id }, nextAt, 'reminder');
}

// ── Sweep (every 15 min, idempotent) ──────────────────────────────────────────

function dublinTodayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function sweepReminders(user) {
  const hub = db.hub();

  // 0. Ensure the recurring content cadence reminders exist (INSERT OR IGNORE)
  try {
    require('./content-reminders').seedContentReminders(user);
  } catch (err) {
    console.warn('[reminders] content seed failed:', err.message);
  }

  // 1. Overdue open tasks → auto-escalating reminder (one per task, ever)
  const today = dublinTodayIso();
  const nowLocal = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Dublin' }).slice(0, 16).replace(' ', 'T');
  const overdue = hub.prepare(`
    SELECT * FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL AND parent_id IS NULL
      AND ((deadline IS NOT NULL AND deadline != '' AND deadline < ?)
        OR ((deadline IS NULL OR deadline = '') AND due IS NOT NULL AND due != '' AND substr(due, 1, 10) < ?))
  `).all(user, nowLocal, today);
  for (const task of overdue) {
    const { hours, minutes } = dublinParts();
    const beforeNine = hours < 9 || (hours === 9 && minutes === 0);
    const remindAt = beforeNine ? epochAtNextDublin(9, 0, { allowNow: true }) : now();
    createReminder(user, {
      kind: 'task',
      targetId: task.id,
      title: `Overdue: ${task.title}`,
      remindAt,
      source: 'task-overdue',
      dedupKey: `task-overdue:${task.id}`,
    });
  }

  // 2. Crash recovery: live reminders due within 20 min but with no pending job
  const live = hub.prepare(`
    SELECT r.* FROM reminders r
    WHERE r.user = ? AND r.status IN ('scheduled','snoozed')
      AND r.next_fire_at IS NOT NULL AND r.next_fire_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM system_jobs j
        WHERE j.type = 'reminder_fire' AND j.status IN ('pending','running')
          AND json_extract(j.payload, '$.reminderId') = r.id
      )
  `).all(user, now() + 20 * 60);
  for (const r of live) {
    scheduleJob('reminder_fire', { reminderId: r.id }, Math.max(r.next_fire_at, now() + 5), 'reminder-sweep');
  }

  // 3. Escalation must never outlive the work: cancel reminders whose target resolved elsewhere
  const cancelTask = hub.prepare(`
    UPDATE reminders SET status = 'cancelled', next_fire_at = NULL, updated_at = unixepoch()
    WHERE user = ? AND kind = 'task' AND status NOT IN ('done','cancelled')
      AND target_id IN (
        SELECT id FROM google_tasks WHERE user = ? AND (status = 'completed' OR deleted_at IS NOT NULL)
      )
  `).run(user, user);
  const cancelFact = hub.prepare(`
    UPDATE reminders SET status = 'cancelled', next_fire_at = NULL, updated_at = unixepoch()
    WHERE user = ? AND kind = 'fact' AND status NOT IN ('done','cancelled')
      AND target_id IN (
        SELECT id FROM crm_facts WHERE user = ? AND status IN ('done','closed','archived','wrong')
      )
  `).run(user, user);
  if (cancelTask.changes || cancelFact.changes) {
    console.log(`[reminders] sweep cancelled ${cancelTask.changes + cancelFact.changes} resolved reminder(s) for ${user}`);
  }

  // 4. Overdue follow-up facts with a due date → reminder (Phase 2)
  const dueFacts = hub.prepare(`
    SELECT f.*, c.name AS contact_name FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status = 'follow_up' AND f.due_date IS NOT NULL AND f.due_date != ''
      AND f.due_date <= ?
  `).all(user, today);
  for (const fact of dueFacts) {
    const { hours } = dublinParts();
    const remindAt = hours < 9 ? epochAtNextDublin(9, 0, { allowNow: true }) : now();
    createReminder(user, {
      kind: 'fact',
      targetId: fact.id,
      title: `Follow up with ${fact.contact_name}: ${fact.fact}`,
      remindAt,
      source: 'fact-due',
      dedupKey: `fact-due:${fact.id}`,
    });
  }
}

// Stale + acked reminders for the morning briefing
function briefingReminderLines(user) {
  const rows = db.hub().prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND status IN ('stale','acked')
    ORDER BY remind_at ASC LIMIT 10
  `).all(user);
  return rows.map(r => `• #${r.short_code} ${r.title} _(reply "done ${r.short_code}" when finished)_`);
}

module.exports = {
  createReminder,
  listOpenReminders,
  findByShortCode,
  ackReminder,
  snoozeReminder,
  doneReminder,
  cancelReminder,
  fireReminder,
  sweepReminders,
  deliverChat,
  briefingReminderLines,
  parseSnoozeDuration,
  epochAtNextDublin,
  nextRecurOccurrence,
  dublinIsoToEpoch,
};
