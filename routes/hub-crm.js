const express = require('express');
const router = express.Router();
const fetch = require('../lib/fetch');
const { OAuth2Client } = require('google-auth-library');
const db = require('../lib/db');
const {
  processCrmCommand,
  listContacts,
  buildBriefingText,
  fetchTodayCalendarEvents,
  syncCalendarMeetings,
  parseJsonArray,
  syncContactVaultFact,
  syncContactVaultProfile,
} = require('../lib/crm');
const { readNote, searchNotes, writeNote } = require('../lib/obsidian-vault');
const { uuid } = require('../lib/id');
const {
  writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');
const {
  createTask, createSubtask, updateTask,
  syncTasks, completeTask, deleteTask, deleteTaskEverywhere, restoreTask,
  getTask, getCachedTasks,
} = require('../lib/google-tasks');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');

const googleChatClient = new OAuth2Client();
const GOOGLE_CHAT_ADDON_EMAIL_RE = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;

function todayIso() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function chatResponse(text, card) {
  const msg = { text: String(text || '').slice(0, 3500) };
  if (card?.cardsV2) msg.cardsV2 = card.cardsV2;
  return msg;
}

function isGoogleWorkspaceAddOnRequest(req) {
  return Boolean(req.body?.chat || String(req.headers['user-agent'] || '').includes('Google-gsuiteaddons'));
}

// replyOrText can be a plain string or { text, card } from handlers that produce cards
function googleChatReply(req, replyOrText) {
  const text = typeof replyOrText === 'object' ? (replyOrText.text || '') : replyOrText;
  const card = typeof replyOrText === 'object' ? replyOrText.card : undefined;
  const message = chatResponse(text, card);
  if (!isGoogleWorkspaceAddOnRequest(req)) return message;
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: { message },
      },
    },
  };
}

function cleanGoogleChatText(raw) {
  return String(raw || '')
    .replace(/<users\/[^>]+>/g, '')
    .replace(/@[^\s]+/g, '')
    .trim()
    .replace(/^\/(crm|hermes)\s*/i, '')
    .trim();
}

function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function verifyGoogleChatRequest(req) {
  const skip = process.env.GOOGLE_CHAT_VERIFY === 'false';
  if (skip) return true;

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!bearer) {
    console.warn('[google-chat] auth failed: missing bearer token');
    return false;
  }

  const audiences = [
    process.env.GOOGLE_CHAT_AUTH_AUDIENCE,
    process.env.GOOGLE_CHAT_PROJECT_NUMBER,
    'https://dchat.mclellan.scot/api/google-chat/hermes',
    '801490335247',
  ].filter(Boolean);

  const chatIssuer = 'chat@system.gserviceaccount.com';
  const isAllowedGoogleChatEmail = (email) =>
    email === chatIssuer || GOOGLE_CHAT_ADDON_EMAIL_RE.test(String(email || ''));

  try {
    for (const audience of audiences) {
      try {
        const ticket = await googleChatClient.verifyIdToken({ idToken: bearer, audience });
        const payload = ticket.getPayload();
        if (payload?.email_verified && isAllowedGoogleChatEmail(payload.email)) return true;
      } catch (_) {}
    }

    const certResp = await fetch(`https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(chatIssuer)}`);
    const certs = await certResp.json();
    for (const audience of audiences) {
      try {
        await googleChatClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [chatIssuer]);
        return true;
      } catch (_) {}
    }

    const claims = decodeJwtClaims(bearer) || {};
    console.warn(`[google-chat] auth failed: token did not verify for audiences ${audiences.join(', ')}; claims=${JSON.stringify({
      iss: claims.iss,
      aud: claims.aud,
      email: claims.email,
      azp: claims.azp,
    })}`);
    return false;
  } catch (err) {
    console.warn('[google-chat] auth failed:', err.message);
    return false;
  }
}

const { postToGoogleChatSpace } = require('../lib/google-chat');

function helpText() {
  return [
    '"Had a call with Karol - she is pushing for June" saves a CRM note',
    '"briefing" shows today\'s open CRM items',
    '"today" reads today\'s Obsidian daily note',
    '"search Dad physio" searches the vault',
    '"read Daily/2026-05-13.md" reads a vault note',
    '"remember ..." appends to today\'s daily note',
    '"follow up ..." appends a follow-up to today\'s daily note',
    '"linkedin <topic>" generates a scored LinkedIn post + image + adds to content calendar (include a URL to anchor research to that article)',
    '"remind me to X at/in Y" sets an escalating reminder',
    '"reminders" lists open reminders; reply "done 3", "snooze 3 2h", "ok 3", or "edit 3 new title at 3pm"',
    '"suggestions" lists AI suggestions; reply "accept 2", "dismiss 2", or "why 2"',
    '"who is Tom" looks up a contact',
    '"flights" shows upcoming flights',
    '"agenda" shows today\'s calendar, flights, and due reminders',
    '"regs" explains that regulatory monitoring now sends Nakai-only email',
    '"debrief" opens the end-of-day debrief',
    'Send a photo → extracted and saved to CRM',
  ].join('\n- ');
}

