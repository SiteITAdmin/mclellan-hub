'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const fetch   = require('node-fetch');
const multer  = require('multer');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const db     = require('../lib/db');
const { vaultRoot } = require('../lib/obsidian-vault');
const { startGoogleAuth, finishGoogleAuth } = require('../lib/google-auth');
const { requireSameOrigin } = require('../lib/security');
const {
  indexAll,
  buildGraph,
  findRelated,
  getOrphans,
  searchAll,
  CONTENT_SOURCES,
} = require('../lib/wiki-engine');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
router.use(limiter);

// ── Auth ──────────────────────────────────────────────────────────────────────
const WIKI_USER = 'douglas';

function requireAuth(req, res, next) {
  if (req.session?.wikiAuthed) return next();
  res.redirect('/login');
}

router.get('/login', (req, res) => res.render('wiki/login'));

router.get('/auth/google', startGoogleAuth({
  purpose: 'wiki',
  user: WIKI_USER,
  callbackPath: '/auth/google/callback',
  returnTo: '/',
}));

router.get('/auth/google/callback', finishGoogleAuth({
  purpose: 'wiki',
  user: WIKI_USER,
  callbackPath: '/auth/google/callback',
  sessionKey: 'wikiAuthed',
  returnTo: '/',
}));

router.post('/logout', requireSameOrigin, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Wiki page helpers (wiki/ directory only) ──────────────────────────────────
function wikiDir() {
  return path.join(vaultRoot(), 'wiki');
}

function wikiDeleteQueueDir() {
  return path.join(vaultRoot(), 'raw_sources', 'wiki-delete-queue');
}

function writeWikiDeleteTombstone(slug) {
  const queueDir = wikiDeleteQueueDir();
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, `${slug}.json`),
    `${JSON.stringify({ slug, deletedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );
}

function clearWikiDeleteTombstone(slug) {
  const filepath = path.join(wikiDeleteQueueDir(), `${slug}.json`);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

function parseFrontmatter(yaml) {
  const result = {};
  const lines  = yaml.split('\n');
  let currentKey = null;
  let currentList = null;
  for (const line of lines) {
    const listItem = line.match(/^  - (.+)$/);
    const kv       = line.match(/^(\w+):\s*(.*)$/);
    if (listItem && currentList) {
      try { currentList.push(JSON.parse(listItem[1])); } catch { currentList.push(listItem[1].replace(/^['"]|['"]$/g, '')); }
    } else if (kv) {
      currentKey = kv[1];
      const val  = kv[2].trim();
      if (val === '' || val === '[]') { result[currentKey] = []; currentList = result[currentKey]; }
      else if (val.startsWith('[')) { try { result[currentKey] = JSON.parse(val); } catch { result[currentKey] = []; } currentList = null; }
      else { result[currentKey] = val.replace(/^['"]|['"]$/g, ''); currentList = null; }
    }
  }
  return result;
}

function parseWikiPage(slug) {
  const filepath = path.join(wikiDir(), `${slug}.md`);
  if (!fs.existsSync(filepath)) return null;
  const raw      = fs.readFileSync(filepath, 'utf8');
  const fmMatch  = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { slug, title: slug, content: raw, tags: [], categories: [], sources: [], created: null };
  const fm      = parseFrontmatter(fmMatch[1]);
  const content = fmMatch[2].trim();
  return {
    slug,
    title:      content.match(/^# (.+)/m)?.[1] || fm.title || slug,
    content,
    tags:       fm.tags || [],
    categories: fm.categories || [],
    sources:    fm.sources || [],
    created:    fm.created || null,
    confidence: fm.confidence || null,
    aliases:    fm.aliases || [],
    project:    fm.project || null,
    filename:   fm.filename || null,
  };
}

function allWikiPages() {
  const dir = wikiDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseWikiPage(f.replace('.md', '')))
    .filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const q        = (req.query.q || '').trim();
  const pages    = q ? [] : indexAll()
    .filter(p => p.type === 'wiki' && !p.system)
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
    .slice(0, 12); // search handled client-side via API
  const allPages = indexAll();
  const counts   = {};
  for (const s of CONTENT_SOURCES) counts[s.label] = allPages.filter(p => p.type === s.type).length;
  const total = allPages.length;
  res.render('wiki/index', { q, pages, total, counts });
});

router.get('/browse', requireAuth, (req, res) => {
  const allPages = indexAll();
  const byType = {};
  for (const p of allPages.filter(p => !p.system)) {
    (byType[p.typeLabel] = byType[p.typeLabel] || []).push(p);
  }
  const systemPages = allPages.filter(p => p.system);
  res.render('wiki/browse', { byType, systemPages });
});

// ── Wiki editing helpers ───────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function rebuildFile(page, { title, content, categories, tags }) {
  const fm = {
    title: title || page.title,
    aliases: page.aliases || [],
    categories: categories || page.categories || [],
    tags: tags || page.tags || [],
    confidence: page.confidence || 'medium',
    status: 'active',
    created: page.created || new Date().toISOString(),
  };
  const yamlLines = [
    `title: '${fm.title.replace(/'/g, "''")}'`,
    `aliases: [${fm.aliases.map(a => `'${a}'`).join(', ')}]`,
    `categories:`,
    ...fm.categories.map(c => `  - ${c}`),
    `tags:`,
    ...fm.tags.map(t => `  - ${t}`),
    `confidence: ${fm.confidence}`,
    `status: ${fm.status}`,
    `created: '${fm.created}'`,
  ];
  return `---\n${yamlLines.join('\n')}\n---\n\n${content.trim()}\n`;
}

