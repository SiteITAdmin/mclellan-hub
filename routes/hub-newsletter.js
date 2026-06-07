'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  getWeekKey, weekKeyLabel,
  weekKeyRange, briefingPeriodLabel,
  backfillFromLabels, generateBriefing, generateCreatorBriefing, buildBriefingPdf, sendBriefing,
} = require('../lib/newsletter-pipeline');
const { ingestFeed } = require('../lib/rss-ingest');
const { listUserLabels } = require('../lib/gmail');
const { writeWikiPage } = require('../lib/vault');

// ── Main curation page ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const user = req.hubUser;
  const hub = db.hub();
  const requestedWeek = req.query.week || getWeekKey();
  const defaultRange = weekKeyRange(requestedWeek) || weekKeyRange(getWeekKey());
  const weekKey = weekKeyRange(requestedWeek) ? requestedWeek : getWeekKey();

  // Available weeks (last 8)
  const weeks = hub.prepare(`
    SELECT week_key, COUNT(*) as total, SUM(selected) as selected
    FROM nl_topics WHERE user = ?
    GROUP BY week_key ORDER BY week_key DESC LIMIT 8
  `).all(user);

  // Topics for selected week, grouped
  const topics = hub.prepare(`
    SELECT * FROM nl_topics WHERE user = ? AND week_key = ?
    ORDER BY category, created_at DESC
  `).all(user, weekKey);

  const grouped = {};
  for (const t of topics) {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  }

  // Formats and interests for management sections
  const formats = hub.prepare('SELECT * FROM nl_formats WHERE user = ? ORDER BY is_default DESC, name').all(user);
  const interests = hub.prepare('SELECT * FROM nl_interests WHERE user = ? ORDER BY display_order').all(user);
  const models = hub.prepare('SELECT key, label, model_id FROM model_config WHERE enabled = 1 ORDER BY display_order, label').all();

  // Recent briefings
  const briefings = hub.prepare(`
    SELECT b.*, f.name as format_name FROM nl_briefings b
    LEFT JOIN nl_formats f ON f.id = b.format_id
    WHERE b.user = ? ORDER BY b.created_at DESC LIMIT 5
  `).all(user);

  res.render('hub/newsletter', {
    user, weekKey, weekLabel: weekKeyLabel(weekKey),
    defaultDateFrom: defaultRange.dateFrom,
    defaultDateTo: defaultRange.dateTo,
    briefingPeriodLabel,
    weeks, grouped, formats, interests, briefings, models,
    totalTopics: topics.length,
    selectedTopics: topics.filter(t => t.selected).length,
  });
});

// ── Topic toggle ──────────────────────────────────────────────────────────────

router.post('/topics/toggle', (req, res) => {
  const { id, week } = req.body;
  if (!id) return res.redirect('/newsletter');
  const hub = db.hub();
  const t = hub.prepare('SELECT selected FROM nl_topics WHERE id = ? AND user = ?').get(id, req.hubUser);
  if (t) hub.prepare('UPDATE nl_topics SET selected = ? WHERE id = ?').run(t.selected ? 0 : 1, id);
  res.redirect(`/newsletter${week ? '?week=' + week : ''}`);
});

router.post('/topics/toggle-week', (req, res) => {
  const { week, value } = req.body;
  if (!week) return res.redirect('/newsletter');
  db.hub().prepare('UPDATE nl_topics SET selected = ? WHERE user = ? AND week_key = ?')
    .run(value === '1' ? 1 : 0, req.hubUser, week);
  res.redirect(`/newsletter?week=${week}`);
});

// ── Gmail label list ──────────────────────────────────────────────────────────

