'use strict';

const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { finishGoogleAuth, startGoogleAuth } = require('../lib/google-auth');
const { requireSameOrigin } = require('../lib/security');
const {
  PURPOSES,
  MODEL_TIERS,
  MODEL_FAMILIES,
  AUDIT_STAGES,
  HARNESS_LABELS,
  classifyPrompt,
  savePrompt,
  updatePrompt,
  reclassifyPrompt,
  listPrompts,
  getPrompt,
  newsletterPromptCandidates,
  importNewsletterPrompt,
  adaptPrompt,
  senseCheckPrompt,
  recentAdaptations,
  optimizePrompt,
  recentOptimizations,
  getOptimization,
  normalizePurpose,
  buildAuditAgentPack,
  saveAuditAgentPack,
  listAgentPacks,
  getAgentPack,
  importPromptKitUrl,
} = require('../lib/prompt-library');

const VALID_USERS = new Set(['douglas', 'nakai']);

function promptUserFromSession(req) {
  const user = req.session?.promptUser;
  return VALID_USERS.has(user) ? user : null;
}

function requirePromptAuth(req, res, next) {
  // Native iOS Prompts app: bearer token via mobileBearerBridge (server.js),
  // which already set req.hubUser to douglas.
  if (req.mobileAuth) return next();
  const user = promptUserFromSession(req);
  if (!user) return res.redirect('/login');
  req.hubUser = user;
  return next();
}

router.use((req, res, next) => {
  const user = promptUserFromSession(req);
  if (user) req.hubUser = user;
  next();
});

router.get('/login', (req, res) => {
  res.render('prompt/login', { error: null });
});

router.get('/auth/google', (req, res, next) => {
  const user = String(req.query.user || '').trim().toLowerCase();
  if (!VALID_USERS.has(user)) {
    return res.status(400).render('prompt/login', { error: 'Choose Douglas or Nakai before signing in.' });
  }
  req.hubUser = user;
  return startGoogleAuth({
    purpose: 'prompt',
    user,
    callbackPath: '/auth/google/callback',
    returnTo: '/',
    extraScopes: [],
  })(req, res, next);
});

router.get('/auth/google/callback', (req, res, next) => {
  const savedUser = req.session?.googleOAuth?.user;
  if (!VALID_USERS.has(savedUser)) return res.status(400).send('Invalid sign-in state');
  req.hubUser = savedUser;
  return finishGoogleAuth({
    purpose: 'prompt',
    user: savedUser,
    callbackPath: '/auth/google/callback',
    sessionKey: 'promptUser',
    returnTo: '/',
  })(req, res, next);
});

router.post('/logout', requireSameOrigin, (req, res) => {
  req.session.promptUser = null;
  res.redirect('/login');
});

router.use((req, res, next) => {
  if (req.method === 'POST') return requireSameOrigin(req, res, next);
  return next();
});

// ── Mobile app JSON APIs ─────────────────────────────────────────────────────
// Read endpoints for the native iOS Prompts app (bearer auth).
router.get('/api/mobile/prompts', requirePromptAuth, (req, res) => {
  const prompts = listPrompts(req.hubUser, {
    purpose: req.query.purpose || 'all',
    q: req.query.q || '',
  });
  res.json({ prompts, purposes: PURPOSES });
});

