const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { captureLinkedInPost, removeKnowledgeBySourceId } = require('../lib/knowledge-format');
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
    `SELECT id, topic, content_type, spiciness, score_json, carousel_url, sheet_url,
            scheduled_date, status, created_at, published_at,
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
  const rawSourceUrl = String(req.body?.sourceUrl || '').trim();
  let sourceUrl = null;
  if (rawSourceUrl) {
    try { sourceUrl = new URL(rawSourceUrl).href; } catch (_) { /* ignore invalid URLs */ }
  }
  const validSpiciness = ['professional', 'challenging', 'provocative'];
  const spiciness = validSpiciness.includes(req.body?.spiciness) ? req.body.spiciness : 'professional';
  const { randomUUID } = require('crypto');
  const { runPipeline } = require('../lib/linkedin-pipeline');
  const postId = randomUUID();
  db.hub().prepare(
    `INSERT INTO linkedin_posts (id, user, topic, status, spiciness) VALUES (?, ?, ?, 'processing', ?)`
  ).run(postId, req.hubUser, topic, spiciness);
  setImmediate(async () => {
    try {
      await runPipeline(req.hubUser, topic, s => console.log('[content]', s), postId, sourceUrl, spiciness);
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
    `UPDATE linkedin_posts
       SET status = ?,
           published_at = CASE
             WHEN ? = 'published' THEN COALESCE(published_at, unixepoch())
             ELSE NULL
           END
     WHERE id = ? AND user = ?`
  ).run(status, status, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });

  if (status === 'published') {
    try {
      require('../lib/reminders').advanceRecurringReminder(req.hubUser, `content-linkedin:${req.hubUser}`);
    } catch (err) {
      console.warn('[content] could not advance LinkedIn cadence reminder:', err.message);
    }
    try {
      captureLinkedInPost(req.hubUser, req.params.id);
    } catch (err) {
      console.warn('[content] knowledge capture failed:', err.message);
    }
    setImmediate(async () => {
      try {
        const post = db.hub().prepare(
          `SELECT topic, content_type, research, draft, refined_draft, created_at FROM linkedin_posts WHERE id = ?`
        ).get(req.params.id);
        if (!post) return;

        const { writeNote, vaultRoot } = require('../lib/obsidian-vault');
        const path = require('path');
        const slug = post.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const date = new Date(post.created_at * 1000).toISOString().slice(0, 10);
        const postText = (post.refined_draft || post.draft || '').trim();
        const research = (post.research || '').slice(0, 3000).trim();
        const category = post.content_type || '';

        const content = [
          `# ${post.topic}`,
          '',
          `**Published:** ${date}` + (category ? `  \n**Category:** ${category}` : ''),
          '',
          '## Post',
          '',
          postText,
          ...(research ? ['', '## Research', '', research] : []),
        ].join('\n');

        writeNote({ notePath: `wiki/linkedin/${slug}.md`, content, mode: 'write' });

        const synthadocUrl = process.env.SYNTHADOC_URL;
        if (synthadocUrl) {
          const fullPath = path.join(vaultRoot(), 'wiki', 'linkedin', `${slug}.md`);
          await fetch(`${synthadocUrl}/jobs/ingest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: fullPath }),
          });
        }
      } catch (err) {
        console.error('[content] wiki write failed:', err.message);
      }
    });
  } else {
    try {
      removeKnowledgeBySourceId({ user: req.hubUser, public: true, sourceId: `linkedin:${req.params.id}` });
    } catch (err) {
      console.warn('[content] knowledge removal failed:', err.message);
    }
  }

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

router.post('/api/content/posts/:id/retry-carousel', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const post = db.hub().prepare(
    `SELECT id, status FROM linkedin_posts WHERE id = ? AND user = ?`
  ).get(req.params.id, req.hubUser);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (post.status === 'processing') return res.status(409).json({ error: 'Post is still processing' });

  const { resumePost } = require('../lib/linkedin-pipeline');
  db.hub().prepare(`UPDATE linkedin_posts SET status = 'processing' WHERE id = ?`).run(req.params.id);
  setImmediate(async () => {
    try {
      await resumePost(req.params.id, req.hubUser, s => console.log('[carousel-retry]', s));
    } catch (err) {
      console.error('[carousel-retry] error:', err.message);
      try { db.hub().prepare(`UPDATE linkedin_posts SET status = 'draft' WHERE id = ?`).run(req.params.id); } catch (_) {}
    }
  });
  res.json({ ok: true });
});

router.post('/api/content/posts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  db.hub().prepare(`DELETE FROM linkedin_posts WHERE id = ? AND user = ?`).run(req.params.id, req.hubUser);
  res.json({ ok: true });
});

module.exports = router;