async function handleGoogleChatCommand(user, text, { spaceName = '' } = {}) {
  if (!text) return helpText();
  const lower = text.toLowerCase();

  if (lower === 'help') return helpText();

  // Reminder commands — regex-first so acks are instant and cost no tokens
  if (lower === 'reminders') {
    const { listOpenReminders } = require('../lib/reminders');
    const { buildReminderCard } = require('../lib/google-chat');
    const open = listOpenReminders(user);
    if (!open.length) return 'No open reminders. Say "remind me to X at Y" to set one.';
    return { text: `${open.length} open reminder${open.length !== 1 ? 's' : ''}`, card: buildReminderCard(open) };
  }

  if (lower === 'suggestions') {
    const { listOpenSuggestions } = require('../lib/suggestion-engine');
    const { buildSuggestionCard } = require('../lib/google-chat');
    const open = listOpenSuggestions(user);
    if (!open.length) return 'No open suggestions. The daily run looks at travel and content signals each morning.';
    return { text: `${open.length} open suggestion${open.length !== 1 ? 's' : ''}`, card: buildSuggestionCard(open) };
  }

  const suggestionCmd = lower.match(/^(accept|dismiss|why)\s+(\d+)$/);
  if (suggestionCmd) {
    const { acceptSuggestion, dismissSuggestion, whySuggestion } = require('../lib/suggestion-engine');
    const [, verb, code] = suggestionCmd;
    const result = verb === 'accept' ? await acceptSuggestion(user, code)
      : verb === 'dismiss' ? dismissSuggestion(user, code)
      : whySuggestion(user, code);
    return result.message;
  }

  const reminderCmd = lower.match(/^(done|did|ok|ack|snooze|cancel)\s+(\d+)\s*(.*)$/);
  if (reminderCmd) {
    const { doneReminder, ackReminder, snoozeReminder, cancelReminder } = require('../lib/reminders');
    const [, verb, code, rest] = reminderCmd;
    let result;
    if (verb === 'done' || verb === 'did') result = await doneReminder(user, code);
    else if (verb === 'snooze') result = snoozeReminder(user, code, rest);
    else if (verb === 'cancel') result = cancelReminder(user, code);
    else result = ackReminder(user, code);
    return result.message;
  }

  // edit <n> with no text — prompt with current title so user knows what they're editing
  const editPromptCmd = lower.match(/^edit\s+(\d+)$/);
  if (editPromptCmd) {
    const { findByShortCode } = require('../lib/reminders');
    const r = findByShortCode(user, editPromptCmd[1]);
    if (!r) return `No open reminder #${editPromptCmd[1]}.`;
    const when = r.next_fire_at
      ? new Date(r.next_fire_at * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' })
      : r.status;
    return `✏️ Editing #${r.short_code}: _"${r.title}"_ — ${when}\n\nType: \`edit ${r.short_code} <new title and/or new time>\`\nExamples:\n• \`edit ${r.short_code} Call the pharmacist at 3pm\`\n• \`edit ${r.short_code} at 9am tomorrow\`\n• \`edit ${r.short_code} Chase the consultant instead\``;
  }

  const editCmd = lower.match(/^edit\s+(\d+)\s+(.+)$/);
  if (editCmd) {
    const [, code, editText] = editCmd;
    const { findByShortCode, editReminder, dublinIsoToEpoch, epochAtNextDublin } = require('../lib/reminders');
    const r = findByShortCode(user, code);
    if (!r) return `No open reminder #${code}.`;

    // Use LLM to split edit text into optional new title + optional new time
    const nowIso = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Dublin' }).replace(' ', 'T');
    let newTitle = null;
    let newRemindAt = null;
    try {
      const parseResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: openRouterHeaders(TASK_CODES.HERMES_CRM_CAPTURE),
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: `Now is ${nowIso} Dublin time. I'm editing reminder #${code} whose current title is: "${r.title}"

Edit instruction: "${editText}"

Return JSON:
{
  "title": "new title if the instruction changes the title, else null to keep current",
  "remind_at_iso": "ISO 8601 datetime if the instruction specifies a new time, else null to keep current"
}

Examples:
- "Call the doctor at 3pm Friday" → title: "Call the doctor", remind_at_iso: "2026-06-20T15:00:00"
- "at 9am tomorrow" → title: null, remind_at_iso: "2026-06-19T09:00:00"
- "Chase the pharmacist instead" → title: "Chase the pharmacist instead", remind_at_iso: null
- "in 2h" → title: null, remind_at_iso: (now + 2 hours ISO)`,
          }],
        }),
      });
      if (parseResp.ok) {
        const data = await parseResp.json();
        const raw = (data.choices?.[0]?.message?.content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(raw);
        newTitle = parsed.title || null;
        newRemindAt = parsed.remind_at_iso ? dublinIsoToEpoch(parsed.remind_at_iso) : null;
      }
    } catch (e) {
      console.warn('[google-chat] edit parse:', e.message);
    }

    // Fallback: treat whole text as new title if parse failed
    if (!newTitle && !newRemindAt) newTitle = editText;

    const result = editReminder(user, code, { title: newTitle, remindAt: newRemindAt });
    return result.message;
  }

  if (lower === 'briefing' || lower === 'brief') {
    const events = await fetchTodayCalendarEvents(user);
    return buildBriefingText(user, events) || '_No open items._';
  }

  if (lower === 'today' || lower === 'daily') {
    const note = readNote(`Daily/${todayIso()}.md`);
    return note ? `${note.path}\n\n${note.content.slice(0, 3000)}` : `No daily note for ${todayIso()}.`;
  }

  if (lower.startsWith('search ') || lower.startsWith('find ')) {
    const query = text.replace(/^(search|find)\s+/i, '').trim();
    if (!query) return 'Search for what? Example: search Dad physio';
    const results = await searchNotes({ query, limit: 5 });
    if (!results.length) return `No vault matches for: ${query}`;
    return results.map((r, i) => `${i + 1}. ${r.path}\n${(r.excerpt || '').slice(0, 280)}`).join('\n\n');
  }

  if (lower.startsWith('read ')) {
    const notePath = text.slice(5).trim();
    if (!notePath) return 'Read which note? Example: read Daily/2026-05-13.md';
    const note = readNote(notePath);
    return note ? `${note.path}\n\n${note.content.slice(0, 3000)}` : `No such vault note: ${notePath}`;
  }

  if (lower.startsWith('remember ') || lower.startsWith('follow up ')) {
    const isFollowUp = lower.startsWith('follow up ');
    const body = text.slice(isFollowUp ? 10 : 9).trim();
    if (!body) return 'Append what?';
    const section = isFollowUp ? 'Follow-ups' : 'Remembered';
    writeNote({
      notePath: `Daily/${todayIso()}.md`,
      mode: 'append',
      content: `\n## ${section}\n- ${body}\n`,
    });
    try {
      await processCrmCommand(user, isFollowUp ? `follow up: ${body}` : body, 'google-chat');
    } catch (err) {
      console.warn('[google-chat] CRM side-write skipped:', err.message);
    }
    return `Added to Daily/${todayIso()}.md`;
  }

  if (lower.startsWith('linkedin ') || lower.startsWith('content ')) {
    const raw = text.replace(/^(linkedin|content)\s+/i, '').trim();
    if (!raw) return 'What topic? e.g. "linkedin Microsoft Teams new AI feature"';

    // Extract any URL present in the message — treat it as the primary source
    const urlMatch = raw.match(/https?:\/\/\S+/);
    let sourceUrl = null;
    let topic = raw;
    if (urlMatch) {
      sourceUrl = urlMatch[0].replace(/[.,;!?)]+$/, ''); // strip trailing punctuation
      topic = raw.replace(urlMatch[0], '').replace(/\s{2,}/g, ' ').trim() || raw;
    }

    if (!topic) return 'What topic? e.g. "linkedin Microsoft Teams new AI feature"';
    const { runPipeline } = require('../lib/linkedin-pipeline');

    setImmediate(async () => {
      try {
        const result = await runPipeline(user, topic, s => console.log('[linkedin]', s), null, sourceUrl);
        const sc = result.score || {};
        const overall = sc.overall_score || '?';
        const verdict = sc.recruiter_value || '';
        const emoji = overall >= 4 ? '🟢' : overall >= 3 ? '🟡' : '🔴';
        const postText = result.refinedDraft || result.draft;
        const lines = [
          `✅ *LinkedIn post ready — ${topic}*`,
          '',
          postText,
          '',
          `${emoji} *${overall}/5* ${verdict}`,
        ];
        const topFix1 = sc.top_fixes?.[0];
        if (topFix1) lines.push(`_Top fix: ${topFix1.problem} → ${topFix1.fix}_`);
        if (sc.recruiter_perspective) lines.push(`_${sc.recruiter_perspective}_`);
        if (result.carouselUrl) lines.push(`📄 Carousel: ${result.carouselUrl}`);
        if (result.sheetUrl) lines.push(`📋 ${result.sheetUrl}`);
        await postToGoogleChatSpace(spaceName, lines.join('\n'));
      } catch (err) {
        console.error('[linkedin] pipeline error:', err);
        await postToGoogleChatSpace(spaceName, `❌ LinkedIn pipeline failed: ${err.message}`);
      }
    });

    return sourceUrl
      ? `Working on a LinkedIn post about *${topic}* — anchoring research to your source article. I'll post the result here when ready (~30 seconds).`
      : `Working on a LinkedIn post about *${topic}*. I'll post the result here when ready (~30 seconds).`;
  }

  // ── Conversational queries ─────────────────────────────────────────────────

  const whoMatch = lower.match(/^who(?:'s| is)\s+(.+?)[\?.]?\s*$/);
  if (whoMatch) {
    const query = whoMatch[1].trim();
    const results = listContacts(user, query);
    if (!results.length) return `No contact found matching "${query}".`;
    const c = results[0];
    const company = c.company_name
      ? `${c.company_name}${c.company_role ? `, ${c.company_role}` : ''}`
      : null;
    const lines = [`*${c.name}*${company ? ` — ${company}` : ''}`];
    if (c.email) lines.push(`📧 ${c.email}`);
    const topFacts = (c.facts || []).slice(0, 5);
    if (topFacts.length) lines.push('', ...topFacts.map(f => `• ${f.fact}`));
    if (results.length > 1) lines.push(`\n_Also: ${results.slice(1, 4).map(r => r.name).join(', ')}_`);
    return lines.join('\n');
  }

  if (/^(?:my\s+)?flights?[\?]?$/.test(lower) || lower === 'next flight') {
    const upcoming = db.hub().prepare(`
      SELECT * FROM flights
      WHERE user = ? AND flight_date >= ?
      ORDER BY flight_date ASC, scheduled_dep ASC
      LIMIT 10
    `).all(user, todayIso());
    if (!upcoming.length) return 'No upcoming flights logged.';
    const lines = upcoming.map(f => {
      const dep = f.scheduled_dep ? f.scheduled_dep.slice(0, 5) : '?';
      const arr = f.scheduled_arr ? f.scheduled_arr.slice(0, 5) : '?';
      const badge = f.status !== 'scheduled' ? ` _(${f.status})_` : '';
      return `✈ *${f.flight_date}* ${f.flight_number} ${f.direction} ${dep}→${arr}${badge}`;
    });
    return `*Upcoming flights:*\n${lines.join('\n')}`;
  }

  if (lower === 'agenda' || lower === 'whats on' || lower === "what's on") {
    const [events, { listOpenReminders: lor }] = await Promise.all([
      fetchTodayCalendarEvents(user),
      Promise.resolve(require('../lib/reminders')),
    ]);
    const nowSecs = Math.floor(Date.now() / 1000);
    const dueToday = lor(user).filter(r => r.next_fire_at && r.next_fire_at <= nowSecs + 24 * 3600);
    const todayFlights = db.hub().prepare(
      'SELECT * FROM flights WHERE user = ? AND flight_date = ? ORDER BY scheduled_dep ASC'
    ).all(user, todayIso());
    const parts = [];
    if (events.length) {
      parts.push(`*Calendar today:*\n${events.map(e => `• ${e.summary}${e.time ? ' ' + e.time : ''}`).join('\n')}`);
    }
    if (todayFlights.length) {
      parts.push(`*Flights today:*\n${todayFlights.map(f => `✈ ${f.flight_number} ${f.direction}${f.scheduled_dep ? ' ' + f.scheduled_dep.slice(0, 5) : ''}`).join('\n')}`);
    }
    if (dueToday.length) {
      parts.push(`*Due today:*\n${dueToday.map(r => `• #${r.short_code} ${r.title}`).join('\n')}`);
    }
    return parts.length ? parts.join('\n\n') : 'Nothing on today.';
  }

  if (lower === 'regs' || lower === 'regulatory') {
    return 'Regulatory monitoring is configured as a Nakai-only email digest. It no longer posts regulatory updates into Chat or the Hub.';
  }

  if (lower === 'debrief') {
    const hubUrl = (process.env.HUB_BASE_URL || 'https://dchat.mclellan.scot').replace(/\/$/, '');
    return {
      text: 'Ready when you are.',
      card: {
        cardsV2: [{
          cardId: 'debrief',
          card: {
            header: { title: '🎙 End-of-day debrief', subtitle: 'Voice interview — tap to start' },
            sections: [{
              widgets: [{
                buttonList: {
                  buttons: [
                    { text: 'Start debrief →', onClick: { openLink: { url: `${hubUrl}/debrief` } } },
                  ],
                },
              }],
            }],
          },
        }],
      },
    };
  }

  const result = await processCrmCommand(user, text, 'google-chat');
  return result.ok ? result.message : result.message || 'Could not process that note.';
}

// ── CRM endpoints ─────────────────────────────────────────────────────────────
router.get('/api/crm/contacts', requireAuth, (req, res) => {
  const contacts = listContacts(req.hubUser, req.query.q);
  res.json(contacts);
});

router.post('/api/crm/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const hub = db.hub();
  const existing = hub.prepare('SELECT id FROM contacts WHERE user = ? AND name = ?').get(req.hubUser, name);
  if (existing) return res.status(409).json({ error: 'Contact already exists', id: existing.id });
  const id = uuid();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const notes = String(req.body.notes || '').trim() || null;
  hub.prepare('INSERT INTO contacts (id, user, name, email, notes) VALUES (?, ?, ?, ?, ?)').run(
    id, req.hubUser, name, email, notes
  );
  syncContactVaultProfile(req.hubUser, id);
  res.json({ ok: true, id, name });
});

router.post('/api/crm/contacts/:id/merge', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const source = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!source) return res.status(404).json({ error: 'Source contact not found' });
  const targetId = String(req.body.targetId || '').trim();
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  if (targetId === source.id) return res.status(400).json({ error: 'Cannot merge a contact into itself' });
  const target = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(targetId, req.hubUser);
  if (!target) return res.status(404).json({ error: 'Target contact not found' });

  hub.transaction(() => {
    // Move facts owned by source → target (skip exact-duplicate facts)
    const sourceFacts = hub.prepare('SELECT id, fact FROM crm_facts WHERE contact_id = ? AND user = ?').all(source.id, req.hubUser);
    const targetFactTexts = new Set(
      hub.prepare('SELECT fact FROM crm_facts WHERE contact_id = ? AND user = ?').all(targetId, req.hubUser).map(f => f.fact)
    );
    const moveFact = hub.prepare('UPDATE crm_facts SET contact_id = ? WHERE id = ?');
    const deleteFact = hub.prepare('DELETE FROM crm_facts WHERE id = ?');
    for (const f of sourceFacts) {
      if (targetFactTexts.has(f.fact)) deleteFact.run(f.id);
      else moveFact.run(targetId, f.id);
    }

    // Rewrite linked_contacts in any fact that references source
    const linkedFacts = hub.prepare(
      "SELECT id, linked_contacts FROM crm_facts WHERE user = ? AND linked_contacts LIKE ?"
    ).all(req.hubUser, `%"${source.id}"%`);
    const updateLinks = hub.prepare('UPDATE crm_facts SET linked_contacts = ? WHERE id = ?');
    for (const fact of linkedFacts) {
      const ids = parseJsonArray(fact.linked_contacts).map(id => id === source.id ? targetId : id);
      const deduped = [...new Set(ids)];
      updateLinks.run(JSON.stringify(deduped), fact.id);
    }

    // Move meeting attendances (skip duplicates)
    const sourceMeetings = hub.prepare('SELECT meeting_id FROM meeting_attendees WHERE contact_id = ?').all(source.id);
    const targetMeetingIds = new Set(
      hub.prepare('SELECT meeting_id FROM meeting_attendees WHERE contact_id = ?').all(targetId).map(r => r.meeting_id)
    );
    const moveAttendee = hub.prepare('UPDATE meeting_attendees SET contact_id = ? WHERE contact_id = ? AND meeting_id = ?');
    const deleteAttendee = hub.prepare('DELETE FROM meeting_attendees WHERE contact_id = ? AND meeting_id = ?');
    for (const { meeting_id } of sourceMeetings) {
      if (targetMeetingIds.has(meeting_id)) deleteAttendee.run(source.id, meeting_id);
      else moveAttendee.run(targetId, source.id, meeting_id);
    }

    // Move project links (skip duplicates)
    const sourceProjects = hub.prepare('SELECT project_id FROM contact_projects WHERE contact_id = ?').all(source.id);
    const targetProjectIds = new Set(
      hub.prepare('SELECT project_id FROM contact_projects WHERE contact_id = ?').all(targetId).map(r => r.project_id)
    );
    const deleteProj = hub.prepare('DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?');
    const moveProj = hub.prepare('UPDATE contact_projects SET contact_id = ? WHERE contact_id = ? AND project_id = ?');
    for (const { project_id } of sourceProjects) {
      if (targetProjectIds.has(project_id)) deleteProj.run(source.id, project_id);
      else moveProj.run(targetId, source.id, project_id);
    }

    // Move company links (skip duplicates)
    const sourceCompanies = hub.prepare('SELECT company_id FROM contact_companies WHERE contact_id = ?').all(source.id);
    const targetCompanyIds = new Set(
      hub.prepare('SELECT company_id FROM contact_companies WHERE contact_id = ?').all(targetId).map(r => r.company_id)
    );
    const deleteCo = hub.prepare('DELETE FROM contact_companies WHERE contact_id = ? AND company_id = ?');
    const moveCo = hub.prepare('UPDATE contact_companies SET contact_id = ? WHERE contact_id = ? AND company_id = ?');
    for (const { company_id } of sourceCompanies) {
      if (targetCompanyIds.has(company_id)) deleteCo.run(source.id, company_id);
      else moveCo.run(targetId, source.id, company_id);
    }

    // Delete source contact
    hub.prepare('DELETE FROM contacts WHERE id = ?').run(source.id);
  })();

  res.json({ ok: true, merged: source.name, into: target.name, targetId });
});

