'use strict';

/**
 * Outlook (Microsoft 365) work email + calendar sync.
 *
 * Input contract:
 *   Mail:     Graph inbox -> inbound_email_records (source 'outlook', raw store)
 *             + email_summaries compatibility row ('outlook:<id>') so the CRM
 *             knowledge engine, embeddings backfill, and digests pick it up.
 *   Calendar: Graph calendarView -> meetings (source 'outlook_calendar'),
 *             same upsert + attendee matching as the Google calendar path.
 *
 * Read-only: nothing is written back to the mailbox or calendar.
 */

const db = require('./db');
const { uuid } = require('./id');
const msGraph = require('./ms-graph');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');

const LAST_CHECK_KEY = '_outlook_last_check_ts';
const TZ = 'Europe/Dublin';

function stripOutlookHtml(html) {
  return String(html || '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeOutlookMessage(msg) {
  const from = msg.from?.emailAddress || {};
  const body = msg.body?.contentType === 'html'
    ? stripOutlookHtml(msg.body?.content)
    : String(msg.body?.content || '').trim();
  return {
    id: msg.id,
    subject: msg.subject || '(no subject)',
    fromName: String(from.name || '').trim(),
    fromEmail: String(from.address || '').trim().toLowerCase(),
    receivedAt: Math.floor(new Date(msg.receivedDateTime || Date.now()).getTime() / 1000),
    threadId: msg.conversationId || null,
    bodyText: (body || msg.bodyPreview || '').slice(0, 500000),
    to: (msg.toRecipients || []).map(r => r.emailAddress?.address || '').filter(Boolean),
    cc: (msg.ccRecipients || []).map(r => r.emailAddress?.address || '').filter(Boolean),
    hasAttachments: Boolean(msg.hasAttachments),
    webLink: msg.webLink || '',
  };
}

// Graph returns start/end in the requested timezone when the Prefer header is
// set, as '2026-07-07T14:00:00.0000000' — no offset suffix to parse.
function normalizeOutlookEvent(ev, accountEmail = '') {
  const startLocal = String(ev.start?.dateTime || '');
  const endLocal = String(ev.end?.dateTime || '');
  const durationMins = startLocal && endLocal
    ? Math.max(0, Math.round((new Date(endLocal.slice(0, 19)) - new Date(startLocal.slice(0, 19))) / 60000))
    : null;
  const self = String(accountEmail || '').toLowerCase();
  return {
    id: ev.id,
    summary: ev.subject || '(no title)',
    date: startLocal.slice(0, 10),
    time: ev.isAllDay ? null : startLocal.slice(11, 16),
    durationMins: ev.isAllDay ? null : durationMins,
    isAllDay: Boolean(ev.isAllDay),
    isCancelled: Boolean(ev.isCancelled),
    location: ev.location?.displayName || '',
    notes: String(ev.bodyPreview || '').slice(0, 2000),
    attendeeDetails: (ev.attendees || [])
      .map(a => ({
        name: String(a.emailAddress?.name || '').trim(),
        email: String(a.emailAddress?.address || '').trim().toLowerCase(),
      }))
      .filter(a => (a.name || a.email) && a.email !== self),
  };
}

function isOutlookSyncEnabled(user) {
  return msGraph.isMsGraphConfigured() && msGraph.hasMsToken(user);
}

// ── Mail ──────────────────────────────────────────────────────────────────────

async function processOutlookMail(user = 'douglas', options = {}) {
  const hub = db.hub();
  const fetchAll = options.graphGetAll || ((path, opts) => msGraph.graphGetAll(user, path, opts));
  const classify = options.classify || require('./email-processor').classifyEmail;

  const lastCheckRow = hub.prepare(
    'SELECT value FROM crm_context WHERE user = ? AND key = ?'
  ).get(user, LAST_CHECK_KEY);
  const lastCheckTs = lastCheckRow
    ? parseInt(lastCheckRow.value, 10)
    : Math.floor(Date.now() / 1000) - 24 * 3600;
  const checkStartedTs = Math.floor(Date.now() / 1000);

  // 5-minute overlap so clock skew can't drop a message; the unique
  // (user, source, external_message_id) constraint absorbs the re-reads.
  const sinceIso = new Date((lastCheckTs - 300) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const select = 'id,subject,from,receivedDateTime,conversationId,body,bodyPreview,toRecipients,ccRecipients,hasAttachments,webLink';
  const messages = await fetchAll(
    `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${sinceIso}`
    + `&$orderby=receivedDateTime asc&$top=50&$select=${encodeURIComponent(select)}`,
    { limit: options.limit || 200 }
  );

  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ? ORDER BY name').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  const { getEnabledEmailLabels } = require('./email-taxonomy');
  const emailLabels = getEnabledEmailLabels(user);

  let processed = 0;
  let skipped = 0;

  for (const raw of messages) {
    const email = normalizeOutlookMessage(raw);
    const exists = hub.prepare(`
      SELECT 1 FROM inbound_email_records
      WHERE user = ? AND source = 'outlook' AND external_message_id = ?
    `).get(user, email.id);
    if (exists) { skipped++; continue; }

    try {
      const hasContent = email.bodyText.trim().length >= 5;
      const classification = (hasContent
        ? await classify(email, contacts, projects, emailLabels, user, 'outlook')
        : null) ?? { summary: '', project_slug: null, move_label: null };
      const validProject = projects.some(p => p.slug === classification.project_slug)
        ? classification.project_slug
        : null;
      const senderContact = contacts.find(contact =>
        contact.email && contact.email.trim().toLowerCase() === email.fromEmail
      );

      hub.prepare(`
        INSERT INTO inbound_email_records
          (id, user, source, external_message_id, thread_id, from_name, from_email,
           subject, received_at, summary, classification, project_slug, status, raw_metadata)
        VALUES (?, ?, 'outlook', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?)
      `).run(
        uuid(), user, email.id, email.threadId, email.fromName, email.fromEmail,
        email.subject, email.receivedAt, classification.summary || '',
        classification.move_label || null, validProject,
        JSON.stringify({
          to: email.to,
          cc: email.cc,
          hasAttachments: email.hasAttachments,
          webLink: email.webLink,
        })
      );

      // Compatibility surface: the CRM knowledge engine, embeddings backfill,
      // and email digest all read email_summaries.
      hub.prepare(`
        INSERT OR IGNORE INTO email_summaries
          (id, user, gmail_message_id, subject, from_name, from_email,
           received_at, summary, project_slug, contact_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuid(), user, `outlook:${email.id}`, email.subject, email.fromName,
        email.fromEmail, email.receivedAt, classification.summary || '',
        validProject, senderContact?.id || null
      );

      processed++;
      resolveProcessingFailure('outlook', email.id);
    } catch (err) {
      recordProcessingFailure('outlook', email.id, err);
      console.error(`[outlook] failed ${email.id}:`, err.message);
    }
  }

  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, LAST_CHECK_KEY, String(checkStartedTs));

  if (processed) console.log(`[outlook] ${user}: ${processed} email(s) processed, ${skipped} already known`);
  return { processed, skipped, listed: messages.length };
}

// ── Calendar ──────────────────────────────────────────────────────────────────

async function syncOutlookCalendar(user = 'douglas', options = {}) {
  const hub = db.hub();
  const fetchAll = options.graphGetAll || ((path, opts) => msGraph.graphGetAll(user, path, opts));
  const accountEmail = options.accountEmail ?? msGraph.getMsAccountEmail(user);

  const daysBack = options.daysBack ?? 30;
  const daysForward = options.daysForward ?? 30;
  const startIso = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();
  const endIso = new Date(Date.now() + daysForward * 86400 * 1000).toISOString();
  const select = 'id,subject,start,end,isAllDay,isCancelled,location,bodyPreview,attendees,organizer';
  const rawEvents = await fetchAll(
    `/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}`
    + `&$orderby=start/dateTime&$top=100&$select=${encodeURIComponent(select)}`,
    { limit: options.limit || 500, headers: { Prefer: `outlook.timezone="${TZ}"` } }
  );

  const events = rawEvents
    .map(ev => normalizeOutlookEvent(ev, accountEmail))
    .filter(ev => ev.date && !ev.isCancelled);

  const { matchCalendarAttendee } = require('./crm');
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ?').all(user);
  const contextRows = hub.prepare('SELECT key, value FROM crm_context WHERE user = ?').all(user);
  const upsert = hub.prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, duration_mins, location, notes,
       company_id, calendar_event_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outlook_calendar')
    ON CONFLICT(user, calendar_event_id) DO UPDATE SET
      title = excluded.title,
      meeting_date = excluded.meeting_date,
      meeting_time = excluded.meeting_time,
      duration_mins = excluded.duration_mins,
      location = excluded.location,
      notes = excluded.notes,
      company_id = COALESCE(meetings.company_id, excluded.company_id)
  `);
  const findMeeting = hub.prepare('SELECT id FROM meetings WHERE user = ? AND calendar_event_id = ?');
  const clearAttendees = hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?');
  const addAttendee = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');

  let attendeesMatched = 0;
  const transaction = hub.transaction(() => {
    for (const event of events) {
      const company = companies.find(item =>
        `${event.summary} ${event.location}`.toLowerCase().includes(item.name.toLowerCase())
      );
      const existing = findMeeting.get(user, event.id);
      const meetingId = existing?.id || uuid();
      upsert.run(
        meetingId, user, event.summary, event.date, event.time, event.durationMins,
        event.location, event.notes, company?.id || null, event.id
      );
      clearAttendees.run(meetingId);
      for (const attendee of event.attendeeDetails) {
        const contact = matchCalendarAttendee(contacts, contextRows, attendee);
        if (!contact) continue;
        addAttendee.run(meetingId, contact.id);
        attendeesMatched++;
      }
    }
  });
  transaction();

  try {
    require('./crm-nudges').recomputeLastContacted(user);
  } catch (err) {
    console.warn('[outlook] last-contacted recompute failed:', err.message);
  }

  if (events.length) console.log(`[outlook] ${user}: ${events.length} calendar event(s) synced, ${attendeesMatched} attendee(s) matched`);
  return { events: events.length, attendeesMatched };
}

module.exports = {
  isOutlookSyncEnabled,
  normalizeOutlookEvent,
  normalizeOutlookMessage,
  processOutlookMail,
  stripOutlookHtml,
  syncOutlookCalendar,
};
