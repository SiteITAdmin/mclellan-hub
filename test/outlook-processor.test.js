'use strict';

// Synthetic build-time test for the Outlook (Microsoft 365) sync (CLAUDE.md
// Rule 3): fake Graph API payloads pushed through the real storage path
// against a fresh temp DB. No network, no real tenancy needed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// Isolated temp copy of the initialised schema — db.hub()'s migrations assume
// the init-db base tables already exist, so bootstrap those first if needed.
const repoRoot = path.join(__dirname, '..');
const baseDb = path.join(repoRoot, 'data', 'hub.db');
if (!fs.existsSync(baseDb)) {
  execSync('node scripts/init-db.js', { cwd: repoRoot, stdio: 'ignore' });
}
const TMP_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-outlook-test-')), 'hub.db');
fs.copyFileSync(baseDb, TMP_DB);
process.env.HUB_DB_PATH = TMP_DB;

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  getSyncFolders,
  normalizeOutlookEvent,
  normalizeOutlookMessage,
  processOutlookMail,
  setSyncFolders,
  stripOutlookHtml,
  syncOutlookCalendar,
} = require('../lib/outlook-processor');

const USER = 'douglas';
const SELF_EMAIL = 'douglas.mclellan@beaconhospital.ie';

const hub = db.hub();
hub.prepare('INSERT OR IGNORE INTO contacts (id, user, name, email) VALUES (?, ?, ?, ?)')
   .run('contact-aoife', USER, 'Aoife Byrne', 'aoife.byrne@beaconhospital.ie');
