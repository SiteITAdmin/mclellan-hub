const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');
const { writeNote } = require('./obsidian-vault');
const { getWikiPagesByTags } = require('./wiki-tags');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { createTask, getCachedTasks } = require('./google-tasks');

// Append a dated entry to People/{name}.md in the vault
function appendContactVaultEntry(name, line) {
  const d = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  try {
    writeNote({ notePath: `People/${name}.md`, content: `\n- ${d}: ${line}`, mode: 'append' });
  } catch (err) {
    console.warn(`[crm] vault write failed for People/${name}.md:`, err.message);
  }
}

// ── Intent parsing ────────────────────────────────────────────────────────────

async function parseIntent(user, text) {
  const context = db.hub().prepare(
    'SELECT key, value FROM crm_context WHERE user = ? ORDER BY key'
  ).all(user);

  const contextStr = context.length
    ? 'Known context about this user\'s world:\n' + context.map(c => `- ${c.key} = ${c.value}`).join('\n') + '\n\n'
    : '';

  const prompt = getSystemPrompt('crm_parser', 'system', PROMPTS.crm_parser)
    .replace('[CONTEXT]', contextStr)
    .replace('[NOTE]', text);

  const started = Date.now();
  const modelId = getSystemModelId('crm_parser', 'system', 'google/gemini-2.5-pro-preview');
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'crm-intent',
    modelKey: 'crm-intent',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
  });
  return JSON.parse(data.choices[0].message.content);
}

// ── Contact resolution ────────────────────────────────────────────────────────

function resolveContact(user, name) {
  if (!name) return null;
  const normalized = name.toLowerCase().trim();
  const hub = db.hub();

  let contact = hub.prepare(
    'SELECT * FROM contacts WHERE user = ? AND lower(name) = ?'
  ).get(user, normalized);

  if (!contact) {
    const all = hub.prepare('SELECT * FROM contacts WHERE user = ?').all(user);
    contact = all.find(c => {
      try { return JSON.parse(c.aliases).some(a => a.toLowerCase() === normalized); }
      catch { return false; }
    }) || null;
  }

  if (!contact) {
    const id = uuid();
    hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, user, name.trim());
    contact = hub.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  }

  return contact;
}

// ── Fact matching ─────────────────────────────────────────────────────────────

function findBestFact(facts, hint) {
  if (!facts.length) return null;
  if (!hint) return facts[0];
  const terms = hint.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return facts.reduce((best, f) => {
    const score = terms.filter(t => f.fact.toLowerCase().includes(t)).length;
    return score > (best?.score || 0) ? { ...f, score } : best;
  }, null) || facts[0];
}

// ── Process /crm command ──────────────────────────────────────────────────────

