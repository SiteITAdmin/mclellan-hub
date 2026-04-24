const express = require('express');
const router = express.Router();
const users = require('../config/users');
const db = require('../lib/db');
const { finishGoogleAuth, startGoogleAuth } = require('../lib/google-auth');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');

function defaultSearchModeForTier(tier) {
  if (tier === 'image' || tier === 'coding') return 'none';
  return 'web-plugin';
}

function requireHubAdmin(req, res, next) {
  if (req.session?.hubAdminUser === req.hubUser) return next();
  res.redirect('/admin/login');
}

// Bearer-token auth for MCP. Falls back to admin session for browser testing.
function requireMcpAuth(req, res, next) {
  const creds = users[req.hubUser]?.hubAdmin;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (creds?.mcpToken && token && token === creds.mcpToken) return next();
  if (req.session?.hubAdminUser === req.hubUser) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── Auth ──────────────────────────────────────────────────────────────────────
router.get('/admin/login', (req, res) => {
  res.render('hub-admin/login', { user: req.hubUser, error: null });
});

router.get('/admin/auth/google', (req, res, next) =>
  startGoogleAuth({ purpose: 'hub-admin', user: req.hubUser, callbackPath: '/admin/auth/google/callback', returnTo: '/admin' })(req, res, next)
);

router.get('/admin/auth/google/callback', (req, res, next) =>
  finishGoogleAuth({ purpose: 'hub-admin', user: req.hubUser, callbackPath: '/admin/auth/google/callback', sessionKey: 'hubAdminUser', returnTo: '/admin' })(req, res, next)
);

router.post('/admin/logout', requireSameOrigin, (req, res) => {
  req.session.hubAdminUser = null;
  res.redirect('/admin/login');
});

router.use((req, res, next) => {
  if (req.method === 'POST' && req.path.startsWith('/admin') && req.path !== '/admin/login' && req.path !== '/admin/logout') {
    return requireSameOrigin(req, res, next);
  }
  return next();
});

// ── Dashboard: projects + memory counts ───────────────────────────────────────
router.get('/admin', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const projects = hub.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id) AS memory_count,
           (SELECT MAX(ts) FROM messages m WHERE m.project_id = p.id) AS last_activity
      FROM projects p
     WHERE p.user = ?
  ORDER BY p.name
  `).all(req.hubUser);
  res.render('hub-admin/index', { user: req.hubUser, projects });
});

// ── Projects CRUD ─────────────────────────────────────────────────────────────
router.post('/admin/projects', requireHubAdmin, (req, res) => {
  const { name, slug, context_depth, is_cv_context } = req.body;
  if (!name || !slug) return res.redirect('/admin');
  try {
    db.hub().prepare(`
      INSERT INTO projects (id, user, name, slug, context_depth, is_cv_context)
      VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?)
    `).run(
      req.hubUser,
      name.trim(),
      slug.trim().toLowerCase(),
      parseInt(context_depth, 10) || 20,
      is_cv_context ? 1 : 0
    );
  } catch (err) {
    console.error('[hub-admin] add project:', err.message);
  }
  res.redirect('/admin');
});

router.post('/admin/projects/:id', requireHubAdmin, (req, res) => {
  const { name, slug, context_depth, is_cv_context } = req.body;
  db.hub().prepare(`
    UPDATE projects
       SET name = ?, slug = ?, context_depth = ?, is_cv_context = ?
     WHERE id = ? AND user = ?
  `).run(
    name.trim(),
    slug.trim().toLowerCase(),
    parseInt(context_depth, 10) || 20,
    is_cv_context ? 1 : 0,
    req.params.id,
    req.hubUser
  );
  res.redirect('/admin');
});

router.post('/admin/projects/:id/delete', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const keepMessages = req.body.keep_messages === '1';
  const project = hub.prepare('SELECT * FROM projects WHERE id = ? AND user = ?')
                     .get(req.params.id, req.hubUser);
  if (!project) return res.redirect('/admin');
  if (keepMessages) {
    hub.prepare('UPDATE messages SET project_id = NULL WHERE project_id = ?').run(project.id);
  } else {
    hub.prepare('DELETE FROM messages WHERE project_id = ?').run(project.id);
  }
  hub.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  res.redirect('/admin');
});

// ── Memory + documents viewer (HTML) ──────────────────────────────────────────
router.get('/admin/projects/:slug', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?')
                     .get(req.hubUser, req.params.slug);
  if (!project) return res.redirect('/admin');
  const memories = hub.prepare(`
    SELECT id, conversation_id, role, content, model, ts
      FROM messages
     WHERE project_id = ?
  ORDER BY ts ASC
  `).all(project.id);
  const documents = hub.prepare(`
    SELECT id, filename, mimetype, size_bytes, uploaded_at
      FROM documents
     WHERE project_id = ?
  ORDER BY uploaded_at DESC
  `).all(project.id);
  res.render('hub-admin/project', { user: req.hubUser, project, memories, documents });
});

router.post('/admin/documents/:id/delete', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const doc = hub.prepare('SELECT * FROM documents WHERE id = ? AND user = ?')
                 .get(req.params.id, req.hubUser);
  if (!doc) return res.redirect('/admin');
  const project = doc.project_id
    ? hub.prepare('SELECT slug FROM projects WHERE id = ?').get(doc.project_id)
    : null;
  hub.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.redirect(project ? `/admin/projects/${project.slug}` : '/admin');
});

router.get('/admin/documents/:id', requireHubAdmin, (req, res) => {
  const doc = db.hub().prepare('SELECT * FROM documents WHERE id = ? AND user = ?')
                      .get(req.params.id, req.hubUser);
  if (!doc) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${doc.filename}.md"`);
  res.send(doc.markdown);
});

