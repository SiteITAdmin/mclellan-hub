const express = require('express');
const router = express.Router();
const fetch = require('../lib/fetch');
const users = require('../config/users');
const db = require('../lib/db');
const { finishGoogleAuth, startGoogleAuth } = require('../lib/google-auth');
const { createRateLimiter, requireSameOrigin } = require('../lib/security');
const { exaSearch, braveSearch, WEB_SEARCH_TOOL } = require('../lib/router');
const multer = require('multer');
const { fileToMarkdown: extractFileToMarkdown } = require('../lib/extract');
const {
  RULE_TYPES: EMAIL_RULE_TYPES,
  listEmailTaxonomy,
  normalizeRuleType,
} = require('../lib/email-taxonomy');
const { uuid } = require('../lib/id');
const testUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const { ingestFeed, ingestAllFeeds } = require('../lib/rss-ingest');

// Ensure test_jobs table exists (safe to run every startup)
try {
  db.hub().prepare(`CREATE TABLE IF NOT EXISTS test_jobs (
    id TEXT PRIMARY KEY,
    user TEXT NOT NULL,
    question TEXT NOT NULL,
    combos TEXT NOT NULL,
    results TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  )`).run();
} catch (_) {}

function defaultSearchModeForTier(tier) {
  try {
    const row = db.hub().prepare('SELECT search_default FROM model_tiers WHERE key = ?').get(tier);
    if (row) return row.search_default || 'web-plugin';
  } catch (_) {}
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
  startGoogleAuth({
    purpose: 'hub-admin',
    user: req.hubUser,
    callbackPath: '/admin/auth/google/callback',
    returnTo: '/admin',
    extraScopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  })(req, res, next)
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
  const contacts = hub.prepare('SELECT id, name, wiki_tags FROM contacts WHERE user = ? ORDER BY name').all(req.hubUser);
  const { getAllWikiTags } = require('../lib/wiki-tags');
  const wikiTags = getAllWikiTags();
  // Combined tag pool: wiki tags + project names + contact names
  const nameTagSet = new Set([
    ...projects.map(p => p.name),
    ...contacts.map(c => c.name),
  ]);
  const allTags = [...new Set([...wikiTags, ...nameTagSet])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const assignedTagSet = new Set([
    ...projects.flatMap(p => JSON.parse(p.wiki_tags || '[]')),
    ...contacts.flatMap(c => JSON.parse(c.wiki_tags || '[]')),
  ]);
  const unassignedTags = allTags.filter(t => !assignedTagSet.has(t));
  res.render('hub-admin/index', { user: req.hubUser, projects, wikiTags: allTags, unassignedTags });
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
  const wikiTags = getCombinedTags(req.hubUser);
  const matchedPages = getWikiPagesByTags(JSON.parse(project.wiki_tags || '[]'), { limit: 5 });
  res.render('hub-admin/project', { user: req.hubUser, project, memories, documents, wikiTags, matchedPages });
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

// ── Wiki tags API ─────────────────────────────────────────────────────────────
const { getAllWikiTags, getWikiPagesByTags } = require('../lib/wiki-tags');

function getCombinedTags(user) {
  const hub = db.hub();
  const projects = hub.prepare('SELECT name FROM projects WHERE user = ?').all(user);
  const contacts = hub.prepare('SELECT name FROM contacts WHERE user = ?').all(user);
  const wikiTags = getAllWikiTags();
  return [...new Set([...wikiTags, ...projects.map(p => p.name), ...contacts.map(c => c.name)])]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

router.get('/admin/api/wiki-tags', requireHubAdmin, (req, res) => {
  res.json({ tags: getCombinedTags(req.hubUser) });
});

router.post('/admin/projects/:id/wiki-tags', requireHubAdmin, (req, res) => {
  const tags = req.body.tags;
  const arr = Array.isArray(tags) ? tags : (tags ? [tags] : []);
  const hub = db.hub();
  hub.prepare('UPDATE projects SET wiki_tags = ? WHERE id = ? AND user = ?')
    .run(JSON.stringify(arr), req.params.id, req.hubUser);
  try {
    const { writeTagsIndex, getAllWikiTags } = require('../lib/wiki-tags');
    const projects = hub.prepare('SELECT id, name, wiki_tags FROM projects WHERE user = ?').all(req.hubUser);
    const contacts = hub.prepare('SELECT id, name, wiki_tags FROM contacts WHERE user = ?').all(req.hubUser);
    writeTagsIndex({ projects, contacts, wikiTags: getAllWikiTags() });
  } catch (e) { console.warn('[tags-index]', e.message); }
  res.redirect('/admin');
});

// ── CRM contacts admin ────────────────────────────────────────────────────────
router.get('/admin/crm', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const contacts = hub.prepare(
    'SELECT * FROM contacts WHERE user = ? ORDER BY name'
  ).all(req.hubUser).map(c => ({
    ...c,
    matchedPages: getWikiPagesByTags(JSON.parse(c.wiki_tags || '[]'), { limit: 5 }),
  }));
  const wikiTags = getCombinedTags(req.hubUser);
  res.render('hub-admin/crm', { user: req.hubUser, contacts, wikiTags });
});

router.post('/admin/contacts/:id/wiki-tags', requireHubAdmin, (req, res) => {
  const tags = req.body.tags;
  const arr = Array.isArray(tags) ? tags : (tags ? [tags] : []);
  const hub = db.hub();
  hub.prepare('UPDATE contacts SET wiki_tags = ? WHERE id = ? AND user = ?')
    .run(JSON.stringify(arr), req.params.id, req.hubUser);
  try {
    const { writeTagsIndex, getAllWikiTags } = require('../lib/wiki-tags');
    const projects = hub.prepare('SELECT id, name, wiki_tags FROM projects WHERE user = ?').all(req.hubUser);
    const contacts = hub.prepare('SELECT id, name, wiki_tags FROM contacts WHERE user = ?').all(req.hubUser);
    writeTagsIndex({ projects, contacts, wikiTags: getAllWikiTags() });
  } catch (e) { console.warn('[tags-index]', e.message); }
  res.redirect('/admin/crm');
});

// ── Email taxonomy admin ──────────────────────────────────────────────────────
router.get('/admin/email-taxonomy', requireHubAdmin, (req, res) => {
  const taxonomy = listEmailTaxonomy(req.hubUser);
  const pending = db.hub().prepare(`
    SELECT 'gmail' AS source, gmail_message_id AS message_id,
           from_name, from_email, subject, created_at
    FROM email_classification_pending
    WHERE user = ? AND status = 'pending'
    UNION ALL
    SELECT source, external_message_id AS message_id,
           from_name, from_email, subject, processed_at AS created_at
    FROM inbound_email_records
    WHERE user = ? AND status = 'review'
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.hubUser, req.hubUser);
  res.render('hub-admin/email-taxonomy', {
    user: req.hubUser,
    labels: taxonomy.labels,
    rules: taxonomy.rules,
    ruleTypes: EMAIL_RULE_TYPES,
    pending,
  });
});

router.post('/admin/email-taxonomy/labels', requireHubAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 120) return res.redirect('/admin/email-taxonomy');
  try {
    db.hub().prepare(`
      INSERT INTO email_taxonomy_labels (id, user, name, display_order)
      VALUES (?, ?, ?, ?)
    `).run(uuid(), req.hubUser, name, parseInt(req.body.display_order, 10) || 0);
  } catch (err) {
    console.warn('[email-taxonomy] add label:', err.message);
  }
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/labels/:id', requireHubAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 120) return res.redirect('/admin/email-taxonomy');
  const hub = db.hub();
  const current = hub.prepare(
    'SELECT name FROM email_taxonomy_labels WHERE id = ? AND user = ?'
  ).get(req.params.id, req.hubUser);
  if (!current) return res.redirect('/admin/email-taxonomy');
  const update = hub.transaction(() => {
    hub.prepare(`
      UPDATE email_taxonomy_labels
      SET name = ?, display_order = ?, enabled = ?
      WHERE id = ? AND user = ?
    `).run(
      name,
      parseInt(req.body.display_order, 10) || 0,
      req.body.enabled ? 1 : 0,
      req.params.id,
      req.hubUser
    );
    if (current.name !== name) {
      hub.prepare(`
        UPDATE email_taxonomy_rules SET target_label = ?
        WHERE user = ? AND target_label = ?
      `).run(name, req.hubUser, current.name);
    }
  });
  try { update(); } catch (err) {
    console.warn('[email-taxonomy] update label:', err.message);
  }
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/labels/:id/delete', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const label = hub.prepare(
    'SELECT name FROM email_taxonomy_labels WHERE id = ? AND user = ?'
  ).get(req.params.id, req.hubUser);
  if (label) {
    const used = hub.prepare(
      'SELECT 1 FROM email_taxonomy_rules WHERE user = ? AND target_label = ? LIMIT 1'
    ).get(req.hubUser, label.name);
    if (!used) {
      hub.prepare('DELETE FROM email_taxonomy_labels WHERE id = ? AND user = ?')
        .run(req.params.id, req.hubUser);
    }
  }
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/rules', requireHubAdmin, (req, res) => {
  const matchType = normalizeRuleType(req.body.match_type);
  const matchValue = String(req.body.match_value || '').trim();
  const targetLabel = String(req.body.target_label || '').trim();
  const label = db.hub().prepare(
    'SELECT 1 FROM email_taxonomy_labels WHERE user = ? AND name = ?'
  ).get(req.hubUser, targetLabel);
  if (!matchType || !matchValue || !label) return res.redirect('/admin/email-taxonomy');
  try {
    db.hub().prepare(`
      INSERT INTO email_taxonomy_rules
        (id, user, match_type, match_value, target_label, notes, priority, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      uuid(), req.hubUser, matchType, matchValue, targetLabel,
      String(req.body.notes || '').trim(),
      parseInt(req.body.priority, 10) || 100
    );
  } catch (err) {
    console.warn('[email-taxonomy] add rule:', err.message);
  }
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/rules/:id', requireHubAdmin, (req, res) => {
  const matchType = normalizeRuleType(req.body.match_type);
  const matchValue = String(req.body.match_value || '').trim();
  const targetLabel = String(req.body.target_label || '').trim();
  const label = db.hub().prepare(
    'SELECT 1 FROM email_taxonomy_labels WHERE user = ? AND name = ?'
  ).get(req.hubUser, targetLabel);
  if (matchType && matchValue && label) {
    try {
      db.hub().prepare(`
        UPDATE email_taxonomy_rules
        SET match_type = ?, match_value = ?, target_label = ?, notes = ?,
            priority = ?, enabled = ?
        WHERE id = ? AND user = ?
      `).run(
        matchType, matchValue, targetLabel, String(req.body.notes || '').trim(),
        parseInt(req.body.priority, 10) || 100, req.body.enabled ? 1 : 0,
        req.params.id, req.hubUser
      );
    } catch (err) {
      console.warn('[email-taxonomy] update rule:', err.message);
    }
  }
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/rules/:id/delete', requireHubAdmin, (req, res) => {
  db.hub().prepare(
    'DELETE FROM email_taxonomy_rules WHERE id = ? AND user = ?'
  ).run(req.params.id, req.hubUser);
  res.redirect('/admin/email-taxonomy');
});

router.post('/admin/email-taxonomy/agentmail-classify', requireHubAdmin, async (req, res) => {
  const messageId = String(req.body.message_id || '');
  const targetLabel = String(req.body.target_label || '').trim();
  const hub = db.hub();
  const label = hub.prepare(
    'SELECT 1 FROM email_taxonomy_labels WHERE user = ? AND name = ? AND enabled = 1'
  ).get(req.hubUser, targetLabel);
  const record = hub.prepare(`
    SELECT from_email FROM inbound_email_records
    WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
  `).get(req.hubUser, messageId);
  if (!label || !record) return res.redirect('/admin/email-taxonomy');

  if (record.from_email) {
    hub.prepare(`
      INSERT INTO email_taxonomy_rules
        (id, user, match_type, match_value, target_label, notes, priority, enabled)
      VALUES (?, ?, 'sender_email', ?, ?, 'Learned from AgentMail review', 200, 1)
      ON CONFLICT(user, match_type, match_value) DO UPDATE SET
        target_label = excluded.target_label,
        notes = excluded.notes,
        priority = excluded.priority,
        enabled = 1
    `).run(uuid(), req.hubUser, record.from_email, targetLabel);
  }
  hub.prepare(`
    UPDATE inbound_email_records
    SET classification = ?, status = 'processed'
    WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
  `).run(targetLabel, req.hubUser, messageId);
  try {
    const { updateMessage } = require('../lib/agentmail');
    await updateMessage(messageId, {
      addLabels: ['hub-processed'],
      removeLabels: ['hub:review'],
    });
  } catch (err) {
    console.warn('[agentmail] review label update:', err.message);
  }
  res.redirect('/admin/email-taxonomy');
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

// ── Debrief session logs ──────────────────────────────────────────────────────
router.get('/admin/debrief', requireHubAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 200);
  const sessions = db.hub().prepare(`
    SELECT id, user, started_at, ended_at, turns, note_path, extraction, error, calendar_events
    FROM debrief_sessions
    WHERE user = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(req.hubUser, limit);

  // Parse JSON fields
  const parsed = sessions.map(s => ({
    ...s,
    extraction: s.extraction ? (() => { try { return JSON.parse(s.extraction); } catch { return null; } })() : null,
    calendar_events: s.calendar_events ? (() => { try { return JSON.parse(s.calendar_events); } catch { return []; } })() : [],
    duration: s.ended_at && s.started_at ? s.ended_at - s.started_at : null,
  }));

  res.render('hub-admin/debrief', { user: req.hubUser, sessions: parsed, limit });
});

router.get('/admin/debrief/:id', requireHubAdmin, (req, res) => {
  const session = db.hub().prepare('SELECT * FROM debrief_sessions WHERE id = ? AND user = ?')
    .get(req.params.id, req.hubUser);
  if (!session) return res.status(404).send('Not found');
  const parsed = {
    ...session,
    extraction: session.extraction ? (() => { try { return JSON.parse(session.extraction); } catch { return null; } })() : null,
    calendar_events: session.calendar_events ? (() => { try { return JSON.parse(session.calendar_events); } catch { return []; } })() : [],
    duration: session.ended_at && session.started_at ? session.ended_at - session.started_at : null,
  };
  res.render('hub-admin/debrief-detail', { user: req.hubUser, session: parsed });
});

// ── Model management ──────────────────────────────────────────────────────────
const { DEFAULT_MODELS, getDefaultModel } = require('../lib/router');
const { uuid: uuidId } = require('../lib/id');
const { getSystemModelId, setSystemModel, getSystemModelLabel, getSystemPromptOverride, setSystemPromptOverride } = require('../lib/settings');
const { PROMPTS } = require('../lib/prompts');

// System model slots — displayed as configurable cards in /admin/models.
// scope 'system' = shared across users; scope 'user' = per-user (stored under req.hubUser).
const SYSTEM_MODEL_GROUPS = [
  { id: 'chat-infra', label: 'Chat infrastructure', slots: [
    { feature: 'recall_tagger',          scope: 'system', label: 'Recall tagger',          note: 'Fires silently after every chat turn — prefer cheapest available.', fallback: 'meta-llama/llama-3.1-8b-instruct:free' },
    { feature: 'multisearch_planner',    scope: 'system', label: 'Multi-search planner',   note: 'Plans search queries for orchestrated research.', fallback: 'deepseek/deepseek-v3.2' },
    { feature: 'multisearch_synthesiser',scope: 'system', label: 'Multi-search synthesiser',note: 'Writes the final report from gathered sources.', fallback: 'google/gemini-2.5-pro-preview' },
  ]},
  { id: 'background', label: 'Background processing', slots: [
    { feature: 'crm_parser',       scope: 'system', label: 'CRM intent parser',   note: 'Runs when you save a CRM note.', fallback: 'google/gemini-2.5-pro-preview' },
    { feature: 'email_classifier', scope: 'system', label: 'Email classifier',    note: 'Runs on Gmail ingestion.', fallback: 'google/gemini-2.5-pro-preview' },
    { feature: 'agentmail_extractor', scope: 'system', label: 'AgentMail extractor', note: 'Extracts people, facts and multiple actions from AgentMail messages.', fallback: 'google/gemini-3.1-pro-preview' },
    { feature: 'reg_synopsis',     scope: 'system', label: 'Regulatory synopsis', note: 'Writes 2-sentence summaries of regulatory publications.', fallback: 'google/gemini-2.5-pro-preview' },
    { feature: 'prompt_improver',  scope: 'system', label: 'Prompt improver',     note: 'Rewrites prompts in the admin test panel.', fallback: 'google/gemini-2.5-flash-lite' },
    { feature: 'admin_synthesiser',scope: 'system', label: 'Test synthesiser',    note: 'Synthesises multi-search results in the admin test arena.', fallback: 'google/gemini-2.5-flash-lite' },
  ]},
  { id: 'debrief', label: 'Debrief', slots: [
    { feature: 'debrief_interviewer', scope: 'user', label: 'Debrief interviewer', note: 'Conducts the end-of-day voice debrief. Must be fast with short outputs.', fallback: 'anthropic/claude-haiku-4-5' },
    { feature: 'debrief_extractor',  scope: 'user', label: 'Debrief extractor',   note: 'Extracts CRM facts and actions from the transcript.', fallback: 'deepseek/deepseek-v3.2' },
  ]},
  { id: 'linkedin', label: 'LinkedIn pipeline', slots: [
    { feature: 'linkedin_planner',    scope: 'user', label: 'Query planner',          note: 'Generates search queries for a LinkedIn topic.', fallback: 'deepseek/deepseek-v3.2' },
    { feature: 'linkedin_synthesiser',scope: 'user', label: 'Research synthesiser',   note: 'Writes a research briefing from gathered sources.', fallback: 'anthropic/claude-sonnet-4-6' },
    { feature: 'linkedin_drafter',    scope: 'user', label: 'Post drafter',           note: 'Writes the initial teaser post.', fallback: 'deepseek/deepseek-v4-flash' },
    { feature: 'linkedin_scorer',     scope: 'user', label: 'Post scorer',            note: 'Evaluates and scores the draft against the rubric.', fallback: 'anthropic/claude-sonnet-4-6' },
    { feature: 'linkedin_carousel',   scope: 'user', label: 'Carousel generator',     note: 'Generates carousel slide content from research.', fallback: 'deepseek/deepseek-v4-flash' },
    { feature: 'linkedin_refiner',    scope: 'user', label: 'Draft refiner',           note: 'Makes targeted improvements to the teaser post.', fallback: 'mistralai/mistral-medium-3' },
    { feature: 'linkedin_carousel_reviewer', scope: 'user', label: 'Carousel reviewer', note: 'Reviews generated carousel JSON against the content rubric.', fallback: 'mistralai/mistral-medium-3' },
    { feature: 'linkedin_image',      scope: 'user', label: 'Image prompt writer',    note: 'Writes the prompt used for image generation.', fallback: 'deepseek/deepseek-chat' },
  ]},
  { id: 'workday', label: 'Workday', slots: [
    { feature: 'workday_narrative', scope: 'user', label: 'Narrative writer', note: 'Converts a workday voice transcript into a structured Markdown note.', fallback: 'free (or WORKDAY_NARRATIVE_MODEL env)' },
  ]},
  { id: 'portfolio', label: 'Public portfolio', slots: [
    { feature: 'portfolio_chat', scope: 'user', label: '"Ask me" chat',  note: 'Public-facing portfolio chat — anyone can trigger. Prefer fast, cheap models.', fallback: 'free' },
    { feature: 'jd_analyser',   scope: 'user', label: 'JD analyser',    note: 'Public-facing JD analyser — anyone can trigger. Prefer fast, cheap models.', fallback: 'free' },
  ]},
  { id: 'wiki', label: 'Wiki', slots: [
    { feature: 'wiki_page_writer', scope: 'system', label: 'Page writer',     note: 'Converts documents and Q&A into structured wiki pages.', fallback: 'google/gemini-2.5-pro-preview' },
    { feature: 'wiki_image_vision',scope: 'system', label: 'Image vision',    note: 'Describes uploaded images before converting them to wiki pages. Cheap vision model recommended.', fallback: 'google/gemini-2.0-flash-001' },
  ]},
  { id: 'newsletter', label: 'Newsletter intelligence', slots: [
    { feature: 'newsletter_extractor', scope: 'system', label: 'Topic extractor', note: 'Extracts structured topics from newsletter emails. Runs on every newsletter received.', fallback: 'google/gemini-2.5-flash-lite' },
    { feature: 'newsletter_briefing',  scope: 'user',   label: 'Briefing writer',  note: 'Writes the weekly intelligence briefing from selected topics.', fallback: 'anthropic/claude-sonnet-4-6' },
  ]},
];

function getAdminTiers(hub) {
  return hub.prepare('SELECT key, label, search_default, display_order FROM model_tiers ORDER BY display_order, key').all();
}

router.get('/admin/models', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  // Seed the free fallback if the table is completely empty (first run only)
  const hasAny = hub.prepare('SELECT 1 FROM model_config LIMIT 1').get();
  if (!hasAny) {
    const insert = hub.prepare(
      'INSERT OR IGNORE INTO model_config (key, label, endpoint, model_id, tier, search, enabled, user) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)'
    );
    for (const [key, def] of Object.entries(DEFAULT_MODELS)) {
      insert.run(key, def.label || key, def.endpoint, def.id, def.tier, def.search);
    }
  }
  const models = hub.prepare(
    `SELECT *, category, cost_input, cost_output, context_length FROM model_config
      WHERE user IS NULL OR user = ?
      ORDER BY (user IS NULL) DESC, tier, display_order, key`
  ).all(req.hubUser);
  const tiers = getAdminTiers(hub);
  const defaultModel = getDefaultModel(req.hubUser);
  // Resolve current setting for each system model slot
  const systemGroups = SYSTEM_MODEL_GROUPS.map(group => ({
    ...group,
    slots: group.slots.map(slot => {
      const resolvedScope = slot.scope === 'user' ? req.hubUser : 'system';
      const current = getSystemModelLabel(slot.feature, resolvedScope);
      const promptOverride = getSystemPromptOverride(slot.feature, resolvedScope);
      const promptDefault = PROMPTS[slot.feature] || '';
      return { ...slot, resolvedScope, currentKey: current?.key || null, currentLabel: current?.label || null, promptOverride, promptDefault };
    }),
  }));
  res.render('hub-admin/models', { user: req.hubUser, models, tiers, defaultModel, systemGroups });
});

router.post('/admin/models/_set-default', requireHubAdmin, (req, res) => {
  const { key } = req.body;
  if (!key) return res.redirect('/admin/models');
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, 'hub_default_model', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuidId(), req.hubUser, key);
  res.redirect('/admin/models');
});

router.post('/admin/system-models/_set', requireHubAdmin, (req, res) => {
  const { feature, scope, model_key } = req.body;
  if (!feature) return res.redirect('/admin/models');
  const resolvedScope = scope === 'system' ? 'system' : req.hubUser;
  setSystemModel(feature, resolvedScope, model_key || null);
  res.redirect('/admin/models#sys-' + feature);
});

router.post('/admin/system-models/_set-prompt', requireHubAdmin, (req, res) => {
  const { feature, scope, prompt } = req.body;
  if (!feature) return res.redirect('/admin/models');
  const resolvedScope = scope === 'system' ? 'system' : req.hubUser;
  setSystemPromptOverride(feature, resolvedScope, prompt || null);
  res.redirect('/admin/models#sys-' + feature);
});

router.post('/admin/models', requireHubAdmin, (req, res) => {
  const { key, label, endpoint, model_id, tier, search, base_url, api_key_env, api_key, category, cost_input, cost_output, context_length } = req.body;
  if (!key || !label || !endpoint || !model_id || !tier) return res.redirect('/admin/models');
  const finalTier = tier.trim();
  const finalSearch = (search || defaultSearchModeForTier(finalTier)).trim();
  try {
    db.hub().prepare(`
      INSERT INTO model_config (key, label, endpoint, model_id, tier, search, enabled, user, base_url, api_key_env, api_key, category, cost_input, cost_output, context_length)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
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
      category?.trim() || null,
      cost_input ? parseFloat(cost_input) : null,
      cost_output ? parseFloat(cost_output) : null,
      context_length ? parseInt(context_length, 10) : null,
    );
  } catch (err) {
    console.error('[hub-admin] add model:', err.message);
  }
  res.redirect('/admin/models');
});

// Model key-in-body actions — avoids slash-in-key URL routing issues
router.post('/admin/models/_update', requireHubAdmin, (req, res) => {
  const { key, label, model_id, tier, search, base_url, api_key_env, api_key, enabled, category, cost_input, cost_output, context_length } = req.body;
  if (!key) return res.redirect('/admin/models');
  const hub = db.hub();
  const existing = hub.prepare('SELECT api_key FROM model_config WHERE key = ?').get(key);
  if (!existing) return res.redirect('/admin/models');
  const resolvedKey = api_key?.trim() || (existing?.api_key ?? null);
  const finalTier = tier?.trim() || 'everyday';
  const finalSearch = (search || defaultSearchModeForTier(finalTier)).trim();
  hub.prepare(`
    UPDATE model_config
       SET label = ?, model_id = ?, tier = ?, search = ?,
           base_url = ?, api_key_env = ?, api_key = ?, enabled = ?,
           category = ?, cost_input = ?, cost_output = ?, context_length = ?
     WHERE key = ?
  `).run(
    label?.trim() || key,
    model_id?.trim() || '',
    finalTier,
    finalSearch,
    base_url?.trim() || null,
    api_key_env?.trim() || null,
    resolvedKey,
    enabled ? 1 : 0,
    category?.trim() || null,
    cost_input ? parseFloat(cost_input) : null,
    cost_output ? parseFloat(cost_output) : null,
    context_length ? parseInt(context_length, 10) : null,
    key,
  );
  res.redirect('/admin/models');
});

router.post('/admin/models/_toggle', requireHubAdmin, (req, res) => {
  const { key } = req.body;
  if (!key) return res.redirect('/admin/models');
  const hub = db.hub();
  const row = hub.prepare('SELECT * FROM model_config WHERE key = ?').get(key);
  if (!row) return res.redirect('/admin/models');
  hub.prepare('UPDATE model_config SET enabled = ? WHERE key = ?').run(row.enabled ? 0 : 1, key);
  res.redirect('/admin/models');
});

router.post('/admin/models/_delete', requireHubAdmin, (req, res) => {
  const { key } = req.body;
  if (!key) return res.redirect('/admin/models');
  db.hub().prepare('DELETE FROM model_config WHERE key = ?').run(key);
  res.redirect('/admin/models');
});

// ── Brave web-plugin test ─────────────────────────────────────────────────────
router.post('/admin/models/_test-brave', requireHubAdmin, async (req, res) => {
  const { key } = req.body;
  const hub = db.hub();
  const m = hub.prepare('SELECT key, model_id, api_key FROM model_config WHERE key = ?').get(key);
  if (!m) return res.status(404).json({ ok: false, error: 'Model not found' });

  // Internal tool-call syntax leaking as text — model never actually surfaced search results to user
  // Covers: DeepSeek DSML, Kimi <|tool_calls_section_begin|>, and similar delimiter formats
  const TOOL_LEAK_RE = /\u{FF5C}{2}DSML\u{FF5C}{2}|<\u{FF5C}{2}DSML|<[|]tool_calls_section_begin[|]>/u;

  const testedAt = new Date().toISOString();
  const log = (...args) => console.log(`[brave-test] ${m.key} |`, ...args);

  const fail = (reason, preview) => {
    log(`FAIL — ${reason}`);
    hub.prepare('UPDATE model_config SET brave_tested = -1, brave_tested_at = ?, brave_preview = ? WHERE key = ?')
      .run(testedAt, (preview || reason).slice(0, 1200), key);
    return res.json({ ok: false, error: reason, testedAt, preview: preview || reason });
  };

  log(`starting test for model_id=${m.model_id}`);

  // ── Step 1: pull ground-truth headlines directly from Brave API ──────────────
  let groundTruth = '';
  try {
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!braveKey) throw new Error('BRAVE_SEARCH_API_KEY not set');
    const br = await fetch(
      'https://api.search.brave.com/res/v1/web/search?q=bbc.com%2Fnews+top+stories+today&count=8&freshness=pd',
      { headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey } }
    );
    const bd = await br.json();
    const results = (bd.web?.results || [])
      .filter(r => r.url.includes('bbc.com/news') && !r.url.includes('newspaper-headlines'))
      .slice(0, 5);
    groundTruth = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join('\n');
    log(`Brave API: ${results.length} ground-truth results`);
    results.forEach((r, i) => log(`  GT${i + 1}: ${r.title}`));
  } catch (e) {
    groundTruth = `(Brave API unavailable: ${e.message})`;
    log(`Brave API error: ${e.message}`);
  }

  // ── Step 2: ask the model to write a newsreader script using its web plugin ──
  const prompt = `You are a BBC radio newsreader. Search bbc.com/news right now for the current top stories and write a 20-second headline bulletin — the kind read at the top of the hour on BBC Radio 4. Cover 3 stories. Be specific: include real names, places, and details from what you find. Start with "Here are today's headlines."`;

  try {
    const apiKey = m.api_key || process.env.OPENROUTER_API_KEY;
    log(`calling OpenRouter stream=false`);
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://mclellan.scot',
        'X-Title': 'McLellan Hub Brave test',
      },
      body: JSON.stringify({
        model: m.model_id,
        messages: [{ role: 'user', content: prompt }],
        tools: [WEB_SEARCH_TOOL],
        tool_choice: 'auto',
        stream: false,
      }),
    });

    const rawText = await r.text();
    log(`OpenRouter HTTP ${r.status}, raw response length=${rawText.length}`);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      log(`JSON parse failed — raw: ${rawText.slice(0, 300)}`);
      return fail('Truncated response — model may have streamed despite stream:false', `Truncated/unparseable response:\n${rawText.slice(0, 600)}`);
    }

    if (!r.ok) {
      const errMsg = data.error?.message || `HTTP ${r.status}`;
      log(`OpenRouter error: ${errMsg}`);
      return fail(errMsg);
    }

    const msg        = data.choices?.[0]?.message || {};
    const content    = msg.content || '';
    const finishReason = data.choices?.[0]?.finish_reason || 'unknown';
    const annotations  = msg.annotations || [];
    const citations    = annotations.filter(a => a.type === 'url_citation' && a.url_citation?.url);

    log(`finish_reason=${finishReason} content_length=${content.length} annotations=${annotations.length} citations=${citations.length}`);
    log(`content preview: ${content.slice(0, 200).replace(/\n/g, ' ')}`);
    if (citations.length) citations.forEach((c, i) => log(`  cite${i + 1}: ${c.url_citation?.url}`));

    // finish_reason=tool_calls means OpenRouter returned the intermediate tool-call turn and stopped —
    // the model invoked the web search but never wrote the final response the user would actually see
    if (finishReason === 'tool_calls' || (content.length === 0 && citations.length > 0)) {
      const citeSample = citations.slice(0, 5).map(c => `• ${c.url_citation?.url}`).join('\n');
      return fail(
        `Model stopped at tool call stage (finish_reason=${finishReason}) — searched but produced no output`,
        `Model invoked web search (${citations.length} citations) but finish_reason=${finishReason} with no text output.\nUser would see a blank response in chat.\n\nCitations found:\n${citeSample}`
      );
    }

    if (TOOL_LEAK_RE.test(content)) {
      const leakType = content.includes('<|tool_calls_section_begin|>') ? 'Kimi <|tool_calls_section_begin|>' : 'DSML';
      log(`TOOL LEAK detected (${leakType}) — citations present but output is raw tool syntax`);
      return fail(
        `Model leaked internal ${leakType} tool syntax — raw tool call in output, not a usable response`,
        `Tool call leak (${leakType}):\n\n${content.slice(0, 600)}\n\n── CITATIONS (present but output unusable) ──\n${citations.map(c => `• ${c.url_citation?.title || c.url_citation?.url}`).join('\n') || 'none'}`
      );
    }

    const passed = citations.length > 0;
    log(`result: ${passed ? 'PASS' : 'FAIL'} (${citations.length} citations)`);

    const sourceList = citations.length
      ? citations.map(a => `• ${a.url_citation.title || a.url_citation.url}`).join('\n')
      : 'No web citations returned.';

    const preview = [
      '── BRAVE API (ground truth) ──────────────────',
      groundTruth || '(no results)',
      '',
      '── MODEL OUTPUT ──────────────────────────────',
      content || '(empty)',
      '',
      '── CITATIONS ─────────────────────────────────',
      sourceList,
    ].join('\n');

    hub.prepare('UPDATE model_config SET brave_tested = ?, brave_tested_at = ?, brave_preview = ? WHERE key = ?')
      .run(passed ? 1 : -1, testedAt, preview.slice(0, 1200), key);
    return res.json({ ok: passed, citations: citations.length, testedAt, preview });

  } catch (err) {
    log(`exception: ${err.message}`);
    return fail(err.message);
  }
});