// /page/new MUST come before /page/:slug to avoid being swallowed by the param route
router.get('/page/new', requireAuth, (req, res) => {
  res.render('wiki/edit', { page: null });
});

router.post('/page/new', requireAuth, requireSameOrigin, express.urlencoded({ extended: false }), (req, res) => {
  const { title, content, categories, tags } = req.body;
  if (!title) return res.redirect('/page/new');
  const slug = slugify(title);
  const newPath = path.join(wikiDir(), `${slug}.md`);
  const cats = (categories || '').split(',').map(s => s.trim()).filter(Boolean);
  const tagList = (tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const page = { slug, title, aliases: [], categories: cats, tags: tagList, confidence: 'medium', created: new Date().toISOString() };
  const fileContent = rebuildFile(page, { title, content, categories: cats, tags: tagList });
  fs.mkdirSync(wikiDir(), { recursive: true });
  clearWikiDeleteTombstone(slug);
  fs.writeFileSync(newPath, fileContent, 'utf8');
  res.redirect(`/page/${slug}`);
});

router.get('/page/:slug', requireAuth, (req, res) => {
  const page = parseWikiPage(req.params.slug);
  if (!page) return res.status(404).render('wiki/404', { slug: req.params.slug });
  const allPages = indexAll();
  const related  = findRelated(
    { ...page, type: 'wiki', aliases: page.aliases || [] },
    allPages
  ).slice(0, 6);
  res.render('wiki/page', { page, related });
});

router.get('/page/:slug/edit', requireAuth, (req, res) => {
  const page = parseWikiPage(req.params.slug);
  if (!page) return res.status(404).render('wiki/404', { slug: req.params.slug });
  res.render('wiki/edit', { page });
});

router.post('/page/:slug/save', requireAuth, requireSameOrigin, express.urlencoded({ extended: false }), (req, res) => {
  const page = parseWikiPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const { title, content, categories, tags } = req.body;
  const cats = (categories || '').split(',').map(s => s.trim()).filter(Boolean);
  const tagList = (tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const fileContent = rebuildFile(page, { title, content, categories: cats, tags: tagList });
  clearWikiDeleteTombstone(page.slug);
  fs.writeFileSync(path.join(wikiDir(), `${page.slug}.md`), fileContent, 'utf8');
  res.redirect(`/page/${page.slug}`);
});

router.post('/page/:slug/rename', requireAuth, requireSameOrigin, express.urlencoded({ extended: false }), (req, res) => {
  const page = parseWikiPage(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const newSlug = slugify(req.body.new_slug || '');
  if (!newSlug) return res.redirect(`/page/${page.slug}/edit`);
  const oldPath = path.join(wikiDir(), `${page.slug}.md`);
  const newPath = path.join(wikiDir(), `${newSlug}.md`);
  if (fs.existsSync(newPath)) return res.redirect(`/page/${page.slug}/edit?err=exists`);
  writeWikiDeleteTombstone(page.slug);
  clearWikiDeleteTombstone(newSlug);
  fs.renameSync(oldPath, newPath);
  res.redirect(`/page/${newSlug}`);
});

router.post('/page/:slug/delete', requireAuth, requireSameOrigin, express.urlencoded({ extended: false }), (req, res) => {
  const { slug } = req.params;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
  const filepath = path.join(wikiDir(), `${slug}.md`);
  writeWikiDeleteTombstone(slug);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  res.redirect('/browse');
});

router.get('/source/*', requireAuth, (req, res) => {
  const slug = req.params[0];
  const allPages = indexAll();
  const page = allPages.find(p => p.slug === slug && p.type !== 'wiki');
  if (!page) return res.status(404).render('wiki/404', { slug });
  const related = findRelated(page, allPages).slice(0, 6);
  res.render('wiki/page', {
    page: {
      ...page,
      categories: [],
      sources: [],
      created: page.created || null,
      confidence: null,
    },
    related,
  });
});

router.get('/orphans', requireAuth, (req, res) => {
  const allPages = indexAll();
  const graph    = buildGraph(allPages);
  const { orphans, sinks, sources } = getOrphans(allPages, graph);
  // For each orphan, suggest possible links
  const suggestions = orphans.slice(0, 20).map(p => ({
    page: p,
    related: findRelated({ ...p, aliases: p.aliases || [] }, allPages, { limit: 4 }),
  }));
  const wikiCount = allPages.filter(p => p.type === 'wiki').length;
  res.render('wiki/orphans', { orphans, sinks, sources, suggestions, wikiCount });
});

router.get('/graph', requireAuth, (req, res) => {
  res.render('wiki/graph');
});

router.get('/ingest', requireAuth, (req, res) => {
  const queueDir = path.join(vaultRoot(), 'raw_sources', 'ingest-queue');
  const queued   = fs.existsSync(queueDir)
    ? fs.readdirSync(queueDir).filter(f => f.endsWith('.url') || f.endsWith('.path')).slice(-10).reverse()
    : [];
  res.render('wiki/ingest', { queued, status: req.query.status || null });
});

// ── API: Queue URL ────────────────────────────────────────────────────────────
router.post('/api/ingest/url', requireAuth, requireSameOrigin, express.json(), async (req, res) => {
  const { url, projectSlug } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const queueDir = path.join(vaultRoot(), 'raw_sources', 'ingest-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const slug     = url.replace(/[^a-z0-9]/gi, '-').slice(-40);
  const filename = `${Date.now()}-${slug}.url`;
  fs.writeFileSync(path.join(queueDir, filename), JSON.stringify({ url, projectSlug: projectSlug || null }), 'utf8');
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (secret && process.env.HUB_URL) {
    fetch(`${process.env.HUB_URL}/api/synthadoc/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url, projectSlug, user: WIKI_USER }),
    }).catch(() => {});
  }
  res.json({ ok: true, queued: filename });
});

// ── API: Search + synthesise (all vault content) ──────────────────────────────
router.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], synthesis: null });

  const matches = searchAll(q, { limit: 8 });

  // Email summaries from DB
  const hub = db.hub();
  const emailMatches = hub.prepare(`
    SELECT subject, from_name, summary, received_at
    FROM email_summaries WHERE user = ?
    AND (subject LIKE ? OR summary LIKE ?)
    ORDER BY received_at DESC LIMIT 4
  `).all(WIKI_USER, `%${q}%`, `%${q}%`);

  if (!matches.length && !emailMatches.length) return res.json({ results: [], synthesis: null });

  // Build synthesis context — label each source by type
  const sourceContext = matches.map((p, index) => {
    const label = `[S${index + 1} | ${p.typeLabel} | ${p.title}]`;
    return `${label}\n${p.content.slice(0, 600)}`;
  }).join('\n\n');

  const emailContext = emailMatches.map((e, index) => {
    const d = new Date(e.received_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `[E${index + 1} | Email | ${d} | ${e.from_name} | ${e.subject}]\n${e.summary}`;
  }).join('\n\n');

  const context = [sourceContext, emailContext].filter(Boolean).join('\n\n---\n\n');

  let synthesis = null;
  if (process.env.OPENROUTER_API_KEY && context) {
    try {
      const sourceDirectory = matches.map((p, index) => (
        `S${index + 1}: ${p.typeLabel} | ${p.title} | ${p.type === 'wiki' ? p.slug : p.relativePath}`
      )).concat(emailMatches.map((e, index) => (
        `E${index + 1}: Email | ${e.subject} | ${e.from_name}`
      ))).join('\n');
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://wiki.mclellan.scot',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v3.2',
          messages: [
            {
              role: 'system',
              content: [
                'Answer from the supplied private knowledge-base sources only.',
                'Return valid JSON with this exact shape:',
                '{"headline":"short specific title","summary":"2-4 sentence direct answer","facts":[{"label":"short label","detail":"specific fact","source_ids":["S1"]}],"gaps":["specific missing information"],"assessment":"one sentence describing how complete the evidence is"}',
                'Use 3-7 facts. Keep facts concrete and avoid repeating the summary.',
                'A gap must be relevant to the question, not a generic wish list.',
                'Never claim a source says something absent from its excerpt.',
                'Do not output Markdown or text outside the JSON object.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `Question: ${q}\n\nSource directory:\n${sourceDirectory}\n\nSource excerpts:\n${context}`,
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });
      const data = await resp.json();
      const rawSynthesis = data.choices?.[0]?.message?.content?.trim();
      if (rawSynthesis) synthesis = JSON.parse(rawSynthesis);
    } catch (_) {}
  }

  const resultRows = matches.map((p, index) => ({
    sourceId:  `S${index + 1}`,
    slug:      p.type === 'wiki' ? p.slug : null,
    url:       p.type === 'wiki' ? `/page/${encodeURIComponent(p.slug)}` : `/source/${encodeURIComponent(p.slug)}`,
    title:     p.title,
    type:      p.type,
    typeLabel: p.typeLabel,
    project:   p.project,
    filename:  p.filename,
    tags:      p.tags,
    excerpt:   p.content.slice(0, 200),
  }));

  res.json({
    results: resultRows,
    emailMatches: emailMatches.map((e, index) => ({ ...e, sourceId: `E${index + 1}` })),
    synthesis,
  });
});

// ── API: Graph data ───────────────────────────────────────────────────────────
router.get('/api/graph', requireAuth, (req, res) => {
  const pages = indexAll();
  const graph = buildGraph(pages);
  const nodes = pages.map(p => ({
    id:        p.slug,
    label:     p.title,
    type:      p.type,
    typeLabel: p.typeLabel,
    tags:      p.tags || [],
    system:    !!p.system,
  }));
  const edges = [];
  for (const [from, targets] of graph.outbound) {
    for (const to of targets) edges.push({ from, to });
  }
  res.json({ nodes, edges });
});

module.exports = router;