router.get('/api/crm/briefing', requireAuth, async (req, res) => {
  try {
    const events = await fetchTodayCalendarEvents(req.hubUser);
    const text = buildBriefingText(req.hubUser, events);
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Google Chat HTTP endpoint. This bypasses Apps Script entirely:
// configure Google Chat API connection settings to HTTP endpoint URL:
// https://dchat.mclellan.scot/api/google-chat/hermes
router.post('/api/google-chat/hermes', writeLimiter, async (req, res) => {
  const authed = await verifyGoogleChatRequest(req);
  if (!authed) return res.status(401).json({ error: 'Unauthorized' });

  const event = req.body?.chat || req.body || {};
  const type = event.type || '';
  const message = event.message || event.messagePayload?.message || {};
  const user = process.env.GOOGLE_CHAT_USER || req.hubUser || 'douglas';

  try {
    if (type === 'ADDED_TO_SPACE' || event.addedToSpacePayload) {
      return res.json(googleChatReply(req, 'McLellan Hermes connected.\n\n- ' + helpText()));
    }

    if (type === 'REMOVED_FROM_SPACE' || event.removedFromSpacePayload) {
      console.log('[google-chat] removed from space', event.space?.name || '');
      return res.json({});
    }

    const spaceName = event.space?.name || message.space?.name || '';
    // Remember where Douglas talks to hermes so reminders can post into a
    // space where replies actually reach this endpoint (webhooks are one-way)
    if (spaceName) {
      db.hub().prepare(`
        INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_hermes_space', ?)
        ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
      `).run(uuid(), user, spaceName);
    }

    // Card button clicks arrive as CARD_CLICKED with the action in event.action.actionMethodName.
    // The function name is whatever string we put in the button's onClick.action.function,
    // so it maps directly to existing command handlers — no new logic needed.
    if (type === 'CARD_CLICKED') {
      const actionText = event.action?.actionMethodName || event.common?.invokedFunction || '';
      if (!actionText) return res.json({});
      const reply = await handleGoogleChatCommand(user, actionText, { spaceName });
      console.log(`[google-chat] card click action="${actionText}"`);
      return res.json(googleChatReply(req, reply));
    }

    // Image/photo attachments — download and extract CRM info via vision model.
    // Fires async so Google Chat gets an immediate ack; result posts back into the space.
    const attachments = message.attachment || [];
    const imageAtt = attachments.find(a => String(a.contentType || '').startsWith('image/'));
    if (imageAtt) {
      const resourceName = imageAtt.attachmentDataRef?.resourceName || imageAtt.name;
      if (resourceName && spaceName) {
        setImmediate(async () => {
          try {
            const { downloadChatAttachment } = require('../lib/google-chat');
            const b64 = await downloadChatAttachment(resourceName);
            if (!b64) {
              await postToGoogleChatSpace(spaceName, '⚠️ Could not download the image — try sharing it from Drive instead.');
              return;
            }
            const orKey = process.env.OPENROUTER_API_KEY;
            if (!orKey) { await postToGoogleChatSpace(spaceName, '⚠️ OPENROUTER_API_KEY not set.'); return; }
            const mimeType = imageAtt.contentType || 'image/jpeg';
            const nowIso = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Dublin' }).replace(' ', 'T');

            // Single vision + structure call: extract and decide what to do in one pass
            const started = Date.now();
            const visionResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: openRouterHeaders(TASK_CODES.HERMES_IMAGE_VISION),
              body: JSON.stringify({
                model: 'google/gemini-2.5-flash',
                response_format: { type: 'json_object' },
                messages: [{
                  role: 'user',
                  content: [
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } },
                    { type: 'text', text: `Now is ${nowIso} (Europe/Dublin). Analyse this image for a personal knowledge management system. Extract ALL useful information — names, dates, medication, test results, tasks, any visible text.

Return JSON:
{
  "summary": "one-sentence summary of what this image shows",
  "contact_name": "full name of the primary person this relates to, or null",
  "crm_note": "complete CRM note to save — write naturally including the person's name if known, all facts, any context",
  "action_items": [
    {
      "title": "specific action to take",
      "due_iso": "ISO 8601 datetime if a date/time is visible or implied, else null",
      "kind": "reminder | task | fact",
      "kind_reason": "one phrase explaining the classification"
    }
  ],
  "obsidian_note": "markdown paragraph to log in today's daily note capturing what was seen and why it matters, or null if nothing journal-worthy"
}

Classification rules for kind:
- "reminder": time-sensitive nudge that should fire in chat (e.g. "call the doctor", "collect prescription", "pay this by Friday")
- "task": a concrete piece of work to add to a task list (e.g. "draft the report", "book flights", "review document")
- "fact": informational only — record it but no action needed (e.g. a bill amount already paid, a reference number, a test result to note)

Bills and invoices: if unpaid with a due date → "reminder". If already paid or just for records → "fact".

Be thorough. If you see a prescription, extract drug names, dosages, instructions. If a letter, extract sender, date, key points, any deadlines. If a whiteboard or handwritten note, transcribe it. If a business card, extract everything.` },
                  ],
                }],
              }),
            });
            if (!visionResp.ok) throw new Error(`Vision model ${visionResp.status}: ${await visionResp.text()}`);
            const visionData = await visionResp.json();
            logUsageFromResponse({
              user, feature: 'hermes-image-vision', modelKey: 'hermes_image_vision',
              fallbackModelId: 'google/gemini-2.5-flash', data: visionData,
              durationMs: Date.now() - started, taskCode: TASK_CODES.HERMES_IMAGE_VISION,
            });

            const raw = visionData.choices?.[0]?.message?.content?.trim() || '';
            const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
            let parsed;
            try { parsed = JSON.parse(cleaned); } catch { parsed = null; }
            if (!parsed) { await postToGoogleChatSpace(spaceName, '⚠️ Could not parse image content.'); return; }

            const { summary, contact_name, crm_note, action_items = [], obsidian_note } = parsed;
            const lines = [`📷 *${summary || 'Image captured'}*`];

            // ── Contact resolution ───────────────────────────────────────────
            let resolvedContact = null;
            if (contact_name) {
              const matches = listContacts(user, contact_name);
              resolvedContact = matches[0] || null;
              lines.push(resolvedContact
                ? `Links to: *${resolvedContact.name}*`
                : `Person mentioned: ${contact_name} _(not in CRM yet)_`);
            }

            // ── CRM note ─────────────────────────────────────────────────────
            if (crm_note) {
              const crmResult = await processCrmCommand(user, crm_note, 'google-chat');
              lines.push(crmResult.ok ? '✅ CRM note saved' : `⚠️ CRM: ${crmResult.message}`);
            }

            // ── Action items — routed by kind ─────────────────────────────────
            if (action_items.length) {
              const { createReminder, dublinIsoToEpoch, epochAtNextDublin } = require('../lib/reminders');
              const nowSecs = Math.floor(Date.now() / 1000);
              for (const item of action_items) {
                const kind = item.kind || 'reminder';

                if (kind === 'fact') {
                  // Informational only — already captured in crm_note, just acknowledge
                  lines.push(`📎 Noted: "${item.title}"`);
                  continue;
                }

                if (kind === 'task') {
                  try {
                    const t = await createTask(user, {
                      title: item.title,
                      notes: item.kind_reason || '',
                      due: item.due_iso || null,
                      source: 'photo',
                      sourceId: resolvedContact?.id || null,
                    });
                    lines.push(`✅ Task: "${item.title}"`);
                  } catch (e) {
                    lines.push(`⚠️ Task failed: "${item.title}" — ${e.message}`);
                  }
                  continue;
                }

                // Default: reminder
                const remindAt = item.due_iso
                  ? (dublinIsoToEpoch(item.due_iso) || epochAtNextDublin(9, 0))
                  : epochAtNextDublin(9, 0);
                const r = createReminder(user, {
                  title: item.title,
                  remindAt: Math.max(remindAt, nowSecs + 60),
                  source: 'photo',
                  kind: resolvedContact ? 'fact' : 'adhoc',
                  targetId: resolvedContact ? resolvedContact.id : null,
                });
                const when = new Date(Math.max(remindAt, nowSecs + 60) * 1000).toLocaleString('en-GB', {
                  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
                });
                lines.push(r ? `✅ Reminder: "${item.title}" — ${when}` : `⚠️ Could not create reminder: "${item.title}"`);
              }
            }

            // ── Obsidian daily note ───────────────────────────────────────────
            if (obsidian_note) {
              try {
                writeNote({
                  notePath: `Daily/${todayIso()}.md`,
                  mode: 'append',
                  content: `\n## 📷 ${summary || 'Photo capture'}\n${obsidian_note}\n`,
                });
                lines.push('✅ Added to today\'s daily note');
              } catch (e) {
                lines.push(`⚠️ Obsidian append failed: ${e.message}`);
              }
            }

            await postToGoogleChatSpace(spaceName, lines.join('\n'));
          } catch (err) {
            console.error('[google-chat] image processing:', err.message);
            await postToGoogleChatSpace(spaceName, `❌ Image processing failed: ${err.message}`);
          }
        });
        return res.json(googleChatReply(req, '📷 Got your image — extracting and routing to CRM, reminders, and Obsidian…'));
      }
    }

    const text = cleanGoogleChatText(message.argumentText || message.text || '');
    const reply = await handleGoogleChatCommand(user, text, { spaceName });
    console.log(`[google-chat] handled ${type || 'event'} addon=${isGoogleWorkspaceAddOnRequest(req)} text_chars=${text.length} reply_chars=${String(reply || '').length}`);
    return res.json(googleChatReply(req, reply));
  } catch (err) {
    console.error('[google-chat]', err);
    return res.json(googleChatReply(req, 'Error: ' + err.message));
  }
});

