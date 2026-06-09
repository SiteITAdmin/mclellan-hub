'use strict';

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { vaultRoot } = require('./obsidian-vault');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const SYSTEM_WIKI_SLUGS = new Set([
  'dashboard',
  'index',
  'mclellan-hub-overview',
  'overview',
  'purpose',
  'synthadoc-integration',
  'tags-index',
]);

// ── Content sources ───────────────────────────────────────────────────────────
// writable=true means the auto-linker may inject [[wikilinks]] into these files.
const CONTENT_SOURCES = [
  { dir: 'wiki',                type: 'wiki',    label: 'Wiki',        writable: true  },
  { dir: 'Meetings',            type: 'meeting', label: 'Meetings',    writable: false },
  { dir: 'Journal',             type: 'journal', label: 'Journal',     writable: false },
  { dir: 'Daily',               type: 'daily',   label: 'Daily Notes', writable: false },
  { dir: 'raw_sources/workday', type: 'workday', label: 'Workday',     writable: false },
  { dir: 'People',              type: 'person',  label: 'People',      writable: false },
  { dir: 'Projects',            type: 'project', label: 'Projects',    writable: false, recursive: true },
  // Loose notes at the vault root (Nicola.md, Beacon.md, …) — excludes system files
  { dir: '',                    type: 'note',    label: 'Notes',       writable: false, exclude: ['AGENTS.md', 'log.md'] },
];

