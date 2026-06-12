'use strict';

// Synthetic build-time test for CRM nudges (CLAUDE.md Rule 3).
// Run: node test/nudges-synthetic.js

const assert = require('assert');
const db = require('./../lib/db');
const hub = db.hub();
const nudges = require('./../lib/crm-nudges');
const { uuid } = require('./../lib/id');

const USER = 'douglas';
let failures = 0;
const ids = { contacts: [], meetings: [], facts: [], emails: [] };

function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (err) { failures++; console.error(`  ❌ ${label}: ${err.message}`); }
}

function cleanup() {
  for (const id of ids.facts) hub.prepare('DELETE FROM crm_facts WHERE id = ?').run(id);
  for (const id of ids.emails) hub.prepare('DELETE FROM email_summaries WHERE id = ?').run(id);
  for (const id of ids.meetings) {
    hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(id);
    hub.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  }
  for (const id of ids.contacts) {
    hub.prepare('DELETE FROM reminders WHERE target_id = ?').run(id);
    hub.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  }
  hub.prepare("DELETE FROM system_jobs WHERE type = 'reminder_fire' AND json_extract(payload, '$.reminderId') NOT IN (SELECT id FROM reminders)").run();
}

function mkContact(name, extra = {}) {
  const id = uuid();
  hub.prepare('INSERT INTO contacts (id, user, name, birthday, keep_warm_days) VALUES (?, ?, ?, ?, ?)')
    .run(id, USER, name, extra.birthday || null, extra.keepWarmDays || null);
  ids.contacts.push(id);
  return id;
}

(() => {
  const now = Math.floor(Date.now() / 1000);
  const dublinToday = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });

  console.log('1. last_contacted_at recompute');
  const cMeeting = mkContact('Synthnudge Meeting Person');
  const meetingId = uuid();
  hub.prepare("INSERT INTO meetings (id, user, title, meeting_date, source) VALUES (?, ?, 'Synthnudge mtg', '2026-06-01', 'manual')")
    .run(meetingId, USER);
  hub.prepare('INSERT INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)').run(meetingId, cMeeting);
  ids.meetings.push(meetingId);

  const cEmail = mkContact('Synthnudge Email Person');
  const emailId = uuid();
  hub.prepare("INSERT INTO email_summaries (id, user, gmail_message_id, received_at, contact_id) VALUES (?, ?, ?, ?, ?)")
    .run(emailId, USER, 'synthnudge-' + Date.now(), now - 5 * 86400, cEmail);
  ids.emails.push(emailId);

  const cNever = mkContact('Synthnudge Never Contacted');

  nudges.recomputeLastContacted(USER);
  const lcMeeting = hub.prepare('SELECT last_contacted_at FROM contacts WHERE id = ?').get(cMeeting).last_contacted_at;
  const lcEmail = hub.prepare('SELECT last_contacted_at FROM contacts WHERE id = ?').get(cEmail).last_contacted_at;
  const lcNever = hub.prepare('SELECT last_contacted_at FROM contacts WHERE id = ?').get(cNever).last_contacted_at;
  check('meeting attendee got last_contacted_at = meeting date', () => {
    assert(lcMeeting, 'null');
    assert.strictEqual(new Date(lcMeeting * 1000).toISOString().slice(0, 10), '2026-06-01');
  });
  check('email contact got last_contacted_at ≈ 5 days ago', () => {
    assert(lcEmail);
    assert(Math.abs(lcEmail - (now - 5 * 86400)) < 60);
  });
  check('never-contacted contact stays NULL', () => assert.strictEqual(lcNever, null));

  console.log('2. Keep-warm cadence');
  hub.prepare('UPDATE contacts SET keep_warm_days = 30 WHERE id = ?').run(cMeeting); // last contact 2026-06-01, 11 days ago — not due
  const cCold = mkContact('Synthnudge Cold Person', { keepWarmDays: 30 });
  const coldEmailId = uuid();
  hub.prepare('INSERT INTO email_summaries (id, user, gmail_message_id, received_at, contact_id) VALUES (?, ?, ?, ?, ?)')
    .run(coldEmailId, USER, 'synthnudge-cold-' + Date.now(), now - 45 * 86400, cCold);
  ids.emails.push(coldEmailId);
  nudges.recomputeLastContacted(USER);
  const warm = nudges.keepWarmDue(USER);
  check('45-days-cold contact is due, 11-days one is not', () => {
    assert(warm.some(c => c.id === cCold));
    assert(!warm.some(c => c.id === cMeeting));
    const cold = warm.find(c => c.id === cCold);
    assert(cold.days_since >= 44 && cold.days_since <= 46, `days_since=${cold.days_since}`);
  });

  console.log('3. Birthdays');
  const todayMd = dublinToday.slice(5);
  const inThreeMd = new Date(Date.now() + 3 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' }).slice(5);
  const cBdayToday = mkContact('Synthnudge Birthday Today', { birthday: `1990-${todayMd}` });
  const cBdaySoon = mkContact('Synthnudge Birthday Soon', { birthday: inThreeMd });
  const bdays = nudges.upcomingBirthdays(USER);
  check('today + in-3-days birthdays found (both date formats)', () => {
    assert.strictEqual(bdays.find(b => b.id === cBdayToday)?.inDays, 0);
    assert.strictEqual(bdays.find(b => b.id === cBdaySoon)?.inDays, 3);
  });

  console.log('4. Nightly run creates birthday reminder (deduped per year)');
  nudges.runNightlyNudges(USER);
  nudges.runNightlyNudges(USER);
  const year = dublinToday.slice(0, 4);
  check('exactly one birthday reminder for today\'s birthday', () =>
    assert.strictEqual(
      hub.prepare('SELECT COUNT(*) AS n FROM reminders WHERE dedup_key = ?').get(`birthday:${cBdayToday}:${year}`).n, 1));

  console.log('5. Briefing nudge lines');
  const factId = uuid();
  hub.prepare(`INSERT INTO crm_facts (id, user, contact_id, fact, status, source, due_date)
               VALUES (?, ?, ?, 'synthnudge chase invoice', 'follow_up', 'synthtest', '2026-06-01')`)
    .run(factId, USER, cCold);
  ids.facts.push(factId);
  const lines = nudges.buildNudgeLines(USER).join('\n');
  check('birthday section present', () => assert(lines.includes('Synthnudge Birthday Today — 🎂 today')));
  check('overdue follow-up section present', () => assert(lines.includes('synthnudge chase invoice')));
  check('keep-in-touch section present with day count', () => assert(/Synthnudge Cold Person — 4[456] days/.test(lines)));

  cleanup();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll nudge tests passed.');
  process.exit(failures ? 1 : 0);
})();
