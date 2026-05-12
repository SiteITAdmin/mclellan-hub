const fetch = require('node-fetch');
const path = require('path');
const { writeNote } = require('./obsidian-vault');
const { fetchTodayCalendarEvents } = require('./crm');
const db = require('./db');

async function buildJournalEntry(user, transcript, date = new Date()) {
  const hub = db.hub();

  const calendarEvents = await fetchTodayCalendarEvents(user).catch(() => []);

  const activeFacts = hub.prepare(`
    SELECT f.fact, f.status, c.name, c.aliases
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status IN ('active', 'follow_up')
    ORDER BY c.name, f.created_at DESC
  `).all(user);

  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
  });

  const calendarStr = calendarEvents.length
    ? calendarEvents.map(e => `- ${e.time ? e.time + ' ' : ''}${e.summary}`).join('\n')
    : '(no calendar events)';

  const crmStr = activeFacts.length
    ? activeFacts.map(f => {
        const aliases = (() => { try { return JSON.parse(f.aliases || '[]'); } catch { return []; } })();
        const label = aliases.length ? `${f.name} (${aliases.join(', ')})` : f.name;
        return `- ${label}: ${f.fact}`;
      }).join('\n')
    : '(no active items)';

  const prompt = `You are writing a personal daily journal entry for Douglas McLellan.

Douglas has dictated this voice note:
"${transcript.trim()}"

Today is ${dateStr}.

Today's calendar:
${calendarStr}

Active people and open items:
${crmStr}

Write a reflective, first-person journal entry in Douglas's voice. Rules:
- Diary tone — honest, private, personal. Not corporate or structured.
- Weave in calendar and people context only where genuinely relevant to what Douglas said.
- Use [[Name]] wikilink syntax for people, projects, and significant topics. Use the name Douglas actually uses — e.g. [[Dad]] not [[Alister McLellan]], [[Wayne]] not a full formal name. The CRM list shows formal names with aliases in brackets — always use the alias form for wikilinks where one exists.
- Flowing prose, not bullet points.
- Do not invent facts not present in the transcript or context.
- Keep it to what Douglas actually said, naturally enriched.`;

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: process.env.JOURNAL_MODEL || 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!resp.ok) throw new Error(`LLM error ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

async function writeJournalEntry(user, transcript, date = new Date()) {
  const isoDate = date.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const notePath = `Daily/${isoDate}.md`;

  const entry = await buildJournalEntry(user, transcript, date);
  await writeNote({ notePath, content: `\n\n---\n\n## Journal\n\n${entry}`, mode: 'append' });

  // Queue for synthadoc ingest on Mac Mini (written to vault, sync picks it up)
  const vaultRoot = require('./obsidian-vault').vaultRoot();
  const queueDir = path.join(vaultRoot, 'raw_sources', 'ingest-queue');
  const fs = require('fs');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, `${isoDate}-journal.path`),
    path.join(vaultRoot, notePath),
    'utf8'
  );

  return { notePath, entry };
}

module.exports = { writeJournalEntry };