// Hermes (or any external agent) posts a /crm note here
// Secured by a shared secret: Authorization: Bearer <HERMES_WEBHOOK_SECRET>
router.post('/api/crm/webhook', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { text, source = 'hermes', dedup_key } = req.body;
  const user = req.hubUser || req.body.user;
  if (!text || !user) return res.status(400).json({ error: 'text and user required' });

  // Dedup: reject retries from the same message ID within 5 minutes
  if (dedup_key) {
    const hub = db.hub();
    const dedupCtxKey = `_dedup_${dedup_key.replace(/[^a-z0-9_/-]/gi, '_')}`;
    const existing = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, dedupCtxKey);
    if (existing && (Date.now() - parseInt(existing.value)) < 5 * 60 * 1000) {
      return res.json({ ok: true, message: 'Duplicate ignored' });
    }
    hub.prepare(`INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value`)
      .run(uuid(), user, dedupCtxKey, Date.now().toString());
  }

  try {
    const result = await processCrmCommand(user, text, source);
    res.json(result);
  } catch (err) {
    console.error('[crm webhook]', err);
    res.status(500).json({ error: err.message });
  }
});

// On-demand briefing push (callable from Google Chat bot or Hermes)
router.post('/api/crm/briefing-push', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const user = req.hubUser || req.body.user;
  if (!user) return res.status(400).json({ error: 'user required' });

  try {
    const { sendDailyBriefing } = require('../lib/crm');
    const hub = db.hub();
    const existing = hub.prepare(
      `SELECT id FROM crm_context WHERE user = ? AND key = '_briefing_push_lock' AND CAST(value AS INTEGER) > ?`
    ).get(user, Date.now() - 5 * 60 * 1000);
    if (existing) return res.json({ ok: true, message: 'Briefing already sent recently' });

    hub.prepare(`INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_briefing_push_lock', ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value`)
      .run(uuid(), user, Date.now().toString());

    res.json({ ok: true, message: 'Briefing push started' });
    sendDailyBriefing(user).catch(err => console.error('[crm briefing-push]', err));
  } catch (err) {
    console.error('[crm briefing-push]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CRM view page ─────────────────────────────────────────────────────────────
router.get('/crm', requireAuth, (req, res) => {
  res.redirect('/crm/contacts');
});

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function crmPageData(user) {
  return {
    user,
    nav: [
      { href: '/crm/contacts', label: 'People' },
      { href: '/crm/companies', label: 'Companies' },
      { href: '/crm/meetings', label: 'Meetings' },
      { href: '/crm/tasks', label: 'Tasks' },
      { href: '/crm/reminders', label: 'Reminders' },
      { href: '/crm/projects', label: 'Projects' },
    ],
  };
}

function safeBack(req, fallback) {
  try {
    const url = new URL(String(req.headers.referer || ''), 'http://local');
    return url.pathname.startsWith('/crm/') ? `${url.pathname}${url.search}` : fallback;
  } catch {
    return fallback;
  }
}

function setPrimaryCompany(hub, contactId, companyId) {
  return hub.transaction(() => {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contactId);
    return hub.prepare(`
      UPDATE contact_companies SET is_primary = 1
      WHERE contact_id = ? AND company_id = ?
    `).run(contactId, companyId);
  })();
}

function promoteFirstLinkedCompany(hub, contactId) {
  const next = hub.prepare(`
    SELECT cc.company_id
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY co.name
    LIMIT 1
  `).get(contactId);
  if (next) setPrimaryCompany(hub, contactId, next.company_id);
}

router.get('/crm/contacts', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const contacts = listContacts(req.hubUser, q);
  res.render('hub/crm', { ...crmPageData(req.hubUser), contacts, q });
});

router.post('/crm/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Name required');
  const hub = db.hub();
  const id = uuid();
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  hub.prepare('INSERT INTO contacts (id, user, name, email, notes) VALUES (?, ?, ?, ?, ?)').run(
    id, req.hubUser, name, email, String(req.body.notes || '').trim()
  );
  syncContactVaultProfile(req.hubUser, id);
  res.redirect('/crm/contact/' + id);
});