async function processCrmCommand(user, text, source = 'dchat') {
  const intent = await parseIntent(user, text);
  const hub = db.hub();

  if (intent.action === 'add_context' && intent.context_key) {
    const key = intent.context_key.toLowerCase().trim();
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, key, intent.context_value || '');
    return { ok: true, message: `Context noted: **${key}** = ${intent.context_value}` };
  }

  const contact = resolveContact(user, intent.contact);
  if (!contact) {
    return { ok: false, message: 'No person identified. Try: `/crm [Name] ...`' };
  }

  if (intent.action === 'new_fact') {
    hub.prepare(`
      INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(uuid(), user, contact.id, intent.fact, source);
    appendContactVaultEntry(contact.name, `[fact] ${intent.fact}${source !== 'dchat' ? ` _(${source})_` : ''}`);
    return { ok: true, message: `Saved for **${contact.name}**: ${intent.fact}` };
  }

  if (intent.action === 'mark_done') {
    const activeFacts = hub.prepare(
      "SELECT * FROM crm_facts WHERE user = ? AND contact_id = ? AND status = 'active' ORDER BY created_at DESC"
    ).all(user, contact.id);

    const matched = findBestFact(activeFacts, intent.matches_fact);
    if (matched) {
      hub.prepare("UPDATE crm_facts SET status = 'done', updated_at = unixepoch() WHERE id = ?").run(matched.id);
    }

    if (matched) appendContactVaultEntry(contact.name, `[done] ${matched.fact}`);

    let followUpMsg = '';
    if (intent.follow_up) {
      const factId = uuid();
      hub.prepare(`
        INSERT INTO crm_facts (id, user, contact_id, fact, status, source, parent_id)
        VALUES (?, ?, ?, ?, 'follow_up', ?, ?)
      `).run(factId, user, contact.id, intent.follow_up, source, matched?.id || null);
      appendContactVaultEntry(contact.name, `[follow-up] ${intent.follow_up}`);
      followUpMsg = `\nFollow-up: *${intent.follow_up}*`;
      createTask(user, {
        title: `Follow up with ${contact.name}`,
        notes: intent.follow_up,
        source: 'crm-follow-up',
        sourceId: factId,
        contactId: contact.id,
      }).catch(err => console.warn('[tasks] follow-up create failed:', err.message));
    }

    const doneText = matched ? `~~${matched.fact}~~` : '(no matching open item)';
    return { ok: true, message: `Done for **${contact.name}**: ${doneText}${followUpMsg}` };
  }

  if (intent.action === 'close_followup') {
    const followUps = hub.prepare(
      "SELECT * FROM crm_facts WHERE user = ? AND contact_id = ? AND status = 'follow_up' ORDER BY created_at DESC"
    ).all(user, contact.id);

    const matched = findBestFact(followUps, intent.matches_fact);
    if (!matched) {
      return { ok: false, message: `No open follow-ups found for **${contact.name}**` };
    }
    hub.prepare("UPDATE crm_facts SET status = 'closed', updated_at = unixepoch() WHERE id = ?").run(matched.id);
    appendContactVaultEntry(contact.name, `[closed] ${matched.fact}`);
    return { ok: true, message: `Closed for **${contact.name}**: ~~${matched.fact}~~` };
  }

  return { ok: false, message: 'Could not parse that CRM note.' };
}

// ── Briefing ──────────────────────────────────────────────────────────────────

function wordSet(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function calendarEventText(ev) {
  return [
    ev.summary,
    ...(ev.attendees || []).map(attendee => typeof attendee === 'string' ? attendee : attendee.name),
  ].filter(Boolean).join(' ');
}

function contactNameCandidates(name, aliases) {
  let parsedAliases = [];
  try {
    parsedAliases = Array.isArray(JSON.parse(aliases || '[]')) ? JSON.parse(aliases || '[]') : [];
  } catch {
    parsedAliases = [];
  }
  return [name, ...parsedAliases].filter(Boolean);
}

function contactMatchesCalendarEvent(name, aliases, ev) {
  const eventWords = wordSet(calendarEventText(ev));
  return contactNameCandidates(name, aliases).some(candidate => {
    const parts = String(candidate).toLowerCase().match(/[a-z0-9]+/g) || [];
    if (!parts.length) return false;
    return parts.every(part => eventWords.has(part));
  });
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildBriefingText(user, calendarEvents = []) {
  const hub = db.hub();
  const storedToday = hub.prepare(`
    SELECT m.*, co.name AS company_name
    FROM meetings m
    LEFT JOIN companies co ON co.id = m.company_id
    WHERE m.user = ? AND m.meeting_date = ?
    ORDER BY m.meeting_time, m.title
  `).all(user, new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' }));
  const facts = hub.prepare(`
    SELECT f.*, c.name AS contact_name, c.aliases AS contact_aliases
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status IN ('active', 'follow_up')
    ORDER BY c.name, f.status DESC, f.created_at ASC
  `).all(user);

  if (!facts.length && !calendarEvents.length && !storedToday.length) return null;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines = [`*Morning Briefing — ${today}*`];

  const briefingMeetings = storedToday.length ? storedToday.map(meeting => ({
    ...meeting,
    summary: meeting.title,
    time: meeting.meeting_time,
    attendees: hub.prepare(`
      SELECT c.id, c.name
      FROM meeting_attendees ma
      JOIN contacts c ON c.id = ma.contact_id
      WHERE ma.meeting_id = ?
      ORDER BY c.name
    `).all(meeting.id),
  })) : calendarEvents;

  if (briefingMeetings.length) {
    lines.push('', '*Today\'s meetings:*');
    for (const ev of briefingMeetings) {
      const attendeeNames = (ev.attendees || []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean);
      const context = [
        ev.company_name,
        attendeeNames.length ? attendeeNames.join(', ') : null,
      ].filter(Boolean).join(' · ');
      lines.push(`• ${ev.time ? ev.time + ' — ' : ''}${ev.summary}${context ? ` (${context})` : ''}`);
      for (const attendee of ev.attendees || []) {
        if (!attendee.id) continue;
        const actions = hub.prepare(`
          SELECT fact FROM crm_facts
          WHERE user = ? AND fact_type = 'action' AND status IN ('active', 'follow_up')
            AND (contact_id = ? OR linked_contacts LIKE ?)
          ORDER BY created_at
        `).all(user, attendee.id, `%"${attendee.id}"%`);
        for (const action of actions) lines.push(`  • ${attendee.name}: ${action.fact}`);
      }
    }
  }

  // Facts grouped by contact, with meeting contacts surfaced first
  const byContact = {};
  for (const f of facts) {
    (byContact[f.contact_name] ||= []).push(f);
  }

  const contactMeetings = new Map();
  for (const [name, contactFacts] of Object.entries(byContact)) {
    const aliases = contactFacts[0]?.contact_aliases;
    const meetings = calendarEvents.filter(ev => contactMatchesCalendarEvent(name, aliases, ev));
    if (meetings.length) contactMeetings.set(name, meetings);
  }

  // Sort: meeting contacts first, then alphabetical
  const sorted = Object.keys(byContact).sort((a, b) => {
    const aM = contactMeetings.has(a) ? 0 : 1;
    const bM = contactMeetings.has(b) ? 0 : 1;
    return aM - bM || a.localeCompare(b);
  });

  if (sorted.length) {
    lines.push('', '*People:*');
    for (const name of sorted) {
      const meetings = contactMeetings.get(name) || [];
      const hasMeeting = meetings.length > 0;
      lines.push(`\n*${name}*${hasMeeting ? ' 📅' : ''}`);
      for (const ev of meetings) {
        lines.push(`  • [meeting] ${ev.time ? ev.time + ' — ' : ''}${ev.summary}`);
      }
      for (const f of byContact[name]) {
        const tag = f.status === 'follow_up' ? '[follow-up]' : '[action]';
        lines.push(`  • ${tag} ${f.fact}`);
      }
    }
  }

  const unresolvedDecisions = hub.prepare(`
    SELECT DISTINCT d.fact, c.name AS contact_name, m.title AS meeting_title
    FROM crm_facts d
    JOIN contacts c ON c.id = d.contact_id
    LEFT JOIN meetings m ON m.id = d.meeting_id
    WHERE d.user = ? AND d.fact_type = 'decision'
      AND d.created_at >= unixepoch() - (14 * 86400)
      AND EXISTS (
        SELECT 1 FROM crm_facts a
        WHERE a.user = d.user
          AND a.fact_type = 'action'
          AND a.status IN ('active', 'follow_up')
          AND (
            (d.meeting_id IS NOT NULL AND a.meeting_id = d.meeting_id)
            OR a.contact_id = d.contact_id
            OR a.linked_contacts LIKE '%"' || d.contact_id || '"%'
          )
      )
    ORDER BY d.created_at DESC
    LIMIT 6
  `).all(user);
  if (unresolvedDecisions.length) {
    lines.push('', '*Recent decisions with open actions:*');
    for (const decision of unresolvedDecisions) {
      const context = decision.meeting_title ? ` at ${decision.meeting_title}` : '';
      lines.push(`• ${decision.contact_name}${context}: ${decision.fact}`);
    }
  }

  // Wiki knowledge: pages matching any project or contact wiki_tags
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const allTagSets = [];

    const projects = hub.prepare(
      'SELECT name, wiki_tags FROM projects WHERE user = ? AND wiki_tags != \'[]\' AND wiki_tags IS NOT NULL'
    ).all(user);
    for (const p of projects) {
      const tags = JSON.parse(p.wiki_tags || '[]');
      if (tags.length) allTagSets.push({ label: p.name, tags });
    }

    const contactsWithTags = hub.prepare(
      'SELECT name, wiki_tags FROM contacts WHERE user = ? AND wiki_tags != \'[]\' AND wiki_tags IS NOT NULL'
    ).all(user);
    for (const c of contactsWithTags) {
      const tags = JSON.parse(c.wiki_tags || '[]');
      if (tags.length) allTagSets.push({ label: c.name, tags });
    }

    const seen = new Set();
    const wikiLines = [];
    for (const { label, tags } of allTagSets) {
      const pages = getWikiPagesByTags(tags, { limit: 3, since: sevenDaysAgo });
      const fresh = pages.filter(p => !seen.has(p.slug));
      if (!fresh.length) continue;
      fresh.forEach(p => seen.add(p.slug));
      wikiLines.push(`*${label}:* ` + fresh.map(p => p.title).join(', '));
    }
    if (wikiLines.length) {
      lines.push('', '*Recent knowledge:*');
      for (const l of wikiLines) lines.push(`• ${l}`);
    }
  } catch (err) {
    console.warn('[crm] wiki knowledge section failed:', err.message);
  }

  // Open Google Tasks (from local cache — sync happens at briefing send time)
  try {
    const openTasks = getCachedTasks(user);
    if (openTasks.length) {
      lines.push('', '*Open tasks:*');
      for (const t of openTasks.slice(0, 10)) {
        const dueStr = t.due ? ` _(due ${new Date(t.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})_` : '';
        lines.push(`• ${t.title}${dueStr}`);
      }
      if (openTasks.length > 10) lines.push(`  _…and ${openTasks.length - 10} more_`);
    }
  } catch (err) {
    console.warn('[crm] tasks section failed:', err.message);
  }

  const total = facts.length;
  lines.push('', `_${sorted.length} ${sorted.length === 1 ? 'person' : 'people'}, ${total} ${total === 1 ? 'item' : 'items'}_`);
  return lines.join('\n');
}

async function pushGoogleChatBriefing(user, text) {
  const webhookUrl = process.env[`GOOGLE_CHAT_WEBHOOK_${user.toUpperCase()}`];
  if (!webhookUrl) {
    console.warn(`[crm] No GOOGLE_CHAT_WEBHOOK_${user.toUpperCase()} set — skipping push`);
    return false;
  }
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) console.error(`[crm] Google Chat webhook error: ${resp.status}`);
  return resp.ok;
}

function isoDateInDublin(date) {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

async function fetchCalendarEvents(user, { daysBack = 0, daysForward = 0 } = {}) {
  try {
    const tokenRow = db.hub().prepare(
      "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
    ).get(user);
    if (!tokenRow) return [];

    const { google } = require('googleapis');
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    client.setCredentials({ refresh_token: tokenRow.value });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const tz = 'Europe/Dublin';
    const now = new Date();
    const start = new Date(now.getTime() - Math.max(0, daysBack) * 86400000);
    const end = new Date(now.getTime() + Math.max(0, daysForward) * 86400000);
    const startDate = isoDateInDublin(start);
    const endDate = isoDateInDublin(new Date(end.getTime() + 86400000));

    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: `${startDate}T00:00:00Z`,
      timeMax: `${endDate}T00:00:00Z`,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const allItems = resp.data.items || [];
    const allDay = allItems.filter(ev => ev.status !== 'cancelled' && ev.summary && !ev.start?.dateTime);
    if (allDay.length) console.log(`[crm] skipping ${allDay.length} all-day event(s):`, allDay.map(e => e.summary).join(', '));
    return allItems
      .filter(ev => ev.status !== 'cancelled' && ev.summary && ev.start?.dateTime)
      .map(ev => ({
        id: ev.id,
        summary: ev.summary,
        date: ev.start?.dateTime
          ? new Date(ev.start.dateTime).toLocaleDateString('sv-SE', { timeZone: tz })
          : ev.start?.date || startDate,
        time: ev.start?.dateTime
          ? new Date(ev.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
          : null,
        durationMins: ev.start?.dateTime && ev.end?.dateTime
          ? Math.max(0, Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000))
          : null,
        location: ev.location || '',
        notes: ev.description || '',
        attendees: (ev.attendees || [])
          .filter(a => !a.self)
          .map(a => a.displayName || a.email || '')
          .filter(Boolean),
        attendeeDetails: (ev.attendees || [])
          .filter(a => !a.self)
          .map(a => ({ name: a.displayName || '', email: String(a.email || '').toLowerCase() })),
      }));
  } catch (err) {
    console.warn(`[crm] calendar fetch failed for ${user}:`, err.message);
    return [];
  }
}

async function fetchTodayCalendarEvents(user) {
  return fetchCalendarEvents(user);
}

function matchCalendarAttendee(contacts, contextRows, attendee) {
  const email = String(attendee.email || '').toLowerCase();
  const displayName = String(attendee.name || '').trim().toLowerCase();
  const emailContext = contextRows.find(row => String(row.value || '').trim().toLowerCase() === email);
  const contextName = emailContext
    ? String(emailContext.key || '').replace(/(?:'s)?[_\s-]*email$/i, '').replace(/_/g, ' ').trim().toLowerCase()
    : '';
  return contacts.find(contact => {
    const names = [contact.name, ...parseJsonArray(contact.aliases)].map(name => String(name).toLowerCase());
    return names.includes(displayName) || names.includes(contextName);
  }) || null;
}

async function syncCalendarMeetings(user, options = {}) {
  const hub = db.hub();
  const events = await fetchCalendarEvents(user, {
    daysBack: options.daysBack ?? 30,
    daysForward: options.daysForward ?? 30,
  });
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ?').all(user);
  const contextRows = hub.prepare('SELECT key, value FROM crm_context WHERE user = ?').all(user);
  const upsert = hub.prepare(`
    INSERT INTO meetings
      (id, user, title, meeting_date, meeting_time, duration_mins, location, notes,
       company_id, calendar_event_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'calendar')
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
      for (const attendee of event.attendeeDetails || []) {
        const contact = matchCalendarAttendee(contacts, contextRows, attendee);
        if (!contact) continue;
        addAttendee.run(meetingId, contact.id);
        attendeesMatched++;
      }
    }
  });
  transaction();
  return { events: events.length, attendeesMatched };
}

