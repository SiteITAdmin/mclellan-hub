#!/usr/bin/env node
/**
 * vault.js — local CLI for vault ↔ dchat sync, wiki processing, and link repair
 *
 * Commands:
 *   pull              VPS dchat documents → local vault raw_sources
 *   push              Local vault wiki pages → VPS knowledge-base project
 *   process           Process unhandled raw_sources into wiki pages
 *   link              Discover and add missing [[wikilinks]] across wiki pages
 *   status            Show what's unsynced / unprocessed / orphaned
 *
 * All LLM calls use --model <key> where key matches a model in lib/router.js DEFAULT_MODELS.
 * Defaults: process → deepseek-v3, link → gemini-25-pro
 *
 * Usage:
 *   node scripts/vault.js pull
 *   node scripts/vault.js push
 *   node scripts/vault.js process [--model deepseek-v3]
 *   node scripts/vault.js link [--model gemini-25-pro]
 *   node scripts/vault.js status
 */

// Load .env — walk up from __dirname until we find one
const path = require('path');
const fs0  = require('fs');
let envPath = path.resolve(__dirname, '.env');
for (let i = 0; i < 6; i++) {
  const candidate = path.resolve(__dirname, '../'.repeat(i) + '.env');
  if (fs0.existsSync(candidate)) { envPath = candidate; break; }
}
require('dotenv').config({ path: envPath });

const fetch  = require('node-fetch');
const fs     = require('fs');
const vault  = require('../lib/vault');

// ── Inline model registry (mirrors lib/router.js DEFAULT_MODELS) ─────────────
const MODELS = {
  'free':             'openrouter/free',
  'deepseek-v3':      'deepseek/deepseek-v3.2',
  'mistral-small':    'mistralai/mistral-small-2603',
  'grok-fast':        'x-ai/grok-3-mini',
  'claude-opus':      'anthropic/claude-opus-4.7',
  'sonar':            'perplexity/sonar',
  'gemini-25-pro':    'google/gemini-2.5-pro-preview',
  'claude-sonnet':    'anthropic/claude-sonnet-4.6',
  'o3':               'openai/o3',
};

