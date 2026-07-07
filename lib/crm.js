const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { readNote, writeNote } = require('./obsidian-vault');
const { getWikiPagesByTags } = require('./wiki-tags');
const { logUsageFromResponse } = require('./openrouter-usage');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { createTask, getCachedTasks } = require('./google-tasks');

const CRM_PROFILE_START = '<!-- crm-profile:start -->';
const CRM_PROFILE_END = '<!-- crm-profile:end -->';

function contactWikiLink(name) {
  return `[[${String(name || '').trim()}]]`;
}

function syncContactVaultProfile(user, contactId) {
  const hub = db.hub();
  const contact = hub.prepare(
    'SELECT * FROM contacts WHERE id = ? AND user = ?'
  ).get(contactId, user);
  if (!contact) return { synced: false, reason: 'Contact not found' };

  const companies = hub.prepare(`
    SELECT co.name, cc.role, cc.is_primary
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE cc.contact_id = ?
    ORDER BY cc.is_primary DESC, co.name
  `).all(contact.id);
  const projects = hub.prepare(`
    SELECT p.name, cp.role
    FROM contact_projects cp
    JOIN projects p ON p.id = cp.project_id
    WHERE cp.contact_id = ?
    ORDER BY p.name
  `).all(contact.id);
  let aliases = [];
  try { aliases = JSON.parse(contact.aliases || '[]'); } catch (_) {}

  const lines = [
    CRM_PROFILE_START,
    `# ${contact.name}`,
    '',
    '## CRM profile',
    contact.email ? `- Email: ${contact.email}` : null,
    aliases.length ? `- Also known as: ${aliases.join(', ')}` : null,
    companies.length
      ? `- ${companies.length === 1 ? 'Company' : 'Companies'}: ${companies.map(company =>
        `${contactWikiLink(company.name)}${company.role ? ` (${company.role})` : ''}`
      ).join(', ')}`
      : null,
    projects.length
      ? `- ${projects.length === 1 ? 'Project' : 'Projects'}: ${projects.map(project =>
        `${contactWikiLink(project.name)}${project.role ? ` (${project.role})` : ''}`
      ).join(', ')}`
      : null,
    CRM_PROFILE_END,
  ].filter(line => line !== null);
  const profile = lines.join('\n');
  const notePath = `People/${contact.name}.md`;
  const existing = readNote(notePath)?.content || '';
  const start = existing.indexOf(CRM_PROFILE_START);
  const end = existing.indexOf(CRM_PROFILE_END);
  let content;

  if (start >= 0 && end >= start) {
    content = existing.slice(0, start)
      + profile
      + existing.slice(end + CRM_PROFILE_END.length);
  } else {
    content = `${profile}\n\n${existing.trimStart()}`;
  }

  try {
    writeNote({ notePath, content: content.trimEnd() + '\n', mode: 'write' });
    return { synced: true, notePath };
  } catch (err) {
    console.warn(`[crm] vault profile sync failed for ${notePath}:`, err.message);
    return { synced: false, reason: err.message };
  }
}

// Append a dated projection to People/{name}.md and retain the exact line on the CRM fact.
function appendContactVaultEntry(name, line, { factId = null, date = new Date() } = {}) {
  const d = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const projection = `- ${d}: ${line}`;
  try {
    writeNote({ notePath: `People/${name}.md`, content: `\n${projection}`, mode: 'append' });
    if (factId) {
      db.hub().prepare('UPDATE crm_facts SET vault_projection = ? WHERE id = ?').run(projection, factId);
    }
    return projection;
  } catch (err) {
    console.warn(`[crm] vault write failed for People/${name}.md:`, err.message);
    return null;
  }
}

function syncContactVaultFact({ user, factId, contactName, oldFact, newFact }) {
  const notePath = `People/${contactName}.md`;
  const note = readNote(notePath);
  if (!note) return { synced: false, reason: 'People note not found' };

  const row = db.hub().prepare(
    'SELECT vault_projection FROM crm_facts WHERE id = ? AND user = ?'
  ).get(factId, user);
  const lines = note.content.split('\n');
  let index = -1;

  if (row?.vault_projection) {
    index = lines.lastIndexOf(row.vault_projection);
  }
  if (index < 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('- ') && lines[i].includes(oldFact)) {
        index = i;
        break;
      }
    }
  }
  if (index < 0) return { synced: false, reason: 'Matching People note entry not found' };

  const updatedProjection = lines[index].replace(oldFact, newFact);
  if (updatedProjection === lines[index]) {
    return { synced: false, reason: 'Matching People note text not found' };
  }
  lines[index] = updatedProjection;
  writeNote({ notePath, content: lines.join('\n'), mode: 'write' });
  db.hub().prepare(
    'UPDATE crm_facts SET vault_projection = ? WHERE id = ? AND user = ?'
  ).run(updatedProjection, factId, user);
  return { synced: true };
}

