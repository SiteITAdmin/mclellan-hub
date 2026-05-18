'use strict';

const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { requireSameOrigin } = require('../lib/security');
const { fetchTodayCalendarEvents } = require('../lib/crm');
const {
  transcribeAudio, textToSpeech, generateQuestion,
  openingPrompt, processAndSave, isEndPhrase,
} = require('../lib/debrief-engine');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function requireAuth(req, res, next) {
  if (req.session?.user || req.userId) {
    req.userId = req.userId || req.session.user;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ── UI ────────────────────────────────────────────────────────────────────────
router.get('/debrief', requireAuth, async (req, res) => {
  let calendarEvents = [];
  try { calendarEvents = await fetchTodayCalendarEvents(req.userId); } catch {}
  res.render('debrief/index', { user: req.userId, calendarEvents });
});

// ── Transcribe audio ──────────────────────────────────────────────────────────
router.post('/api/debrief/transcribe', requireAuth, requireSameOrigin, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio uploaded' });
  try {
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    res.json({ text, done: isEndPhrase(text) });
  } catch (err) {
    console.error('[debrief] STT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate next question (+ TTS audio) ──────────────────────────────────────
router.post('/api/debrief/question', requireAuth, requireSameOrigin, express.json(), async (req, res) => {
  const history        = req.body.history || [];
  const calendarEvents = req.body.calendarEvents || [];
  const userName       = req.userId.charAt(0).toUpperCase() + req.userId.slice(1);
  const msgs = history.length === 0
    ? [{ role: 'user', content: openingPrompt(userName, calendarEvents) }]
    : history;
  try {
    const text     = await generateQuestion(msgs);
    const audioBuf = await textToSpeech(text);
    console.log('[debrief] question ok:', text.slice(0, 80));
    res.json({ text, audio: audioBuf.toString('base64') });
  } catch (err) {
    console.error('[debrief] question error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Save session ──────────────────────────────────────────────────────────────
router.post('/api/debrief/save', requireAuth, requireSameOrigin, express.json(), async (req, res) => {
  const { mode, transcript = '', exchanges = [] } = req.body;
  if (!mode) return res.status(400).json({ error: 'mode required' });
  try {
    const result = await processAndSave({ mode, transcript, exchanges });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[debrief] save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