hub.prepare('INSERT OR IGNORE INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
   .run(uuid(), USER, 'Beacon Hospital', 'beacon');

const FAKE_MESSAGES = [
  {
    id: 'AAMkAGfake001',
    subject: 'M365 audit checklist',
    from: { emailAddress: { name: 'Aoife Byrne', address: 'Aoife.Byrne@beaconhospital.ie' } },
    receivedDateTime: '2026-07-07T09:15:00Z',
    conversationId: 'AAQkAGthread01',
    body: { contentType: 'html', content: '<html><head><style>p{color:red}</style></head><body><p>Hi Douglas,</p><p>Can you send the <b>audit checklist</b> by Friday?</p></body></html>' },
    bodyPreview: 'Hi Douglas, Can you send the audit checklist by Friday?',
    toRecipients: [{ emailAddress: { address: SELF_EMAIL } }],
    ccRecipients: [],
    hasAttachments: false,
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGfake001',
  },
  {
    id: 'AAMkAGfake002',
    subject: 'Fw: SharePoint permissions review',
    from: { emailAddress: { name: 'Nick Ryan', address: 'nick.ryan@beaconhospital.ie' } },
    receivedDateTime: '2026-07-07T10:30:00Z',
    conversationId: 'AAQkAGthread02',
    body: { contentType: 'text', content: 'Forwarding the permissions review notes for the Teams migration.' },
    bodyPreview: 'Forwarding the permissions review notes',
    toRecipients: [{ emailAddress: { address: SELF_EMAIL } }],
    ccRecipients: [{ emailAddress: { address: 'aoife.byrne@beaconhospital.ie' } }],
    hasAttachments: true,
    webLink: 'https://outlook.office365.com/owa/?ItemID=AAMkAGfake002',
  },
];

const FAKE_EVENTS = [
  {
    id: 'AAMkAGevent001',
    subject: 'IT security review',
    start: { dateTime: '2026-07-08T14:00:00.0000000', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-07-08T15:00:00.0000000', timeZone: 'Europe/Dublin' },
    isAllDay: false,
    isCancelled: false,
    location: { displayName: 'Beacon Hospital Boardroom' },
    bodyPreview: 'Quarterly review of tenant security posture.',
    attendees: [
      { emailAddress: { name: 'Douglas McLellan', address: SELF_EMAIL } },
      { emailAddress: { name: 'Aoife Byrne', address: 'aoife.byrne@beaconhospital.ie' } },
    ],
  },
  {
    id: 'AAMkAGevent002',
    subject: 'Data centre migration window',
    start: { dateTime: '2026-07-10T00:00:00.0000000', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-07-11T00:00:00.0000000', timeZone: 'Europe/Dublin' },
    isAllDay: true,
    isCancelled: false,
    location: {},
    bodyPreview: '',
    attendees: [],
  },
  {
    id: 'AAMkAGevent003',
    subject: 'Cancelled standup',
    start: { dateTime: '2026-07-09T09:00:00.0000000', timeZone: 'Europe/Dublin' },
    end: { dateTime: '2026-07-09T09:30:00.0000000', timeZone: 'Europe/Dublin' },
    isAllDay: false,
    isCancelled: true,
    location: {},
    bodyPreview: '',
    attendees: [],
  },
];

const fakeMailGraph = async () => FAKE_MESSAGES;
const fakeCalendarGraph = async () => FAKE_EVENTS;
const fakeClassify = async (email) => ({
  summary: `Summary of: ${email.subject}`,
  project_slug: 'beacon',
  move_label: null,
});

test('Outlook message normalisation strips HTML and lowercases sender', () => {
  const email = normalizeOutlookMessage(FAKE_MESSAGES[0]);
  assert.equal(email.fromEmail, 'aoife.byrne@beaconhospital.ie');
  assert.equal(email.fromName, 'Aoife Byrne');
  assert.ok(email.bodyText.includes('audit checklist'));
  assert.ok(!email.bodyText.includes('<'), 'HTML tags must be stripped');
  assert.ok(!email.bodyText.includes('color:red'), 'style blocks must be stripped');
  assert.equal(email.receivedAt, Math.floor(new Date('2026-07-07T09:15:00Z').getTime() / 1000));
});

test('Outlook event normalisation handles timed, all-day, and self-attendee cases', () => {
  const timed = normalizeOutlookEvent(FAKE_EVENTS[0], SELF_EMAIL);
  assert.equal(timed.date, '2026-07-08');
  assert.equal(timed.time, '14:00');
  assert.equal(timed.durationMins, 60);
  assert.deepEqual(timed.attendeeDetails, [{ name: 'Aoife Byrne', email: 'aoife.byrne@beaconhospital.ie' }]);

  const allDay = normalizeOutlookEvent(FAKE_EVENTS[1], SELF_EMAIL);
  assert.equal(allDay.time, null);
  assert.equal(allDay.isAllDay, true);
});

test('Outlook mail sync stores raw records and knowledge-engine-visible summaries', async () => {
  const first = await processOutlookMail(USER, { graphGetAll: fakeMailGraph, classify: fakeClassify });
  assert.equal(first.processed, 2);
  assert.equal(first.skipped, 0);

  const records = hub.prepare(
    "SELECT * FROM inbound_email_records WHERE user = ? AND source = 'outlook' ORDER BY received_at"
  ).all(USER);
  assert.equal(records.length, 2);
  assert.equal(records[0].from_email, 'aoife.byrne@beaconhospital.ie');
  assert.equal(records[0].project_slug, 'beacon');
  assert.ok(JSON.parse(records[0].raw_metadata).webLink.includes('AAMkAGfake001'));

  const summary = hub.prepare(
    "SELECT * FROM email_summaries WHERE user = ? AND gmail_message_id = 'outlook:AAMkAGfake001'"
  ).get(USER);
  assert.ok(summary, 'compatibility email_summaries row must exist for the CRM knowledge engine');
  assert.equal(summary.summary, 'Summary of: M365 audit checklist');
  assert.equal(summary.contact_id, 'contact-aoife');

  const lastCheck = hub.prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_outlook_last_check_ts'"
  ).get(USER);
  assert.ok(lastCheck && parseInt(lastCheck.value, 10) > 0, 'last-check timestamp must be recorded');

  // Second run must be a no-op — dedup by external message id.
  const second = await processOutlookMail(USER, { graphGetAll: fakeMailGraph, classify: fakeClassify });
  assert.equal(second.processed, 0);
  assert.equal(second.skipped, 2);
  assert.equal(
    hub.prepare("SELECT COUNT(*) AS n FROM email_summaries WHERE user = ? AND gmail_message_id LIKE 'outlook:%'").get(USER).n,
    2
  );
});

test('Outlook calendar sync upserts meetings and matches attendees to contacts', async () => {
  const first = await syncOutlookCalendar(USER, { graphGetAll: fakeCalendarGraph, accountEmail: SELF_EMAIL });
  assert.equal(first.events, 2, 'cancelled events must be skipped');
  assert.equal(first.attendeesMatched, 1);

  const meeting = hub.prepare(
    "SELECT * FROM meetings WHERE user = ? AND calendar_event_id = 'AAMkAGevent001'"
  ).get(USER);
  assert.equal(meeting.title, 'IT security review');
  assert.equal(meeting.meeting_date, '2026-07-08');
  assert.equal(meeting.meeting_time, '14:00');
  assert.equal(meeting.duration_mins, 60);
  assert.equal(meeting.source, 'outlook_calendar');
  assert.equal(meeting.location, 'Beacon Hospital Boardroom');

  const attendee = hub.prepare(
    'SELECT * FROM meeting_attendees WHERE meeting_id = ?'
  ).all(meeting.id);
  assert.deepEqual(attendee.map(a => a.contact_id), ['contact-aoife']);

  const allDay = hub.prepare(
    "SELECT * FROM meetings WHERE user = ? AND calendar_event_id = 'AAMkAGevent002'"
  ).get(USER);
  assert.equal(allDay.meeting_time, null);

  // Re-run with a changed title — must update in place, not duplicate.
  const updatedEvents = [{ ...FAKE_EVENTS[0], subject: 'IT security review (moved)' }];
  const second = await syncOutlookCalendar(USER, { graphGetAll: async () => updatedEvents, accountEmail: SELF_EMAIL });
  assert.equal(second.events, 1);
  const outlookMeetings = hub.prepare(
    "SELECT * FROM meetings WHERE user = ? AND source = 'outlook_calendar'"
  ).all(USER);
  assert.equal(outlookMeetings.length, 2);
  assert.equal(
    hub.prepare("SELECT title FROM meetings WHERE user = ? AND calendar_event_id = 'AAMkAGevent001'").get(USER).title,
    'IT security review (moved)'
  );
});

test('Outlook folder scoping only ingests designated folders', async () => {
  assert.deepEqual(getSyncFolders(USER), ['Inbox'], 'default is the whole Inbox');
  setSyncFolders(USER, 'Hub, Hub Reports, Old Projects');

  const hubFolderMessage = {
    ...FAKE_MESSAGES[0],
    id: 'AAMkAGfake003',
    subject: 'Filed into the Hub folder by an Outlook rule',
    conversationId: 'AAQkAGthread03',
  };
  const routedGraph = async (path) => {
    if (path.startsWith('/me/mailFolders?')) {
      return [
        { id: 'f-hub', displayName: 'Hub', childFolders: [{ id: 'f-hub-reports', displayName: 'Hub Reports' }] },
        { id: 'f-alerts', displayName: 'Server Alerts' },
      ];
    }
    if (path.startsWith('/me/mailFolders/f-hub/messages')) return [hubFolderMessage];
    if (path.startsWith('/me/mailFolders/f-hub-reports/messages')) return [];
    if (path.startsWith('/me/mailFolders/f-alerts/messages')) {
      throw new Error('undesignated folder must never be queried');
    }
    if (path.startsWith('/me/mailFolders/inbox/messages')) {
      throw new Error('inbox must not be queried when explicit folders are configured');
    }
    throw new Error(`unexpected Graph path: ${path}`);
  };

  const res = await processOutlookMail(USER, { graphGetAll: routedGraph, classify: fakeClassify });
  assert.equal(res.processed, 1);
  assert.deepEqual([...res.folders].sort(), ['Hub', 'Hub Reports']);
  assert.deepEqual(res.missingFolders, ['Old Projects']);

  assert.ok(hub.prepare(
    "SELECT 1 FROM inbound_email_records WHERE user = ? AND external_message_id = 'AAMkAGfake003'"
  ).get(USER), 'mail in a designated folder is ingested');

  // Clearing the config falls back to Inbox.
  setSyncFolders(USER, '');
  assert.deepEqual(getSyncFolders(USER), ['Inbox']);
});

test('Outlook HTML stripper survives entities and nested markup', () => {
  assert.equal(
    stripOutlookHtml('<div>Q3 &amp; Q4 budget&nbsp;&lt;draft&gt;<br><span>attached</span></div>'),
    'Q3 & Q4 budget <draft> attached'
  );
});
