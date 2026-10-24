'use strict';

// Pull endpoints for the Mac mini subscription worker, which runs the
// Claude/Codex CLIs for the public sites' chat and JD analyser.

const express = require('express');
const jobs = require('../lib/subscription-agent-jobs');
const { createRateLimiter } = require('../lib/security');

const router = express.Router();

// The worker polls on a tight loop; auth is the real gate, this is a ceiling.
const workerLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 2000, keyPrefix: 'mac-worker' });

function requireWorkerAuth(req, res, next) {
  const secret = process.env.SUBSCRIPTION_AGENT_WORKER_SECRET;
  if (!secret) return res.status(503).json({ error: 'Subscription agent worker auth not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

router.post('/api/subscription-agent/worker/claim', requireWorkerAuth, workerLimiter, (req, res) => {
  try {
    res.json(jobs.claim({ workerId: req.body?.worker_id || 'mac', limit: req.body?.limit || 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/subscription-agent/worker/complete', requireWorkerAuth, workerLimiter, async (req, res) => {
  try {
    const result = await jobs.complete({
      jobId: req.body?.job_id,
      claimToken: req.body?.claim_token,
      output: req.body?.output,
      meta: req.body?.meta || null,
    });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/api/subscription-agent/worker/fail', requireWorkerAuth, workerLimiter, (req, res) => {
  try {
    const result = jobs.fail({ jobId: req.body?.job_id, claimToken: req.body?.claim_token, error: req.body?.error });
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
