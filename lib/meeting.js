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

// Log a "met with" fact against each known CRM contact in the attendees list
function logMeetingFact(user, attendeeNames, title, date) {
  const hub = db.hub();
  const isoDate = (date || new Date()).toISOString().slice(0, 10);
  const allContacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);

  for (const name of attendeeNames) {
    const nameLower = name.trim().toLowerCase();
    const contact = allContacts.find(c => {
      if (c.name.toLowerCase() === nameLower) return true;
      try {
        return JSON.parse(c.aliases || '[]').some(a => a.toLowerCase() === nameLower);
      } catch { return false; }
    });
    if (!contact) continue;
    hub.prepare(
      `INSERT INTO crm_facts (id, user, contact_id, fact, source)
       VALUES (?, ?, ?, ?, 'meeting-debrief')`
    ).run(newId(), user, contact.id, `Met in "${title}" on ${isoDate}`);
  }
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

  // Log CRM facts
  logMeetingFact(user, attendees, title, date);

  return { notePath, filename };
}

module.exports = { writeMeetingNote };
