'use strict';

// Synthetic build-time test for the reminder engine (CLAUDE.md Rule 3).
// Run: node test/reminders-synthetic.js — exercises migrations, create/dedup,
// fire/escalate, snooze/ack/done, overdue-task sweep, and cancel-on-resolve
// against the local dev DB, then cleans up its own rows.

process.env.TZ = process.env.TZ || 'UTC';
const assert = require('assert');
const db = require('./../lib/db');
const hub = db.hub();

const reminders = require('./../lib/reminders');
const { uuid } = require('./../lib/id');

const USER = 'douglas';
const MARK = 'synthtest-' + Date.now();
let failures = 0;

function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}: ${err.message}`); }
}

function cleanup() {
  hub.prepare("DELETE FROM reminders WHERE source LIKE 'synthtest%' OR title LIKE '%synthtest%' OR dedup_key LIKE '%synthtest%'").run();
  hub.prepare("DELETE FROM google_tasks WHERE source = ? ").run(MARK);
  hub.prepare("DELETE FROM meetings WHERE source = ?").run(MARK);
  hub.prepare("DELETE FROM system_jobs WHERE type IN ('reminder_fire') AND json_extract(payload, '$.reminderId') NOT IN (SELECT id FROM reminders)").run();
  hub.prepare("DELETE FROM crm_facts WHERE source = ?").run(MARK);
  hub.prepare("DELETE FROM contacts WHERE name = 'Synthtest Person'").run();
}

(async () => {
  console.log('1. Schema migrations');
  check('reminders table exists', () =>
    assert(hub.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reminders'").get()));
  check('suggestions table exists', () =>
    assert(hub.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='suggestions'").get()));
  check('travel_price_points table exists', () =>
    assert(hub.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='travel_price_points'").get()));
  check('crm_facts.due_date column', () =>
    assert(hub.prepare("PRAGMA table_info(crm_facts)").all().some(c => c.name === 'due_date')));
  check('contacts nudge columns', () => {
    const cols = hub.prepare("PRAGMA table_info(contacts)").all().map(c => c.name);
    for (const c of ['birthday', 'keep_warm_days', 'last_contacted_at']) assert(cols.includes(c), c);
  });

  console.log('2. Create + dedup');
  const r1 = reminders.createReminder(USER, {
    title: 'synthtest adhoc reminder', remindAt: Math.floor(Date.now() / 1000) - 10, source: 'synthtest',
  });
  check('adhoc reminder created with short code', () => assert(r1 && r1.short_code >= 1));
  check('fire job enqueued', () =>
    assert(hub.prepare("SELECT 1 FROM system_jobs WHERE type='reminder_fire' AND status='pending' AND json_extract(payload,'$.reminderId') = ?").get(r1.id)));
  const d1 = reminders.createReminder(USER, {
    title: 'synthtest dedup A', remindAt: Math.floor(Date.now() / 1000), source: 'synthtest', dedupKey: `synthtest:${MARK}`,
  });
  const d2 = reminders.createReminder(USER, {
    title: 'synthtest dedup B', remindAt: Math.floor(Date.now() / 1000), source: 'synthtest', dedupKey: `synthtest:${MARK}`,
  });
  check('dedup_key prevents duplicate', () => { assert(d1); assert.strictEqual(d2, null); });

  console.log('3. Fire + escalate (delivery falls back to webhook=unset, send is a no-op)');
  await reminders.fireReminder(r1.id);
  const fired = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(r1.id);
  const quiet = (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Dublin' })); const m = d.getHours() * 60 + d.getMinutes(); return m >= 1320 || m < 450; })();
  if (quiet) {
    check('quiet hours: fire deferred, level unchanged', () =>
      assert.strictEqual(fired.escalation_level, 0));
  } else {
    check('escalation level bumped to 1', () => assert.strictEqual(fired.escalation_level, 1));
    check('next fire ~30min out', () => {
      const gap = fired.next_fire_at - Math.floor(Date.now() / 1000);
      assert(gap > 28 * 60 && gap < 32 * 60, `gap was ${gap}s`);
    });
  }

  console.log('4. Snooze / ack / done');
  const s = reminders.snoozeReminder(USER, r1.short_code, '2h');
  const snoozed = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(r1.id);
  check('snooze sets status + ~2h next fire + level reset', () => {
    assert(s.ok);
    assert.strictEqual(snoozed.status, 'snoozed');
    assert.strictEqual(snoozed.escalation_level, 0);
    const gap = snoozed.next_fire_at - Math.floor(Date.now() / 1000);
    assert(gap > 115 * 60 && gap < 125 * 60, `gap was ${gap}s`);
  });
  const a = reminders.ackReminder(USER, r1.short_code);
  check('ack stops escalation', () => {
    assert(a.ok);
    const row = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(r1.id);
    assert.strictEqual(row.status, 'acked');
    assert.strictEqual(row.next_fire_at, null);
  });
  check('acked reminder appears in briefing lines', () =>
    assert(reminders.briefingReminderLines(USER).some(l => l.includes('synthtest adhoc'))));
  const done = await reminders.doneReminder(USER, r1.short_code);
  check('done resolves reminder', () => {
    assert(done.ok);
    assert.strictEqual(hub.prepare('SELECT status FROM reminders WHERE id = ?').get(r1.id).status, 'done');
  });

  console.log('5. Overdue task sweep (fake task, past due date)');
  const taskId = uuid();
  hub.prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, title, due, status, source, source_id)
    VALUES (?, ?, ?, 'synthtest overdue task', '2026-06-01', 'needsAction', ?, ?)
  `).run(taskId, USER, 'synthtest-gtask-' + Date.now(), MARK, MARK);
  reminders.sweepReminders(USER);
  check('sweep created exactly one overdue reminder', () =>
    assert.strictEqual(hub.prepare("SELECT COUNT(*) AS n FROM reminders WHERE dedup_key = ?").get(`task-overdue:${taskId}`).n, 1));
  reminders.sweepReminders(USER);
  check('second sweep adds nothing (idempotent)', () =>
    assert.strictEqual(hub.prepare("SELECT COUNT(*) AS n FROM reminders WHERE dedup_key = ?").get(`task-overdue:${taskId}`).n, 1));

  console.log('5b. Dependency-aware overdue reminder lifecycle');
  const deferredTaskId = uuid();
  hub.prepare(`
    INSERT INTO google_tasks (id, user, google_task_id, title, notes, due, deadline, status, source, source_id)
    VALUES (?, ?, ?, 'synthtest deferred task', '[start: 2099-10-05]', '2026-06-01', '2026-06-01T09:00', 'needsAction', ?, ?)
  `).run(deferredTaskId, USER, 'synthtest-deferred-gtask-' + Date.now(), MARK, MARK);
  const premature = reminders.createReminder(USER, {
    kind: 'task', targetId: deferredTaskId, title: 'Overdue: synthtest deferred task',
    remindAt: Math.floor(Date.now() / 1000), source: 'task-overdue', dedupKey: `task-overdue:${deferredTaskId}`,
  });
  hub.prepare("UPDATE reminders SET status = 'stale', next_fire_at = NULL WHERE id = ?").run(premature.id);
  reminders.sweepReminders(USER);
  check('future start cancels an existing false overdue reminder', () => {
    const row = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(premature.id);
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.source, 'task-overdue-deferred');
  });

  hub.prepare("UPDATE google_tasks SET notes = '[start: 2020-01-01]' WHERE id = ?").run(deferredTaskId);
  reminders.sweepReminders(USER);
  check('deferred reminder reactivates when its dependency floor has passed', () => {
    const row = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(premature.id);
    assert.strictEqual(row.status, 'scheduled');
    assert.strictEqual(row.source, 'task-overdue');
    assert(row.next_fire_at);
  });

  hub.prepare("UPDATE google_tasks SET notes = '[start: 2099-10-05]' WHERE id = ?").run(deferredTaskId);
  await reminders.fireReminder(premature.id);
  check('fire-time backstop stops a queued reminder after the floor moves', () => {
    const row = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(premature.id);
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.source, 'task-overdue-deferred');
  });

  console.log('6. Cancel-on-resolve (task completed outside the reminder loop)');
  hub.prepare("UPDATE google_tasks SET status = 'completed' WHERE id = ?").run(taskId);
  reminders.sweepReminders(USER);
  check('sweep cancelled reminder for completed task', () =>
    assert.strictEqual(hub.prepare('SELECT status FROM reminders WHERE dedup_key = ?').get(`task-overdue:${taskId}`).status, 'cancelled'));

  console.log('7. Overdue follow-up fact sweep');
  const contactId = uuid();
  hub.prepare("INSERT INTO contacts (id, user, name) VALUES (?, ?, 'Synthtest Person')").run(contactId, USER);
  const factId = uuid();
  hub.prepare(`
    INSERT INTO crm_facts (id, user, contact_id, fact, status, source, due_date)
    VALUES (?, ?, ?, 'synthtest chase the report', 'follow_up', ?, '2026-06-01')
  `).run(factId, USER, contactId, MARK);
  reminders.sweepReminders(USER);
  check('sweep created follow-up-due reminder', () => {
    const row = hub.prepare('SELECT * FROM reminders WHERE dedup_key = ?').get(`fact-due:${factId}`);
    assert(row);
    assert(row.title.includes('Synthtest Person'));
  });
  const factRem = hub.prepare('SELECT * FROM reminders WHERE dedup_key = ?').get(`fact-due:${factId}`);
  const doneFact = await reminders.doneReminder(USER, factRem.short_code);
  check('done on fact reminder closes the crm_fact', () => {
    assert(doneFact.ok);
    assert.strictEqual(hub.prepare('SELECT status FROM crm_facts WHERE id = ?').get(factId).status, 'closed');
  });

  console.log('8. Helpers');
  check('parseSnoozeDuration', () => {
    assert.strictEqual(reminders.parseSnoozeDuration('30m'), 1800);
    assert.strictEqual(reminders.parseSnoozeDuration('2h'), 7200);
    assert.strictEqual(reminders.parseSnoozeDuration('1d'), 86400);
    assert.strictEqual(reminders.parseSnoozeDuration(''), 3600);
    assert.strictEqual(reminders.parseSnoozeDuration('tomorrow'), 'tomorrow');
  });
  check('dublinIsoToEpoch resolves Dublin wall time (BST = UTC+1 in June)', () => {
    const ts = reminders.dublinIsoToEpoch('2026-06-15T17:00:00');
    assert.strictEqual(new Date(ts * 1000).toISOString(), '2026-06-15T16:00:00.000Z');
  });
  check('nextRecurOccurrence weekly lands on requested day/time', () => {
    const ts = reminders.nextRecurOccurrence('weekly:sat:09:00');
    const d = new Date(new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'Europe/Dublin' }));
    assert.strictEqual(d.getDay(), 6);
    assert.strictEqual(d.getHours(), 9);
  });

  cleanup();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll synthetic tests passed.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); cleanup(); process.exit(1); });
