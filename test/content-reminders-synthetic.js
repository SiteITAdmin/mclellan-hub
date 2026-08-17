'use strict';

// Content cadence checks still exist as evaluators. Chat-bound reminder
// rows must not be created.

const assert = require('assert');
const db = require('./../lib/db');
const hub = db.hub();
const reminders = require('./../lib/reminders');
const content = require('./../lib/content-reminders');
const { setContentCadencePolicy } = require('./../lib/content-cadence-policy');
const { uuid } = require('./../lib/id');

const USER = 'douglas';
let failures = 0;
const fakePostIds = [];

function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}: ${err.message}`); }
}

function cleanup() {
  hub.prepare("DELETE FROM reminders WHERE kind = 'content' AND user = ?").run(USER);
  hub.prepare("DELETE FROM crm_context WHERE user = ? AND key = 'content_cadence_policy'").run(USER);
  for (const id of fakePostIds) hub.prepare('DELETE FROM linkedin_posts WHERE id = ?').run(id);
  hub.prepare("DELETE FROM system_jobs WHERE type = 'reminder_fire' AND json_extract(payload, '$.reminderId') NOT IN (SELECT id FROM reminders)").run();
}

(async () => {
  cleanup();
  setContentCadencePolicy(USER, {
    linkedin: { enabled: true, cadenceDays: 7, recur: 'daily:10:00' },
    newsletter: { enabled: true, minTopics: 3, recur: 'weekly:wed:10:00' },
  });

  console.log('1. Seed does not create Chat cadence reminders');
  content.seedContentReminders(USER);
  content.seedContentReminders(USER);
  const seeded = hub.prepare("SELECT * FROM reminders WHERE kind = 'content' AND user = ?").all(USER);
  check('no content reminder rows after seed', () => assert.strictEqual(seeded.length, 0));

  console.log('2. Leftover Chat cadence rows are cancelled');
  const leftover = reminders.createReminder(USER, {
    kind: 'content',
    title: 'LinkedIn posting cadence',
    remindAt: Math.floor(Date.now() / 1000) - 60,
    source: 'content-cadence',
    dedupKey: `content-linkedin:${USER}`,
    recur: 'daily:10:00',
  });
  content.seedContentReminders(USER);
  check('seed cancels leftover LinkedIn cadence row', () => {
    const row = hub.prepare('SELECT status, next_fire_at FROM reminders WHERE dedup_key = ?').get(`content-linkedin:${USER}`);
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.next_fire_at, null);
  });
  await reminders.fireReminder(leftover.id);
  check('fire of a leftover content reminder stays cancelled', () => {
    const row = hub.prepare('SELECT status FROM reminders WHERE id = ?').get(leftover.id);
    assert.strictEqual(row.status, 'cancelled');
  });

  console.log('3. Evaluator still reports LinkedIn cadence without sending Chat');
  const fakeRem = { user: USER, dedup_key: `content-linkedin:${USER}`, last_fired_at: null };
  const overdue = content.evaluateCheck(fakeRem);
  check('overdue message produced', () =>
    assert(overdue.message && overdue.message.includes('LinkedIn'), JSON.stringify(overdue)));
  const postId = uuid();
  fakePostIds.push(postId);
  hub.prepare(`
    INSERT INTO linkedin_posts (id, user, topic, status, published_at)
    VALUES (?, ?, 'synthtest published cadence post', 'published', unixepoch())
  `).run(postId, USER);
  check('published post makes LinkedIn cadence healthy', () =>
    assert.strictEqual(content.evaluateCheck(fakeRem).skip, true));

  cleanup();
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll content-reminder checks passed');
})().catch(err => {
  cleanup();
  console.error(err);
  process.exit(1);
});
