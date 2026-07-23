'use strict';

const { google } = require('googleapis');
const db = require('./db');
const { upsertMeetingRow, linkMeetingAttendee } = require('./crm');

// ── Auth ──────────────────────────────────────────────────────────────────────
// Same refresh-token-from-crm_context pattern as lib/google-tasks.js.

function getCalendarClient(user) {
  const tokenRow = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!tokenRow) throw new Error(`No Google refresh token for user "${user}"`);
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: tokenRow.value });
  return google.calendar({ version: 'v3', auth: client });
}

/**
 * Create a Google Calendar event and mirror it into the local `meetings`
 * table (the same compiled cache the read-side calendar sync writes to —
 * see upsertMeetingRow in lib/crm.js) so it shows up in the Work Brief and
 * CRM meeting pages without waiting for the next daily calendar sync.
 *
 * Idempotent on (user, source, source_id): calling this twice for the same
 * source_id is a no-op on the second call, mirroring createTask's dedup
 * guard in lib/google-tasks.js.
 */
async function createCalendarEvent(user, {
  title, description, location, startAt, endAt,
  source = 'crm-engine', sourceId = null,
  contactId = null, companyId = null,
}) {
  const hub = db.hub();
  if (sourceId) {
    const existing = hub.prepare(
      'SELECT id FROM meetings WHERE user = ? AND source = ? AND source_id = ?'
    ).get(user, source, sourceId);
    if (existing) {
      console.log(`[calendar] skipping duplicate event for ${source}/${sourceId}`);
      return null;
    }
  }

  const calendar = getCalendarClient(user);
  const tz = 'Europe/Dublin';
  const resp = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: title,
      description: description || undefined,
      location: location || undefined,
      start: { dateTime: startAt, timeZone: tz },
      end: { dateTime: endAt, timeZone: tz },
    },
  });
  const event = resp.data;

  const date = String(startAt).slice(0, 10);
  const time = String(startAt).slice(11, 16);
  const durationMins = Math.max(0, Math.round((new Date(endAt) - new Date(startAt)) / 60000));

  const meetingId = upsertMeetingRow(user, {
    title, date, time, durationMins,
    location: location || '', notes: description || '',
    companyId, calendarEventId: event.id, source, sourceId,
  });
  if (contactId) linkMeetingAttendee(meetingId, contactId);

  console.log(`[calendar] created "${title}" for ${user} (${source}) — ${date} ${time}`);
  return { ...event, localId: meetingId };
}

module.exports = { getCalendarClient, createCalendarEvent };