router.get('/crm/contact/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT * FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).send('Contact not found');

  const companies = hub.prepare(`
    SELECT co.*, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY cc.is_primary DESC, co.name
  `).all(contact.id);
  const allMeetings = hub.prepare(`
    SELECT m.*, co.name AS company_name
    FROM meeting_attendees ma
    JOIN meetings m ON m.id = ma.meeting_id
    LEFT JOIN companies co ON co.id = m.company_id
    WHERE ma.contact_id = ? AND m.user = ?
    ORDER BY m.meeting_date ASC, m.meeting_time ASC
  `).all(contact.id, req.hubUser);
  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const upcomingMeetings = allMeetings.filter(m => m.meeting_date >= todayIsoStr);
  const pastMeetings = allMeetings.filter(m => m.meeting_date < todayIsoStr).reverse();
  const meetings = allMeetings; // kept for coworker logic below
  const showHistory = req.query.show_history === '1';
  const allFacts = hub.prepare(`
    SELECT f.*, c.name AS subject_name, m.title AS meeting_title, co.name AS company_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    LEFT JOIN meetings m ON m.id = f.meeting_id
    LEFT JOIN companies co ON co.id = f.company_id
    WHERE f.user = ? AND f.status != 'wrong' ${showHistory ? '' : "AND f.status != 'archived'"}
    ORDER BY f.created_at DESC
  `).all(req.hubUser);
  const facts = allFacts.filter(f => f.contact_id === contact.id || parseJsonArray(f.linked_contacts).includes(contact.id));
  const contactMap = new Map(hub.prepare('SELECT id, name FROM contacts WHERE user = ?').all(req.hubUser).map(c => [c.id, c]));
  const coworkerIds = new Set();
  for (const meeting of meetings) {
    for (const row of hub.prepare('SELECT contact_id FROM meeting_attendees WHERE meeting_id = ?').all(meeting.id)) {
      if (row.contact_id !== contact.id) coworkerIds.add(row.contact_id);
    }
  }
  for (const fact of facts) {
    if (fact.contact_id !== contact.id) coworkerIds.add(fact.contact_id);
    for (const id of parseJsonArray(fact.linked_contacts)) if (id !== contact.id) coworkerIds.add(id);
  }
  const workedWith = [...coworkerIds].map(id => contactMap.get(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const tasks = getCachedTasks(req.hubUser, { contactId: contact.id }, showHistory);

  const linkedProjects = hub.prepare(`
    SELECT p.*, cp.role FROM contact_projects cp
    JOIN projects p ON p.id = cp.project_id
    WHERE cp.contact_id = ? ORDER BY p.name
  `).all(contact.id);
  const allProjects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  const linkedProjectIds = new Set(linkedProjects.map(p => p.id));
  const availableProjects = allProjects.filter(p => !linkedProjectIds.has(p.id));

  const linkedCompanyIds = new Set(companies.map(c => c.id));
  const allCompanies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableCompanies = allCompanies.filter(c => !linkedCompanyIds.has(c.id));

  res.render('hub/crm-contact', {
    ...crmPageData(req.hubUser), contact, companies,
    meetings, upcomingMeetings, pastMeetings,
    facts, workedWith, tasks, showHistory,
    linkedProjects, availableProjects, availableCompanies,
  });
});

router.get('/crm/companies', requireAuth, (req, res) => {
  const companies = db.hub().prepare(`
    SELECT co.*,
      COUNT(DISTINCT cc.contact_id) AS contact_count,
      COUNT(DISTINCT m.id) AS meeting_count
    FROM companies co
    LEFT JOIN contact_companies cc ON cc.company_id = co.id
    LEFT JOIN meetings m ON m.company_id = co.id
    WHERE co.user = ?
    GROUP BY co.id
    ORDER BY co.name
  `).all(req.hubUser);
  res.render('hub/crm-companies', { ...crmPageData(req.hubUser), companies });
});

router.post('/crm/companies', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Company name required');
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO companies (id, user, name, type, website, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, req.hubUser, name, String(req.body.type || '').trim() || null,
    String(req.body.website || '').trim() || null, String(req.body.notes || '').trim() || null
  );
  res.redirect(`/crm/company/${id}`);
});

router.get('/crm/company/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT * FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!company) return res.status(404).send('Company not found');
  const contacts = hub.prepare(`
    SELECT c.*, cc.role, cc.is_primary
    FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.company_id = ? ORDER BY c.name
  `).all(company.id);
  const allCompanyMeetings = hub.prepare(`
    SELECT * FROM meetings WHERE user = ? AND company_id = ?
    ORDER BY meeting_date ASC, meeting_time ASC
  `).all(req.hubUser, company.id);
  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const upcomingMeetings = allCompanyMeetings.filter(m => m.meeting_date >= todayIsoStr);
  const pastMeetings = allCompanyMeetings.filter(m => m.meeting_date < todayIsoStr).reverse();
  const meetings = allCompanyMeetings;
  const contactIds = new Set(contacts.map(c => c.id));
  const facts = hub.prepare(`
    SELECT f.*, c.name AS subject_name, m.title AS meeting_title
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    LEFT JOIN meetings m ON m.id = f.meeting_id
    WHERE f.user = ?
    ORDER BY f.created_at DESC
  `).all(req.hubUser).filter(f =>
    f.company_id === company.id
    || contactIds.has(f.contact_id)
    || parseJsonArray(f.linked_contacts).some(id => contactIds.has(id))
  );
  const availableContacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const showHistory = req.query.show_history === '1';
  const tasks = getCachedTasks(req.hubUser, { companyId: company.id }, showHistory);

  res.render('hub/crm-company', {
    ...crmPageData(req.hubUser), company, contacts,
    meetings, upcomingMeetings, pastMeetings,
    facts, availableContacts, tasks, showHistory,
  });
});

router.post('/crm/company/:id/contacts', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.body.contact_id, req.hubUser);
  if (!company || !contact) return res.status(404).send('Company or contact not found');
  const hasPrimary = hub.prepare(
    'SELECT 1 FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(contact.id);
  const makePrimary = Boolean(req.body.is_primary) || !hasPrimary;
  if (makePrimary) {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contact.id);
  }
  hub.prepare(`
    INSERT INTO contact_companies (contact_id, company_id, role, is_primary)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contact_id, company_id) DO UPDATE SET role = excluded.role, is_primary = excluded.is_primary
  `).run(contact.id, company.id, String(req.body.role || '').trim() || null, makePrimary ? 1 : 0);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.redirect(`/crm/company/${company.id}`);
});

router.post('/crm/company/:id', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Company name required');
  const result = hub.prepare(`
    UPDATE companies SET name = ?, type = ?, website = ?, notes = ?
    WHERE id = ? AND user = ?
  `).run(
    name, String(req.body.type || '').trim() || null,
    String(req.body.website || '').trim() || null, String(req.body.notes || '').trim() || null,
    req.params.id, req.hubUser
  );
  if (!result.changes) return res.status(404).send('Company not found');
  for (const contact of hub.prepare(
    'SELECT contact_id AS id FROM contact_companies WHERE company_id = ?'
  ).all(req.params.id)) {
    syncContactVaultProfile(req.hubUser, contact.id);
  }
  res.redirect(`/crm/company/${req.params.id}`);
});