// ── Frontmatter parser ────────────────────────────────────────────────────────
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: raw };
  const fm = {};
  let currentKey = null;
  let currentList = null;
  for (const line of match[1].split('\n')) {
    const listItem = line.match(/^\s{2,}- (.+)$/);
    const kv       = line.match(/^([\w][\w-]*):\s*(.*)$/);
    if (listItem && currentList !== null) {
      const v = listItem[1].replace(/^['"]|['"]$/g, '');
      try { currentList.push(JSON.parse(v)); } catch { currentList.push(v); }
    } else if (kv) {
      currentKey = kv[1];
      const val  = kv[2].trim();
      if (val === '' || val === '[]') {
        fm[currentKey] = []; currentList = fm[currentKey];
      } else if (val.startsWith('[')) {
        try { fm[currentKey] = JSON.parse(val); } catch { fm[currentKey] = []; } currentList = null;
      } else {
        fm[currentKey] = val.replace(/^['"]|['"]$/g, ''); currentList = null;
      }
    } else {
      currentList = null;
    }
  }
  return { fm, body: match[2].trim() };
}

// ── Wikilink extraction ───────────────────────────────────────────────────────
function extractWikilinks(content) {
  const links = new Set();
  for (const [, target] of String(content).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    links.add(target.trim().toLowerCase().replace(/\s+/g, '-'));
  }
  return [...links];
}

// ── Slug helpers ──────────────────────────────────────────────────────────────
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

// ── Walk a directory for .md files ────────────────────────────────────────────
function walkDir(dir, recursive) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...walkDir(full, true));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

// ── Index a single file ───────────────────────────────────────────────────────
function indexFile(fullPath, relativePath, source) {
  try {
    const raw       = fs.readFileSync(fullPath, 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    const basename  = path.basename(relativePath, '.md');
    // Wiki pages use just the basename as slug; all others use the full relative path
    const slug      = source.type === 'wiki' ? basename : relativePath.replace(/\\/g, '/').replace(/\.md$/, '');
    // Projects/: top-level notes are the projects themselves (aligned with CRM);
    // anything nested (raw_sources etc.) is an ingested document, not a project.
    let type = source.type, typeLabel = source.label;
    if (type === 'project' && slug.split('/').length > 2) {
      type = 'project-doc';
      typeLabel = 'Project files';
    }
    const title     = body.match(/^# (.+)$/m)?.[1]?.trim()
                   || fm.title
                   || basename.replace(/[-_]/g, ' ');
    return {
      slug,
      fullPath,
      relativePath,
      type,
      typeLabel,
      writable:   source.writable || false,
      title,
      tags:       Array.isArray(fm.tags) ? fm.tags : [],
      aliases:    Array.isArray(fm.aliases) ? fm.aliases : [],
      categories: Array.isArray(fm.categories) ? fm.categories : [],
      sources:    Array.isArray(fm.sources) ? fm.sources : [],
      content:    body,
      raw,
      created:    fm.created || fm.captured_at || fm.date || null,
      confidence: fm.confidence || null,
      project:    fm.project || null,
      filename:   fm.filename || null,
      system:     source.type === 'wiki' && SYSTEM_WIKI_SLUGS.has(slug),
      wikilinks:  extractWikilinks(body),
    };
  } catch (_) {
    return null;
  }
}

// ── Index all vault content ───────────────────────────────────────────────────
function indexAll() {
  const root  = vaultRoot();
  const pages = [];
  for (const source of CONTENT_SOURCES) {
    for (const fullPath of walkDir(path.join(root, source.dir), source.recursive || false)) {
      if (source.exclude && source.exclude.includes(path.basename(fullPath))) continue;
      const relativePath = path.relative(root, fullPath);
      const page = indexFile(fullPath, relativePath, source);
      if (page) pages.push(page);
    }
  }
  return pages;
}

// ── Link resolution ───────────────────────────────────────────────────────────
// Wikilink targets are normalised (lowercase, spaces→hyphens) but non-wiki pages
// have path slugs like "People/Aunt Liz", so [[Aunt Liz]] never matches directly.
// The resolver maps every page's slug, basename, title, and aliases (normalised)
// to its canonical slug. Wiki pages register first so they win key collisions.
function normalizeLinkKey(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function buildLinkResolver(pages) {
  const map = new Map();
  const add = (key, slug) => { if (key && !map.has(key)) map.set(key, slug); };
  const ordered = [...pages].sort((a, b) => (a.type === 'wiki' ? 0 : 1) - (b.type === 'wiki' ? 0 : 1));
  for (const p of ordered) {
    add(normalizeLinkKey(p.slug), p.slug);
    add(normalizeLinkKey(p.slug.split('/').pop()), p.slug);
    add(normalizeLinkKey(p.title), p.slug);
    add(slugify(p.title), p.slug);
    for (const a of (p.aliases || [])) {
      add(normalizeLinkKey(a), p.slug);
      add(slugify(a), p.slug);
    }
  }
  return map;
}

// ── Manual links ──────────────────────────────────────────────────────────────
// User-confirmed links between two pages, created from the graph view.
// Stored in the vault so they survive deploys and travel with backups.
// relation: 'same' (same person/thing) or 'related'.
function manualLinksPath() {
  return path.join(vaultRoot(), 'raw_sources', 'manual-links.json');
}

function loadManualLinks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(manualLinksPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveManualLinks(links) {
  fs.mkdirSync(path.dirname(manualLinksPath()), { recursive: true });
  fs.writeFileSync(manualLinksPath(), JSON.stringify(links, null, 2) + '\n', 'utf8');
}

function isSamePair(l, a, b) {
  return (l.from === a && l.to === b) || (l.from === b && l.to === a);
}

// Record the link AND feed it back into both source files as [[wikilinks]],
// so the relationship lives in the markdown, not only in the store.
function addManualLink({ from, to, relation = 'related' }) {
  const pages = indexAll();
  const a = pages.find(p => p.slug === from);
  const b = pages.find(p => p.slug === to);
  if (!a || !b) throw new Error('both pages must exist');
  if (a.slug === b.slug) throw new Error('cannot link a page to itself');

  const links = loadManualLinks().filter(l => !isSamePair(l, from, to));
  links.push({ from, to, relation: relation === 'same' ? 'same' : 'related', created: new Date().toISOString() });
  saveManualLinks(links);

  // Idempotent write-back into each file's Related section
  if (!a.wikilinks.includes(normalizeLinkKey(b.slug))) injectBacklink(a.fullPath, a.raw, b.slug);
  if (!b.wikilinks.includes(normalizeLinkKey(a.slug))) injectBacklink(b.fullPath, b.raw, a.slug);

  return { from, to, relation };
}

// Removes the stored link only — injected wikilinks stay in the files.
function removeManualLink({ from, to }) {
  saveManualLinks(loadManualLinks().filter(l => !isSamePair(l, from, to)));
}

// Replace any [[wikilink]] in this file that resolves to targetSlug with plain text
function stripWikilinksTo(page, targetSlug, resolver) {
  try {
    const raw = fs.readFileSync(page.fullPath, 'utf8');
    const updated = raw.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, target, label) => {
      const resolved = resolver.get(normalizeLinkKey(target));
      return resolved === targetSlug ? (label || target.split('/').pop()) : match;
    });
    if (updated !== raw) fs.writeFileSync(page.fullPath, updated, 'utf8');
  } catch (_) {}
}

// Fully sever a link: remove the manual store entry AND the [[wikilinks]]
// in both files, in both directions. Plain-text mentions are left intact.
function removeLinkCompletely(fromSlug, toSlug) {
  removeManualLink({ from: fromSlug, to: toSlug });
  const pages    = indexAll();
  const resolver = buildLinkResolver(pages);
  const a = pages.find(p => p.slug === fromSlug);
  const b = pages.find(p => p.slug === toSlug);
  if (a) stripWikilinksTo(a, toSlug, resolver);
  if (b) stripWikilinksTo(b, fromSlug, resolver);
}

// ── Build link graph ──────────────────────────────────────────────────────────
// outbound[slug] = Set of slugs this page links to
// inbound[slug]  = Set of slugs that link to this page
// Manual links are merged in so orphans/related views see them too.
function buildGraph(pages, { manualLinks = loadManualLinks() } = {}) {
  const slugSet  = new Set(pages.map(p => p.slug));
  const resolver = buildLinkResolver(pages);
  const outbound = new Map(pages.map(p => [p.slug, new Set()]));
  const inbound  = new Map(pages.map(p => [p.slug, new Set()]));
  for (const p of pages) {
    for (const link of p.wikilinks) {
      const target = slugSet.has(link) ? link : resolver.get(link);
      if (target && target !== p.slug) {
        outbound.get(p.slug).add(target);
        inbound.get(target).add(p.slug);
      }
    }
  }
  for (const m of manualLinks) {
    if (slugSet.has(m.from) && slugSet.has(m.to) && m.from !== m.to) {
      outbound.get(m.from).add(m.to);
      inbound.get(m.to).add(m.from);
    }
  }
  // Project documents implicitly belong to their project note (Projects/<slug>.md)
  for (const p of pages) {
    if (p.type !== 'project-doc') continue;
    const projectSlug = p.slug.split('/').slice(0, 2).join('/');
    if (slugSet.has(projectSlug) && projectSlug !== p.slug) {
      outbound.get(p.slug).add(projectSlug);
      inbound.get(projectSlug).add(p.slug);
    }
  }
  return { outbound, inbound };
}

// ── CRM project sync ──────────────────────────────────────────────────────────
// Ensures every CRM project has a vault note at Projects/<slug>.md so the wiki,
// graph, and CRM all agree on what a "project" is. Never overwrites existing
// notes. Returns the slugs it created.
function syncProjectNotes(projects) {
  const dir = path.join(vaultRoot(), 'Projects');
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (const pr of projects || []) {
    if (!pr || !pr.slug || !/^[a-z0-9][a-z0-9-]*$/.test(pr.slug)) continue;
    const file = path.join(dir, `${pr.slug}.md`);
    if (fs.existsSync(file)) continue;
    const name = pr.name || pr.slug;
    fs.writeFileSync(file, [
      '---',
      `title: ${JSON.stringify(name)}`,
      'type: project',
      `created: '${new Date().toISOString()}'`,
      'tags:',
      '  - project',
      '---',
      '',
      `# ${name}`,
      '',
      'CRM project workspace. Ingested documents appear as linked Project files.',
      '',
    ].join('\n'), 'utf8');
    created.push(pr.slug);
  }
  return created;
}

// ── Find related pages ────────────────────────────────────────────────────────
// Two signals: shared tags (scored x2 each) + full title/alias mention (scored x3).
function findRelated(page, allPages, { limit = 8 } = {}) {
  const pageTags = new Set((page.tags || []).map(t => t.toLowerCase()));
  return allPages
    .filter(p => p.slug !== page.slug)
    .map(p => {
      let score = 0;
      for (const t of (p.tags || [])) {
        if (pageTags.has(t.toLowerCase())) score += 2;
      }
      // Does this page's content mention the target's title/aliases?
      const targetTerms = [p.title, ...(p.aliases || [])].map(t => t.toLowerCase()).filter(t => t.length >= 3);
      const hay1 = page.content.toLowerCase();
      if (targetTerms.some(t => hay1.includes(t))) score += 3;
      // Does the target's content mention this page's title/aliases?
      const sourceTerms = [page.title, ...(page.aliases || [])].map(t => t.toLowerCase()).filter(t => t.length >= 3);
      const hay2 = p.content.toLowerCase();
      if (sourceTerms.some(t => hay2.includes(t))) score += 3;
      return { p, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => p);
}

// ── Orphan detection ──────────────────────────────────────────────────────────
// Checks wiki-to-wiki links only. Non-wiki content is source material, not graph nodes.
function getOrphans(pages, graph) {
  const wikiPages = pages.filter(p => p.type === 'wiki');
  const wikiSlugs = new Set(wikiPages.map(p => p.slug));
  const orphans     = [];
  const sinks       = []; // has outbound wiki links but no inbound
  const sources     = []; // has inbound wiki links but no outbound
  for (const p of wikiPages) {
    const out = [...(graph.outbound.get(p.slug) || [])].filter(s => wikiSlugs.has(s));
    const inn = [...(graph.inbound.get(p.slug)  || [])].filter(s => wikiSlugs.has(s));
    if      (out.length === 0 && inn.length === 0) orphans.push(p);
    else if (out.length > 0   && inn.length === 0) sinks.push({ page: p, out });
    else if (out.length === 0 && inn.length > 0  ) sources.push({ page: p, inn });
  }
  return { orphans, sinks, sources };
}

// ── Auto-linker ───────────────────────────────────────────────────────────────
// Called after writing a new wiki page. Two actions:
// 1. Inject [[newSlug]] into existing wiki pages that mention the new page's title/aliases.
// 2. Return slugs that should appear as [[links]] in the new page (existing pages whose
//    titles appear in the new page's content).
// Only modifies writable=true files. Requires FULL title or alias match (not substrings).
function autoLink(newSlug, newTitle, newAliases, newContent, allPages) {
  const wikiPages   = allPages.filter(p => p.type === 'wiki' && p.writable && p.slug !== newSlug);
  const newTerms    = [newTitle, ...(newAliases || [])].map(t => t.toLowerCase()).filter(t => t.length >= 3);
  const outboundSlugs = new Set();

  for (const existing of wikiPages) {
    const existingTerms = [existing.title, ...existing.aliases].map(t => t.toLowerCase()).filter(t => t.length >= 3);

    // Does the new page's content mention this existing page? → outbound link from new page
    const newHay = newContent.toLowerCase();
    if (existingTerms.some(t => fullWordMatch(newHay, t))) {
      outboundSlugs.add(existing.slug);
    }

    // Does the existing page's content mention the new page? → inject [[newSlug]] into existing
    const existingHay = existing.content.toLowerCase();
    if (!existing.wikilinks.includes(newSlug) && newTerms.some(t => fullWordMatch(existingHay, t))) {
      injectBacklink(existing.fullPath, existing.raw, newSlug);
    }
  }

  return [...outboundSlugs];
}

// Word-boundary-aware match: avoids matching "Microsoft" inside "Microsoft 365"
function fullWordMatch(haystack, needle) {
  if (!needle || needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,;:.()"'\\-])${escaped}(?:[\\s,;:.()"'\\-]|$)`, 'i').test(haystack);
}

// Append [[slug]] to a Related section if it exists, otherwise add one at the end
function injectBacklink(fullPath, raw, slug) {
  try {
    const relatedRe = /^## Related\s*\n/im;
    let updated;
    if (relatedRe.test(raw)) {
      updated = raw.replace(relatedRe, `## Related\n[[${slug}]] `);
    } else {
      updated = raw.trimEnd() + `\n\n## Related\n[[${slug}]]\n`;
    }
    fs.writeFileSync(fullPath, updated, 'utf8');
  } catch (_) {}
}

// ── Keyword search across all indexed content ─────────────────────────────────
function searchAll(query, { limit = 12 } = {}) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const pages = indexAll().filter(p => !p.system);
  return pages
    .map(p => {
      const hay = [p.title, p.content, p.project, p.filename, ...p.tags, ...p.aliases]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!terms.every(t => hay.includes(t))) return null;
      const titleHits = terms.reduce((n, t) => n + (p.title.toLowerCase().includes(t) ? 5 : 0), 0);
      const bodyHits  = terms.reduce((n, t) => n + (p.content.toLowerCase().split(t).length - 1), 0);
      const typeBoost = p.type === 'wiki' ? 10 : 0;
      return { ...p, _score: titleHits + bodyHits + typeBoost };
    })
    .filter(Boolean)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// ── LLM: generate wiki page from a Q&A exchange ──────────────────────────────
async function generateWikiPage({ question, answer, existingPageSummaries }) {
  const summaryStr = existingPageSummaries.slice(0, 40).join('\n');
  const userContent = [
    'Existing wiki pages (slug: title):',
    summaryStr,
    '',
    `Question: ${question.slice(0, 600)}`,
    '',
    `Answer: ${answer.slice(0, 2000)}`,
  ].join('\n');

  const started = Date.now();
  const modelId = getSystemModelId('wiki_page_writer', 'system', 'google/gemini-2.5-pro-preview');
  const sysPrompt = getSystemPrompt('wiki_page_writer', 'system', PROMPTS.wiki_page_writer);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userContent }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'wiki-save',
    modelKey: 'wiki_page_writer',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
  });
  return JSON.parse(data.choices[0].message.content);
}

// ── Save document to wiki ─────────────────────────────────────────────────────
async function documentToWiki({ filename, markdown, projectName }) {
  const allPages  = indexAll();
  const wikiPages = allPages.filter(p => p.type === 'wiki');
  const summaries = wikiPages.map(p => `${p.slug}: ${p.title}`).slice(0, 40).join('\n');

  const docUserContent = [
    'Existing wiki pages (slug: title):',
    summaries,
    '',
    `Source document: ${filename}${projectName ? ` (from project: ${projectName})` : ''}`,
    '',
    markdown.slice(0, 4000),
  ].join('\n');

  const started = Date.now();
  const modelId = getSystemModelId('wiki_page_writer', 'system', 'google/gemini-2.5-pro-preview');
  const docSysPrompt = getSystemPrompt('wiki_page_writer', 'system', PROMPTS.wiki_page_writer);
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'system', content: docSysPrompt }, { role: 'user', content: docUserContent }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({ user: 'system', feature: 'wiki-doc-save', modelKey: 'wiki_page_writer', fallbackModelId: modelId, data, durationMs: Date.now() - started });
  return JSON.parse(data.choices[0].message.content);
}

// ── Save image to wiki (vision → description → wiki page) ─────────────────────
async function imageToWiki({ filename, buffer, mimetype, projectName }) {
  const started = Date.now();
  const modelId = getSystemModelId('wiki_image_vision', 'system', 'google/gemini-2.5-flash');
  const b64 = buffer.toString('base64');

  // Use vision model to describe the image
  const visionResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
      'X-Title': 'McLellan Hub',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${b64}` } },
          { type: 'text', text: getSystemPrompt('wiki_image_vision', 'system', PROMPTS.wiki_image_vision) + (projectName ? ` (project: ${projectName})` : '') },
        ],
      }],
      temperature: 0.2,
    }),
  });
  if (!visionResp.ok) throw new Error(`Vision API error ${visionResp.status}`);
  const visionData = await visionResp.json();
  logUsageFromResponse({ user: 'system', feature: 'wiki-image-vision', modelKey: 'wiki_image_vision', fallbackModelId: modelId, data: visionData, durationMs: Date.now() - started });
  const description = visionData.choices[0].message.content.trim();

  // Generate wiki page from the description
  return documentToWiki({ filename, markdown: `## Image Description\n\n${description}`, projectName });
}

function writeWikiPage(generated) {
  let { slug, title, tags, content, related = [] } = generated;
  slug = slugify(slug || title);

  const allPages  = indexAll();
  const wikiPages = allPages.filter(p => p.type === 'wiki');
  const outboundSlugs = autoLink(slug, title, [], content, allPages);
  const allLinked = [...new Set([...related, ...outboundSlugs])].filter(s => s !== slug && wikiPages.some(p => p.slug === s));
  if (allLinked.length) content += '\n\n## Related\n' + allLinked.map(s => `[[${s}]]`).join(' · ');

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `created: '${new Date().toISOString()}'`,
    'categories:',
    '  - Saved from dchat',
    'tags:',
    ...tags.map(t => `  - ${t}`),
    'confidence: medium',
    '---',
    '',
  ].join('\n');

  const root    = vaultRoot();
  const wikiDir = path.join(root, 'wiki');
  fs.mkdirSync(wikiDir, { recursive: true });

  let finalSlug = slug;
  for (let i = 1; i <= 9 && fs.existsSync(path.join(wikiDir, `${finalSlug}.md`)); i++) {
    finalSlug = `${slug}-${i}`;
  }
  fs.writeFileSync(path.join(wikiDir, `${finalSlug}.md`), frontmatter + content, 'utf8');
  return { slug: finalSlug, title };
}

// ── Save Q&A to wiki ──────────────────────────────────────────────────────────
async function saveToWiki({ question, answer }) {
  const allPages   = indexAll();
  const wikiPages  = allPages.filter(p => p.type === 'wiki');
  const summaries  = wikiPages.map(p => `${p.slug}: ${p.title}`);

  const generated  = await generateWikiPage({ question, answer, existingPageSummaries: summaries });
  let { slug, title, tags, content, related = [] } = generated;
  slug = slugify(slug || title);

  // Auto-link: find outbound links and inject backlinks into existing pages
  const outboundSlugs = autoLink(slug, title, [], content, allPages);
  const allLinked = [...new Set([...related, ...outboundSlugs])].filter(s => s !== slug && wikiPages.some(p => p.slug === s));

  if (allLinked.length) {
    content += '\n\n## Related\n' + allLinked.map(s => `[[${s}]]`).join(' · ');
  }

  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `created: '${new Date().toISOString()}'`,
    'categories:',
    '  - Saved from dchat',
    'tags:',
    ...tags.map(t => `  - ${t}`),
    'confidence: medium',
    '---',
    '',
  ].join('\n');

  return writeWikiPage(generated);
}

module.exports = {
  indexAll,
  buildGraph,
  buildLinkResolver,
  normalizeLinkKey,
  loadManualLinks,
  addManualLink,
  removeManualLink,
  removeLinkCompletely,
  syncProjectNotes,
  findRelated,
  getOrphans,
  autoLink,
  saveToWiki,
  documentToWiki,
  imageToWiki,
  writeWikiPage,
  searchAll,
  slugify,
  CONTENT_SOURCES,
  SYSTEM_WIKI_SLUGS,
};