router.get('/api/mobile/prompts/:id', requirePromptAuth, (req, res) => {
  const prompt = getPrompt(req.hubUser, req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Not found' });
  res.json({ prompt });
});

// Library — browse and pick saved prompt examples
router.get('/', requirePromptAuth, (req, res) => {
  const user = req.hubUser;
  const purpose = req.query.purpose || 'all';
  const q = req.query.q || '';
  const prompts = listPrompts(user, { purpose, q });
  const counts = db.hub().prepare(`
    SELECT purpose, COUNT(*) AS n
      FROM prompt_library
     WHERE user = ?
     GROUP BY purpose
     ORDER BY n DESC
  `).all(user);
  const totalPromptCount = db.hub().prepare('SELECT COUNT(*) AS n FROM prompt_library WHERE user = ?').get(user)?.n || 0;
  res.render('prompt/index', {
    user,
    purpose,
    q,
    prompts,
    counts,
    totalPromptCount,
    purposes: PURPOSES,
  });
});

// Builder — prompt adapter + audit agent builder
router.get('/builder', requirePromptAuth, (req, res) => {
  const user = req.hubUser;
  res.render('prompt/builder', {
    user,
    adaptations: recentAdaptations(user, 8),
    agentPacks: listAgentPacks(user, 8),
    purposes: PURPOSES,
    modelFamilies: MODEL_FAMILIES,
    auditStages: AUDIT_STAGES,
    harnessLabels: HARNESS_LABELS,
  });
});

// Gym — prompt optimiser + run history
router.get('/gym', requirePromptAuth, (req, res) => {
  const user = req.hubUser;
  res.render('prompt/gym', {
    user,
    optimizations: recentOptimizations(user, 6),
    purposes: PURPOSES,
    modelFamilies: MODEL_FAMILIES,
  });
});

// Inbox — manual add, kit import, newsletter candidates
router.get('/inbox', requirePromptAuth, (req, res) => {
  const user = req.hubUser;
  res.render('prompt/inbox', {
    user,
    candidates: newsletterPromptCandidates(user),
    purposes: PURPOSES,
  });
});

router.post('/optimize', requirePromptAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.source_prompt_ids)
      ? req.body.source_prompt_ids
      : req.body.source_prompt_ids
        ? [req.body.source_prompt_ids]
        : [];
    const result = await optimizePrompt(req.hubUser, {
      taskDescription: req.body.task_description,
      currentPrompt: req.body.current_prompt,
      purpose: normalizePurpose(req.body.purpose),
      examplesText: req.body.examples_text,
      sourcePromptIds: ids,
      targetModelFamily: req.body.target_model_family,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/optimizations/:id/save', requirePromptAuth, (req, res) => {
  const row = getOptimization(req.hubUser, req.params.id);
  if (!row) return res.status(404).json({ ok: false, error: 'Optimization not found' });
  try {
    const version = row.logbook?.version_label ? ` (${row.logbook.version_label})` : '';
    const title = String(req.body.title || '').trim() || `Optimized prompt${version}`;
    const saved = savePrompt(req.hubUser, {
      title,
      description: `Optimized recurring prompt: ${String(row.task_description).slice(0, 180)}`,
      raw_prompt: row.final_prompt,
      purpose: row.purpose,
      source_type: 'optimization',
      source_ref: row.id,
      source_title: row.source_prompt_id || null,
      target_model_family: row.target_model_family || null,
      tags: ['optimized', row.logbook?.dspy_candidate ? 'dspy-candidate' : 'prompt-gym'].filter(Boolean).join(', '),
    });
    res.json({ ok: true, id: saved.id });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/prompts/:id', requirePromptAuth, (req, res) => {
  const prompt = getPrompt(req.hubUser, req.params.id);
  if (!prompt) return res.status(404).send('Not found');
  res.render('prompt/detail', {
    user: req.hubUser,
    prompt,
    purposes: PURPOSES,
    modelTiers: MODEL_TIERS,
  });
});

router.post('/prompts', requirePromptAuth, (req, res) => {
  try {
    savePrompt(req.hubUser, {
      title: req.body.title,
      description: req.body.description,
      raw_prompt: req.body.raw_prompt,
      purpose: req.body.purpose,
      tags: req.body.tags,
      source_type: 'manual',
    });
    res.redirect('/?saved=1');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.post('/prompts/:id/update', requirePromptAuth, (req, res) => {
  try {
    updatePrompt(req.hubUser, req.params.id, req.body || {});
    res.redirect(`/prompts/${encodeURIComponent(req.params.id)}?updated=1`);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.post('/prompts/:id/reclassify', requirePromptAuth, (req, res) => {
  try {
    reclassifyPrompt(req.hubUser, req.params.id, req.body.purpose || '');
    res.redirect(`/prompts/${encodeURIComponent(req.params.id)}?reclassified=1`);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.post('/newsletter/import/:id', requirePromptAuth, (req, res) => {
  try {
    importNewsletterPrompt(req.hubUser, req.params.id);
    res.redirect('/?imported=1');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.post('/newsletter/import-all', requirePromptAuth, (req, res) => {
  const candidates = newsletterPromptCandidates(req.hubUser).filter(c => !c.saved_id);
  let imported = 0;
  for (const c of candidates) {
    try {
      importNewsletterPrompt(req.hubUser, c.id);
      imported++;
    } catch (_) {}
  }
  res.redirect(`/?imported=${imported}`);
});

router.post('/import-url', requirePromptAuth, async (req, res) => {
  try {
    const result = await importPromptKitUrl(req.hubUser, req.body.url, { purpose: req.body.purpose });
    res.json({
      ok: true,
      duplicate: !!result.duplicate,
      imported: result.imported,
      existing: result.count || 0,
      title: result.kit.title,
      prompts: result.saved.map(p => ({ id: p.id, title: p.title })),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/adapt', requirePromptAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.source_prompt_ids)
      ? req.body.source_prompt_ids
      : req.body.source_prompt_ids
        ? [req.body.source_prompt_ids]
        : [];
    const result = await adaptPrompt(req.hubUser, {
      roughPrompt: req.body.rough_prompt,
      purpose: normalizePurpose(req.body.purpose),
      mode: req.body.mode || 'quick',
      sourcePromptIds: ids,
      targetModelFamily: req.body.target_model_family,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/adapt/check', requirePromptAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body.source_prompt_ids)
      ? req.body.source_prompt_ids
      : req.body.source_prompt_ids
        ? [req.body.source_prompt_ids]
        : [];
    const result = senseCheckPrompt(req.hubUser, {
      roughPrompt: req.body.rough_prompt,
      purpose: normalizePurpose(req.body.purpose),
      mode: req.body.mode || 'quick',
      sourcePromptIds: ids,
      targetModelFamily: req.body.target_model_family,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/adaptations/:id/save', requirePromptAuth, (req, res) => {
  const row = db.hub().prepare('SELECT * FROM prompt_adaptations WHERE id = ? AND user = ?')
    .get(req.params.id, req.hubUser);
  if (!row) return res.status(404).json({ ok: false, error: 'Adaptation not found' });
  try {
    const title = String(req.body.title || '').trim() || `Adapted prompt — ${new Date(row.created_at * 1000).toLocaleDateString('en-GB')}`;
    const saved = savePrompt(req.hubUser, {
      title,
      description: `Adapted from rough prompt: ${String(row.raw_request).slice(0, 180)}`,
      raw_prompt: row.adapted_prompt,
      purpose: row.purpose,
      source_type: 'adaptation',
      source_ref: row.id,
      source_title: row.source_prompt_id || null,
      target_model_family: row.target_model_family || null,
    });
    res.json({ ok: true, id: saved.id });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/classify', requirePromptAuth, (req, res) => {
  res.json({ ok: true, classification: classifyPrompt({
    title: req.body.title,
    rawPrompt: req.body.raw_prompt,
    purpose: req.body.purpose,
  }) });
});

router.get('/agent-packs/:id', requirePromptAuth, (req, res) => {
  const pack = getAgentPack(req.hubUser, req.params.id);
  if (!pack) return res.status(404).send('Not found');
  res.render('prompt/agent-pack', {
    user: req.hubUser,
    pack,
    input: JSON.parse(pack.input_json || '{}'),
  });
});

router.post('/agent-builder/preview', requirePromptAuth, (req, res) => {
  try {
    const pack = buildAuditAgentPack(req.hubUser, req.body || {});
    res.json({ ok: true, ...pack });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/agent-builder/save', requirePromptAuth, (req, res) => {
  try {
    const pack = saveAuditAgentPack(req.hubUser, req.body || {});
    res.json({ ok: true, ...pack });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