router.get('/gmail-labels', async (req, res) => {
  try {
    const labels = await listUserLabels(req.hubUser);
    res.json({ labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backfill from Gmail labels ────────────────────────────────────────────────

router.post('/backfill', async (req, res) => {
  const { labels, days } = req.body;
  const labelList = (labels || '').split(',').map(l => l.trim()).filter(Boolean);
  if (!labelList.length) return res.status(400).json({ error: 'labels required' });

  const sinceTs = Math.floor(Date.now() / 1000) - (parseInt(days) || 7) * 86400;

  try {
    const results = await backfillFromLabels(req.hubUser, labelList, sinceTs);
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[newsletter] backfill error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate briefing ─────────────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  const { week, format_id, date_from, date_to } = req.body;
  const weekKey = week || getWeekKey();
  try {
    const result = await generateBriefing({
      user: req.hubUser,
      weekKey,
      formatId: format_id || null,
      dateFrom: date_from,
      dateTo: date_to,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[newsletter] generate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Send briefing ─────────────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  const { briefing_id } = req.body;
  if (!briefing_id) return res.status(400).json({ error: 'briefing_id required' });
  try {
    const result = await sendBriefing({ user: req.hubUser, briefingId: briefing_id });
    res.json(result);
  } catch (err) {
    console.error('[newsletter] send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Briefing detail page ──────────────────────────────────────────────────────

router.get('/briefing/:id', (req, res) => {
  const hub = db.hub();
  const briefing = hub.prepare('SELECT * FROM nl_briefings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!briefing) return res.status(404).send('Briefing not found');
  res.render('hub/newsletter-briefing', { user: req.hubUser, briefing, briefingPeriodLabel });
});

// ── Delete briefing ───────────────────────────────────────────────────────────

router.post('/briefing/:id/delete', (req, res) => {
  const hub = db.hub();
  hub.prepare('DELETE FROM nl_briefings WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  res.json({ ok: true });
});

// ── Export briefing to wiki ───────────────────────────────────────────────────

router.post('/briefing/:id/wiki', (req, res) => {
  const hub = db.hub();
  const b = hub.prepare('SELECT * FROM nl_briefings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!b) return res.status(404).json({ error: 'Briefing not found' });

  const periodLabel = briefingPeriodLabel(b);
  const slug = b.date_from && b.date_to
    ? `briefing-${b.date_from}-to-${b.date_to}`
    : `briefing-${b.week_key.toLowerCase()}`;
  const dateStr = new Date(b.created_at * 1000).toISOString().slice(0, 10);
  const frontmatter = `title: "Intelligence Briefing — ${periodLabel}"\ndate: ${dateStr}\ntags: [briefing, intelligence]\nsource: hub-newsletter`;

  writeWikiPage(slug, frontmatter, b.text_content || '');
  hub.prepare('UPDATE nl_briefings SET wiki_slug = ? WHERE id = ?').run(slug, b.id);
  res.json({ ok: true, slug });
});

// ── Publish / unpublish briefing to public feed ───────────────────────────────

router.post('/briefing/:id/publish', (req, res) => {
  const hub = db.hub();
  const b = hub.prepare('SELECT id FROM nl_briefings WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!b) return res.status(404).json({ error: 'Briefing not found' });
  hub.prepare('UPDATE nl_briefings SET published_at = unixepoch() WHERE id = ?').run(b.id);
  res.json({ ok: true });
});

router.post('/briefing/:id/unpublish', (req, res) => {
  const hub = db.hub();
  hub.prepare('UPDATE nl_briefings SET published_at = NULL WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  res.json({ ok: true });
});

// ── PDF download ──────────────────────────────────────────────────────────────

router.get('/briefing/:id/pdf', async (req, res) => {
  try {
    const pdf = await buildBriefingPdf(req.params.id, req.hubUser);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="intelligence-briefing.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[newsletter] pdf error:', err);
    res.status(500).send('PDF generation failed: ' + err.message);
  }
});

// ── Formats CRUD ──────────────────────────────────────────────────────────────

router.post('/formats', (req, res) => {
  const { name, instructions, is_default, target_words, max_tokens, model_id } = req.body;
  if (!name || !instructions) return res.redirect('/newsletter#formats');
  const hub = db.hub();
  if (is_default) hub.prepare('UPDATE nl_formats SET is_default = 0 WHERE user = ?').run(req.hubUser);
  hub.prepare('INSERT INTO nl_formats (id, user, name, instructions, is_default, target_words, max_tokens, model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.hubUser, name.trim(), instructions.trim(), is_default ? 1 : 0,
      parseInt(target_words) || null, parseInt(max_tokens) || null, model_id || null);
  res.redirect('/newsletter#formats');
});

router.post('/formats/update', (req, res) => {
  const { id, name, instructions, is_default, target_words, max_tokens, model_id } = req.body;
  if (!id) return res.redirect('/newsletter#formats');
  const hub = db.hub();
  if (is_default) hub.prepare('UPDATE nl_formats SET is_default = 0 WHERE user = ?').run(req.hubUser);
  hub.prepare('UPDATE nl_formats SET name = ?, instructions = ?, is_default = ?, target_words = ?, max_tokens = ?, model_id = ? WHERE id = ? AND user = ?')
    .run(name?.trim(), instructions?.trim(), is_default ? 1 : 0,
      parseInt(target_words) || null, parseInt(max_tokens) || null, model_id || null,
      id, req.hubUser);
  res.redirect('/newsletter#formats');
});

router.post('/formats/delete', (req, res) => {
  const { id } = req.body;
  if (id) db.hub().prepare('DELETE FROM nl_formats WHERE id = ? AND user = ?').run(id, req.hubUser);
  res.redirect('/newsletter#formats');
});

// ── Interests CRUD ────────────────────────────────────────────────────────────

router.post('/interests', (req, res) => {
  const { name, auto_include, gmail_label, mode, extraction_prompt, body_limit, extract_max_tokens } = req.body;
  if (!name) return res.redirect('/newsletter#interests');
  const hub = db.hub();
  const maxOrder = hub.prepare('SELECT MAX(display_order) as m FROM nl_interests WHERE user = ?').get(req.hubUser)?.m || 0;
  hub.prepare(`INSERT INTO nl_interests (id, user, name, auto_include, display_order, gmail_label, mode, extraction_prompt, body_limit, extract_max_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), req.hubUser, name.trim(), auto_include ? 1 : 0, maxOrder + 1,
      gmail_label?.trim() || null, mode || 'selective',
      extraction_prompt?.trim() || null, parseInt(body_limit) || null, parseInt(extract_max_tokens) || null);
  res.redirect('/newsletter#interests');
});

router.post('/interests/update', (req, res) => {
  const { id, name, gmail_label, mode, extraction_prompt, body_limit, extract_max_tokens } = req.body;
  if (!id) return res.redirect('/newsletter#interests');
  db.hub().prepare(`UPDATE nl_interests
    SET name = ?, gmail_label = ?, mode = ?, extraction_prompt = ?, body_limit = ?, extract_max_tokens = ?
    WHERE id = ? AND user = ?`)
    .run(
      name?.trim(),
      gmail_label?.trim() || null,
      mode || 'selective',
      extraction_prompt?.trim() || null,
      parseInt(body_limit) || null,
      parseInt(extract_max_tokens) || null,
      id, req.hubUser
    );
  res.redirect('/newsletter#interests');
});

router.post('/interests/sync-labels', async (req, res) => {
  try {
    const labels = await listUserLabels(req.hubUser);
    const hub = db.hub();
    const existing = new Set(hub.prepare('SELECT name FROM nl_interests WHERE user = ?').all(req.hubUser).map(r => r.name.toLowerCase()));
    const maxOrder = hub.prepare('SELECT MAX(display_order) as m FROM nl_interests WHERE user = ?').get(req.hubUser)?.m || 0;
    let added = 0;
    labels.forEach((label, i) => {
      if (!existing.has(label.toLowerCase())) {
        hub.prepare('INSERT INTO nl_interests (id, user, name, auto_include, display_order, gmail_label) VALUES (?, ?, ?, 0, ?, ?)')
          .run(uuid(), req.hubUser, label, maxOrder + i + 1, label);
        added++;
      }
    });
    res.json({ ok: true, added, total: labels.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/interests/delete', (req, res) => {
  const { id } = req.body;
  if (id) db.hub().prepare('DELETE FROM nl_interests WHERE id = ? AND user = ?').run(id, req.hubUser);
  res.redirect('/newsletter#interests');
});

router.post('/interests/toggle-auto', (req, res) => {
  const { id } = req.body;
  if (!id) return res.redirect('/newsletter#interests');
  const hub = db.hub();
  const r = hub.prepare('SELECT auto_include FROM nl_interests WHERE id = ? AND user = ?').get(id, req.hubUser);
  if (r) hub.prepare('UPDATE nl_interests SET auto_include = ? WHERE id = ?').run(r.auto_include ? 0 : 1, id);
  res.redirect('/newsletter#interests');
});

// ── Creator RSS feeds ──────────────────────────────────────────────────────────

router.get('/creators', (req, res) => {
  const hub = db.hub();
  const feeds = hub.prepare(`
    SELECT f.*, COUNT(a.id) AS article_count,
      MAX(a.published_at) AS latest_article_at
    FROM rss_feeds f
    LEFT JOIN rss_articles a ON a.feed_id = f.id
    WHERE f.user = ?
    GROUP BY f.id ORDER BY f.name
  `).all(req.hubUser);
  res.render('hub/newsletter-creators', { user: req.hubUser, feeds });
});

router.get('/creator/:slug', (req, res) => {
  const hub = db.hub();
  const feed = hub.prepare(`
    SELECT f.*, COUNT(a.id) AS article_count
    FROM rss_feeds f LEFT JOIN rss_articles a ON a.feed_id = f.id
    WHERE f.user = ? AND f.creator_slug = ?
    GROUP BY f.id
  `).get(req.hubUser, req.params.slug);
  if (!feed) return res.status(404).send('Creator not found');
  const articles = hub.prepare(`
    SELECT id, title, url, published_at, word_count,
      substr(content_markdown, 1, 300) AS excerpt
    FROM rss_articles WHERE user = ? AND creator_slug = ?
    ORDER BY published_at DESC LIMIT 50
  `).all(req.hubUser, req.params.slug);
  const briefings = hub.prepare(`
    SELECT id, date_from, date_to, topic_count, created_at
    FROM nl_briefings WHERE user = ? AND week_key LIKE ?
    ORDER BY created_at DESC LIMIT 10
  `).all(req.hubUser, `creator-${req.params.slug}-%`);
  res.render('hub/newsletter-creator', { user: req.hubUser, feed, articles, briefings });
});

router.post('/creator/:slug/briefing', async (req, res) => {
  const hub = db.hub();
  const feed = hub.prepare('SELECT * FROM rss_feeds WHERE user = ? AND creator_slug = ?').get(req.hubUser, req.params.slug);
  if (!feed) return res.status(404).json({ error: 'Creator not found' });
  try {
    const result = await generateCreatorBriefing({
      user: req.hubUser,
      creatorSlug: feed.creator_slug,
      creatorName: feed.name,
      dateFrom: req.body.date_from || null,
      dateTo: req.body.date_to || null,
    });
    res.json({ ok: true, briefingId: result.id, articleCount: result.articleCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/creator/:slug/fetch', async (req, res) => {
  const hub = db.hub();
  const feed = hub.prepare('SELECT * FROM rss_feeds WHERE user = ? AND creator_slug = ?').get(req.hubUser, req.params.slug);
  if (!feed) return res.status(404).json({ error: 'Creator not found' });
  try {
    const result = await ingestFeed(feed, req.hubUser);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
