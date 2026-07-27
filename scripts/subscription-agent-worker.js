#!/usr/bin/env node
'use strict';

// Mac-mini pull-worker for prepaid Claude/Codex synthesis. It receives only a
// prepared evidence package and returns model output; VPS applies the result.

const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) require('dotenv').config({ path: path.join(root, '.env'), override: false });

const HUB_URL = String(process.env.HUB_URL || '').replace(/\/$/, '');
const SECRET = String(process.env.SUBSCRIPTION_AGENT_WORKER_SECRET || '').trim();
if (!HUB_URL || !SECRET) throw new Error('HUB_URL and SUBSCRIPTION_AGENT_WORKER_SECRET are required');

const { runSubscriptionText } = require('../lib/subscription-agent');

async function api(pathname, body) {
  const response = await fetch(`${HUB_URL}${pathname}`, {
    method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function processJob(job) {
  const p = job.payload || {};
  const local = await runSubscriptionText({ feature: job.feature, systemPrompt: p.systemPrompt || p.prompt, userPrompt: p.userPrompt, timeoutMs: 300000 });
  if (!local) throw new Error(`no local runner configured for ${job.feature}`);
  await api('/api/subscription-agent/worker/complete', { job_id: job.id, claim_token: job.claim_token, output: local.text });
  console.log(`[subscription-agent-worker] completed ${job.feature} ${job.id} (${local.runner}/${local.model}/${local.effort})`);
}

async function main() {
  const claimed = await api('/api/subscription-agent/worker/claim', { worker_id: `mac:${os.hostname()}`, limit: 1 });
  for (const job of claimed.jobs || []) {
    try { await processJob(job); }
    catch (err) {
      console.error(`[subscription-agent-worker] ${job.id}: ${err.message}`);
      await api('/api/subscription-agent/worker/fail', { job_id: job.id, claim_token: job.claim_token, error: err.message }).catch(() => {});
    }
  }
}

main().catch(err => { console.error(`[subscription-agent-worker] ${err.message}`); process.exitCode = 1; });
