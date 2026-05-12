const fetch = require('node-fetch');
const path = require('path');
const { writeNote } = require('./obsidian-vault');
const db = require('./db');

// ── Wikilink injection ────────────────────────────────────────────────────────
// Replaces known contact names/aliases and project names verbatim in text.
// No LLM — purely deterministic string replacement.
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

  // Longest first so "Alister McLellan" matches before "Alister"
  terms.sort((a, b) => b.term.length - a.term.length);

  let result = text;
  for (const { term, label } of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!\\[\\[)\\b${escaped}\\b(?!\\]\\])`, 'gi');
    result = result.replace(re, `[[${label}]]`);
  }
  return result;
}

// ── Structured extraction (LLM — JSON only, temperature 0) ───────────────────
// Extracts names, tomorrow-tasks, and undated tasks from the transcript.
// Does NOT generate prose. Only returns what is explicitly stated.
async function extractStructure(transcript, user) {
  const hub = db.hub();
  const contacts = hub.prepare('SELECT name, aliases FROM contacts WHERE user = ?').all(user);
  const projects = hub.prepare('SELECT name, slug FROM projects WHERE user = ?').all(user);

  const knownNames = contacts.flatMap(c => {
    const aliases = (() => { try { return JSON.parse(c.aliases || '[]'); } catch { return []; } })();
    return [c.name, ...aliases];
  }).filter(Boolean);

  const knownProjects = projects.map(p => p.name);

  const prompt = `Extract structured information from this voice note transcript. Return ONLY valid JSON — no prose, no explanation.

Transcript:
"${transcript.trim()}"

Known people: ${knownNames.join(', ') || 'none'}
Known projects/topics: ${knownProjects.join(', ') || 'none'}

Return this exact JSON shape:
{
  "names": ["list of person names explicitly mentioned — only from the known people list above"],
  "topics": ["project or topic names explicitly mentioned — known projects plus any other capitalised proper nouns that are clearly a named thing (e.g. M365, CISA, Beacon)"],
  "tasks_tomorrow": ["tasks the speaker explicitly says to do tomorrow or in the morning"],
  "tasks_undated": ["tasks or follow-ups mentioned without a specific time — things like 'need to', 'should', 'have to', 'must'"]
}

Rules:
- Only include what is EXPLICITLY stated. Do not infer, expand, or add context.
- If a field has nothing, return an empty array.
- tasks_tomorrow and tasks_undated should be short action phrases, not full sentences.`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://dchat.mclellan.scot',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v3.2',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    });

    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const data = await resp.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return {
      names: Array.isArray(parsed.names) ? parsed.names : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      tasks_tomorrow: Array.isArray(parsed.tasks_tomorrow) ? parsed.tasks_tomorrow : [],
      tasks_undated: Array.isArray(parsed.tasks_undated) ? parsed.tasks_undated : [],
    };
  } catch (err) {
    console.warn('[journal] extraction failed, saving verbatim:', err.message);
    return { names: [], topics: [], tasks_tomorrow: [], tasks_undated: [] };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function journalFilename(date) {
  const opts = { timeZone: 'Europe/London' };
  const weekday = date.toLocaleDateString('en-GB', { ...opts, weekday: 'short' }); // Tue
  const day     = date.toLocaleDateString('en-GB', { ...opts, day: 'numeric' });   // 12
  const month   = date.toLocaleDateString('en-GB', { ...opts, month: 'short' });   // May
  const year    = date.toLocaleDateString('en-GB', { ...opts, year: '2-digit' });  // 26
  return `Journal - ${weekday} ${day} ${month} ${year}`;
}

async function writeJournalEntry(user, transcript, date = new Date()) {
  const filename = journalFilename(date);
  const notePath = `Journal/${filename}.md`;
  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London',
  });

  // Run both in parallel — wikilinks are instant, extraction takes ~1s
  const [withLinks, structure] = await Promise.all([
    Promise.resolve(injectWikilinks(transcript.trim(), user)),
    extractStructure(transcript.trim(), user),
  ]);

  // Build tags from names + topics found
  const tags = [...new Set([...structure.names, ...structure.topics])];

  // Compose the note section
  const lines = [
    `---`,
    `tags: [${tags.map(t => JSON.stringify(t)).join(', ')}]`,
    `---`,
    ``,
    `*${dateStr}*`,
    ``,
    withLinks,
  ];

  if (structure.tasks_tomorrow.length) {
    lines.push('', '### Tomorrow', ...structure.tasks_tomorrow.map(t => `- [ ] ${t}`));
  }

  if (structure.tasks_undated.length) {
    lines.push('', '### Tasks', ...structure.tasks_undated.map(t => `- [ ] ${t}`));
  }

  const entry = lines.join('\n');
  await writeNote({ notePath, content: `\n\n---\n\n## Journal\n\n${entry}`, mode: 'append' });

  // Queue for synthadoc ingest on Mac Mini
  const vaultRoot = require('./obsidian-vault').vaultRoot();
  const queueDir = path.join(vaultRoot, 'raw_sources', 'ingest-queue');
  const fs = require('fs');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, `${filename}-journal.path`),
    path.join(vaultRoot, notePath),
    'utf8'
  );

  return { notePath, entry, tags, tasks_tomorrow: structure.tasks_tomorrow, tasks_undated: structure.tasks_undated };
}

module.exports = { writeJournalEntry };
