const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { captureLinkedInPost, removeKnowledgeBySourceId } = require('../lib/knowledge-format');
const {
  writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');

function activeLinkedInQualityVeto(user, postId) {
  return require('../lib/hub-quality-board').qualityVetoBlocks(user, postId);
}

function activeLinkedInNonArtifactQualityVeto(user, postId) {
  return require('../lib/hub-quality-board').qualityVetoBlocks(user, postId, { artifactOnlyOk: true });
}

function getContentPosts(user) {
  const posts = db.hub().prepare(
    `SELECT id, topic, display_title, content_type, spiciness, score_json, carousel_url, sheet_url,
            scheduled_date, status, created_at, published_at, quality_override,
            substr(refined_draft, 1, 300) AS preview
     FROM linkedin_posts WHERE user = ? ORDER BY created_at DESC LIMIT 200`
  ).all(user);
  const { qualityVetoBlocks } = require('../lib/hub-quality-board');
  return posts.map(p => ({
    ...p,
    score: (() => { try { return JSON.parse(p.score_json || '{}'); } catch { return {}; } })(),
    quality_veto: p.status !== 'published' ? qualityVetoBlocks(user, p.id) : false,
    quality_override: Boolean(p.quality_override),
  }));
}

// Create — generate box + researched suggestions + recent activity
router.get('/lin', requireAuth, (req, res) => {
  const { getContentCadencePolicy } = require('../lib/content-cadence-policy');
  const { buildContentTopicPlan } = require('../lib/content-topic-plan');
  const policy = getContentCadencePolicy(req.hubUser);
  const topicPlan = buildContentTopicPlan(req.hubUser, policy.topicPlan);
  const allPosts = getContentPosts(req.hubUser);
  res.render('hub/content', {
    user: req.hubUser,
    topicPlan,
    recentPosts: allPosts.slice(0, 6),
    queueCount: allPosts.filter(p => p.status !== 'published').length,
  });
});

// Plan — cadence policy + topic plan
router.get('/lin/plan', requireAuth, (req, res) => {
  const { getContentCadencePolicy } = require('../lib/content-cadence-policy');
  const { buildContentTopicPlan } = require('../lib/content-topic-plan');
  const { listContentTopicNames } = require('../lib/content-taxonomy');
  const policy = getContentCadencePolicy(req.hubUser);
  const topicPlan = buildContentTopicPlan(req.hubUser, policy.topicPlan);
  const allPosts = getContentPosts(req.hubUser);
  res.render('hub/content-plan', {
    user: req.hubUser,
    contentTypes: listContentTopicNames(req.hubUser),
    cadencePolicy: policy,
    topicPlan,
    queueCount: allPosts.filter(p => p.status !== 'published').length,
  });
});

// Cadence — posting/newsletter/research schedules (split out of the Plan page)
router.get('/lin/cadence', requireAuth, (req, res) => {
  const { getContentCadencePolicy, describeRecur } = require('../lib/content-cadence-policy');
  const { evaluateCheck } = require('../lib/content-reminders');
  const policy = getContentCadencePolicy(req.hubUser);
  const cadenceRows = db.hub().prepare(`
    SELECT * FROM reminders
    WHERE user = ? AND kind = 'content'
    ORDER BY dedup_key
  `).all(req.hubUser).map(r => ({
    ...r,
    due_label: r.next_fire_at
      ? new Date(r.next_fire_at * 1000).toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Dublin' })
      : '',
    needs_action: Boolean(evaluateCheck(r).message),
  }));
  const allPosts = getContentPosts(req.hubUser);
  res.render('hub/content-cadence', {
    user: req.hubUser,
    cadencePolicy: policy,
    cadenceRows,
    describeRecur,
    queueCount: allPosts.filter(p => p.status !== 'published').length,
  });
});

// Queue — processing, error, draft, scheduled
router.get('/lin/queue', requireAuth, (req, res) => {
  const { listContentTopicNames } = require('../lib/content-taxonomy');
  const allPosts = getContentPosts(req.hubUser);
  res.render('hub/content-queue', {
    user: req.hubUser,
    posts: allPosts.filter(p => p.status !== 'published'),
    contentTypes: listContentTopicNames(req.hubUser),
  });
});

// Published — archive + stats
router.get('/lin/published', requireAuth, (req, res) => {
  const { listContentTopicNames } = require('../lib/content-taxonomy');
  const allPosts = getContentPosts(req.hubUser);
  const published = allPosts.filter(p => p.status === 'published')
    .sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  res.render('hub/content-published', {
    user: req.hubUser,
    posts: published,
    totalPosts: allPosts.length,
    contentTypes: listContentTopicNames(req.hubUser),
    queueCount: allPosts.filter(p => p.status !== 'published').length,
  });
});

// Mobile app JSON list (bearer auth via mobileBearerBridge). Post detail and
// status changes reuse the existing /api/content/posts/:id endpoints.
router.get('/api/mobile/content', requireAuth, (req, res) => {
  res.json({ posts: getContentPosts(req.hubUser) });
});

// Cadence page save: schedules and toggles ONLY. Merge-saved so it can never
// touch the topic plan's dayPrefs (the old whole-object save silently wiped
// day topics whenever the cadence form was submitted).
router.post('/api/content/cadence-policy', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const { mergeContentCadencePolicy } = require('../lib/content-cadence-policy');
  const bool = (value) => value === true || value === 'true' || value === 'on' || value === '1';
  const policy = mergeContentCadencePolicy(req.hubUser, {
    linkedin: {
      enabled: bool(req.body?.linkedinEnabled),
      cadenceDays: req.body?.linkedinCadenceDays,
      recur: req.body?.linkedinRecur,
    },
    newsletter: {
      enabled: bool(req.body?.newsletterEnabled),
      minTopics: req.body?.newsletterMinTopics,
      recur: req.body?.newsletterRecur,
    },
    topicPlan: {
      researchEnabled: bool(req.body?.topicPlanResearchEnabled),
      researchRecur: req.body?.topicPlanResearchRecur,
    },
  });
  try {
    require('../lib/content-reminders').seedContentReminders(req.hubUser);
  } catch (err) {
    console.warn('[content] cadence policy saved but reminder sync failed:', err.message);
  }
  res.json({ ok: true, policy });
});