// ── Tier management ───────────────────────────────────────────────────────────
router.post('/admin/tiers', requireHubAdmin, (req, res) => {
  const { key, label, search_default, display_order } = req.body;
  if (!key || !label) return res.redirect('/admin/models');
  try {
    db.hub().prepare(
      'INSERT INTO model_tiers (key, label, search_default, display_order) VALUES (?, ?, ?, ?)'
    ).run(
      key.trim().toLowerCase().replace(/\s+/g, '-'),
      label.trim(),
      search_default?.trim() || 'web-plugin',
      parseInt(display_order, 10) || 0,
    );
  } catch (err) {
    console.error('[hub-admin] add tier:', err.message);
  }
  res.redirect('/admin/models');
});

router.post('/admin/tiers/_update', requireHubAdmin, (req, res) => {
  const { key, label, search_default, display_order } = req.body;
  if (!key) return res.redirect('/admin/models');
  db.hub().prepare(
    'UPDATE model_tiers SET label = ?, search_default = ?, display_order = ? WHERE key = ?'
  ).run(label?.trim() || key, search_default?.trim() || 'web-plugin', parseInt(display_order, 10) || 0, key);
  res.redirect('/admin/models');
});

router.post('/admin/tiers/_delete', requireHubAdmin, (req, res) => {
  const { key } = req.body;
  if (!key) return res.redirect('/admin/models');
  db.hub().prepare('DELETE FROM model_tiers WHERE key = ?').run(key);
  res.redirect('/admin/models');
});

