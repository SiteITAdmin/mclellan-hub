const express = require('express');
const router = express.Router();
const { listNotes, readNote, searchNotes, writeNote, vaultRoot } = require('../lib/obsidian-vault');
const {
  writeLimiter, requireAuth, requireSameOrigin, requireHermesAuth,
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

module.exports = router;