// ── Intent parsing ────────────────────────────────────────────────────────────

function taskCodeForCrmSource(source) {
  return String(source || '').toLowerCase() === 'hermes'
    ? TASK_CODES.HERMES_CRM_CAPTURE
    : TASK_CODES.CRM;
}

async function parseIntent(user, text, source = 'dchat') {
  const taskCode = taskCodeForCrmSource(source);
  const context = db.hub().prepare(
    'SELECT key, value FROM crm_context WHERE user = ? ORDER BY key'
  ).all(user);

  const contextStr = context.length
    ? 'Known context about this user\'s world:\n' + context.map(c => `- ${c.key} = ${c.value}`).join('\n') + '\n\n'
    : '';

  const nowStr = new Date().toLocaleString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
  });
  const prompt = getSystemPrompt('crm_parser', 'system', PROMPTS.crm_parser)
    .replace('[NOW]', `${nowStr} (Europe/Dublin)`)
    .replace('[CONTEXT]', contextStr)
    .replace('[NOTE]', text);

  const started = Date.now();
  const modelId = getSystemModelId('crm_parser', 'system', 'google/gemini-2.5-pro-preview');
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(taskCode),
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
    feature: taskCode === TASK_CODES.HERMES_CRM_CAPTURE ? 'hermes-crm-capture' : 'crm-intent',
    modelKey: 'crm-intent',
    fallbackModelId: modelId,
    data,
    taskCode,
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
  const intent = await parseIntent(user, text, source);
  const hub = db.hub();

  if (intent.action === 'add_context' && intent.context_key) {
    const key = intent.context_key.toLowerCase().trim();
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, key, intent.context_value || '');
    return { ok: true, message: `Context noted: **${key}** = ${intent.context_value}` };
  }

  if (intent.action === 'set_reminder' && intent.reminder_text) {
    const { createReminder, dublinIsoToEpoch, epochAtNextDublin } = require('./reminders');
    let remindAt = dublinIsoToEpoch(intent.remind_at_iso);
    if (!remindAt || remindAt < Math.floor(Date.now() / 1000) - 60) remindAt = epochAtNextDublin(9, 0);
    const reminder = createReminder(user, { kind: 'adhoc', title: intent.reminder_text, remindAt, source });
    if (!reminder) return { ok: false, message: 'Could not set that reminder.' };
    const when = new Date(remindAt * 1000).toLocaleString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
    });
    return { ok: true, message: `⏰ Reminder #${reminder.short_code} set for ${when}: ${intent.reminder_text}\nReply "done ${reminder.short_code}" / "snooze ${reminder.short_code} 2h" when it fires.` };
  }

  const contact = resolveContact(user, intent.contact);
  if (!contact) {
    return { ok: false, message: 'No person identified. Try: `/crm [Name] ...`' };
  }

  if (intent.action === 'new_fact') {
    const factId = uuid();
    hub.prepare(`
      INSERT INTO crm_facts (id, user, contact_id, fact, status, source)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(factId, user, contact.id, intent.fact, source);
    appendContactVaultEntry(
      contact.name,
      `[fact] ${intent.fact}${source !== 'dchat' ? ` _(${source})_` : ''}`,
      { factId }
    );
    return {
      ok: true,
      message: `Saved for **${contact.name}**: ${intent.fact}`,
      detail: { action: 'new_fact', contactId: contact.id, contactName: contact.name, fact: intent.fact, factId },
    };
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
      const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(intent.follow_up_due || '') ? intent.follow_up_due : null;
      hub.prepare(`
        INSERT INTO crm_facts (id, user, contact_id, fact, status, source, parent_id, due_date)
        VALUES (?, ?, ?, ?, 'follow_up', ?, ?, ?)
      `).run(factId, user, contact.id, intent.follow_up, source, matched?.id || null, dueDate);
      appendContactVaultEntry(contact.name, `[follow-up] ${intent.follow_up}`, { factId });
      followUpMsg = `\nFollow-up: *${intent.follow_up}*${dueDate ? ` _(due ${dueDate})_` : ''}`;
      createTask(user, {
        title: `Follow up with ${contact.name}`,
        notes: intent.follow_up,
        due: dueDate || undefined,
        source: 'crm-follow-up',
        sourceId: factId,
        contactId: contact.id,
      }).catch(err => console.warn('[tasks] follow-up create failed:', err.message));
    }

    const doneText = matched ? `~~${matched.fact}~~` : '(no matching open item)';
    return {
      ok: true,
      message: `Done for **${contact.name}**: ${doneText}${followUpMsg}`,
      detail: {
        action: 'mark_done', contactId: contact.id, contactName: contact.name,
        fact: matched ? matched.fact : null, followUp: intent.follow_up || null,
      },
    };
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

function parseCurationFlags(value) {
  return new Set(parseJsonArray(value));
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
    SELECT f.*, c.name AS contact_name, c.aliases AS contact_aliases, c.curation_flags, c.curation_notes
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status IN ('active', 'follow_up')
    ORDER BY c.name, f.status DESC, f.created_at ASC
  `).all(user);

  let reminderLines = [];
  try {
    const { briefingReminderLines } = require('./reminders');
    reminderLines = briefingReminderLines(user);
  } catch (err) {
    console.warn('[crm] reminders section failed:', err.message);
  }

  if (!facts.length && !calendarEvents.length && !storedToday.length && !reminderLines.length) return null;

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const lines = [`*Morning Briefing — ${today}*`];

  const curatedContacts = hub.prepare(`
    SELECT id, name, curation_flags, curation_notes
    FROM contacts
    WHERE user = ? AND curation_flags IS NOT NULL AND curation_flags != '[]'
    ORDER BY name
  `).all(user)
    .map(contact => ({ ...contact, flags: parseCurationFlags(contact.curation_flags) }))
    .filter(contact => contact.flags.has('pin_briefing') || contact.flags.has('watch'));

  if (curatedContacts.length) {
    lines.push('', '*Curated contacts:*');
    for (const contact of curatedContacts) {
      const labels = [
        contact.flags.has('pin_briefing') ? 'pinned' : null,
        contact.flags.has('watch') ? 'watch' : null,
        contact.flags.has('sensitive') ? 'sensitive' : null,
      ].filter(Boolean).join(', ');
      const note = contact.curation_notes ? ` — ${contact.curation_notes}` : '';
      lines.push(`• ${contact.name}${labels ? ` (${labels})` : ''}${note}`);
    }
  }

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

  try {
    const { buildNudgeLines } = require('./crm-nudges');
    lines.push(...buildNudgeLines(user));
  } catch (err) {
    console.warn('[crm] nudges section failed:', err.message);
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

  // Wiki context pins: project-only manual context. Contact relationships now
  // come from the knowledge layer, not hand-maintained topic tags.
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
      lines.push('', '*Recent project wiki context:*');
      for (const l of wikiLines) lines.push(`• ${l}`);
    }
  } catch (err) {
    console.warn('[crm] wiki knowledge section failed:', err.message);
  }

  if (reminderLines.length) {
    lines.push('', '*Reminders waiting on you:*', ...reminderLines);
  }

  try {
    const { briefingSuggestionLines } = require('./suggestion-engine');
    const suggestionLines = briefingSuggestionLines(user);
    if (suggestionLines.length) {
      lines.push('', '*Suggestions:*', ...suggestionLines);
    }
  } catch (err) {
    console.warn('[crm] suggestions section failed:', err.message);
  }

  // Open Google Tasks (from local cache — sync happens at briefing send time).
  // Grouped by horizon with high-priority overdue first so the briefing reads
  // as a work order, not an unsorted dump.
  try {
    const openTasks = getCachedTasks(user);
    if (openTasks.length) {
      const todayIso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
      const weekIso = new Date(Date.now() + 7 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
      const rank = { high: 0, medium: 1, low: 2 };
      const byUrgency = (a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3) || String(a.due || '9999').localeCompare(String(b.due || '9999'));
      const fmtTask = t => {
        const bits = [
          t.priority === 'high' ? '‼️' : null,
          t.title,
          t.due ? `_(due ${new Date(t.due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})_` : null,
          t.effort_minutes ? `_[${t.effort_minutes >= 60 ? (t.effort_minutes / 60) + 'h' : t.effort_minutes + 'm'}]_` : null,
        ].filter(Boolean).join(' ');
        return `• ${bits}`;
      };
      const overdue = openTasks.filter(t => t.due && String(t.due).slice(0, 10) < todayIso).sort(byUrgency);
      const dueToday = openTasks.filter(t => t.due && String(t.due).slice(0, 10) === todayIso).sort(byUrgency);
      const thisWeek = openTasks.filter(t => t.due && String(t.due).slice(0, 10) > todayIso && String(t.due).slice(0, 10) <= weekIso).sort(byUrgency);
      const later = openTasks.filter(t => !t.due || String(t.due).slice(0, 10) > weekIso).sort(byUrgency);
      lines.push('', '*Open tasks:*');
      let shown = 0;
      for (const [label, group] of [['Overdue', overdue], ['Today', dueToday], ['This week', thisWeek], ['Later', later]]) {
        if (!group.length || shown >= 12) continue;
        lines.push(`_${label}:_`);
        for (const t of group.slice(0, Math.max(0, 12 - shown))) { lines.push(fmtTask(t)); shown++; }
      }
      if (openTasks.length > shown) lines.push(`  _…and ${openTasks.length - shown} more_`);
    }
  } catch (err) {
    console.warn('[crm] tasks section failed:', err.message);
  }

  // Active reminders with escalation counts — silent failure surfacing rule
  try {
    const { listOpenReminders } = require('./reminders');
    const openReminders = listOpenReminders(user).filter(r => ['scheduled', 'snoozed', 'stale'].includes(r.status));
    if (openReminders.length) {
      lines.push('', '*Active reminders:*');
      for (const r of openReminders.slice(0, 6)) {
        lines.push(`• #${r.short_code} ${r.title}${r.escalation_level > 0 ? ` _(pinged ${r.escalation_level}×)_` : ''}`);
      }
      if (openReminders.length > 6) lines.push(`  _…and ${openReminders.length - 6} more_`);
    }
  } catch (err) {
    console.warn('[crm] reminders section failed:', err.message);
  }

  const total = facts.length;
  lines.push('', `_${sorted.length} ${sorted.length === 1 ? 'person' : 'people'}, ${total} ${total === 1 ? 'item' : 'items'}_`);
  return lines.join('\n');
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
    return allItems
      .filter(ev => ev.status !== 'cancelled' && ev.summary && (ev.start?.dateTime || ev.start?.date))
      .map(ev => {
        const isAllDay = !ev.start?.dateTime;
        const durationMins = isAllDay
          ? (ev.start?.date && ev.end?.date
              ? Math.round((new Date(ev.end.date) - new Date(ev.start.date)) / 60000)
              : null)
          : Math.max(0, Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000));
        return {
          id: ev.id,
          summary: ev.summary,
          date: isAllDay
            ? ev.start.date
            : new Date(ev.start.dateTime).toLocaleDateString('sv-SE', { timeZone: tz }),
          time: isAllDay
            ? null
            : new Date(ev.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz }),
          durationMins,
          isAllDay,
          location: ev.location || '',
          notes: ev.description || '',
          attendees: (ev.attendees || [])
            .filter(a => !a.self)
            .map(a => a.displayName || a.email || '')
            .filter(Boolean),
          attendeeDetails: (ev.attendees || [])
            .filter(a => !a.self)
            .map(a => ({ name: a.displayName || '', email: String(a.email || '').toLowerCase() })),
        };
      });
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
  try {
    require('./crm-nudges').recomputeLastContacted(user);
  } catch (err) {
    console.warn('[crm] last-contacted recompute failed:', err.message);
  }
  return { events: events.length, attendeesMatched };
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


