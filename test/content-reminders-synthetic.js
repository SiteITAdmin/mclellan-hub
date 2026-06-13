'use strict';

// Synthetic build-time test for content cadence reminders (CLAUDE.md Rule 3).
// Run: node test/content-reminders-synthetic.js

const assert = require('assert');
const db = require('./../lib/db');
const hub = db.hub();
const reminders = require('./../lib/reminders');
const content = require('./../lib/content-reminders');
const { uuid } = require('./../lib/id');

const USER = 'douglas';
let failures = 0;
const fakeTopicIds = [];
const fakeDocumentIds = [];

function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}: ${err.message}`); }
}

function cleanup() {
  hub.prepare("DELETE FROM reminders WHERE kind = 'content' AND user = ?").run(USER);
  for (const id of fakeTopicIds) hub.prepare('DELETE FROM intel_items WHERE id = ?').run(id);
  for (const id of fakeDocumentIds) hub.prepare('DELETE FROM intel_documents WHERE id = ?').run(id);
  hub.prepare("DELETE FROM system_jobs WHERE type = 'reminder_fire' AND json_extract(payload, '$.reminderId') NOT IN (SELECT id FROM reminders)").run();
}

(async () => {
  console.log('1. Seeding is idempotent');
  content.seedContentReminders(USER);
  content.seedContentReminders(USER);
  const seeded = hub.prepare("SELECT * FROM reminders WHERE kind = 'content' AND user = ? ORDER BY dedup_key").all(USER);
  check('exactly 2 content reminders after double seed', () => assert.strictEqual(seeded.length, 2));
  check('both have recur specs and future fire times', () => {
    for (const r of seeded) {
      assert(r.recur, 'recur missing');
      assert(r.next_fire_at > Math.floor(Date.now() / 1000), 'fire time not future');
    }
  });

  const liRem = seeded.find(r => r.dedup_key.startsWith('content-linkedin'));
  const nlRem = seeded.find(r => r.dedup_key.startsWith('content-nl-midweek'));

  console.log('2. LinkedIn check (linkedin_posts is empty locally → overdue message)');
  const liResult = content.evaluateCheck(liRem);
  check('overdue message produced', () =>
    assert(liResult.message && liResult.message.includes('LinkedIn'), JSON.stringify(liResult)));

  console.log('3. Fire → single ping, reschedule to next occurrence, no escalation');
  hub.prepare('UPDATE reminders SET next_fire_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 5, liRem.id);
  await reminders.fireReminder(liRem.id);
  const afterFire = hub.prepare('SELECT * FROM reminders WHERE id = ?').get(liRem.id);
  const quiet = (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Dublin' })); const m = d.getHours() * 60 + d.getMinutes(); return m >= 1320 || m < 450; })();
  if (quiet) {
    check('quiet hours: content fire deferred', () => assert(afterFire.next_fire_at > Math.floor(Date.now() / 1000)));
  } else {
    check('ping recorded, escalation stays 0, rescheduled to next 10:00', () => {
      assert(afterFire.last_fired_at, 'last_fired_at not set');
      assert.strictEqual(afterFire.escalation_level, 0);
      assert.strictEqual(afterFire.status, 'scheduled');
      assert(afterFire.next_fire_at > Math.floor(Date.now() / 1000));
    });
    check('3-day throttle: immediate re-check skips', () => {
      const again = content.evaluateCheck(afterFire);
      assert.strictEqual(again.skip, true, JSON.stringify(again));
    });
  }

  console.log('4. Newsletter midweek check responds to topic count');
  const week = (() => {
    const d = new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const ys = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - ys) / 86400000 + 1) / 7)).padStart(2, '0')}`;
  })();
  const range = require('../lib/newsletter-pipeline').weekKeyRange(week);
  const fromTs = Date.parse(`${range.dateFrom}T00:00:00Z`) / 1000;
  const toTs = Date.parse(`${range.dateTo}T23:59:59Z`) / 1000;
  const existing = hub.prepare('SELECT COUNT(*) AS n FROM intel_items WHERE user = ? AND published_at BETWEEN ? AND ? AND selected = 1').get(USER, fromTs, toTs).n;
  const needed = Math.max(0, 3 - existing);
  for (let i = 0; i < needed; i++) {
    const documentId = uuid();
    hub.prepare(`
      INSERT INTO intel_documents
        (id, user, external_id, source_kind, title, published_at, content_text)
      VALUES (?, ?, ?, 'test', ?, ?, ?)
    `).run(documentId, USER, `synthtest-${documentId}`, `synthtest document ${i}`, fromTs + i, 'test');
    fakeDocumentIds.push(documentId);
    const id = uuid();
    hub.prepare(`
      INSERT INTO intel_items
        (id, user, document_id, title, content_text, published_at, selected)
      VALUES (?, ?, ?, ?, 'test', ?, 1)
    `).run(id, USER, documentId, `synthtest topic ${i}`, fromTs + i);
    fakeTopicIds.push(id);
  }
  check('healthy week (≥3 topics) → skip', () =>
    assert.strictEqual(content.evaluateCheck(nlRem).skip, true));
  for (const id of fakeTopicIds) hub.prepare('DELETE FROM intel_items WHERE id = ?').run(id);
  for (const id of fakeDocumentIds) hub.prepare('DELETE FROM intel_documents WHERE id = ?').run(id);
  fakeTopicIds.length = 0;
  fakeDocumentIds.length = 0;
  if (existing < 3) {
    check('thin week → nudge message with count', () => {
      const r = content.evaluateCheck(nlRem);
      assert(r.message && r.message.includes('thin'), JSON.stringify(r));
    });
  } else {
    console.log('  (skipped thin-week assertion — real data already has ≥3 topics)');
  }

  cleanup();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll content reminder tests passed.');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); cleanup(); process.exit(1); });