// ── Chat shortcuts (welcome screen cards) ─────────────────────────────────────
router.get('/admin/shortcuts', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const shortcuts = hub.prepare(
    `SELECT * FROM chat_shortcuts WHERE user IS NULL OR user = ? ORDER BY display_order, rowid`
  ).all(req.hubUser);
  const models = hub.prepare(
    `SELECT key, label FROM model_config WHERE enabled = 1 AND (user IS NULL OR user = ?) ORDER BY tier, display_order, key`
  ).all(req.hubUser);
  res.render('hub-admin/shortcuts', { user: req.hubUser, shortcuts, models });
});

router.post('/admin/shortcuts', requireHubAdmin, (req, res) => {
  const { kicker, icon, label, desc, model_key, search, display_order } = req.body;
  if (!kicker || !label || !model_key) return res.redirect('/admin/shortcuts');
  const { uuid } = require('../lib/id');
  db.hub().prepare(`
    INSERT INTO chat_shortcuts (id, user, kicker, icon, label, desc, model_key, search, display_order, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    uuid(), req.hubUser,
    kicker.trim().toUpperCase(),
    icon?.trim() || '◎',
    label.trim(),
    desc?.trim() || null,
    model_key.trim(),
    search?.trim() || null,
    parseInt(display_order, 10) || 0,
  );
  res.redirect('/admin/shortcuts');
});

router.post('/admin/shortcuts/:id', requireHubAdmin, (req, res) => {
  const { kicker, icon, label, desc, model_key, search, display_order, enabled } = req.body;
  db.hub().prepare(`
    UPDATE chat_shortcuts
       SET kicker = ?, icon = ?, label = ?, desc = ?, model_key = ?,
           search = ?, display_order = ?, enabled = ?
     WHERE id = ? AND (user IS NULL OR user = ?)
  `).run(
    kicker.trim().toUpperCase(),
    icon?.trim() || '◎',
    label.trim(),
    desc?.trim() || null,
    model_key.trim(),
    search?.trim() || null,
    parseInt(display_order, 10) || 0,
    enabled ? 1 : 0,
    req.params.id, req.hubUser,
  );
  res.redirect('/admin/shortcuts');
});

router.post('/admin/shortcuts/:id/delete', requireHubAdmin, (req, res) => {
  db.hub().prepare('DELETE FROM chat_shortcuts WHERE id = ? AND user = ?')
    .run(req.params.id, req.hubUser);
  res.redirect('/admin/shortcuts');
});

// ── Model test arena ──────────────────────────────────────────────────────────
router.get('/admin/test', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const models = hub.prepare(
    `SELECT key, label, model_id, tier, search, enabled FROM model_config
     WHERE enabled = 1 AND (user IS NULL OR user = ?)
     ORDER BY tier, display_order, key`
  ).all(req.hubUser);
  const tiers = hub.prepare('SELECT key, label FROM model_tiers ORDER BY display_order, key').all();
  const logs = hub.prepare(
    'SELECT id, question, run_at, results FROM test_runs WHERE user = ? ORDER BY run_at DESC LIMIT 5'
  ).all(req.hubUser).map(r => ({ ...r, results: JSON.parse(r.results) }));
  res.render('hub-admin/test', { user: req.hubUser, models, tiers, logs });
});

router.post('/admin/test/save', requireHubAdmin, (req, res) => {
  const { question, results } = req.body;
  if (!question || !Array.isArray(results)) return res.json({ ok: false });
  const hub = db.hub();
  const id = require('crypto').randomBytes(8).toString('hex');
  hub.prepare(
    'INSERT INTO test_runs (id, user, question, results) VALUES (?, ?, ?, ?)'
  ).run(id, req.hubUser, question, JSON.stringify(results));
  // Prune to 5 most recent
  hub.prepare(
    `DELETE FROM test_runs WHERE user = ? AND id NOT IN (
       SELECT id FROM test_runs WHERE user = ? ORDER BY run_at DESC LIMIT 5
     )`
  ).run(req.hubUser, req.hubUser);
  res.json({ ok: true, id });
});

const UPLOAD_CHAR_LIMIT = 150_000;

router.post('/admin/test/upload', requireHubAdmin, testUpload.single('file'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, error: 'No file received' });
  const { originalname, buffer } = req.file;
  const ext = originalname.split('.').pop().toLowerCase();
  if (!['pdf', 'docx'].includes(ext)) return res.json({ ok: false, error: 'Only PDF and Word (.docx) files are supported' });
  try {
    const { markdown } = await extractFileToMarkdown(originalname, buffer);
    const truncated = markdown.length > UPLOAD_CHAR_LIMIT;
    const text = truncated ? markdown.slice(0, UPLOAD_CHAR_LIMIT) : markdown;
    res.json({ ok: true, text, filename: originalname, chars: markdown.length, truncated, truncatedAt: UPLOAD_CHAR_LIMIT });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

const IMPROVE_PROMPT_FALLBACK = 'google/gemini-2.5-flash-lite';
const IMPROVE_META_PROMPT = `You are an expert prompt engineer acting as a STRUCTURAL editor only. A user has written a prompt they want to send to an AI model. Rewrite it to significantly improve the quality of the response they'll get.

Your role is to improve structure, clarity, and framing — NOT to fact-check or validate content. Preserve all proper nouns, product names, brand names, technical terms, and capitalised terms exactly as written, even if you don't recognise them. Unknown terms are intentional — treat them as correct and keep them verbatim.

Apply these improvements as relevant:
- Specify the desired output format (structured briefing, memo, bullet points, table, etc.)
- Define the target audience and what they'll do with the answer
- Add role framing ("You are an expert in...")
- Anchor context (who is asking, from what perspective, for what purpose)
- Make vague requests specific and concrete
- Add output length or depth guidance where useful
- Include constraints or scope limits to prevent rambling

Return ONLY the improved prompt. No explanation, no preamble, no commentary. Just the rewritten prompt text, ready to use directly.`;

router.post('/admin/test/improve-prompt', requireHubAdmin, async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.json({ ok: false, error: 'No prompt provided' });
  const orHeaders = {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://mclellan.scot',
    'X-Title': 'McLellan Hub Test',
  };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: orHeaders,
      body: JSON.stringify({
        model: getSystemModelId('prompt_improver', 'system', IMPROVE_PROMPT_FALLBACK),
        messages: [
          { role: 'system', content: getSystemPrompt('prompt_improver', 'system', PROMPTS.prompt_improver) },
          { role: 'user', content: question },
        ],
        stream: false,
      }),
    });
    const data = await r.json();
    const improved = data.choices?.[0]?.message?.content?.trim();
    if (!improved) return res.json({ ok: false, error: data.error?.message || 'Model returned no content' });
    res.json({ ok: true, improved });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Shared combo execution — used by both /run (single) and /run-all (SSE)
async function runComboInternal(question, model, search) {
  const orHeaders = {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://mclellan.scot',
    'X-Title': 'McLellan Hub Test',
  };

  // No explicit timeout — infrastructure (nginx 300s) is the backstop,
  // same as the main chat. Individual combos run in parallel so a slow
  // one doesn't block the others.

  const start = Date.now();
  let userContent = question;
  let sources = [];
  let answer = '';
  let tokensIn = 0, tokensOut = 0, costUsd = null;

  // ── Multi-search orchestration (exa + brave → synthesis) ───────────────────
  if (model.endpoint === 'multi-search') {
    const [exaSettled, braveSettled] = await Promise.allSettled([
      exaSearch(question),
      braveSearch(question),
    ]);
    const exaR   = exaSettled.status   === 'fulfilled' ? exaSettled.value   : { content: '', sources: [] };
    const braveR = braveSettled.status === 'fulfilled' ? braveSettled.value : { content: '', sources: [] };
    const seenUrls = new Set();
    sources = [...exaR.sources, ...braveR.sources].filter(s => !seenUrls.has(s.url) && seenUrls.add(s.url));
    const combinedContext = [
      exaR.content   ? `## Semantic search results\n${exaR.content}`   : '',
      braveR.content ? `## Web search results\n${braveR.content}` : '',
    ].filter(Boolean).join('\n\n');
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: orHeaders,
      body: JSON.stringify({
        model: getSystemModelId('admin_synthesiser', 'system', 'google/gemini-2.5-flash-lite'),
        messages: [
          { role: 'system', content: getSystemPrompt('admin_synthesiser', 'system', PROMPTS.admin_synthesiser) },
          { role: 'user', content: `${combinedContext}\n\n---\n\n${question}` },
        ],
        stream: false,
      }),
    });
    const data = await r.json();
    if (!r.ok) return { error: data.error?.message || `API error ${r.status}` };
    answer = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    tokensIn  = usage.prompt_tokens     || 0;
    tokensOut = usage.completion_tokens || 0;
    if (usage.cost != null) costUsd = usage.cost;
    return {
      ok: true, answer,
      time_ms: Date.now() - start,
      tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
      word_count: answer.trim().split(/\s+/).filter(Boolean).length,
      search_used: 'exa+brave', sources,
      model_id: 'google/gemini-2.5-flash-lite', model_label: model.label || model.key,
    };
  }

  if (search === 'exa') {
    const result = await exaSearch(question);
    userContent = result.content; sources = result.sources;
  } else if (search === 'brave') {
    const result = await braveSearch(question);
    userContent = result.content; sources = result.sources;
  }

  const messages = [{ role: 'user', content: userContent }];

  // web-plugin path only applies to OpenRouter models — custom-openai endpoints
  // don't support the plugin tool and should use the standard call path below.
  if (search === 'web-plugin' && model.endpoint !== 'custom-openai') {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: orHeaders,
      body: JSON.stringify({ model: model.model_id, messages, stream: true, tools: [WEB_SEARCH_TOOL], tool_choice: 'auto' }),
    });
    if (!r.ok) {
      const t = await r.text();
      let msg = `API error ${r.status}`;
      try { msg = JSON.parse(t).error?.message || msg; } catch (_) {}
      return { error: msg };
    }
    for await (const chunk of r.body) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6);
        if (d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          const delta = p.choices?.[0]?.delta?.content;
          if (delta) answer += delta;
          if (p.usage) {
            tokensIn  = p.usage.prompt_tokens  || 0;
            tokensOut = p.usage.completion_tokens || 0;
            if (p.usage.cost != null) costUsd = p.usage.cost;
          }
        } catch (_) {}
      }
    }
  } else {
    let apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
    let headers = orHeaders;
    if (model.endpoint === 'custom-openai' && model.base_url) {
      const apiKey = model.api_key || (model.api_key_env ? process.env[model.api_key_env] : null);
      apiUrl = `${model.base_url.replace(/\/+$/, '')}/chat/completions`;
      headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    }
    const r = await fetch(apiUrl, {
      method: 'POST', headers, body: JSON.stringify({ model: model.model_id, messages, stream: false }),
    });
    const data = await r.json();
    if (!r.ok) return { error: data.error?.message || `API error ${r.status}` };

    answer = data.choices?.[0]?.message?.content || '';
    if (data.citations?.length) {
      sources = data.citations.map(u => ({ url: u, title: u }));
      answer += '\n\n---\n**Sources**\n' + data.citations.map((u, i) => `[${i + 1}] ${u}`).join('\n');
    }
    const usage = data.usage || {};
    tokensIn  = usage.prompt_tokens  || 0;
    tokensOut = usage.completion_tokens || 0;
    if (usage.cost != null) costUsd = usage.cost;
  }

  if (costUsd == null && model.cost_input != null && model.cost_output != null) {
    costUsd = (tokensIn / 1_000_000) * model.cost_input + (tokensOut / 1_000_000) * model.cost_output;
  }

  return {
    ok: true, answer,
    time_ms: Date.now() - start,
    tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
    word_count: answer.trim().split(/\s+/).filter(Boolean).length,
    search_used: search, sources,
    model_id: model.model_id, model_label: model.label || model.key,
  };
}

