'use strict';

const fs = require('fs');
const path = require('path');
const { vaultRoot } = require('./obsidian-vault');

function wikiDir() {
  return path.join(vaultRoot(), 'wiki');
}

function parseFrontmatterTags(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { tags: [], title: null, created: null };
  const fm = match[1];
  const tags = [];

  // Inline array: tags: [a, b, c]
  const inlineMatch = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    for (const t of inlineMatch[1].split(',')) {
      const clean = t.trim().replace(/^['"]|['"]$/g, '');
      if (clean) tags.push(clean);
    }
  } else {
    // Block list: tags:\n- item  OR  tags:\n  - item (any indentation)
    let inTags = false;
    for (const line of fm.split('\n')) {
      if (/^tags:/.test(line)) { inTags = true; continue; }
      if (inTags && /^\s*- (.+)$/.test(line)) { tags.push(line.match(/^\s*- (.+)$/)[1].trim()); continue; }
      if (inTags && /^\S/.test(line)) inTags = false;
    }
  }

  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const createdMatch = fm.match(/^created:\s*'?([^'\n]+)'?/m);
  return {
    tags,
    title: titleMatch ? titleMatch[1].replace(/^['"]|['"]$/g, '').trim() : null,
    created: createdMatch ? createdMatch[1].trim() : null,
  };
}

// All unique tags across wiki pages, sorted alphabetically
function getAllWikiTags() {
  const dir = wikiDir();
  if (!fs.existsSync(dir)) return [];
  const tagSet = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { tags } = parseFrontmatterTags(raw);
      for (const t of tags) if (t) tagSet.add(t);
    } catch (_) {}
  }
  return [...tagSet].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Wiki pages whose tags overlap with the given tag array, sorted newest first
// Returns: [{ slug, title, tags, created, matchedTags }]
function getWikiPagesByTags(tags, { limit = 10, since = null } = {}) {
  if (!tags || !tags.length) return [];
  const dir = wikiDir();
  if (!fs.existsSync(dir)) return [];
  const tagSet = new Set(tags.map(t => t.toLowerCase()));
  const results = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { tags: pageTags, title, created } = parseFrontmatterTags(raw);
      if (!pageTags.length) continue;
      if (since && created && new Date(created) < new Date(since)) continue;
      const matched = pageTags.filter(t => tagSet.has(t.toLowerCase()));
      if (!matched.length) continue;
      const slug = file.replace(/\.md$/, '');
      const displayTitle = title || raw.match(/^# (.+)/m)?.[1] || slug;
      results.push({ slug, title: displayTitle, tags: pageTags, created, matchedTags: matched });
    } catch (_) {}
  }
  results.sort((a, b) => {
    if (a.created && b.created) return new Date(b.created) - new Date(a.created);
    if (a.created) return -1;
    if (b.created) return 1;
    return 0;
  });
  return results.slice(0, limit);
}

// Write wiki/tags-index.md — the vault's record of what's tagged where.
// Called after every tag assignment in admin so synthadoc sees the mapping.
function writeTagsIndex({ projects, contacts, wikiTags }) {
  const { writeNote } = require('./obsidian-vault');

  const allAssigned = new Set([
    ...projects.flatMap(p => JSON.parse(p.wiki_tags || '[]')),
    ...contacts.flatMap(c => JSON.parse(c.wiki_tags || '[]')),
  ]);
  const unassigned = wikiTags.filter(t => !allAssigned.has(t));

  const lines = [
    '---',
    'title: Knowledge Tags Index',
    'type: tags-index',
    `updated: '${new Date().toISOString().slice(0, 10)}'`,
    'tags: [tags-index, knowledge-map]',
    '---',
    '',
    '# Knowledge Tags Index',
    '',
    '## Projects',
  ];

  for (const p of projects) {
    const tags = JSON.parse(p.wiki_tags || '[]');
    const tagStr = tags.length ? ': ' + tags.map(t => `[[${t}]]`).join(', ') : '';
    lines.push(`- [[${p.name}]]${tagStr}`);
  }

  lines.push('', '## Contacts');
  for (const c of contacts) {
    const tags = JSON.parse(c.wiki_tags || '[]');
    const tagStr = tags.length ? ': ' + tags.map(t => `[[${t}]]`).join(', ') : '';
    lines.push(`- [[${c.name}]]${tagStr}`);
  }

  if (unassigned.length) {
    lines.push('', '## Unassigned', unassigned.join(', '));
  }

  writeNote({ notePath: 'wiki/tags-index.md', content: lines.join('\n'), mode: 'update' });
}

module.exports = { getAllWikiTags, getWikiPagesByTags, writeTagsIndex };
