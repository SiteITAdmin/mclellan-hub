const express = require('express');
const router = express.Router();
const { ingestWorkdayInterview } = require('../lib/workday-ingest');
const {
  uploadLimiter, audioUpload,
  requireAuth, requireSameOrigin,
  requireWorkdayWebhookAuth, validWorkdayWebhookAuth,
} = require('./hub-shared');

// ── Workday interview ingest ──────────────────────────────────────────────────
// Accepts either:
// - multipart/form-data with text fields: transcript, title, source, model
// - multipart/form-data with audio file field: file
//
// The resulting note is saved as a project document under /workday and mirrored
// into the Synthadoc/Obsidian vault at raw_sources/workday/.
router.post('/api/workday/interview', requireAuth, requireSameOrigin, uploadLimiter, audioUpload.single('file'), async (req, res) => {
  try {
    const result = await ingestWorkdayInterview({
      user: req.hubUser,
      transcript: req.body.transcript,
      audioBuffer: req.file?.buffer,
      audioFilename: req.file?.originalname,
      audioMimetype: req.file?.mimetype,
      title: req.body.title,
      source: req.body.source || (req.file ? 'browser-audio' : 'manual'),
      projectSlug: req.body.projectSlug || 'workday',
      projectName: req.body.projectName || 'Workday Journal',
      model: req.body.model,
      synthadoc: req.body.synthadoc !== '0',
    });
    res.json(result);
  } catch (err) {
    console.error('[workday interview]', err);
    res.status(400).json({ error: err.message });
  }
});

// External capture endpoint for Siri Shortcuts or trusted agents.
// Secured by Authorization: Bearer <WORKDAY_WEBHOOK_SECRET> or WORKDAY_MOBILE_TOKEN.
router.post('/api/workday/webhook', requireWorkdayWebhookAuth, uploadLimiter, audioUpload.single('file'), async (req, res) => {
  const auth = validWorkdayWebhookAuth(req);
  if (!auth.configured) return res.status(503).json({ error: 'Workday webhook not configured' });
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });

  const hasAudio = !!(req.file || (Buffer.isBuffer(req.body) && req.body.length));
  const user = req.hubUser || req.body.user || 'douglas';
  const opts = {
    user,
    transcript: req.body.transcript || req.body.text,
    audioBuffer: req.file?.buffer || (Buffer.isBuffer(req.body) ? req.body : null),
    audioFilename: req.file?.originalname || req.headers['x-workday-filename'] || 'workday-audio.m4a',
    audioMimetype: req.file?.mimetype || req.headers['content-type'],
    title: req.body.title,
    source: req.body.source || (hasAudio ? 'shortcut-audio' : 'shortcut-transcript'),
    projectSlug: req.body.projectSlug || 'workday',
    projectName: req.body.projectName || 'Workday Journal',
    model: req.body.model,
    synthadoc: req.body.synthadoc !== '0',
  };

  // If audio is included, respond immediately and process in background
  if (hasAudio && !opts.transcript) {
    res.status(202).json({ ok: true, message: 'Audio received — processing in background' });
    ingestWorkdayInterview(opts)
      .then(result => {
        console.log(`[workday webhook] done for ${user}: ${result.document?.filename}`);
      })
      .catch(err => console.error('[workday webhook] background processing failed:', err.message));
    return;
  }

  // Transcript-only: fast enough to respond synchronously
  try {
    const result = await ingestWorkdayInterview(opts);
    res.json(result);
  } catch (err) {
    console.error('[workday webhook]', err);
    res.status(400).json({ error: err.message });
  }
});

router.post('/api/workday/audio', requireWorkdayWebhookAuth, uploadLimiter, express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
  const auth = validWorkdayWebhookAuth(req);
  if (!auth.configured) return res.status(503).json({ error: 'Workday audio endpoint not configured' });
  if (!auth.ok) return res.status(401).json({ error: 'Unauthorized' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Audio body required' });
  }

  // Respond immediately so the iOS Shortcut doesn't time out waiting for
  // transcription + narrative generation (which can take 60–180 s).
  res.status(202).json({ ok: true, message: 'Audio received — processing in background' });

  const user = req.hubUser || req.headers['x-workday-user'] || 'douglas';
  const audioBuffer = req.body;
  const opts = {
    user,
    audioBuffer,
    audioFilename: req.headers['x-workday-filename'] || 'workday-audio.m4a',
    audioMimetype: req.headers['content-type'] || 'audio/mp4',
    title: req.headers['x-workday-title'] || 'Drive home audio debrief',
    source: req.headers['x-workday-source'] || 'iphone-shortcut-audio',
    projectSlug: req.headers['x-workday-project'] || 'workday',
    projectName: 'Workday Journal',
    synthadoc: req.headers['x-workday-synthadoc'] !== '0',
  };

  ingestWorkdayInterview(opts)
    .then(result => {
      console.log(`[workday audio] done for ${user}: ${result.document?.filename} (${result.transcriptChars} chars)`);
    })
    .catch(err => console.error('[workday audio] background processing failed:', err.message));
});

module.exports = router;