router.post('/admin/memories/:id/delete', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const msg = hub.prepare('SELECT * FROM messages WHERE id = ? AND user = ?')
                 .get(req.params.id, req.hubUser);
  if (!msg) return res.redirect('/admin');
  const project = msg.project_id
    ? hub.prepare('SELECT slug FROM projects WHERE id = ?').get(msg.project_id)
    : null;
  hub.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  res.redirect(project ? `/admin/projects/${project.slug}` : '/admin');
});

// ── Chat logs ─────────────────────────────────────────────────────────────────
router.get('/admin/chatlogs', requireHubAdmin, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 50, 500);
  const rating = req.query.rating !== undefined ? parseInt(req.query.rating) : null;
  const sort   = req.query.sort === 'rating_desc' ? 'rl.rating DESC, rl.ts DESC'
               : req.query.sort === 'rating_asc'  ? 'rl.rating ASC, rl.ts DESC'
               : 'rl.ts DESC';
  const ratingFilter = (rating !== null && !isNaN(rating))
    ? (rating === 0 ? 'AND rl.rating IS NULL' : `AND rl.rating = ${rating}`)
    : '';
  const logs = db.hub().prepare(`
    SELECT rl.*,
           um.content AS question,
           am.content AS answer
      FROM request_logs rl
      LEFT JOIN messages um ON um.id = rl.user_msg_id
      LEFT JOIN messages am ON am.id = rl.asst_msg_id
     WHERE rl.user = ? ${ratingFilter}
     ORDER BY ${sort}
     LIMIT ?
  `).all(req.hubUser, limit);
  res.render('hub-admin/chatlogs', { user: req.hubUser, logs, limit, rating, sort: req.query.sort || 'newest' });
});

// ── Model management ──────────────────────────────────────────────────────────
const { DEFAULT_MODELS } = require('../lib/router');

router.get('/admin/models', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  // Ensure shared defaults exist, while preserving admin edits to existing rows.
  const insert = hub.prepare(
    'INSERT OR IGNORE INTO model_config (key, label, endpoint, model_id, tier, search, enabled, user) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)'
  );
  for (const [key, def] of Object.entries(DEFAULT_MODELS)) {
    insert.run(key, def.label || key, def.endpoint, def.id, def.tier, def.search);
  }
  const models = hub.prepare(
    `SELECT * FROM model_config
      WHERE user IS NULL OR user = ?
      ORDER BY (user IS NULL) DESC, tier, display_order, key`
  ).all(req.hubUser);
  res.render('hub-admin/models', { user: req.hubUser, models });
});

