const path = require('path');
const { writeNote } = require('./obsidian-vault');
const db = require('./db');

// Inject [[wikilinks]] for known contact names/aliases found verbatim in the transcript.
// Only replaces whole words — doesn't invent anything.
function injectWikilinks(text, user) {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT name, aliases FROM contacts WHERE user = ?').all(user);

  // Build list of (term → wikilink label) sorted longest-first to avoid partial matches
  const terms = [];
  for (const c of contacts) {
    const aliases = (() => { try { return JSON.parse(c.aliases || '[]'); } catch { return []; } })();
    const preferred = aliases[0] || c.name; // use first alias (e.g. "Dad") as the link label
    for (const term of [c.name, ...aliases]) {
      if (term) terms.push({ term, label: preferred });
    }
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

async function writeJournalEntry(user, transcript, date = new Date()) {
  const isoDate = date.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
  });
  const notePath = `Daily/${isoDate}.md`;

  const withLinks = injectWikilinks(transcript.trim(), user);
  const entry = `*${dateStr}*\n\n${withLinks}`;

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