router.post('/crm/company/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!company) return res.status(404).send('Company not found');
  const contactIds = hub.prepare(
    'SELECT contact_id AS id FROM contact_companies WHERE company_id = ?'
  ).all(company.id);
  hub.transaction(() => {
    hub.prepare('DELETE FROM contact_companies WHERE company_id = ?').run(company.id);
    hub.prepare('UPDATE meetings SET company_id = NULL WHERE company_id = ? AND user = ?').run(company.id, req.hubUser);
    hub.prepare('UPDATE crm_facts SET company_id = NULL WHERE company_id = ? AND user = ?').run(company.id, req.hubUser);
    hub.prepare('DELETE FROM companies WHERE id = ?').run(company.id);
  })();
  for (const contact of contactIds) syncContactVaultProfile(req.hubUser, contact.id);
  res.redirect('/crm/companies');
});

router.get('/crm/meetings', requireAuth, (req, res) => {
  const hub = db.hub();
  const meetings = hub.prepare(`
    SELECT m.*, co.name AS company_name, COUNT(ma.contact_id) AS attendee_count
    FROM meetings m
    LEFT JOIN companies co ON co.id = m.company_id
    LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
    WHERE m.user = ?
    GROUP BY m.id
    ORDER BY m.meeting_date DESC, m.meeting_time DESC
  `).all(req.hubUser);
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-meetings', {
    ...crmPageData(req.hubUser), meetings, contacts, companies, query: req.query,
  });
});