// Plan page save: topic plan settings and day topics ONLY. Merge-saved so it
// never resets schedules owned by the cadence page.
router.post('/api/content/topic-plan', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const { mergeContentCadencePolicy } = require('../lib/content-cadence-policy');
  const bool = (value) => value === true || value === 'true' || value === 'on' || value === '1';
  const policy = mergeContentCadencePolicy(req.hubUser, {
    topicPlan: {
      days: req.body?.topicPlanDays,
      suggestionsPerDay: req.body?.topicPlanSuggestionsPerDay,
      showIntelFallback: bool(req.body?.topicPlanShowIntelFallback),
      useLast30Days: bool(req.body?.topicPlanUseLast30Days),
      dayPrefs: req.body?.topicPlanDayPrefs,
    },
  });
  res.json({ ok: true, policy });
});

router.post('/api/content/topic-plan/suggestions/clear', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const result = db.hub().prepare('DELETE FROM content_research_suggestions WHERE user = ?').run(req.hubUser);
  res.json({ ok: true, deleted: result.changes });
});

router.post('/api/content/topic-plan/research', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const date = String(req.body?.date || '').trim();
  const topic = String(req.body?.topic || '').trim();
  const tone = String(req.body?.tone || 'professional').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  if (!topic) return res.status(400).json({ error: 'Choose a topic first' });
  try {
    const result = await require('../lib/content-research').researchPlannedTopic(req.hubUser, {
      date,
      topic,
      tone,
      limit: 3,
    });
    res.json({ ok: true, result });
  } catch (err) {
    console.error('[content] topic research failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const { listContentTopicNames } = require('../lib/content-taxonomy');
  if (type && !listContentTopicNames(req.hubUser).includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const result = db.hub().prepare(
    `UPDATE linkedin_posts SET content_type = ? WHERE id = ? AND user = ?`
  ).run(type, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.post('/api/content/posts/:id/status', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const status = String(req.body?.status || '').trim();
  if (!['draft', 'needs_revision', 'scheduled', 'published'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (['scheduled', 'published'].includes(status) && activeLinkedInQualityVeto(req.hubUser, req.params.id)) {
    return res.status(409).json({ error: 'Quality board veto is active. Resolve the review issues before scheduling or publishing.' });
  }
  const postUrl = String(req.body?.post_url || '').trim();
  if (postUrl && !/^https:\/\/(www\.)?linkedin\.com\//.test(postUrl)) {
    return res.status(400).json({ error: 'post_url must be a linkedin.com URL' });
  }
  const result = db.hub().prepare(
    `UPDATE linkedin_posts
       SET status = ?,
           post_url = CASE WHEN ? != '' THEN ? ELSE post_url END,
           published_at = CASE
             WHEN ? = 'published' THEN COALESCE(published_at, unixepoch())
             ELSE NULL
           END
     WHERE id = ? AND user = ?`
  ).run(status, postUrl, postUrl, status, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });

  if (status === 'published') {
    try {
      require('../lib/reminders').advanceRecurringReminder(req.hubUser, `content-linkedin:${req.hubUser}`);
    } catch (err) {
      console.warn('[content] could not advance LinkedIn cadence reminder:', err.message);
    }
    try {
      const existing = db.hub().prepare('SELECT display_title FROM linkedin_posts WHERE id = ?').get(req.params.id);
      if (existing && !existing.display_title) {
        await require('../lib/linkedin-pipeline').generateDisplayTitle(req.hubUser, req.params.id);
      }
    } catch (err) {
      console.warn('[content] display title generation failed (topic used as-is):', err.message);
    }
    let captureOk = false;
    let captureError = null;
    try {
      captureLinkedInPost(req.hubUser, req.params.id);
      captureOk = true;
    } catch (err) {
      captureError = err;
      console.warn('[content] knowledge capture failed:', err.message);
    }
    try {
      const post = db.hub().prepare('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
      require('../lib/linkedin-agent-team').writePublishingReceipt({
        user: req.hubUser,
        postId: req.params.id,
        post,
        postUrl,
        captureOk,
        error: captureError,
      });
    } catch (err) {
      console.warn('[content] publishing receipt failed:', err.message);
    }
    setImmediate(async () => {
      try {
        const post = db.hub().prepare(
          `SELECT topic, display_title, content_type, research, draft, refined_draft, created_at FROM linkedin_posts WHERE id = ?`
        ).get(req.params.id);
        if (!post) return;

        const { writeNote, vaultRoot } = require('../lib/obsidian-vault');
        const path = require('path');
        const noteTitle = post.display_title || post.topic;
        const slug = noteTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
        const date = new Date(post.created_at * 1000).toISOString().slice(0, 10);
        const postText = (post.refined_draft || post.draft || '').trim();
        const research = (post.research || '').slice(0, 3000).trim();
        const category = post.content_type || '';

        const content = [
          `# ${noteTitle}`,
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

router.post('/api/content/posts/:id/title', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const title = String(req.body?.display_title || '').replace(/\s+/g, ' ').trim();
  if (!title) return res.status(400).json({ error: 'display_title required' });
  if (title.length > 120) return res.status(400).json({ error: 'display_title too long (max 120 chars)' });
  const result = db.hub().prepare(
    'UPDATE linkedin_posts SET display_title = ? WHERE id = ? AND user = ?'
  ).run(title, req.params.id, req.hubUser);
  if (!result.changes) return res.status(404).json({ error: 'Not found' });

  // Regenerate the public knowledge bundle page — the slug is derived from the title
  const post = db.hub().prepare('SELECT status FROM linkedin_posts WHERE id = ?').get(req.params.id);
  if (post?.status === 'published') {
    try {
      removeKnowledgeBySourceId({ user: req.hubUser, public: true, sourceId: `linkedin:${req.params.id}` });
      captureLinkedInPost(req.hubUser, req.params.id);
    } catch (err) {
      console.warn('[content] knowledge recapture after title edit failed:', err.message);
    }
  }
  res.json({ ok: true, display_title: title });
});

router.post('/api/content/posts/:id/schedule', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const date = String(req.body?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
  if (activeLinkedInQualityVeto(req.hubUser, req.params.id)) {
    return res.status(409).json({ error: 'Quality board veto is active. Resolve the review issues before scheduling.' });
  }
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
  if (activeLinkedInNonArtifactQualityVeto(req.hubUser, req.params.id)) {
    return res.status(409).json({ error: 'Quality board veto is active. Resolve the content review issues before generating a PDF.' });
  }

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

// Override an active quality veto: Douglas has read the post and chooses to ship
// it anyway. Recorded on the post and in a receipt for audit. Pass { clear: true }
// to lift a previous override (the board's verdict governs again).
router.post('/api/content/posts/:id/override', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const post = db.hub().prepare('SELECT id FROM linkedin_posts WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const clear = Boolean(req.body?.clear);
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  if (clear) {
    db.hub().prepare("UPDATE linkedin_posts SET quality_override = NULL, quality_override_reason = '' WHERE id = ? AND user = ?")
      .run(req.params.id, req.hubUser);
  } else {
    db.hub().prepare('UPDATE linkedin_posts SET quality_override = unixepoch(), quality_override_reason = ? WHERE id = ? AND user = ?')
      .run(reason, req.params.id, req.hubUser);
  }
  try {
    require('../lib/agent-receipts').writeAgentReceipt({
      user: req.hubUser,
      sourceKind: 'linkedin_post',
      sourceId: req.params.id,
      stage: 'agent:linkedin_quality_override',
      status: clear ? 'pass' : 'warn',
      summary: clear
        ? 'Quality veto override lifted — board verdict governs again'
        : `Quality veto overridden by Douglas${reason ? `: ${reason}` : ''}`,
      payload: { overridden: !clear, reason, at: new Date().toISOString() },
    });
  } catch (err) {
    console.warn('[content] override receipt failed:', err.message);
  }
  res.json({ ok: true, overridden: !clear });
});

// Regenerate an existing post in place: re-run the pipeline on the same post so a
// vetoed draft can actually improve and be re-reviewed, instead of forcing a
// delete-and-start-over. Clears any prior override so the fresh review governs.
router.post('/api/content/posts/:id/regenerate', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const post = db.hub().prepare(
    'SELECT id, topic, spiciness, status FROM linkedin_posts WHERE id = ? AND user = ?'
  ).get(req.params.id, req.hubUser);
  if (!post) return res.status(404).json({ error: 'Not found' });
  if (post.status === 'processing') return res.status(409).json({ error: 'Post is still processing' });
  if (!post.topic) return res.status(400).json({ error: 'Post has no topic to regenerate from' });
  const { runPipeline } = require('../lib/linkedin-pipeline');
  db.hub().prepare("UPDATE linkedin_posts SET status = 'processing', quality_override = NULL, quality_override_reason = '' WHERE id = ?")
    .run(req.params.id);
  setImmediate(async () => {
    try {
      await runPipeline(req.hubUser, post.topic, s => console.log('[content-regen]', s), req.params.id, null, post.spiciness || 'professional');
    } catch (err) {
      console.error('[content-regen] pipeline error:', err.message);
      try { db.hub().prepare("UPDATE linkedin_posts SET status = 'error' WHERE id = ?").run(req.params.id); } catch (_) {}
    }
  });
  res.json({ ok: true, postId: req.params.id });
});

router.post('/api/content/posts/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  db.hub().prepare(`DELETE FROM linkedin_posts WHERE id = ? AND user = ?`).run(req.params.id, req.hubUser);
  res.json({ ok: true });
});

module.exports = router;