// ── Async job runner — all combos in parallel, no client connection needed ────
async function runJob(jobId, user, question, combos) {
  const hub = db.hub();
  const results = [];

  const persist = () => {
    try { hub.prepare('UPDATE test_jobs SET results = ? WHERE id = ?').run(JSON.stringify(results), jobId); } catch (_) {}
  };

  await Promise.allSettled(combos.map(async ({ modelKey, search }) => {
    const model = hub.prepare('SELECT * FROM model_config WHERE key = ?').get(modelKey);
    let entry;
    if (!model) {
      entry = { modelKey, search, error: `Unknown model: ${modelKey}` };
    } else if (model.search === 'native' && search === 'web-plugin') {
      entry = { modelKey, search, _skipped: true };
    } else {
      try {
        entry = { modelKey, search, ...(await runComboInternal(question, model, search)) };
      } catch (e) {
        const msg = (e.name === 'AbortError' || e.name === 'TimeoutError')
          ? 'Timed out (120s)' : e.message;
        entry = { modelKey, search, error: msg };
      }
    }
    results.push(entry);
    persist();
  }));

  hub.prepare('UPDATE test_jobs SET status = ?, completed_at = unixepoch(), results = ? WHERE id = ?')
    .run('done', JSON.stringify(results), jobId);

  // Prune old jobs — keep last 20 per user
  hub.prepare(`DELETE FROM test_jobs WHERE user = ? AND id NOT IN (
    SELECT id FROM test_jobs WHERE user = ? ORDER BY created_at DESC LIMIT 20
  )`).run(user, user);
}

