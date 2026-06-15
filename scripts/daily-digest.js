#!/usr/bin/env node
// Daily topic digest — runs locally on Mac Mini after vault sync.
// For each active project/topic, pulls together recent journal mentions
// and matching email summaries, then writes a digest note to the vault.
//
// Usage: node scripts/daily-digest.js [--days=7] [--user=douglas]

'use strict';

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const db = require('../lib/db');
const { writeNote, vaultRoot } = require('../lib/obsidian-vault');
const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
const { logUsageFromResponse } = require('../lib/openrouter-usage');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const DAYS = parseInt(args.days || '7', 10);
const USER = args.user || 'douglas';
const VAULT = vaultRoot();
const DIGEST_DIR = 'Reviews';

async function main() {
  const hub = db.hub();
  const cutoff = Math.floor(Date.now() / 1000) - DAYS * 86400;

  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(USER);
  if (!projects.length) { console.log('[digest] no projects found'); return; }

  // Load journal notes from the vault written in the last DAYS days
  const journalDir = path.join(VAULT, 'Journal');
  const dailyNotes = [];
  if (fs.existsSync(journalDir)) {
    for (const file of fs.readdirSync(journalDir).sort().reverse()) {
      if (!file.endsWith('.md')) continue;
      const stat = fs.statSync(path.join(journalDir, file));
      if (stat.mtimeMs < cutoff * 1000) break;
      try {
        dailyNotes.push({ date: file.replace('.md', ''), content: fs.readFileSync(path.join(journalDir, file), 'utf8') });
      } catch (_) {}
    }
  }

  // Load recent email summaries from DB
  const emails = hub.prepare(`
    SELECT subject, from_name, summary, received_at, project_slug
    FROM email_summaries
    WHERE user = ? AND received_at > ?
    ORDER BY received_at DESC
  `).all(USER, cutoff);

  // For each project, check if there's relevant content
  const isoToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const digestLines = [
    `# Weekly digest — ${isoToday}`,
    `*${DAYS}-day review across journal and email*`,
    '',
  ];
  let sectionsWritten = 0;

  for (const project of projects) {
    const nameRe = new RegExp(`\\b${project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const slugRe = new RegExp(`\\b${project.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

    const matchingNotes = dailyNotes.filter(n => nameRe.test(n.content) || slugRe.test(n.content));
    const matchingEmails = emails.filter(e =>
      e.project_slug === project.slug ||
      nameRe.test(e.subject + ' ' + e.summary)
    );

    if (!matchingNotes.length && !matchingEmails.length) continue;

    // Build context for synthesis
    const noteContext = matchingNotes.map(n => `[Journal ${n.date}]\n${extractJournalSection(n.content)}`).join('\n\n');
    const emailContext = matchingEmails.map(e => {
      const d = new Date(e.received_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `[Email ${d}] ${e.from_name}: ${e.subject}\n${e.summary}`;
    }).join('\n\n');

    const combinedContext = [noteContext, emailContext].filter(Boolean).join('\n\n---\n\n');
    if (!combinedContext.trim()) continue;

    console.log(`[digest] synthesising /${project.slug} (${matchingNotes.length} notes, ${matchingEmails.length} emails)`);

    const synthesis = await synthesise(project.name, combinedContext);

    digestLines.push(`## [[${project.name}]]`, '', synthesis, '');
    sectionsWritten++;
  }

  if (!sectionsWritten) {
    console.log('[digest] nothing to digest today');
    return;
  }

  const notePath = `${DIGEST_DIR}/${isoToday}-digest.md`;
  await writeNote({ notePath, content: digestLines.join('\n'), mode: 'overwrite' });
  console.log(`[digest] written → ${notePath}`);
}

// Pull just the Journal section content from a daily note
function extractJournalSection(content) {
  const match = content.match(/## Journal\s+([\s\S]+?)(?=\n## |\n---|\s*$)/);
  return match ? match[1].trim() : content.slice(0, 600);
}

async function synthesise(topicName, context) {
  const prompt = `You are summarising recent activity about "${topicName}" from journal entries and emails.

${context}

Write 2–4 sentences covering: what's happened recently, any open threads or decisions, and what to watch next.
- Use [[wikilink]] syntax for people and project names.
- Only include what is evidenced in the content above.
- No bullet points. Flowing prose.`;

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders(TASK_CODES.DAILY_DIGEST),
      body: JSON.stringify({
        model: process.env.DIGEST_MODEL || 'deepseek/deepseek-v3.2',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}`);
    const data = await resp.json();
    logUsageFromResponse({
      user,
      feature: 'daily-digest',
      modelKey: 'daily-digest',
      fallbackModelId: process.env.DIGEST_MODEL || 'deepseek/deepseek-v3.2',
      data,
      taskCode: TASK_CODES.DAILY_DIGEST,
    });
    return data.choices[0].message.content.trim();
  } catch (err) {
    console.warn(`[digest] synthesis failed for ${topicName}:`, err.message);
    return `*(synthesis unavailable)*`;
  }
}

main().catch(err => { console.error('[digest] fatal:', err.message); process.exit(1); });