async function sendDailyBriefing(user, calendarEvents) {
  const hub = db.hub();
  const dateStr = new Date().toLocaleDateString('en-GB');

  const alreadySent = hub.prepare(
    'SELECT 1 FROM crm_briefing_log WHERE user = ? AND date_str = ?'
  ).get(user, dateStr);
  if (alreadySent) return;

  // Refresh task cache before building briefing
  try {
    const { syncTasks } = require('./google-tasks');
    await syncTasks(user);
  } catch (err) {
    console.warn('[crm] task sync before briefing failed:', err.message);
  }

  const events = calendarEvents ?? await fetchTodayCalendarEvents(user);
  const text = buildBriefingText(user, events);
  if (!text) return;

  // Mirror briefing to vault daily note
  const isoDate = new Date().toISOString().slice(0, 10);
  try {
    const facts = db.hub().prepare(`
      SELECT f.fact, f.status, c.name AS contact_name
      FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
      WHERE f.user = ? AND f.status IN ('active', 'follow_up')
      ORDER BY c.name, f.status DESC
    `).all(user);
    const vaultLines = ['', '## Morning Briefing'];
    if (events.length) {
      vaultLines.push('', '**Meetings:**');
      for (const ev of events) vaultLines.push(`- ${ev.time ? ev.time + ' — ' : ''}${ev.summary}`);
    }
    const byContact = {};
    for (const f of facts) (byContact[f.contact_name] ||= []).push(f);
    if (Object.keys(byContact).length) {
      vaultLines.push('', '**People:**');
      for (const [cname, cf] of Object.entries(byContact)) {
        const items = cf.map(f => `[${f.status === 'follow_up' ? 'follow-up' : f.status}] ${f.fact}`).join('; ');
        vaultLines.push(`- **[[${cname}]]**: ${items}`);
      }
    }
    writeNote({ notePath: `Daily/${isoDate}.md`, content: vaultLines.join('\n'), mode: 'append' });
  } catch (err) {
    console.warn('[crm] vault briefing write failed:', err.message);
  }

  const sent = await pushGoogleChatBriefing(user, text);
  if (sent) {
    hub.prepare(
      'INSERT INTO crm_briefing_log (id, user, date_str) VALUES (?, ?, ?)'
    ).run(uuid(), user, dateStr);
    console.log(`[crm] Briefing sent for ${user} on ${dateStr}`);
  }
}

