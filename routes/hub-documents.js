const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { DEFAULT_MODELS } = require('../lib/router');
const { listProjects } = require('../lib/project-lifecycle');
const {
  writeLimiter, requireAuth, requireSameOrigin,
} = require('./hub-shared');

// ── Documents (user-facing) ───────────────────────────────────────────────────
router.get('/api/projects/:slug/documents', requireAuth, (req, res) => {
  const hub = db.hub();
  const project = hub.prepare('SELECT id, slug, name FROM projects WHERE user = ? AND slug = ?')
                     .get(req.hubUser, req.params.slug);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const docs = hub.prepare(
    'SELECT id, filename, size_bytes, uploaded_at FROM documents WHERE project_id = ? ORDER BY uploaded_at DESC'
  ).all(project.id);
  res.json({ project, documents: docs });
});

router.get('/api/documents/:id', requireAuth, (req, res) => {
  const doc = db.hub().prepare('SELECT * FROM documents WHERE id = ? AND user = ?')
                      .get(req.params.id, req.hubUser);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: doc.id, filename: doc.filename, size_bytes: doc.size_bytes,
    uploaded_at: doc.uploaded_at, markdown: doc.markdown,
    ingestion_package_path: doc.ingestion_package_path || null,
  });
});

// ── Send existing document to wiki ────────────────────────────────────────────
router.post('/api/documents/:id/to-wiki', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const hub = db.hub();
  const doc = hub.prepare('SELECT d.*, p.name AS project_name FROM documents d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ? AND d.user = ?')
                 .get(req.params.id, req.hubUser);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  try {
    const { documentToWiki, imageToWiki, writeWikiPage } = require('../lib/wiki-engine');
    const { IMAGE_EXTS } = require('../lib/extract');
    const path = require('path');
    const ext = path.extname(doc.filename || '').toLowerCase();

    let generated;
    if (IMAGE_EXTS.includes(ext)) {
      // Raw image bytes are saved to vault/Projects/{slug}/raw_sources/{filename} on upload.
      const fs = require('fs');
      const { vaultRoot } = require('../lib/obsidian-vault');
      const project = hub.prepare('SELECT slug FROM projects WHERE id = ?').get(doc.project_id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const safeName = doc.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const imagePath = path.join(vaultRoot(), 'Projects', project.slug, 'raw_sources', safeName);
      if (!fs.existsSync(imagePath)) {
        return res.status(404).json({ error: 'Image file not found on disk. Try re-uploading with the wiki toggle.' });
      }
      const buffer = fs.readFileSync(imagePath);
      generated = await imageToWiki({ filename: doc.filename, buffer, mimetype: doc.mimetype, projectName: doc.project_name });
    } else {
      generated = await documentToWiki({
        filename: doc.filename,
        markdown: (doc.markdown || '').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .+\n+/, ''), // strip frontmatter & h1
        projectName: doc.project_name,
      });
    }

    const { slug, title } = writeWikiPage(generated);
    res.json({ ok: true, slug, title, url: `https://wiki.mclellan.scot/page/${slug}` });
  } catch (err) {
    console.error('[to-wiki]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Request canonical document-task review (legacy direct path is gated) ────
router.post('/api/documents/:id/extract-tasks', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const hub = db.hub();
  const doc = hub.prepare(`
    SELECT d.*, p.name AS project_name, p.slug AS project_slug
    FROM documents d LEFT JOIN projects p ON p.id = d.project_id
    WHERE d.id = ? AND d.user = ?
  `).get(req.params.id, req.hubUser);
  if (!doc) return res.status(404).json({ error: 'Not found' });

  const markdown = (doc.markdown || '').replace(/^---[\s\S]*?---\n+/, '').replace(/^# .+\n+/, '');
  if (!markdown.trim()) return res.status(400).json({ error: 'Document has no content' });

  const { isGeneratedDocument } = require('../lib/document-tasks');
  if (isGeneratedDocument(doc)) {
    return res.status(400).json({ error: 'Generated project-memory documents are not task sources' });
  }

  // The canonical CRM knowledge engine owns source triage, exact-evidence
  // action outcomes, review, and any eventual Google Task projection.  This
  // endpoint only requests that versioned path in normal operation; it must
  // never call a shadow extractor or provider task API directly.
  const { legacyDirectCrmWritesEnabled } = require('../lib/crm-pipeline-mode');
  if (!legacyDirectCrmWritesEnabled()) {
    try {
      const { queueCrmKnowledgeEngine } = require('../lib/crm-knowledge-queue');
      const queued = queueCrmKnowledgeEngine({
        user: req.hubUser,
        sourceKind: 'document',
        sourceId: doc.id,
        requestedBy: 'document-extract-tasks',
      }, hub);
      const queueVerb = queued.existing ? 'reused' : 'queued';
      return res.status(202).json({
        ok: true,
        queued: true,
        existing: Boolean(queued.existing),
        jobId: queued.jobId,
        review: true,
        message: `Document task review ${queueVerb} for canonical CRM knowledge; no task was created directly.`,
      });
    } catch (err) {
      console.error('[extract-tasks] canonical CRM queue failed:', err.message);
      return res.status(500).json({ error: 'Unable to queue canonical CRM knowledge processing' });
    }
  }

  // Rollback-only compatibility path.  This retains the historical direct
  // extractor/provider writes solely when explicitly enabled by operations.
  const { extractionPrompt } = require('../lib/document-tasks');
  const { formatLearnedTaskRules } = require('../lib/task-learning');
  const fetch = require('../lib/fetch');
  const { logUsageFromResponse } = require('../lib/openrouter-usage');
  const { TASK_CODES, openRouterHeaders } = require('../lib/openrouter-attribution');
  const { createTask } = require('../lib/google-tasks');
  const { getSystemModelId } = require('../lib/settings');

  const modelId = getSystemModelId('task_extractor', 'system', 'google/gemini-2.5-pro-preview');
  const started = Date.now();

  const prompt = extractionPrompt(
    doc,
    markdown,
    formatLearnedTaskRules(req.hubUser, 'document'),
  );

  let extracted;
  try {
    const resp = await fetch('hub-model://v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders(TASK_CODES.DOCUMENT_TASKS),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });
    if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
    const data = await resp.json();
    logUsageFromResponse({
      user: req.hubUser, feature: 'doc-task-extractor', modelKey: 'task_extractor',
      fallbackModelId: modelId, data, durationMs: Date.now() - started,
      taskCode: TASK_CODES.DOCUMENT_TASKS,
    });
    extracted = JSON.parse(data.choices[0].message.content);
  } catch (err) {
    console.error('[extract-tasks] LLM error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const tasks = (extracted.tasks || []).filter(t => t?.title?.trim());
  if (!tasks.length) return res.json({ ok: true, created: 0, skipped: 0, message: 'No open tasks found in document' });

  let created = 0;
  let skipped = 0;
  for (const t of tasks) {
    const sourceRef = t.source_ref ? String(t.source_ref).slice(0, 60) : null;
    const sourceId = `doc:${doc.id}:${sourceRef || t.title.slice(0, 60)}`;
    const result = await createTask(req.hubUser, {
      title: t.title,
      notes: [t.notes, `Source: ${doc.filename}`].filter(Boolean).join(' · '),
      source: 'document',
      sourceId,
      projectSlug: doc.project_slug || null,
    }).catch(err => { console.warn('[extract-tasks] task create failed:', err.message); return null; });
    if (result === null) skipped++;
    else if (result) created++;
    else skipped++; // duplicate
  }

  console.log(`[extract-tasks] ${doc.filename}: ${created} created, ${skipped} skipped`);
  res.json({ ok: true, created, skipped, total: tasks.length });
});

router.post('/api/documents/:id/delete', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const doc = hub.prepare('SELECT * FROM documents WHERE id = ? AND user = ?')
                 .get(req.params.id, req.hubUser);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  hub.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  res.json({ ok: true });
});

// ── Save a single Q&A pair from a chat into a project ────────────────────────
router.post('/api/messages/:msgId/save-to-project', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const { projectSlug } = req.body;
  if (!projectSlug) return res.status(400).json({ error: 'projectSlug required' });

  const project = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?')
                     .get(req.hubUser, projectSlug);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const asstMsg = hub.prepare('SELECT * FROM messages WHERE id = ? AND user = ? AND role = ?')
                     .get(req.params.msgId, req.hubUser, 'assistant');
  if (!asstMsg) return res.status(404).json({ error: 'Message not found' });

  const userMsg = hub.prepare(`
    SELECT * FROM messages
     WHERE user = ? AND role = 'user'
       AND (conversation_id = ? OR project_id = ?)
       AND ts < ?
     ORDER BY ts DESC LIMIT 1
  `).get(req.hubUser, asstMsg.conversation_id, asstMsg.project_id, asstMsg.ts);

  const question = userMsg?.content || '(no question)';
  const answer   = asstMsg.content || '(no answer)';
  const title    = question.slice(0, 60).replace(/\n/g, ' ').replace(/[^\w\s-]/g, '') || 'Chat note';
  // This is a convenience copy of an assistant answer, not a new raw source.
  // Keep the structural marker with the document so canonical evidence, task
  // extraction, health, and replay can exclude it without hiding it from the
  // ordinary project-document UI.
  const markdown = [
    '---',
    'auto_generated: true',
    'generated_kind: "chat-answer"',
    `assistant_message_id: ${JSON.stringify(asstMsg.id)}`,
    `user_message_id: ${JSON.stringify(userMsg?.id || null)}`,
    `conversation_id: ${JSON.stringify(asstMsg.conversation_id || null)}`,
    '---',
    '',
    `# ${title}`,
    '',
    `**Q:** ${question}`,
    '',
    `**A:** ${answer}`,
  ].join('\n');
  const filename = `${title.slice(0, 50)} [chat].md`;

  const docId = require('crypto').randomUUID();
  hub.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, size_bytes, markdown)
    VALUES (?, ?, ?, ?, 'text/markdown', ?, ?)
  `).run(docId, req.hubUser, project.id, filename, Buffer.byteLength(markdown), markdown);

  res.json({ ok: true, projectSlug, filename });
});

// ── Save message to wiki ──────────────────────────────────────────────────────
router.post('/api/wiki/save', requireAuth, requireSameOrigin, writeLimiter, async (req, res) => {
  const hub    = db.hub();
  const msgId  = req.body.msgId;
  if (!msgId) return res.status(400).json({ error: 'msgId required' });

  const asstMsg = hub.prepare('SELECT * FROM messages WHERE id = ? AND user = ? AND role = ?')
                     .get(msgId, req.hubUser, 'assistant');
  if (!asstMsg) return res.status(404).json({ error: 'Message not found' });

  const userMsg = hub.prepare(`
    SELECT content FROM messages
     WHERE user = ? AND role = 'user'
       AND (conversation_id = ? OR project_id = ?)
       AND ts < ?
     ORDER BY ts DESC LIMIT 1
  `).get(req.hubUser, asstMsg.conversation_id, asstMsg.project_id, asstMsg.ts);

  try {
    const { saveToWiki } = require('../lib/wiki-engine');
    const result = await saveToWiki({
      question: userMsg?.content || '',
      answer:   asstMsg.content || '',
    });
    res.json({ ok: true, slug: result.slug, title: result.title });
  } catch (err) {
    console.error('[wiki-save]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Move conversation into a project ─────────────────────────────────────────
router.post('/api/conversations/:convId/move', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const hub = db.hub();
  const conv = hub.prepare('SELECT * FROM conversations WHERE id = ? AND user = ?')
                  .get(req.params.convId, req.hubUser);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });

  const { projectSlug } = req.body;
  const project = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?')
                     .get(req.hubUser, projectSlug);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  hub.prepare(
    'UPDATE messages SET project_id = ?, conversation_id = NULL WHERE conversation_id = ? AND user = ?'
  ).run(project.id, conv.id, req.hubUser);
  hub.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);

  res.json({ ok: true, projectSlug: project.slug });
});

// ── Projects API ──────────────────────────────────────────────────────────────
router.get('/api/projects', requireAuth, (req, res) => {
  const hub = db.hub();
  const projects = listProjects(hub, req.hubUser);
  res.json(projects);
});

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

router.post('/api/projects', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const { name, slug, contextDepth } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const finalSlug = slugify(slug || name);
  if (!finalSlug) return res.status(400).json({ error: 'invalid slug' });
  const hub = db.hub();
  try {
    const id = Buffer.from(require('crypto').randomBytes(8)).toString('hex');
    hub.prepare(
      'INSERT INTO projects (id, user, name, slug, context_depth, project_kind) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, req.hubUser, name.trim(), finalSlug, contextDepth || 20, 'workspace');
    res.json({ ok: true, project: { id, name: name.trim(), slug: finalSlug } });
  } catch (err) {
    res.status(400).json({ error: 'Slug already exists' });
  }
});

// ── Request logs (debugging) ──────────────────────────────────────────────────
router.get('/logs', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = db.hub().prepare(
    `SELECT * FROM request_logs ORDER BY ts DESC LIMIT ?`
  ).all(limit);
  res.render('hub/logs', { user: req.hubUser, logs, limit });
});

router.get('/api/logs', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = db.hub().prepare(
    `SELECT * FROM request_logs ORDER BY ts DESC LIMIT ?`
  ).all(limit);
  res.json(logs);
});

// ── Settings (model config) ───────────────────────────────────────────────────
router.get('/settings', requireAuth, (req, res) => {
  const hub = db.hub();
  const insert = hub.prepare(
    'INSERT OR IGNORE INTO model_config (key, label, endpoint, model_id, tier, search, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'
  );
  for (const [key, def] of Object.entries(DEFAULT_MODELS)) {
    insert.run(key, key, def.endpoint, def.id, def.tier, def.search);
  }
  const models = hub.prepare('SELECT * FROM model_config ORDER BY tier, key').all();
  res.render('hub/settings', { user: req.hubUser, models });
});

router.post('/settings/models/:key', requireAuth, requireSameOrigin, writeLimiter, (req, res) => {
  const { model_id, label, enabled } = req.body;
  db.hub().prepare(
    'UPDATE model_config SET model_id = ?, label = ?, enabled = ? WHERE key = ?'
  ).run(model_id, label, enabled ? 1 : 0, req.params.key);
  res.redirect('/settings');
});

module.exports = router;
