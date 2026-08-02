'use strict';

const path = require('path');
const fs = require('fs');
const { writeNote, vaultRoot } = require('./obsidian-vault');
const db = require('./db');
const { uuid: newId } = require('./id');

function injectWikilinks(text, user) {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT name, aliases FROM contacts WHERE user = ?').all(user);
  const projects = hub.prepare('SELECT name, slug FROM projects WHERE user = ?').all(user);

  const terms = [];
  for (const c of contacts) {
    const aliases = (() => { try { return JSON.parse(c.aliases || '[]'); } catch { return []; } })();
    const label = aliases[0] || c.name;
    for (const term of [c.name, ...aliases]) {
      if (term) terms.push({ term, label });
    }
  }
  for (const p of projects) {
    terms.push({ term: p.name, label: p.name });
  }
  terms.sort((a, b) => b.term.length - a.term.length);

  let result = text;
  for (const { term, label } of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, 'gi');
    result = result.replace(re, `[[${label}]]`);
  }
  return result;
}

function meetingFilename(title, date) {
  const d = date || new Date();
  const iso = d.toISOString().slice(0, 10);
  const safe = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').slice(0, 60);
  return `${iso}-${safe}`;
}

function matchContactByName(allContacts, name) {
  const nameLower = String(name || '').trim().toLowerCase();
  if (!nameLower) return null;
  return allContacts.find(c => {
    if (c.name.toLowerCase() === nameLower) return true;
    try {
      return JSON.parse(c.aliases || '[]').some(a => a.toLowerCase() === nameLower);
    } catch { return false; }
  }) || null;
}

// A debrief is also a CRM meeting — create the meetings row (with the date/
// time/duration/channel columns the table already had but debriefs never
// filled) and link matched attendees, so debriefed meetings show up in the
// CRM meetings list and feed last_contacted_at.
function recordCrmMeeting(user, { title, isoDate, meetingTime, durationMins, channel, attendees }) {
  const hub = db.hub();
  const meetingId = newId();
  hub.prepare(`
    INSERT INTO meetings (id, user, title, meeting_date, meeting_time, duration_mins, location, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'debrief')
  `).run(
    meetingId, user, title, isoDate,
    meetingTime || null,
    Number.isFinite(durationMins) ? durationMins : null,
    channel || null
  );
  const allContacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const addAttendee = hub.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, contact_id) VALUES (?, ?)');
  for (const name of attendees) {
    const contact = matchContactByName(allContacts, name);
    if (contact) addAttendee.run(meetingId, contact.id);
  }
  return meetingId;
}

async function writeMeetingNote(user, {
  title,
  attendees = [],     // array of names
  projectSlug = null,
  topics = '',
  takeaways = '',
  myThoughts = '',    // voice debrief transcript
  uploadedTranscript = '', // text from uploaded file
  date = new Date(),
  meetingTime = '',   // HH:MM, Dublin local
  durationMins = null,
  channel = '',       // video call | in person | phone | chat | async
} = {}) {
  const hub = db.hub();
  const project = projectSlug
    ? hub.prepare('SELECT name FROM projects WHERE slug = ? AND user = ?').get(projectSlug, user)
    : null;

  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/London',
  });

  const filename = meetingFilename(title, date);
  const notePath = `Meetings/${filename}.md`;

  const tags = [...new Set([
    'meeting',
    ...attendees.filter(Boolean),
    ...(projectSlug ? [projectSlug] : []),
  ])];

  const attendeeLinks = attendees
    .filter(Boolean)
    .map(n => injectWikilinks(n, user))
    .join(', ');

  const lines = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `date: ${date.toISOString().slice(0, 10)}`,
    `attendees: [${attendees.map(n => `"${n}"`).join(', ')}]`,
    projectSlug ? `project: ${projectSlug}` : null,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    'type: meeting',
    '---',
    '',
    `# ${title}`,
    '',
    `*${dateStr}*`,
    '',
    `**Attendees:** ${attendeeLinks || '—'}`,
    project ? `**Project:** [[${project.name}]]` : null,
    '',
  ].filter(l => l !== null);

  if (topics.trim()) {
    lines.push('## Topics', '', injectWikilinks(topics.trim(), user), '');
  }

  if (takeaways.trim()) {
    lines.push('## Key takeaways', '', injectWikilinks(takeaways.trim(), user), '');
  }

  if (myThoughts.trim()) {
    lines.push('## My thoughts', '', injectWikilinks(myThoughts.trim(), user), '');
  }

  if (uploadedTranscript.trim()) {
    lines.push('## Transcript', '', uploadedTranscript.trim(), '');
  }

  const content = lines.join('\n');
  await writeNote({ notePath, content, mode: 'create' });

  // Queue for synthadoc
  const vault = vaultRoot();
  const queueDir = path.join(vault, 'raw_sources', 'ingest-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, `${filename}-meeting.path`), notePath, 'utf8');

  const meetingId = recordCrmMeeting(user, {
    title,
    isoDate: date.toISOString().slice(0, 10),
    meetingTime,
    durationMins,
    channel,
    attendees,
  });

  return { notePath, filename, meetingId };
}

module.exports = { writeMeetingNote };