// ── Email digest briefing ─────────────────────────────────────────────────────

function buildEmailBriefingText(user) {
  const hub = db.hub();

  // Emails received since last 4pm briefing (~24h window)
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const emails = hub.prepare(`
    SELECT e.*, c.name AS contact_name, p.name AS project_name
    FROM email_summaries e
    LEFT JOIN contacts c ON c.id = e.contact_id
    LEFT JOIN projects p ON p.slug = e.project_slug AND p.user = e.user
    WHERE e.user = ? AND e.received_at > ?
      AND (e.project_slug IS NULL OR e.project_slug NOT IN ('__system', '__skip'))
    ORDER BY e.project_slug NULLS LAST, e.received_at DESC
  `).all(user, since);

  if (!emails.length) return null;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines = [`*Email Digest — ${today}*`];

  // Group by project/category
  const byProject = {};
  const uncategorised = [];
  for (const email of emails) {
    if (email.project_slug) {
      (byProject[email.project_name || email.project_slug] ||= []).push(email);
    } else {
      uncategorised.push(email);
    }
  }

  for (const [projectName, projectEmails] of Object.entries(byProject)) {
    lines.push(`\n*${projectName}*`);
    for (const e of projectEmails) {
      const contact = e.contact_name ? ` _(${e.contact_name})_` : '';
      lines.push(`  • ${e.summary}${contact}`);
    }
  }

  if (uncategorised.length) {
    lines.push(`\n*Uncategorised — ${uncategorised.length} email${uncategorised.length === 1 ? '' : 's'} (review when you have a moment)*`);
    for (const e of uncategorised) {
      lines.push(`  • *${e.subject}* from ${e.from_name || e.from_email} — ${e.summary}`);
    }
  }

  const total = emails.length;
  lines.push('', `_${total} email${total === 1 ? '' : 's'} in the last 24 hours_`);
  return lines.join('\n');
}

