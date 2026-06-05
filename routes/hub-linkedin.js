const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const {
  writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');

// ── LinkedIn Content (hub) ────────────────────────────────────────────────────
const CONTENT_TYPES_HUB = [
  'AI & Technology', 'M365 & Microsoft', 'Healthcare IT', 'Digital Transformation',
  'EU Policy & Regulation', 'Leadership & Management', 'Industry Analysis',
  'Product Review', 'Case Study', 'Career & Development',
];

router.get('/lin', requireAuth, (req, res) => {
  const posts = db.hub().prepare(
    `SELECT id, topic, content_type, score_json, carousel_url, sheet_url,
            scheduled_date, status, created_at,
            substr(refined_draft, 1, 300) AS preview
     FROM linkedin_posts WHERE user = ? ORDER BY created_at DESC LIMIT 100`
  ).all(req.hubUser);
  const parsed = posts.map(p => ({
    ...p,
    score: (() => { try { return JSON.parse(p.score_json || '{}'); } catch { return {}; } })(),
  }));
  res.render('hub/content', { user: req.hubUser, posts: parsed, contentTypes: CONTENT_TYPES_HUB });
});

router.post('/api/content/generate', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'Topic is required' });
  const { randomUUID } = require('crypto');
  const { runPipeline } = require('../lib/linkedin-pipeline');
  const postId = randomUUID();
  db.hub().prepare(
    `INSERT INTO linkedin_posts (id, user, topic, status) VALUES (?, ?, ?, 'processing')`
  ).run(postId, req.hubUser, topic);
  setImmediate(async () => {
    try {
      await runPipeline(req.hubUser, topic, s => console.log('[content]', s), postId);
    } catch (err) {
      console.error('[content] pipeline error:', err.message);
      try { db.hub().prepare(`UPDATE linkedin_posts SET status = 'error' WHERE id = ?`).run(postId); } catch (_) {}
    }
  });
  res.json({ ok: true, postId });
});

router.get('/api/content/posts/:id', requireAuth, (req, res) => {
  const post = db.hub().prepare(
    `SELECT id, topic, content_type, score_json, carousel_url, sheet_url,
            scheduled_date, status, created_at, refined_draft, draft
     FROM linkedin_posts WHERE id = ? AND user = ?`
  ).get(req.params.id, req.hubUser);
  if (!post) return res.status(404).json({ error: 'Not found' });
  let score = {};
  try { score = JSON.parse(post.score_json || '{}'); } catch (_) {}
  res.json({ ok: true, post: { ...post, score } });
});

router.post('/api/content/posts/:id/type', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const type = String(req.body?.type || '').trim();
  if (type && !CONTENT_TYPES_HUB.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const result = db.hub().prepare(
    `UPDATE linkedin_posts SET content_type = ? WHERE id = ? AND user = ?`
  ).run(type, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/content/posts/:id/status', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!['draft', 'scheduled', 'published'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const result = db.hub().prepare(
    `UPDATE linkedin_posts SET status = ? WHERE id = ? AND user = ?`
  ).run(status, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/content/posts/:id/schedule', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const date = String(req.body?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
  const result = db.hub().prepare(
    `UPDATE linkedin_posts SET scheduled_date = ?, status = 'scheduled' WHERE id = ? AND user = ?`
  ).run(date, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/content/posts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  db.hub().prepare(`DELETE FROM linkedin_posts WHERE id = ? AND user = ?`).run(req.params.id, req.hubUser);
  res.json({ ok: true });
});

module.exports = router;