// Submit a test job — returns job ID immediately, runs all combos in parallel on server
router.post('/admin/test/start', requireHubAdmin, (req, res) => {
  const { question, combos } = req.body;
  if (!question || !Array.isArray(combos) || !combos.length)
    return res.status(400).json({ error: 'Missing question or combos' });

  const jobId = require('crypto').randomBytes(8).toString('hex');
  db.hub().prepare('INSERT INTO test_jobs (id, user, question, combos) VALUES (?, ?, ?, ?)')
    .run(jobId, req.hubUser, question, JSON.stringify(combos));

  res.json({ ok: true, jobId });

  runJob(jobId, req.hubUser, question, combos).catch(e => {
    console.error(`[test-arena] job ${jobId} error:`, e.message);
    try { db.hub().prepare('UPDATE test_jobs SET status = ? WHERE id = ?').run('done', jobId); } catch (_) {}
  });
});

// Poll job status
router.get('/admin/test/jobs/:id', requireHubAdmin, (req, res) => {
  const job = db.hub().prepare(
    'SELECT id, status, results, combos, created_at, completed_at FROM test_jobs WHERE id = ? AND user = ?'
  ).get(req.params.id, req.hubUser);
  if (!job) return res.status(404).json({ error: 'Not found' });
  // Treat stale running jobs (>10min) as done
  const status = (job.status === 'running' && (Date.now() / 1000 - job.created_at) > 600)
    ? 'done' : job.status;
  res.json({
    id: job.id, status,
    results: JSON.parse(job.results || '[]'),
    total: JSON.parse(job.combos || '[]').length,
    created_at: job.created_at, completed_at: job.completed_at,
  });
});