router.post('/crm/meetings', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meeting_date || '').trim();
  if (!title || !meetingDate) return res.status(400).send('Title and date required');
  const id = uuid();
  const requestedCompanyId = String(req.body.company_id || '').trim();
  const company = requestedCompanyId
    ? hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(requestedCompanyId, req.hubUser)
    : null;
  const create = hub.transaction(() => {
    hub.prepare(`
      INSERT INTO meetings
        (id, user, title, meeting_date, meeting_time, duration_mins, location, notes, company_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(
      id, req.hubUser, title, meetingDate, String(req.body.meeting_time || '').trim() || null,
      Number(req.body.duration_mins) || null, String(req.body.location || '').trim() || null,
      String(req.body.notes || '').trim() || null, company?.id || null
    );
    const insert = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
    for (const contactId of asArray(req.body.attendee_ids)) {
      const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(contactId, req.hubUser);
      if (contact) insert.run(id, contact.id);
    }
  });
  create();
  res.redirect(`/crm/meeting/${id}`);
});

router.post('/crm/meetings/sync-calendar', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const result = await syncCalendarMeetings(req.hubUser);
    res.redirect(`/crm/meetings?synced=${result.events}&matched=${result.attendeesMatched}`);
  } catch (err) {
    console.error('[crm calendar sync]', err);
    res.status(500).send(`Calendar sync failed: ${err.message}`);
  }
});

router.get('/crm/meeting/:id', requireAuth, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare(`
    SELECT m.*, co.name AS company_name
    FROM meetings m LEFT JOIN companies co ON co.id = m.company_id
    WHERE m.id = ? AND m.user = ?
  `).get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  const attendees = hub.prepare(`
    SELECT c.* FROM meeting_attendees ma JOIN contacts c ON c.id = ma.contact_id
    WHERE ma.meeting_id = ? ORDER BY c.name
  `).all(meeting.id);
  const facts = hub.prepare(`
    SELECT f.*, c.name AS subject_name
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.meeting_id = ?
    ORDER BY f.created_at DESC
  `).all(req.hubUser, meeting.id);
  const contactMap = new Map(hub.prepare('SELECT id, name FROM contacts WHERE user = ?').all(req.hubUser).map(c => [c.id, c]));
  const touchedIds = new Set(attendees.map(c => c.id));
  for (const fact of facts) {
    touchedIds.add(fact.contact_id);
    for (const id of parseJsonArray(fact.linked_contacts)) touchedIds.add(id);
  }
  const touchedContacts = [...touchedIds].map(id => contactMap.get(id)).filter(Boolean);
  const contacts = [...contactMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-meeting', {
    ...crmPageData(req.hubUser), meeting, attendees, facts, touchedContacts, contacts, companies,
  });
});

router.post('/crm/meeting/:id/fact', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT * FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.body.contact_id, req.hubUser);
  const fact = String(req.body.fact || '').trim();
  const factType = ['fact', 'decision', 'action', 'note'].includes(req.body.fact_type) ? req.body.fact_type : 'fact';
  if (!meeting || !contact || !fact) return res.status(400).send('Meeting, subject, and text required');
  const validContactIds = new Set(
    hub.prepare('SELECT id FROM contacts WHERE user = ?').all(req.hubUser).map(row => row.id)
  );
  const linked = asArray(req.body.linked_contacts)
    .filter(id => id !== contact.id && validContactIds.has(id));
  hub.prepare(`
    INSERT INTO crm_facts
      (id, user, contact_id, fact, status, source, meeting_id, company_id, linked_contacts, fact_type)
    VALUES (?, ?, ?, ?, 'active', 'meeting', ?, ?, ?, ?)
  `).run(uuid(), req.hubUser, contact.id, fact, meeting.id, meeting.company_id, JSON.stringify(linked), factType);
  res.redirect(`/crm/meeting/${meeting.id}`);
});

router.post('/crm/meeting/:id', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT id FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  const title = String(req.body.title || '').trim();
  const meetingDate = String(req.body.meeting_date || '').trim();
  if (!title || !meetingDate) return res.status(400).send('Title and date required');
  const company = req.body.company_id
    ? hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser)
    : null;
  hub.transaction(() => {
    hub.prepare(`
      UPDATE meetings SET title = ?, meeting_date = ?, meeting_time = ?, duration_mins = ?,
        location = ?, notes = ?, company_id = ?
      WHERE id = ? AND user = ?
    `).run(
      title, meetingDate,
      String(req.body.meeting_time || '').trim() || null, Number(req.body.duration_mins) || null,
      String(req.body.location || '').trim() || null, String(req.body.notes || '').trim() || null,
      company?.id || null, meeting.id, req.hubUser
    );
    hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
    const insert = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
    const validIds = new Set(hub.prepare('SELECT id FROM contacts WHERE user = ?').all(req.hubUser).map(row => row.id));
    for (const contactId of asArray(req.body.attendee_ids)) {
      if (validIds.has(contactId)) insert.run(meeting.id, contactId);
    }
  })();
  res.redirect(`/crm/meeting/${meeting.id}`);
});

router.post('/crm/meeting/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const meeting = hub.prepare('SELECT id FROM meetings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!meeting) return res.status(404).send('Meeting not found');
  hub.transaction(() => {
    hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
    hub.prepare('UPDATE crm_facts SET meeting_id = NULL WHERE meeting_id = ? AND user = ?').run(meeting.id, req.hubUser);
    hub.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  })();
  res.redirect('/crm/meetings');
});

router.post('/crm/facts/:id/complete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(`
    UPDATE crm_facts SET status = 'done', updated_at = unixepoch()
    WHERE id = ? AND user = ?
  `).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).send('Fact not found');
  res.redirect(safeBack(req, '/crm/contacts'));
});

router.post('/api/crm/contacts/:id/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const project = hub.prepare('SELECT id FROM projects WHERE id = ? AND user = ?').get(req.body.project_id, req.hubUser);
  if (!contact || !project) return res.status(404).json({ error: 'Not found' });
  hub.prepare(`
    INSERT OR IGNORE INTO contact_projects (contact_id, project_id, role) VALUES (?, ?, ?)
  `).run(contact.id, project.id, String(req.body.role || '').trim() || null);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/projects/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  hub.prepare('DELETE FROM contact_projects WHERE contact_id = ? AND project_id = ?')
    .run(req.params.id, req.body.project_id);
  syncContactVaultProfile(req.hubUser, req.params.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser);
  if (!contact || !company) return res.status(404).json({ error: 'Not found' });
  const hasPrimary = hub.prepare(
    'SELECT 1 FROM contact_companies WHERE contact_id = ? AND is_primary = 1'
  ).get(contact.id);
  const makePrimary = Boolean(req.body.is_primary) || !hasPrimary;
  if (makePrimary) {
    hub.prepare('UPDATE contact_companies SET is_primary = 0 WHERE contact_id = ?').run(contact.id);
  }
  hub.prepare(`
    INSERT INTO contact_companies (contact_id, company_id, role, is_primary)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(contact_id, company_id) DO UPDATE SET
      role = excluded.role,
      is_primary = excluded.is_primary
  `).run(contact.id, company.id, String(req.body.role || '').trim() || null, makePrimary ? 1 : 0);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const linked = hub.prepare(`
    SELECT is_primary FROM contact_companies WHERE contact_id = ? AND company_id = ?
  `).get(contact.id, req.body.company_id);
  if (!linked) return res.status(404).json({ error: 'Company link not found' });
  hub.prepare('DELETE FROM contact_companies WHERE contact_id = ? AND company_id = ?')
    .run(contact.id, req.body.company_id);
  if (linked.is_primary) promoteFirstLinkedCompany(hub, contact.id);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/role', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const role = String(req.body.role || '').trim() || null;
  const result = hub.prepare(`
    UPDATE contact_companies SET role = ? WHERE contact_id = ? AND company_id = ?
  `).run(role, contact.id, req.body.company_id);
  if (!result.changes) return res.status(404).json({ error: 'Company link not found' });
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/companies/primary', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.body.company_id, req.hubUser);
  if (!contact || !company) return res.status(404).json({ error: 'Not found' });
  const linked = hub.prepare(`
    SELECT 1 FROM contact_companies WHERE contact_id = ? AND company_id = ?
  `).get(contact.id, company.id);
  if (!linked) return res.status(404).json({ error: 'Company link not found' });
  setPrimaryCompany(hub, contact.id, company.id);
  syncContactVaultProfile(req.hubUser, contact.id);
  res.json({ ok: true });
});

router.post('/api/crm/companies/:id/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const company = hub.prepare('SELECT id FROM companies WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  const project = hub.prepare('SELECT id FROM projects WHERE id = ? AND user = ?').get(req.body.project_id, req.hubUser);
  if (!company || !project) return res.status(404).json({ error: 'Not found' });
  hub.prepare(`
    INSERT OR IGNORE INTO company_projects (company_id, project_id, role) VALUES (?, ?, ?)
  `).run(company.id, project.id, String(req.body.role || '').trim() || null);
  res.json({ ok: true });
});

router.post('/api/crm/companies/:id/projects/unlink', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  hub.prepare('DELETE FROM company_projects WHERE company_id = ? AND project_id = ?')
    .run(req.params.id, req.body.project_id);
  res.json({ ok: true });
});

router.post('/api/crm/contacts/:id/edit', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const aliases = String(req.body.aliases || '').split(',').map(a => a.trim()).filter(Boolean);
  const email = String(req.body.email || '').trim().toLowerCase() || null;
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.birthday || '')) ? req.body.birthday : null;
  const keepWarm = [30, 60, 90].includes(parseInt(req.body.keep_warm_days, 10)) ? parseInt(req.body.keep_warm_days, 10) : null;
  hub.prepare('UPDATE contacts SET name = ?, email = ?, aliases = ?, birthday = ?, keep_warm_days = ? WHERE id = ?')
    .run(name, email, JSON.stringify(aliases), birthday, keepWarm, contact.id);
  const profileSync = syncContactVaultProfile(req.hubUser, contact.id);
  res.json({
    ok: true,
    profileSynced: profileSync.synced,
    profileWarning: profileSync.synced ? null : profileSync.reason,
  });
});

router.post('/api/crm/contacts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const contact = hub.prepare('SELECT id FROM contacts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  hub.transaction(() => {
    hub.prepare('DELETE FROM contact_companies WHERE contact_id = ?').run(contact.id);
    hub.prepare('DELETE FROM meeting_attendees WHERE contact_id = ?').run(contact.id);
    hub.prepare('DELETE FROM crm_facts WHERE contact_id = ? AND user = ?').run(contact.id, req.hubUser);
    const linkedFacts = hub.prepare(
      "SELECT id, linked_contacts FROM crm_facts WHERE user = ? AND linked_contacts LIKE ?"
    ).all(req.hubUser, `%"${contact.id}"%`);
    const updateLinks = hub.prepare('UPDATE crm_facts SET linked_contacts = ? WHERE id = ?');
    for (const fact of linkedFacts) {
      updateLinks.run(JSON.stringify(parseJsonArray(fact.linked_contacts).filter(id => id !== contact.id)), fact.id);
    }
    hub.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  })();
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/archive', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'archived', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/unarchive', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'active', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/wrong', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'wrong', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/unwrong', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare(
    "UPDATE crm_facts SET status = 'active', updated_at = unixepoch() WHERE id = ? AND user = ?"
  ).run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/crm/facts/:id/edit', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const factText = String(req.body.fact || '').trim();
  if (!factText) return res.status(400).json({ error: 'Fact text is required' });
  if (factText.length > 4000) return res.status(400).json({ error: 'Fact text is too long' });

  const hub = db.hub();
  const existing = hub.prepare(`
    SELECT f.id, f.fact, f.status, f.due_date, c.name AS contact_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.id = ? AND f.user = ?
  `).get(req.params.id, req.hubUser);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (existing.status === 'follow_up' && 'due_date' in req.body) {
    const dueDate = String(req.body.due_date || '').trim();
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      return res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
    }
    hub.prepare('UPDATE crm_facts SET due_date = ?, updated_at = unixepoch() WHERE id = ? AND user = ?')
       .run(dueDate || null, existing.id, req.hubUser);
  }

  if (existing.fact === factText) return res.json({ ok: true, projectionSynced: true });

  hub.prepare(
    'UPDATE crm_facts SET fact = ?, updated_at = unixepoch() WHERE id = ? AND user = ?'
  ).run(factText, existing.id, req.hubUser);

  try {
    const projection = syncContactVaultFact({
      user: req.hubUser,
      factId: existing.id,
      contactName: existing.contact_name,
      oldFact: existing.fact,
      newFact: factText,
    });
    res.json({ ok: true, projectionSynced: projection.synced, projectionWarning: projection.reason || null });
  } catch (err) {
    console.warn(`[crm] People note sync failed for fact ${existing.id}:`, err.message);
    res.json({ ok: true, projectionSynced: false, projectionWarning: err.message });
  }
});

router.post('/api/crm/facts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare('DELETE FROM crm_facts WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

router.get('/crm/tasks', requireAuth, async (req, res) => {
  const showHistory = req.query.show_history === '1';
  try {
    await syncTasks(req.hubUser);
  } catch (err) {
    console.warn('[tasks] sync on page load failed:', err.message);
  }
  const tasks = getCachedTasks(req.hubUser, {}, showHistory);
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-tasks', { ...crmPageData(req.hubUser), tasks, showHistory, contacts, companies, projects });
});

router.post('/api/tasks', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const task = await createTask(req.hubUser, {
      title,
      notes: String(req.body.notes || '').trim() || null,
      due: req.body.due || null,
      source: 'manual',
      contactId: req.body.contact_id || null,
      companyId: req.body.company_id || null,
      projectSlug: req.body.project_slug || null,
    });
    res.json({ ok: true, task });
  } catch (err) {
    console.error('[tasks] create error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/complete', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const hub = db.hub();
  const row = hub.prepare('SELECT * FROM google_tasks WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    await completeTask(req.hubUser, row.google_task_id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] complete error', err);
    // Fall back to local-only complete if Google API fails
    hub.prepare("UPDATE google_tasks SET status = 'completed' WHERE id = ?").run(row.id);
    res.json({ ok: true, localOnly: true });
  }
});

router.post('/api/tasks/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const ok = deleteTask(req.hubUser, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/tasks/:id/wrong', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const { learnFromWrongTask } = require('../lib/task-learning');
    const learned = await learnFromWrongTask(
      req.hubUser,
      req.params.id,
      String(req.body?.reason || '').trim(),
    );
    const deleted = await deleteTaskEverywhere(req.hubUser, req.params.id, { status: 'wrong' });
    res.json({
      ok: true,
      lesson: learned.lesson.rule,
      evidenceCount: learned.lesson.evidence_count,
      usedFallback: learned.usedFallback,
      remoteDeleted: deleted.remoteDeleted,
      remoteWarning: deleted.remoteError,
    });
  } catch (err) {
    console.error('[tasks] wrong-learning error:', err);
    res.status(err.message === 'Task not found' ? 404 : 500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/restore', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const ok = restoreTask(req.hubUser, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/crm/tasks/:id', requireAuth, async (req, res) => {
  // Sync from Google first so the page always shows fresh data (due dates, etc.)
  try { await syncTasks(req.hubUser); } catch (err) {
    console.warn('[tasks] sync on detail load failed:', err.message);
  }
  const task = getTask(req.hubUser, req.params.id);
  if (!task) return res.status(404).send('Task not found');
  const hub = db.hub();
  const contacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const companies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const projects = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);
  res.render('hub/crm-task', { ...crmPageData(req.hubUser), task, contacts, companies, projects });
});

router.post('/api/tasks/sync', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  try {
    const items = await syncTasks(req.hubUser);
    res.json({ ok: true, count: items.length });
  } catch (err) {
    console.error('[tasks] manual sync error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/update', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const {
    title, notes, due, deadline,
    contact_id: contactId, company_id: companyId, project_slug: projectSlug,
  } = req.body;
  try {
    await updateTask(req.hubUser, req.params.id, {
      ...(title !== undefined && { title: String(title).trim() }),
      ...(notes !== undefined && { notes: String(notes).trim() }),
      ...(due !== undefined && { due: due || null }),
      ...(deadline !== undefined && { deadline: deadline || null }),
      ...(contactId !== undefined && { contactId: contactId || null }),
      ...(companyId !== undefined && { companyId: companyId || null }),
      ...(projectSlug !== undefined && { projectSlug: projectSlug || null }),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[tasks] update error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/tasks/:id/subtasks', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const sub = await createSubtask(req.hubUser, req.params.id, title);
    res.json({ ok: true, subtask: sub });
  } catch (err) {
    console.error('[tasks] subtask create error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Reminders ─────────────────────────────────────────────────────────────────

router.get('/crm/reminders', requireAuth, (req, res) => {
  const { listOpenReminders } = require('../lib/reminders');
  const hub = db.hub();
  const open = listOpenReminders(req.hubUser);
  const todayKey = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const dueDay = (r) => new Date(((r.next_fire_at || r.remind_at || 0) * 1000))
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const stillNeedsAction = (r) => {
    if (r.kind !== 'content') return true;
    try {
      const { evaluateCheck } = require('../lib/content-reminders');
      return Boolean(evaluateCheck(r).message);
    } catch (_) {
      return true;
    }
  };
  const today = open.filter(r => dueDay(r) <= todayKey && stillNeedsAction(r));
  const todayIds = new Set(today.map(r => r.id));
  const general = open.filter(r => !todayIds.has(r.id));
  const resolved = hub.prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND status IN ('done','cancelled') AND updated_at > unixepoch() - 7 * 86400
    ORDER BY updated_at DESC LIMIT 20
  `).all(req.hubUser);
  res.render('hub/crm-reminders', { ...crmPageData(req.hubUser), open, today, general, resolved });
});