// ── CRM list (for API / display) ──────────────────────────────────────────────

function listContacts(user, query = '') {
  const hub = db.hub();
  const contacts = hub.prepare(`
    SELECT c.*, co.id AS company_id, co.name AS company_name, cc.role AS company_role
    FROM contacts c
    LEFT JOIN contact_companies cc ON cc.contact_id = c.id AND cc.is_primary = 1
    LEFT JOIN companies co ON co.id = cc.company_id
    WHERE c.user = ?
    ORDER BY c.name
  `).all(user);

  const factsByContact = new Map();
  for (const fact of hub.prepare(
    'SELECT * FROM crm_facts WHERE user = ? ORDER BY created_at DESC'
  ).all(user)) {
    if (!factsByContact.has(fact.contact_id)) factsByContact.set(fact.contact_id, []);
    factsByContact.get(fact.contact_id).push(fact);
  }

  const companiesByContact = new Map();
  for (const row of hub.prepare(`
    SELECT cc.contact_id, co.name, cc.role
    FROM contact_companies cc
    JOIN companies co ON co.id = cc.company_id
    WHERE co.user = ?
  `).all(user)) {
    if (!companiesByContact.has(row.contact_id)) companiesByContact.set(row.contact_id, []);
    companiesByContact.get(row.contact_id).push(row);
  }

  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return contacts
    .map(contact => {
      const allFacts = factsByContact.get(contact.id) || [];
      const activeFacts = allFacts
        .filter(fact => !['done', 'closed', 'archived'].includes(fact.status))
        .sort((a, b) => b.status.localeCompare(a.status) || a.created_at - b.created_at);
      const companies = companiesByContact.get(contact.id) || [];
      const vaultContent = terms.length
        ? readNote(`People/${contact.name}.md`)?.content || ''
        : '';
      const matchingFacts = terms.length
        ? allFacts.filter(fact => terms.every(term => fact.fact.toLowerCase().includes(term)))
        : [];
      const matchingVaultLines = terms.length
        ? vaultContent.split('\n')
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#') && terms.every(term => line.toLowerCase().includes(term)))
        : [];
      const notesMatch = terms.length && terms.every(term => String(contact.notes || '').toLowerCase().includes(term));
      const companyMatches = terms.length
        ? companies.filter(company => terms.every(term =>
          `${company.name} ${company.role || ''}`.toLowerCase().includes(term)
        ))
        : [];
      const haystack = [
        contact.name,
        contact.aliases,
        contact.email,
        contact.notes,
        vaultContent,
        ...companies.flatMap(company => [company.name, company.role]),
        ...allFacts.map(fact => fact.fact),
      ].join(' ').toLowerCase();
      const searchSnippets = [
        ...(notesMatch ? [String(contact.notes).trim()] : []),
        ...companyMatches.map(company => [company.name, company.role].filter(Boolean).join(' · ')),
        ...matchingFacts.map(fact => fact.fact),
        ...matchingVaultLines.filter(line => !matchingFacts.some(fact => line.includes(fact.fact))),
      ].filter(Boolean);

      // Overdue keep-warm days: how far past the cadence this contact is.
      // Drives list ordering + the overdue badge so the People page is a
      // prioritised work surface, not an alphabetical directory.
      const sinceTs = contact.last_contacted_at || contact.created_at;
      const daysSince = sinceTs ? Math.floor((Date.now() / 1000 - sinceTs) / 86400) : null;
      const keepWarmOverdueDays = contact.keep_warm_days && daysSince !== null
        ? daysSince - contact.keep_warm_days
        : null;

      return {
        ...contact,
        facts: activeFacts,
        matchingFacts,
        daysSinceContact: daysSince,
        keepWarmOverdueDays,
        searchSnippets: [...new Set(searchSnippets)].slice(0, 3),
        _matchesSearch: !terms.length || terms.every(term => haystack.includes(term)),
        _nameMatch: terms.reduce((score, term) => score + (contact.name.toLowerCase().includes(term) ? 1 : 0), 0),
      };
    })
    .filter(contact => contact._matchesSearch)
    .sort((a, b) =>
      b._nameMatch - a._nameMatch
      || (b.keepWarmOverdueDays > 0 ? b.keepWarmOverdueDays : -1) - (a.keepWarmOverdueDays > 0 ? a.keepWarmOverdueDays : -1)
      || a.name.localeCompare(b.name));
}

module.exports = {
  processCrmCommand,
  buildBriefingText,
  buildEmailBriefingText,
  fetchCalendarEvents,
  fetchTodayCalendarEvents,
  syncCalendarMeetings,
  listContacts,
  resolveContact,
  parseJsonArray,
  parseCurationFlags,
  appendContactVaultEntry,
  syncContactVaultFact,
  syncContactVaultProfile,
};