async function sendEmailBriefing(user) {
  const hub = db.hub();

  // Deduplicate: only one email briefing per calendar date
  const dateStr = `email-${new Date().toLocaleDateString('en-GB')}`;
  const alreadySent = hub.prepare(
    'SELECT 1 FROM crm_briefing_log WHERE user = ? AND date_str = ?'
  ).get(user, dateStr);
  if (alreadySent) return;

  const text = buildEmailBriefingText(user);
  if (!text) {
    console.log(`[email] no emails to brief for ${user}`);
    return;
  }

  const sent = await pushGoogleChatBriefing(user, text);
  if (sent) {
    hub.prepare('INSERT INTO crm_briefing_log (id, user, date_str) VALUES (?, ?, ?)').run(uuid(), user, dateStr);
    console.log(`[email] Email digest sent for ${user} on ${dateStr}`);
  }
}

// ── CRM list (for API / display) ──────────────────────────────────────────────

function listContacts(user) {
  const hub = db.hub();
  const contacts = hub.prepare(`
    SELECT c.*, co.id AS company_id, co.name AS company_name, cc.role AS company_role
    FROM contacts c
    LEFT JOIN contact_companies cc ON cc.contact_id = c.id AND cc.is_primary = 1
    LEFT JOIN companies co ON co.id = cc.company_id
    WHERE c.user = ?
    ORDER BY c.name
  `).all(user);

  return contacts.map(c => ({
    ...c,
    facts: hub.prepare(
      "SELECT * FROM crm_facts WHERE contact_id = ? AND status NOT IN ('done', 'closed', 'archived') ORDER BY status DESC, created_at ASC"
    ).all(c.id),
  }));
}

module.exports = {
  processCrmCommand,
  buildBriefingText,
  buildEmailBriefingText,
  sendDailyBriefing,
  sendEmailBriefing,
  pushGoogleChatBriefing,
  fetchCalendarEvents,
  fetchTodayCalendarEvents,
  syncCalendarMeetings,
  listContacts,
  resolveContact,
  parseJsonArray,
};
