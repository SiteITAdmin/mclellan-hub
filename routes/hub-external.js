const express = require('express');
const router = express.Router();
const { listNotes, readNote, searchNotes, writeNote, vaultRoot } = require('../lib/obsidian-vault');
const {
  captureMessagingMessage,
  recentMessagingMessages,
  buildEvidenceText,
} = require('../lib/messaging-capture');
const {
  writeLimiter, messagingCaptureLimiter, requireAuth, requireSameOrigin, requireHermesAuth,
  requireContentResearchWorkerAuth, requireSubscriptionAgentWorkerAuth,
} = require('./hub-shared');

// ── YouTube / URL ingest ──────────────────────────────────────────────────────
async function synthadocIngestUrl(url) {
  const synthadocUrl = process.env.SYNTHADOC_URL;
  if (!synthadocUrl) throw new Error('SYNTHADOC_URL not configured');
  const res = await fetch(`${synthadocUrl}/jobs/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: url }),
  });
  if (!res.ok) throw new Error(`Synthadoc API returned ${res.status}`);
  return res.json();
}

router.post('/api/synthadoc/ingest-url', writeLimiter, async (req, res) => {
  const secret = process.env.HERMES_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const data = await synthadocIngestUrl(url);
    console.log(`[synthadoc] URL ingest enqueued: ${url} → job ${data.job_id}`);
    res.json({ ok: true, job_id: data.job_id });
  } catch (err) {
    console.error('[synthadoc ingest-url]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── URL ingest via session auth (browser dchat) ───────────────────────────────
router.post('/api/synthadoc/ingest-url/session', requireAuth, requireSameOrigin, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const data = await synthadocIngestUrl(url);
    console.log(`[synthadoc] URL ingest enqueued (session): ${url} → job ${data.job_id}`);
    res.json({ ok: true, job_id: data.job_id });
  } catch (err) {
    console.error('[synthadoc ingest-url/session]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Obsidian vault API for Hermes/trusted local agents ────────────────────────
router.get('/api/obsidian/notes', requireHermesAuth, (req, res) => {
  try {
    const notes = listNotes({ limit: parseInt(req.query.limit) || 50, offset: parseInt(req.query.offset) || 0 });
    res.json({ ok: true, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/obsidian/search', requireHermesAuth, async (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const results = await searchNotes({ query: q, limit: parseInt(limit) || 10 });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/obsidian/note', requireHermesAuth, (req, res) => {
  const { path: notePath } = req.query;
  if (!notePath) return res.status(400).json({ error: 'path required' });
  try {
    const note = readNote(notePath);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ ok: true, note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/obsidian/note', requireHermesAuth, writeLimiter, (req, res) => {
  const { path: notePath, content, mode } = req.body;
  if (!notePath || !content) return res.status(400).json({ error: 'path and content required' });
  try {
    writeNote({ notePath, content, mode: mode || 'create' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Messaging capture (WhatsApp via Hermes) ───────────────────────────────────
// Raw evidence only. Hermes posts allowlisted WhatsApp messages here; the CRM
// knowledge engine (source kind messaging_message) decides atoms/tasks.
// Auth: Authorization: Bearer <HERMES_WEBHOOK_SECRET>

router.post('/api/messaging/capture', requireHermesAuth, messagingCaptureLimiter, (req, res) => {
  try {
    const user = String(req.body?.user || req.hubUser || process.env.DCHAT_USER || 'douglas').trim();
    if (!user) return res.status(400).json({ error: 'user required' });

    const result = captureMessagingMessage(user, req.body || {});
    const evidence = result.row ? buildEvidenceText(result.row) : '';
    res.json({
      ok: true,
      id: result.id,
      created: result.created,
      duplicate: !!result.duplicate,
      platform: result.row?.platform || req.body?.platform || 'whatsapp',
      evidence_preview: evidence.slice(0, 240),
    });
  } catch (err) {
    console.error('[messaging capture]', err);
    const status = /required/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get('/api/messaging/recent', requireHermesAuth, (req, res) => {
  try {
    const user = String(req.query.user || process.env.DCHAT_USER || 'douglas').trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rows = recentMessagingMessages(user, { limit });
    res.json({ ok: true, count: rows.length, messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Content research Mac pull-worker ──────────────────────────────────────────
// VPS enqueues jobs when CONTENT_RESEARCH_DRIVER=mac. The always-on Mac mini
// polls these endpoints, runs Grok+last30days locally, and posts suggestions.
// Auth: Authorization: Bearer <CONTENT_RESEARCH_WORKER_SECRET>

router.post('/api/content-research/worker/heartbeat', requireContentResearchWorkerAuth, writeLimiter, (req, res) => {
  try {
    const { recordWorkerHeartbeat, jobStats, useMacWorkerDriver } = require('../lib/content-research-jobs');
    recordWorkerHeartbeat({
      workerId: req.body?.worker_id || 'mac',
      detail: req.body?.detail || null,
    });
    res.json({
      ok: true,
      driver: useMacWorkerDriver() ? 'mac' : (process.env.CONTENT_RESEARCH_DRIVER || ''),
      stats: jobStats(),
    });
  } catch (err) {
    console.error('[content-research worker heartbeat]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/content-research/worker/claim', requireContentResearchWorkerAuth, writeLimiter, (req, res) => {
  try {
    const { claimContentResearchJobs, recordWorkerHeartbeat } = require('../lib/content-research-jobs');
    recordWorkerHeartbeat({ workerId: req.body?.worker_id || 'mac' });
    const result = claimContentResearchJobs({
      workerId: req.body?.worker_id || 'mac',
      limit: req.body?.limit || 1,
    });
    res.json(result);
  } catch (err) {
    console.error('[content-research worker claim]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/content-research/worker/complete', requireContentResearchWorkerAuth, writeLimiter, (req, res) => {
  try {
    const { completeContentResearchJob } = require('../lib/content-research-jobs');
    const result = completeContentResearchJob({
      jobId: req.body?.job_id,
      claimToken: req.body?.claim_token,
      suggestions: req.body?.suggestions,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[content-research worker complete]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/content-research/worker/fail', requireContentResearchWorkerAuth, writeLimiter, (req, res) => {
  try {
    const { failContentResearchJob } = require('../lib/content-research-jobs');
    const result = failContentResearchJob({
      jobId: req.body?.job_id,
      claimToken: req.body?.claim_token,
      error: req.body?.error,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[content-research worker fail]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Subscription agent Mac pull-worker ───────────────────────────────────────
// The VPS only prepares source-backed packages. The Mini executes the selected
// prepaid CLI and returns a bounded result; this endpoint applies validation.
router.post('/api/subscription-agent/worker/claim', requireSubscriptionAgentWorkerAuth, writeLimiter, (req, res) => {
  try {
    const result = require('../lib/subscription-agent-jobs').claim({ workerId: req.body?.worker_id || 'mac', limit: req.body?.limit || 1 });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/subscription-agent/worker/complete', requireSubscriptionAgentWorkerAuth, writeLimiter, async (req, res) => {
  try {
    const result = await require('../lib/subscription-agent-jobs').complete({
      jobId: req.body?.job_id,
      claimToken: req.body?.claim_token,
      output: req.body?.output,
      meta: req.body?.meta || null,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/subscription-agent/worker/fail', requireSubscriptionAgentWorkerAuth, writeLimiter, (req, res) => {
  try {
    const result = require('../lib/subscription-agent-jobs').fail({ jobId: req.body?.job_id, claimToken: req.body?.claim_token, error: req.body?.error });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
