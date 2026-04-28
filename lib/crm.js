const fetch = require('node-fetch');
const db = require('./db');
const { uuid } = require('./id');

// ── Intent parsing ────────────────────────────────────────────────────────────

async function parseIntent(user, text) {
  const context = db.hub().prepare(
    'SELECT key, value FROM crm_context WHERE user = ? ORDER BY key'
  ).all(user);

  const contextStr = context.length
    ? 'Known context about this user\'s world:\n' + context.map(c => `- ${c.key} = ${c.value}`).join('\n') + '\n\n'
    : '';

  const prompt = `You are a personal CRM assistant. Parse the note below and return ONLY a JSON object.

${contextStr}Note: "${text}"

Return JSON in exactly this shape:
{
  "action": "new_fact" | "mark_done" | "close_followup" | "add_context",
  "contact": "person name or null",
  "fact": "clean enriched fact/action to store (use known context to enrich, e.g. append employer name)",
  "matches_fact": "partial description of existing fact being updated, or null",
  "follow_up": "auto follow-up text if action=mark_done (e.g. 'Ask [Name] how they got on with X'), else null",
  "context_key": "lowercase key if action=add_context, else null",
  "context_value": "value if action=add_context, else null"
}

Rules:
- new_fact: something to remember about a person, or an action item for them
- mark_done: user completed an action ("told X about Y", "spoke to X about Y", "sent X the Y")
- close_followup: the follow-up is resolved ("X loved it", "X got back to me about Y")
- add_context: world knowledge ("Beacon is my employer", "X's email is x@y.com", "X works at Z")
- Always enrich the fact with known context where relevant (e.g. "at work" → "at Beacon")`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}`);
  const data = await resp.json();
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

    let followUpMsg = '';
    if (intent.follow_up) {
      hub.prepare(`
        INSERT INTO crm_facts (id, user, contact_id, fact, status, source, parent_id)
        VALUES (?, ?, ?, ?, 'follow_up', ?, ?)
      `).run(uuid(), user, contact.id, intent.follow_up, source, matched?.id || null);
      followUpMsg = `\nFollow-up: *${intent.follow_up}*`;
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
    ...(ev.attendees || []),
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

function buildBriefingText(user, calendarEvents = []) {
  const hub = db.hub();
  const facts = hub.prepare(`
    SELECT f.*, c.name AS contact_name, c.aliases AS contact_aliases
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status IN ('active', 'follow_up')
    ORDER BY c.name, f.status DESC, f.created_at ASC
  `).all(user);

  if (!facts.length && !calendarEvents.length) return null;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines = [`*Morning Briefing — ${today}*`];

  // Calendar section: highlight contacts with meetings today
  if (calendarEvents.length) {
    lines.push('', '*Today\'s meetings:*');
    for (const ev of calendarEvents) {
      lines.push(`• ${ev.time ? ev.time + ' — ' : ''}${ev.summary}`);
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

async function fetchTodayCalendarEvents(user) {
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
    const tz = 'Europe/London';
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    return (resp.data.items || [])
      .filter(ev => ev.status !== 'cancelled' && ev.summary)
      .map(ev => ({
        summary: ev.summary,
        time: ev.start?.dateTime
          ? new Date(ev.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })
          : null,
        attendees: (ev.attendees || [])
          .filter(a => !a.self && a.displayName)
          .map(a => a.displayName),
      }));
  } catch (err) {
    console.warn(`[crm] calendar fetch failed for ${user}:`, err.message);
    return [];
  }
}

async function sendDailyBriefing(user, calendarEvents) {
  const hub = db.hub();
  const dateStr = new Date().toLocaleDateString('en-GB');

  const alreadySent = hub.prepare(
    'SELECT 1 FROM crm_briefing_log WHERE user = ? AND date_str = ?'
  ).get(user, dateStr);
  if (alreadySent) return;

  const events = calendarEvents ?? await fetchTodayCalendarEvents(user);
  const text = buildBriefingText(user, events);
  if (!text) return;

  const sent = await pushGoogleChatBriefing(user, text);
  if (sent) {
    hub.prepare(
      'INSERT INTO crm_briefing_log (id, user, date_str) VALUES (?, ?, ?)'
    ).run(uuid(), user, dateStr);
    console.log(`[crm] Briefing sent for ${user} on ${dateStr}`);
  }
}

// ── CRM list (for API / display) ──────────────────────────────────────────────

function listContacts(user) {
  const hub = db.hub();
  const contacts = hub.prepare(
    'SELECT * FROM contacts WHERE user = ? ORDER BY name'
  ).all(user);

  return contacts.map(c => ({
    ...c,
    facts: hub.prepare(
      "SELECT * FROM crm_facts WHERE contact_id = ? AND status IN ('active', 'follow_up') ORDER BY status DESC, created_at ASC"
    ).all(c.id),
  }));
}

module.exports = {
  processCrmCommand,
  buildBriefingText,
  sendDailyBriefing,
  pushGoogleChatBriefing,
  fetchTodayCalendarEvents,
  listContacts,
  resolveContact,
};