async function fetchOpenRouterFull(modelId, messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mclellan.scot',
      'X-Title': 'McLellan Hub',
      'X-OpenRouter-Cache': 'true',
    },
    body: JSON.stringify({ model: modelId, messages, stream: false }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${await r.text()}`);
  return r.json();
}

const HUB_URL        = (process.env.HUB_URL || 'https://mclellan.scot').replace(/\/$/, '');
const VAULT_SYNC_KEY = process.env.VAULT_SYNC_KEY || '';

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const command  = args[0];
const modelArg = args[indexOf('--model') + 1] || null;

function indexOf(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? args.length : i;
}

function modelId(key) {
  const id = MODELS[key];
  if (!id) { console.error(`Unknown model key: ${key}. Available: ${Object.keys(MODELS).join(', ')}`); process.exit(1); }
  return id;
}

// ── Hub API helpers ───────────────────────────────────────────────────────────
async function hubGet(path) {
  const r = await fetch(`${HUB_URL}${path}`, {
    headers: { Authorization: `Bearer ${VAULT_SYNC_KEY}` },
  });
  if (!r.ok) throw new Error(`Hub API ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function hubPost(path, body) {
  const r = await fetch(`${HUB_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${VAULT_SYNC_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Hub API POST ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

// ── PULL: VPS documents → local vault raw_sources ─────────────────────────────
async function cmdPull() {
  console.log('Pulling documents from dchat…');
  const { documents } = await hubGet('/api/vault/documents');
  let added = 0, skipped = 0;

  for (const doc of documents) {
    if (!doc.project_slug || !doc.markdown) { skipped++; continue; }

    const projDir = path.join(vault.RAW_DCHAT, doc.project_slug);
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

    // Filename: {uploaded_at}-{filename}.md
    const safeName = doc.filename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-');
    const outName  = `${doc.uploaded_at}-${safeName}${safeName.endsWith('.md') ? '' : '.md'}`;
    const outPath  = path.join(projDir, outName);

    if (fs.existsSync(outPath)) { skipped++; continue; }

    fs.writeFileSync(outPath, doc.markdown, 'utf8');
    console.log(`  + ${doc.project_slug}/${outName}`);
    added++;
  }
  console.log(`Pull complete: ${added} new, ${skipped} already present.`);
}

// ── PUSH: local vault wiki → VPS knowledge-base project ──────────────────────
async function cmdPush() {
  if (!VAULT_SYNC_KEY) {
    console.error('VAULT_SYNC_KEY not set in .env — cannot push.');
    process.exit(1);
  }
  console.log('Pushing vault wiki pages to dchat knowledge-base…');
  const pages = vault.listWikiPages().filter(p => p.slug !== 'index' && p.slug !== 'dashboard');
  let pushed = 0, updated = 0;

  for (const page of pages) {
    const result = await hubPost('/api/vault/documents', {
      project_slug: 'knowledge-base',
      project_name: 'Knowledge Base',
      filename: `${page.slug}.md`,
      markdown: page.raw,
      mimetype: 'text/markdown',
    });
    if (result.action === 'created') pushed++;
    else updated++;
    process.stdout.write('.');
  }
  console.log(`\nPush complete: ${pushed} created, ${updated} updated.`);
}

// ── PROCESS: raw_sources → wiki pages ────────────────────────────────────────
async function cmdProcess() {
  const key = modelArg || 'deepseek-v3';
  const mid  = modelId(key);
  console.log(`Processing unhandled raw sources with ${key} (${mid})…`);

  const unprocessed = vault.listUnprocessedRaw();
  if (!unprocessed.length) { console.log('Nothing to process.'); return; }

  console.log(`Found ${unprocessed.length} unprocessed file(s).`);
  const allPages = vault.listWikiPages();

  for (const raw of unprocessed) {
    console.log(`\nProcessing: ${raw.project}/${raw.filename}`);
    const content = fs.readFileSync(raw.filePath, 'utf8').slice(0, 8000);

    const pageList = allPages.map(p => `- ${p.slug}: ${p.title}`).join('\n');

    const data = await fetchOpenRouterFull(mid, [
      {
        role: 'system',
        content: `You are a knowledge base curator. Given a source document, create a concise wiki page in markdown.

Format:
---
title: <short descriptive title>
categories:
- <relevant category>
confidence: medium
sources:
- file: ${raw.filePath}
  ingested: '${new Date().toISOString()}'
---

## Summary
<2-3 sentence summary>

## Key Points
- bullet points of important information

## Details
<main content, 200-400 words>

After the content, add a "## Related" section with [[wikilinks]] to any of these existing pages that are genuinely relevant:
${pageList}

Use [[slug]] format for links. Only link if there is a real thematic connection.`,
      },
      { role: 'user', content: `Source document from project "${raw.project}":\n\n${content}` },
    ]);

    const text = data.choices?.[0]?.message?.content || '';
    if (!text.trim()) { console.log('  ⚠ Empty response, skipping.'); continue; }

    // Derive slug from filename: strip timestamp prefix + extensions
    const slug = raw.filename
      .replace(/^\d+-/, '')
      .replace(/\.(md|pdf\.md|docx\.md|txt\.md)$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    const { frontmatter, body } = vault.splitFrontmatter(text.trim());
    vault.writeWikiPage(slug, frontmatter, body);
    allPages.push({ slug, title: slug, body, frontmatter, raw: text, existingLinks: [], sources: [raw.filePath] });
    console.log(`  ✓ Created wiki/${slug}.md`);
  }

  vault.rebuildIndex(vault.listWikiPages());
  console.log('\nIndex rebuilt.');
}

// ── LINK: discover and add missing [[wikilinks]] ──────────────────────────────
async function cmdLink() {
  const key = modelArg || 'gemini-25-pro';
  const mid  = modelId(key);
  console.log(`Running link discovery with ${key} (${mid})…`);

  const pages = vault.listWikiPages().filter(p => p.slug !== 'index' && p.slug !== 'dashboard');
  if (pages.length < 2) { console.log('Not enough pages to link.'); return; }

  // Build a compact summary of each page for the prompt
  const summaries = pages.map(p => ({
    slug: p.slug,
    title: p.title,
    preview: p.body.replace(/#+\s*/g, '').replace(/\n+/g, ' ').slice(0, 300),
    existingLinks: p.existingLinks,
  }));

  const catalogue = summaries.map(s =>
    `[${s.slug}] "${s.title}"\n  ${s.preview}`
  ).join('\n\n');

  const data = await fetchOpenRouterFull(mid, [
    {
      role: 'system',
      content: `You are a knowledge graph curator. Analyse these wiki pages and find missing connections.
Return ONLY a JSON array of link objects. Each object must have:
  "from": source page slug
  "to": target page slug
  "reason": one sentence explaining the connection

Rules:
- Only suggest links that represent a genuine thematic, topical, or contextual relationship
- Do NOT suggest links that already exist
- Each pair should appear at most once (don't duplicate from/to reversed)
- Aim for 3-10 high-quality connections, not exhaustive ones
- Pay special attention to: project content linking to related wiki articles, videos linking to real projects that demonstrate those concepts

Return raw JSON array only, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Here are all wiki pages:\n\n${catalogue}\n\nExisting links per page:\n${
        summaries.map(s => `${s.slug}: ${s.existingLinks.join(', ') || 'none'}`).join('\n')
      }`,
    },
  ]);

  const text = data.choices?.[0]?.message?.content || '';
  let pairs = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) pairs = JSON.parse(match[0]);
  } catch (e) {
    console.error('Could not parse link response:', e.message);
    console.log('Raw response:', text.slice(0, 500));
    return;
  }

  if (!pairs.length) { console.log('No new links suggested.'); return; }

  console.log(`\nSuggested ${pairs.length} new link(s):\n`);
  let applied = 0;

  for (const { from, to, reason } of pairs) {
    const fromPage = vault.readWikiPage(from);
    const toPage   = vault.readWikiPage(to);
    if (!fromPage || !toPage) {
      console.log(`  ✗ ${from} → ${to}: page not found, skipping`);
      continue;
    }

    console.log(`  ${from} → ${to}\n    ${reason}`);

    // Add [[to]] link to the from-page body if not already present
    const alreadyLinked = fromPage.body.includes(`[[${to}`) || fromPage.body.includes(`[[${to}]]`);
    if (!alreadyLinked) {
      const newBody = fromPage.body.trimEnd() + `\n\n## Related\n\n- [[${to}]] — ${reason}\n`;
      vault.writeWikiPage(from, fromPage.frontmatter, newBody);
      applied++;
    } else {
      console.log(`    (already linked)`);
    }
  }

  console.log(`\nApplied ${applied} new link(s).`);
  vault.rebuildIndex(vault.listWikiPages());
}

// ── STATUS: overview of vault health ─────────────────────────────────────────
function cmdStatus() {
  const pages      = vault.listWikiPages();
  const unprocessed = vault.listUnprocessedRaw();
  const orphans    = pages.filter(p =>
    p.slug !== 'index' && p.slug !== 'dashboard' && p.existingLinks.length === 0
  );

  console.log(`\nVault status (${vault.VAULT_ROOT})`);
  console.log(`  Wiki pages:       ${pages.length}`);
  console.log(`  Unprocessed raw:  ${unprocessed.length}`);
  console.log(`  Orphaned pages:   ${orphans.length}`);

  if (unprocessed.length) {
    console.log('\nUnprocessed:');
    unprocessed.forEach(f => console.log(`  ${f.project}/${f.filename}`));
  }
  if (orphans.length) {
    console.log('\nOrphans (no [[wikilinks]]):');
    orphans.forEach(p => console.log(`  ${p.slug} — ${p.title}`));
  }

  console.log('\nLink summary:');
  pages
    .filter(p => p.slug !== 'index')
    .sort((a, b) => b.existingLinks.length - a.existingLinks.length)
    .forEach(p => console.log(`  ${p.slug.padEnd(50)} ${p.existingLinks.length} link(s)`));
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
(async () => {
  switch (command) {
    case 'pull':    await cmdPull();    break;
    case 'push':    await cmdPush();    break;
    case 'process': await cmdProcess(); break;
    case 'link':    await cmdLink();    break;
    case 'status':  cmdStatus();        break;
    default:
      console.log(`Usage: node scripts/vault.js <pull|push|process|link|status> [--model <key>]`);
      console.log(`\nAvailable models: ${Object.keys(MODELS).join(', ')}`);
      process.exit(1);
  }
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