router.post('/admin/models', requireHubAdmin, (req, res) => {
  const { key, label, endpoint, model_id, tier, search, base_url, api_key_env, api_key } = req.body;
  if (!key || !label || !endpoint || !model_id || !tier) return res.redirect('/admin/models');
  const finalTier = tier.trim();
  const finalSearch = (search || defaultSearchModeForTier(finalTier)).trim();
  try {
    db.hub().prepare(`
      INSERT INTO model_config (key, label, endpoint, model_id, tier, search, enabled, user, base_url, api_key_env, api_key)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      key.trim().toLowerCase(),
      label.trim(),
      endpoint.trim(),
      model_id.trim(),
      finalTier,
      finalSearch,
      req.hubUser,
      base_url?.trim() || null,
      api_key_env?.trim() || null,
      api_key?.trim() || null,
    );
  } catch (err) {
    console.error('[hub-admin] add model:', err.message);
  }
  res.redirect('/admin/models');
});

router.post('/admin/models/:key', requireHubAdmin, (req, res) => {
  const { label, model_id, tier, search, base_url, api_key_env, api_key, enabled } = req.body;
  const hub = db.hub();
  const existing = hub.prepare('SELECT api_key FROM model_config WHERE key = ?').get(req.params.key);
  if (!existing) return res.redirect('/admin/models');
  const resolvedKey = api_key?.trim() || (existing?.api_key ?? null);
  const finalTier = tier?.trim() || 'everyday';
  const finalSearch = (search || defaultSearchModeForTier(finalTier)).trim();
  hub.prepare(`
    UPDATE model_config
       SET label = ?, model_id = ?, tier = ?, search = ?,
           base_url = ?, api_key_env = ?, api_key = ?, enabled = ?
     WHERE key = ?
  `).run(
    label?.trim() || req.params.key,
    model_id?.trim() || '',
    finalTier,
    finalSearch,
    base_url?.trim() || null,
    api_key_env?.trim() || null,
    resolvedKey,
    enabled ? 1 : 0,
    req.params.key,
  );
  res.redirect('/admin/models');
});

router.post('/admin/models/:key/toggle', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const row = hub.prepare('SELECT * FROM model_config WHERE key = ?').get(req.params.key);
  if (!row) return res.redirect('/admin/models');
  hub.prepare('UPDATE model_config SET enabled = ? WHERE key = ?')
     .run(row.enabled ? 0 : 1, req.params.key);
  res.redirect('/admin/models');
});

router.post('/admin/models/:key/delete', requireHubAdmin, (req, res) => {
  db.hub().prepare('DELETE FROM model_config WHERE key = ?').run(req.params.key);
  res.redirect('/admin/models');
});

// ── MCP-friendly JSON API ─────────────────────────────────────────────────────
// Stable schema for a future MCP server to consume.
//
// GET /mcp/projects
//   → { user, projects: [{slug, name, context_depth, is_cv_context,
//                         memory_count, last_activity_ts}] }
//
// GET /mcp/projects/:slug
//   → { project: {...}, memories: [{id, ts, role, content,
//                                   conversation_id, model}] }
//
// Auth: Authorization: Bearer <token> (per-user MCP token in .env),
//       or an active admin session cookie for browser testing.

router.get('/mcp/projects', requireMcpAuth, (req, res) => {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT p.slug, p.name, p.context_depth, p.is_cv_context,
           (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id) AS memory_count,
           (SELECT MAX(ts) FROM messages m WHERE m.project_id = p.id) AS last_activity_ts
      FROM projects p
     WHERE p.user = ?
  ORDER BY p.name
  `).all(req.hubUser);
  res.json({ user: req.hubUser, projects: rows });
});

router.get('/mcp/projects/:slug', requireMcpAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare(
    'SELECT slug, name, context_depth, is_cv_context FROM projects WHERE user = ? AND slug = ?'
  ).get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const sinceParam = req.query.since ? parseInt(req.query.since, 10) : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
  const memories = hub.prepare(`
    SELECT m.id, m.ts, m.role, m.content, m.conversation_id, m.model
      FROM messages m
      JOIN projects p ON p.id = m.project_id
     WHERE p.user = ? AND p.slug = ?
       AND (? IS NULL OR m.ts > ?)
  ORDER BY m.ts ASC
     LIMIT ?
  `).all(req.hubUser, req.params.slug, sinceParam, sinceParam, limit);
  res.json({ project, memories });
});

router.get('/mcp/projects/:slug/documents', requireMcpAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare(
    'SELECT slug, name FROM projects WHERE user = ? AND slug = ?'
  ).get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const documents = hub.prepare(`
    SELECT d.id, d.filename, d.mimetype, d.size_bytes, d.uploaded_at, d.markdown
      FROM documents d
      JOIN projects p ON p.id = d.project_id
     WHERE p.user = ? AND p.slug = ?
  ORDER BY d.uploaded_at ASC
  `).all(req.hubUser, req.params.slug);
  res.json({ project, documents });
});

module.exports = router;