// Single-combo endpoint (kept for backwards compat / direct use)
router.post('/admin/test/run', requireHubAdmin, async (req, res) => {
  const { question, modelKey, search } = req.body;
  if (!question || !modelKey) return res.json({ error: 'Missing question or model' });
  const hub = db.hub();
  const model = hub.prepare('SELECT * FROM model_config WHERE key = ?').get(modelKey);
  if (!model) return res.json({ error: `Unknown model: ${modelKey}` });
  try {
    res.json(await runComboInternal(question, model, search));
  } catch (e) {
    res.json({ error: e.message });
  }
});

// All-combos SSE endpoint — single persistent connection, immune to iOS killing sequential fetches
router.post('/admin/test/run-all', requireHubAdmin, async (req, res) => {
  const { question, combos } = req.body;
  if (!question || !Array.isArray(combos) || !combos.length) {
    return res.status(400).json({ error: 'Missing question or combos' });
  }
  const hub = db.hub();

  console.log(`[test-arena] run-all: ${combos.length} combos — ${combos.map(c => `${c.modelKey}+${c.search}`).join(', ')}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
  res.flushHeaders();

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const send = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {} };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);

  try {
    for (let i = 0; i < combos.length; i++) {
      if (cancelled) break;
      const { modelKey, search } = combos[i];
      send({ type: 'progress', index: i, total: combos.length });

      const model = hub.prepare('SELECT * FROM model_config WHERE key = ?').get(modelKey);
      if (!model) { send({ type: 'result', index: i, modelKey, search, error: `Unknown model: ${modelKey}` }); continue; }

      if (model.search === 'native' && search === 'web-plugin') {
        send({ type: 'result', index: i, modelKey, search, _skipped: true });
        continue;
      }

      try {
        const result = await runComboInternal(question, model, search);
        send({ type: 'result', index: i, modelKey, search, ...result });
      } catch (e) {
        send({ type: 'result', index: i, modelKey, search, error: e.message });
      }
    }
  } finally {
    clearInterval(ping);
    send({ type: 'done' });
    res.end();
  }
});

// ── OpenRouter model catalogue proxy ─────────────────────────────────────────
// Fetches the live OpenRouter model list server-side so the API key is never
// exposed to the browser. Returns a simplified array for the search picker.
router.get('/admin/openrouter-models', requireHubAdmin, async (req, res) => {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://mclellan.scot',
        'X-Title': 'McLellan Hub admin',
      },
    });
    if (!r.ok) return res.status(r.status).json({ error: `OpenRouter ${r.status}` });
    const data = await r.json();
    const models = (data.data || [])
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        context: m.context_length || null,
        inputPer1M:  m.pricing?.prompt      ? (parseFloat(m.pricing.prompt)      * 1_000_000).toFixed(4) : null,
        outputPer1M: m.pricing?.completion  ? (parseFloat(m.pricing.completion)  * 1_000_000).toFixed(4) : null,
        supportsTools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
        nativeSearch:  Array.isArray(m.supported_parameters) && m.supported_parameters.includes('web_search_options'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(models);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── Google Drive → project document ──────────────────────────────────────────
router.post('/admin/projects/:slug/from-drive', requireHubAdmin, async (req, res) => {
  const { downloadDriveFile } = require('../lib/google-drive');
  const { fileToMarkdown, withProjectFrontmatter } = require('../lib/extract');
  const { uuid } = require('../lib/id');

  const project = db.hub().prepare(
    'SELECT * FROM projects WHERE user = ? AND slug = ?'
  ).get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ ok: false, error: 'Project not found' });

  const { driveUrl } = req.body;
  if (!driveUrl) return res.status(400).json({ ok: false, error: 'No Drive URL provided' });

  try {
    const { buffer, filename } = await downloadDriveFile(req.hubUser, driveUrl);
    const { markdown } = await fileToMarkdown(filename, buffer);
    const finalMarkdown = withProjectFrontmatter({ project, filename, markdown });

    db.hub().prepare(
      `INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown)
       VALUES (?, ?, ?, ?, 'text/markdown', ?, ?)`
    ).run(uuid(), req.hubUser, project.id, filename, Buffer.byteLength(finalMarkdown), finalMarkdown);

    res.json({ ok: true, filename, chars: finalMarkdown.length });
  } catch (err) {
    console.error('[drive]', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Manual email fetch trigger ────────────────────────────────────────────────
router.post('/admin/trigger-email-fetch', requireHubAdmin, async (req, res) => {
  const { processNewEmails } = require('../lib/email-processor');
  // Reset last-check to 24h ago so manual trigger always catches recent mail
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(require('../lib/id').uuid(), req.hubUser, String(Math.floor(Date.now() / 1000) - 24 * 3600));
  try {
    const result = await processNewEmails(req.hubUser);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/admin/trigger-agentmail-fetch', requireHubAdmin, async (req, res) => {
  const { processAgentMail } = require('../lib/agentmail-processor');
  try {
    const result = await processAgentMail(req.hubUser);
    res.redirect(`/admin/email-taxonomy?agentmail=${encodeURIComponent(JSON.stringify(result))}`);
  } catch (err) {
    res.redirect(`/admin/email-taxonomy?agentmail_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Manual email digest send ──────────────────────────────────────────────────
router.post('/admin/trigger-email-digest', requireHubAdmin, async (req, res) => {
  const { sendEmailBriefing, buildEmailBriefingText } = require('../lib/crm');
  try {
    const preview = buildEmailBriefingText(req.hubUser);
    if (!preview) return res.json({ ok: true, message: 'No emails to digest yet.' });
    // Force-send by clearing the log entry first
    db.hub().prepare("DELETE FROM crm_briefing_log WHERE user = ? AND date_str = ?")
      .run(req.hubUser, `email-${new Date().toLocaleDateString('en-GB')}`);
    await sendEmailBriefing(req.hubUser);
    res.json({ ok: true, preview });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── LinkedIn content pipeline ─────────────────────────────────────────────────

const CONTENT_TYPES = [
  'AI & Technology', 'M365 & Microsoft', 'Healthcare IT',
  'Digital Transformation', 'EU Policy & Regulation',
  'Leadership & Management', 'Industry Analysis',
  'Product Review', 'Case Study', 'Career & Development',
];

router.get('/admin/linkedin', requireHubAdmin, (req, res) => {
  const posts = db.hub().prepare(
    `SELECT id, user, topic, content_type, score_json, carousel_url, image_url,
            sheet_url, scheduled_date, status, created_at,
            substr(draft, 1, 200) AS draft_preview,
            substr(refined_draft, 1, 200) AS refined_preview
     FROM linkedin_posts WHERE user = ? ORDER BY created_at DESC LIMIT 100`
  ).all(req.hubUser);

  const parsed = posts.map(p => ({
    ...p,
    score: (() => { try { return JSON.parse(p.score_json || '{}'); } catch { return {}; } })(),
  }));

  res.render('hub-admin/linkedin', { user: req.hubUser, posts: parsed, contentTypes: CONTENT_TYPES });
});

router.get('/admin/linkedin/:id', requireHubAdmin, (req, res) => {
  const post = db.hub().prepare(
    `SELECT * FROM linkedin_posts WHERE id = ? AND user = ?`
  ).get(req.params.id, req.hubUser);
  if (!post) return res.status(404).json({ error: 'Not found' });
  post.score = (() => { try { return JSON.parse(post.score_json || '{}'); } catch { return {}; } })();
  res.json({ ok: true, post });
});

router.post('/admin/linkedin/:id/type', requireHubAdmin, (req, res) => {
  const { content_type } = req.body;
  db.hub().prepare('UPDATE linkedin_posts SET content_type = ? WHERE id = ? AND user = ?')
    .run(content_type || '', req.params.id, req.hubUser);
  res.redirect('/admin/linkedin');
});

router.post('/admin/linkedin/:id/status', requireHubAdmin, (req, res) => {
  const { status } = req.body;
  const allowed = ['draft', 'scheduled', 'published', 'archived'];
  if (!allowed.includes(status)) return res.redirect('/admin/linkedin');
  db.hub().prepare('UPDATE linkedin_posts SET status = ? WHERE id = ? AND user = ?')
    .run(status, req.params.id, req.hubUser);
  res.redirect('/admin/linkedin');
});

router.post('/admin/linkedin/:id/schedule', requireHubAdmin, (req, res) => {
  const { scheduled_date } = req.body;
  db.hub().prepare('UPDATE linkedin_posts SET scheduled_date = ?, status = ? WHERE id = ? AND user = ?')
    .run(scheduled_date || '', scheduled_date ? 'scheduled' : 'draft', req.params.id, req.hubUser);
  res.redirect('/admin/linkedin');
});

router.post('/admin/linkedin/:id/delete', requireHubAdmin, (req, res) => {
  db.hub().prepare('DELETE FROM linkedin_posts WHERE id = ? AND user = ?')
    .run(req.params.id, req.hubUser);
  res.redirect('/admin/linkedin');
});

// ── RSS feed management ────────────────────────────────────────────────────────

router.get('/admin/rss-feeds', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const feeds = hub.prepare(`
    SELECT f.*, COUNT(a.id) AS article_count, MAX(a.published_at) AS latest_at
    FROM rss_feeds f LEFT JOIN rss_articles a ON a.feed_id = f.id
    WHERE f.user = ? GROUP BY f.id ORDER BY f.name
  `).all(req.hubUser);
  res.render('hub-admin/rss-feeds', { user: req.hubUser, feeds, msg: req.query.msg || null });
});

router.post('/admin/rss-feeds', requireHubAdmin, async (req, res) => {
  const { name, url, creator_slug } = req.body;
  if (!name || !url || !creator_slug) return res.redirect('/admin/rss-feeds');
  const slug = creator_slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const result = db.hub().prepare(`
    INSERT OR IGNORE INTO rss_feeds (id, user, name, creator_slug, url) VALUES (?, ?, ?, ?, ?)
  `).run(uuid(), req.hubUser, name.trim(), slug, url.trim());
  const msg = result.changes ? 'Feed added' : 'That feed URL is already subscribed';
  res.redirect('/admin/rss-feeds?msg=' + encodeURIComponent(msg));
});

router.post('/admin/rss-feeds/:id/toggle', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const feed = hub.prepare('SELECT enabled FROM rss_feeds WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (feed) hub.prepare('UPDATE rss_feeds SET enabled = ? WHERE id = ?').run(feed.enabled ? 0 : 1, req.params.id);
  res.redirect('/admin/rss-feeds');
});

router.post('/admin/rss-feeds/:id/fetch', requireHubAdmin, async (req, res) => {
  const feed = db.hub().prepare('SELECT * FROM rss_feeds WHERE id = ? AND user = ?').get(req.params.id, req.hubUser);
  if (!feed) return res.redirect('/admin/rss-feeds');
  try {
    const result = await ingestFeed(feed, req.hubUser);
    res.redirect('/admin/rss-feeds?msg=' + encodeURIComponent(`Fetched: ${result.ingested} new, ${result.skipped} skipped`));
  } catch (err) {
    res.redirect('/admin/rss-feeds?msg=' + encodeURIComponent('Error: ' + err.message));
  }
});

router.post('/admin/rss-feeds/:id/delete', requireHubAdmin, (req, res) => {
  db.hub().prepare('DELETE FROM rss_feeds WHERE id = ? AND user = ?').run(req.params.id, req.hubUser);
  res.redirect('/admin/rss-feeds');
});

router.post('/admin/rss-feeds/fetch-all', requireHubAdmin, async (req, res) => {
  try {
    const result = await ingestAllFeeds(req.hubUser);
    res.redirect('/admin/rss-feeds?msg=' + encodeURIComponent(`All feeds: ${result.ingested} new, ${result.skipped} skipped`));
  } catch (err) {
    res.redirect('/admin/rss-feeds?msg=' + encodeURIComponent('Error: ' + err.message));
  }
});

// ── Job queue admin ───────────────────────────────────────────────────────────

router.get('/admin/jobs', requireHubAdmin, (req, res) => {
  const hub = db.hub();
  const pending = hub.prepare(
    "SELECT * FROM system_jobs WHERE status IN ('pending','running') ORDER BY run_at ASC"
  ).all();
  const recent = hub.prepare(
    "SELECT * FROM system_jobs WHERE status IN ('done','failed') ORDER BY ran_at DESC LIMIT 40"
  ).all();
  res.render('hub-admin/jobs', { user: req.hubUser, pending, recent });
});

router.post('/admin/jobs/:id/cancel', requireHubAdmin, (req, res) => {
  db.hub().prepare(
    "UPDATE system_jobs SET status = 'failed', error = 'cancelled by admin', ran_at = ? WHERE id = ? AND status = 'pending'"
  ).run(Math.floor(Date.now() / 1000), req.params.id);
  res.redirect('/admin/jobs');
});

// ── Mycelium connectivity ─────────────────────────────────────────────────────

router.get('/admin/connectivity', requireHubAdmin, (req, res) => {
  const { buildConnectivityReport } = require('../lib/mycelium');
  const hub = db.hub();
  const items = buildConnectivityReport(req.hubUser, hub);
  res.render('hub-admin/connectivity', { user: req.hubUser, items });
});

router.post('/admin/mycelium/run', requireHubAdmin, async (req, res) => {
  const { runMycelium } = require('../lib/mycelium');
  try {
    const result = await runMycelium(req.hubUser);
    res.json({ ok: true, report: result.report, results: result.results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
