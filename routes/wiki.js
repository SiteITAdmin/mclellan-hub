'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const db = require('../lib/db');
const { vaultRoot } = require('../lib/obsidian-vault');
const { startGoogleAuth, finishGoogleAuth } = require('../lib/google-auth');

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

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Wiki page helpers ─────────────────────────────────────────────────────────
const WIKI_DIR = () => path.join(vaultRoot(), 'wiki');

function parseWikiPage(slug) {
  const filepath = path.join(WIKI_DIR(), `${slug}.md`);
  if (!fs.existsSync(filepath)) return null;
  const raw = fs.readFileSync(filepath, 'utf8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { slug, title: slug, content: raw, tags: [], categories: [], sources: [], created: null };
  const fm = parseFrontmatter(fmMatch[1]);
  const content = fmMatch[2].trim();
  return {
    slug,
    title: content.match(/^# (.+)/m)?.[1] || fm.title || slug,
    content,
    tags: fm.tags || [],
    categories: fm.categories || [],
    sources: fm.sources || [],
    created: fm.created || null,
    confidence: fm.confidence || null,
    aliases: fm.aliases || [],
  };
}

function parseFrontmatter(yaml) {
  const result = {};
  const lines = yaml.split('\n');
  let currentKey = null;
  let currentList = null;
  for (const line of lines) {
    const listItem = line.match(/^  - (.+)$/);
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (listItem && currentList) {
      try { currentList.push(JSON.parse(listItem[1])); } catch { currentList.push(listItem[1].replace(/^['"]|['"]$/g, '')); }
    } else if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val === '' || val === '[]') { result[currentKey] = []; currentList = result[currentKey]; }
      else if (val.startsWith('[')) { try { result[currentKey] = JSON.parse(val); } catch { result[currentKey] = []; } currentList = null; }
      else { result[currentKey] = val.replace(/^['"]|['"]$/g, ''); currentList = null; }
    }
  }
  return result;
}

function allWikiPages() {
  const dir = WIKI_DIR();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseWikiPage(f.replace('.md', '')))
    .filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

function searchPages(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return allWikiPages().filter(p => {
    const haystack = [p.title, p.content, ...p.tags, ...p.categories].join(' ').toLowerCase();
    return terms.every(t => haystack.includes(t));
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const pages = q ? searchPages(q) : allWikiPages().slice(0, 12);
  const hub = db.hub();
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(WIKI_USER);
  res.render('wiki/index', { q, pages, projects, total: allWikiPages().length });
});

router.get('/browse', requireAuth, (req, res) => {
  const pages = allWikiPages();
  const byCategory = {};
  for (const p of pages) {
    const cats = p.categories.length ? p.categories : ['Uncategorised'];
    for (const cat of cats) {
      (byCategory[cat] = byCategory[cat] || []).push(p);
    }
  }
  res.render('wiki/browse', { byCategory });
});

router.get('/page/:slug', requireAuth, (req, res) => {
  const page = parseWikiPage(req.params.slug);
  if (!page) return res.status(404).render('wiki/404', { slug: req.params.slug });
  // Related: same tags
  const related = allWikiPages()
    .filter(p => p.slug !== page.slug && p.tags.some(t => page.tags.includes(t)))
    .slice(0, 6);
  res.render('wiki/page', { page, related });
});

router.get('/ingest', requireAuth, (req, res) => {
  const queueDir = path.join(vaultRoot(), 'raw_sources', 'ingest-queue');
  const queued = fs.existsSync(queueDir)
    ? fs.readdirSync(queueDir).filter(f => f.endsWith('.url') || f.endsWith('.path')).slice(-10).reverse()
    : [];
  res.render('wiki/ingest', { queued, status: req.query.status || null });
});

// ── API: Queue URL ────────────────────────────────────────────────────────────
router.post('/api/ingest/url', requireAuth, express.json(), async (req, res) => {
  const { url, projectSlug } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const queueDir = path.join(vaultRoot(), 'raw_sources', 'ingest-queue');
  fs.mkdirSync(queueDir, { recursive: true });

  const slug = url.replace(/[^a-z0-9]/gi, '-').slice(-40);
  const filename = `${Date.now()}-${slug}.url`;
  fs.writeFileSync(path.join(queueDir, filename), JSON.stringify({ url, projectSlug: projectSlug || null }), 'utf8');

  // Also push to VPS queue so it propagates
  const secret = process.env.HERMES_WEBHOOK_SECRET || process.env.WORKDAY_WEBHOOK_SECRET;
  if (secret && process.env.HUB_URL) {
    fetch(`${process.env.HUB_URL}/api/synthadoc/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url, projectSlug, user: WIKI_USER }),
    }).catch(() => {});
  }

  res.json({ ok: true, queued: filename });
});

// ── API: Search + synthesise ──────────────────────────────────────────────────
router.get('/api/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [], synthesis: null });

  const matches = searchPages(q).slice(0, 6);

  // Also pull matching email summaries
  const hub = db.hub();
  const emailMatches = hub.prepare(`
    SELECT subject, from_name, summary, received_at
    FROM email_summaries WHERE user = ?
    AND (subject LIKE ? OR summary LIKE ?)
    ORDER BY received_at DESC LIMIT 5
  `).all(WIKI_USER, `%${q}%`, `%${q}%`);

  if (!matches.length && !emailMatches.length) return res.json({ results: [], synthesis: null });

  // Build context for synthesis
  const wikiContext = matches.map(p =>
    `[Wiki: ${p.title}]\n${p.content.slice(0, 800)}`
  ).join('\n\n');

  const emailContext = emailMatches.map(e => {
    const d = new Date(e.received_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `[Email ${d}] ${e.from_name}: ${e.subject}\n${e.summary}`;
  }).join('\n\n');

  const context = [wikiContext, emailContext].filter(Boolean).join('\n\n---\n\n');

  let synthesis = null;
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://wiki.mclellan.scot',
        },
        body: JSON.stringify({
          model: 'deepseek/deepseek-v3.2',
          messages: [{ role: 'user', content: `Answer this question using only the sources below. Use [[wikilink]] for named topics. If the sources don't cover it, say so.\n\nQuestion: ${q}\n\nSources:\n${context}` }],
          temperature: 0.2,
        }),
      });
      const data = await resp.json();
      synthesis = data.choices?.[0]?.message?.content?.trim() || null;
    } catch (_) {}
  }

  res.json({ results: matches.map(p => ({ slug: p.slug, title: p.title, tags: p.tags, excerpt: p.content.slice(0, 200) })), emailMatches, synthesis });
});

module.exports = router;