router.post('/api/reminders', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const { createReminder, dublinIsoToEpoch, epochAtNextDublin } = require('../lib/reminders');
  let remindAt = dublinIsoToEpoch(String(req.body.remind_at || '').trim());
  if (!remindAt || remindAt < Math.floor(Date.now() / 1000) - 60) remindAt = epochAtNextDublin(9, 0);
  const reminder = createReminder(req.hubUser, {
    kind: req.body.kind === 'task' ? 'task' : 'adhoc',
    targetId: req.body.target_id || null,
    title,
    remindAt,
    source: 'hub-ui',
  });
  if (!reminder) return res.status(500).json({ error: 'Could not create reminder' });
  res.json({ ok: true, reminder });
});

router.post('/api/reminders/:id/:action(done|snooze|cancel|ack)', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const reminders = require('../lib/reminders');
  const row = db.hub().prepare('SELECT * FROM reminders WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (['done', 'cancelled'].includes(row.status)) return res.status(400).json({ error: 'Already resolved' });
  let result;
  if (req.params.action === 'done') result = await reminders.doneReminder(req.hubUser, row.short_code);
  else if (req.params.action === 'snooze') result = reminders.snoozeReminder(req.hubUser, row.short_code, String(req.body.duration || ''));
  else if (req.params.action === 'cancel') result = reminders.cancelReminder(req.hubUser, row.short_code);
  else result = reminders.ackReminder(req.hubUser, row.short_code);
  res.json(result);
});

// ── Projects ──────────────────────────────────────────────────────────────────

router.post('/crm/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).send('Name required');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    db.hub().prepare(
      'INSERT INTO projects (id, user, name, slug) VALUES (lower(hex(randomblob(8))), ?, ?, ?)'
    ).run(req.hubUser, name, slug);
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).send('A project with that name already exists');
    throw err;
  }
  res.redirect('/crm/project/' + slug);
});

router.get('/crm/projects', requireAuth, (req, res) => {
  const hub = db.hub();
  const projects = hub.prepare('SELECT * FROM projects WHERE user = ? ORDER BY name').all(req.hubUser);

  // Annotate each project with open task count and last activity
  const annotated = projects.map(p => {
    const openTasks = hub.prepare(
      "SELECT COUNT(*) AS n FROM google_tasks WHERE user = ? AND project_slug = ? AND status = 'needsAction' AND deleted_at IS NULL"
    ).get(req.hubUser, p.slug)?.n || 0;
    const lastMsg = hub.prepare(
      'SELECT MAX(ts) AS ts FROM messages WHERE project_id = ?'
    ).get(p.id)?.ts;
    return { ...p, openTasks, lastActivity: lastMsg };
  });

  res.render('hub/crm-projects', { ...crmPageData(req.hubUser), projects: annotated });
});

router.get('/crm/project/:slug', requireAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare(
    'SELECT * FROM projects WHERE user = ? AND slug = ?'
  ).get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).send('Project not found');

  const todayIsoStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  const showHistory = req.query.show_history === '1';

  // Tasks for this project
  const tasks = getCachedTasks(req.hubUser, { projectSlug: project.slug }, showHistory);

  // Contacts: directly linked first, then via tasks/emails
  const directContacts = hub.prepare(`
    SELECT c.*, cp.role AS project_role, cc.name AS company_name
    FROM contact_projects cp
    JOIN contacts c ON c.id = cp.contact_id
    LEFT JOIN contact_companies ccj ON ccj.contact_id = c.id AND ccj.is_primary = 1
    LEFT JOIN companies cc ON cc.id = ccj.company_id
    WHERE cp.project_id = ? ORDER BY c.name
  `).all(project.id);
  const directContactIds = new Set(directContacts.map(c => c.id));

  const contactIdsFromTasks = tasks.map(t => t.contact_id).filter(Boolean);
  const contactIdsFromEmail = hub.prepare(
    "SELECT DISTINCT contact_id FROM email_summaries WHERE user = ? AND project_slug = ? AND contact_id IS NOT NULL"
  ).all(req.hubUser, project.slug).map(r => r.contact_id);
  const indirectIds = [...new Set([...contactIdsFromTasks, ...contactIdsFromEmail])].filter(id => !directContactIds.has(id));
  const indirectContacts = indirectIds.length
    ? hub.prepare(
        `SELECT c.*, cc.name AS company_name
         FROM contacts c
         LEFT JOIN contact_companies ccj ON ccj.contact_id = c.id AND ccj.is_primary = 1
         LEFT JOIN companies cc ON cc.id = ccj.company_id
         WHERE c.id IN (${indirectIds.map(() => '?').join(',')})
         ORDER BY c.name`
      ).all(...indirectIds)
    : [];
  const contacts = [...directContacts, ...indirectContacts];

  // Available contacts to link
  const allContacts = hub.prepare('SELECT id, name FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableContacts = allContacts.filter(c => !directContactIds.has(c.id));

  // Companies: directly linked
  const linkedCompanies = hub.prepare(`
    SELECT co.id, co.name, cp.role AS project_role
    FROM company_projects cp
    JOIN companies co ON co.id = cp.company_id
    WHERE cp.project_id = ? ORDER BY co.name
  `).all(project.id);
  const linkedCompanyIds = new Set(linkedCompanies.map(c => c.id));
  const allCompanies = hub.prepare('SELECT id, name FROM companies WHERE user = ? ORDER BY name').all(req.hubUser);
  const availableCompanies = allCompanies.filter(c => !linkedCompanyIds.has(c.id));

  // Recent email summaries for this project
  const recentEmails = hub.prepare(`
    SELECT e.*, c.name AS contact_name
    FROM email_summaries e
    LEFT JOIN contacts c ON c.id = e.contact_id
    WHERE e.user = ? AND e.project_slug = ?
    ORDER BY e.received_at DESC
    LIMIT 10
  `).all(req.hubUser, project.slug);

  // Facts timeline: all facts from contacts linked to this project
  const allProjectContactIds = [...directContactIds];
  const projectFacts = allProjectContactIds.length ? hub.prepare(`
    SELECT f.id, f.fact, f.fact_type, f.source, f.created_at,
           c.id AS contact_id, c.name AS contact_name
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.contact_id IN (${allProjectContactIds.map(() => '?').join(',')})
      AND f.status != 'archived'
    ORDER BY f.created_at DESC
    LIMIT 50
  `).all(...allProjectContactIds) : [];

  // Recent messages in the project chat (for last-activity context)
  const recentMessages = hub.prepare(`
    SELECT role, content, ts FROM messages
    WHERE project_id = ? AND role IN ('user','assistant')
    ORDER BY ts DESC LIMIT 5
  `).all(project.id);

  const projectDocs = hub.prepare(
    'SELECT id, filename, size_bytes, uploaded_at FROM documents WHERE project_id = ? ORDER BY uploaded_at DESC'
  ).all(project.id);

  res.render('hub/crm-project', {
    ...crmPageData(req.hubUser),
    project, tasks, contacts, directContactIds: [...directContactIds],
    availableContacts, linkedCompanies, linkedCompanyIds: [...linkedCompanyIds],
    availableCompanies, recentEmails, projectFacts, recentMessages, showHistory, todayIsoStr,
    projectDocs,
  });
});

router.post('/api/crm/note', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const result = await processCrmCommand(req.hubUser, text.trim(), 'hub-ui');
    res.json(result);
  } catch (err) {
    console.error('[crm note]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
