#!/usr/bin/env node
'use strict';

// Mac-mini pull-worker for subscription-backed synthesis. Receives only a
// prepared evidence package and returns model output; VPS applies the result.
// Continuous loop, one job at a time — no uncontrolled parallel corpus work.

const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');
// Resolve dotenv from the project tree so launchd Node does not miss node_modules.
try {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const dotenv = require(path.join(root, 'node_modules', 'dotenv'));
    dotenv.config({ path: envPath, override: false });
  }
} catch (err) {
  console.warn(`[subscription-agent-worker] dotenv load skipped: ${err.message}`);
}

const HUB_URL = String(process.env.HUB_URL || '').replace(/\/$/, '');
const SECRET = String(process.env.SUBSCRIPTION_AGENT_WORKER_SECRET || '').trim();
if (!HUB_URL || !SECRET) throw new Error('HUB_URL and SUBSCRIPTION_AGENT_WORKER_SECRET are required');

const { runSubscriptionText, availableRunners } = require('../lib/subscription-agent');
const { resolveFeatureRunner } = require('../lib/feature-runners');
const daft = require('../lib/crm/house/daft');
const houseListing = require('../lib/crm/house/listing');

// Default 30s idle poll — continuous 5s claims hit the Hub write rate limiter.
const IDLE_MS = Math.max(5000, Number(process.env.SUBSCRIPTION_AGENT_IDLE_MS) || 30000);
const ONCE = process.env.SUBSCRIPTION_AGENT_ONCE === '1';
const WORKER_ID = String(process.env.SUBSCRIPTION_AGENT_WORKER_ID || `${process.platform === 'darwin' ? 'mac' : 'linux'}:${os.hostname()}`).trim();
const MAX_PRIORITY = Number(process.env.SUBSCRIPTION_AGENT_MAX_PRIORITY) || null;
const MIN_PRIORITY = Number(process.env.SUBSCRIPTION_AGENT_MIN_PRIORITY) || null;

async function api(pathname, body) {
  const response = await fetch(`${HUB_URL}${pathname}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const err = new Error(data.error || `HTTP ${response.status}`);
    err.status = response.status;
    if (retryAfter) err.retryAfterSec = Math.max(1, Number(retryAfter) || 0);
    throw err;
  }
  return data;
}

const LANE_RUNNERS = new Set(['claude', 'codex', 'grok', 'antigravity']);

async function processJob(job) {
  const p = job.payload || {};
  const featureConfig = resolveFeatureRunner(job.feature);
  const config = {
    feature: job.feature,
    runner: p.runner || featureConfig.runner,
    model: p.model || featureConfig.model,
    effort: p.effort || featureConfig.effort,
    timeoutMs: featureConfig.timeoutMs,
    maxInputChars: p.maxInputChars || featureConfig.maxInputChars,
    maxOutputChars: featureConfig.maxOutputChars,
    allowTools: featureConfig.allowTools,
    jsonMode: featureConfig.jsonMode,
    tier: featureConfig.tier,
    fallbackTo: featureConfig.fallbackTo || null,
    lanes: Array.isArray(p.lanes) ? p.lanes.filter(l => l && LANE_RUNNERS.has(l.runner) && typeof l.model === 'string') : null,
  };

  if (p.task === 'daft_sold') {
    const res = await daft.fetchSoldArea(p.county, p.locality, {
      extraLocality: p.extraLocality || '',
      pages: Number(p.pages) || 2,
    });
    await api('/api/subscription-agent/worker/complete', {
      job_id: job.id,
      claim_token: job.claim_token,
      output: JSON.stringify(res),
      meta: { runner: 'daft-worker', model: 'http', rows: res.rows?.length || 0 },
    });
    console.log(`[subscription-agent-worker] completed ${job.feature} ${job.id} (${res.rows?.length || 0} Daft sold rows)`);
    return;
  }

  if (p.task === 'daft_inspect') {
    const res = await houseListing.runDaftInspectTask(p, {
      runModel: ({ systemPrompt, userPrompt, documents }) => runSubscriptionText({
        feature: 'crm_house_photos',
        systemPrompt,
        userPrompt,
        documents,
        timeoutMs: config.timeoutMs || 300000,
        force: true,
        config,
      }),
    });
    await api('/api/subscription-agent/worker/complete', {
      job_id: job.id,
      claim_token: job.claim_token,
      output: JSON.stringify(res.output),
      meta: res.meta,
    });
    console.log(`[subscription-agent-worker] completed ${job.feature} ${job.id} (daft_inspect via ${res.meta?.runner}/${res.meta?.model})`);
    return;
  }

  if (config.runner === 'local') {
    throw new Error(`Feature ${job.feature} is a local specialist and cannot run on the CLI worker`);
  }

  const local = await runSubscriptionText({
    feature: job.feature,
    systemPrompt: p.systemPrompt || p.prompt || '',
    userPrompt: p.userPrompt || p.input || '',
    documents: ['crm_money_read', 'crm_house_photos'].includes(job.feature) ? p.documents : null,
    timeoutMs: config.timeoutMs || 300000,
    force: true,
    config,
  });
  if (!local) throw new Error(`no local runner configured for ${job.feature}`);

  await api('/api/subscription-agent/worker/complete', {
    job_id: job.id,
    claim_token: job.claim_token,
    output: local.text,
    meta: {
      runner: local.runner,
      model: local.model,
      effort: local.effort,
      tier: local.tier,
      durationMs: local.durationMs,
      ...(local.fallbackFrom ? { fallbackFrom: local.fallbackFrom, fallbackChain: local.fallbackChain } : {}),
    },
  });
  console.log(`[subscription-agent-worker] completed ${job.feature} ${job.id} (${local.runner}/${local.model}/${local.effort})`);
}

async function tick() {
  const claimed = await api('/api/subscription-agent/worker/claim', {
    worker_id: WORKER_ID,
    limit: 1,
    ...(MAX_PRIORITY ? { max_priority: MAX_PRIORITY } : {}),
    ...(MIN_PRIORITY ? { min_priority: MIN_PRIORITY } : {}),
    available: availableRunners(),
    capabilities: ['daft'],
  });
  const jobs = claimed.jobs || [];
  if (!jobs.length) return false;
  for (const job of jobs) {
    try {
      await processJob(job);
    } catch (err) {
      console.error(`[subscription-agent-worker] ${job.id}: ${err.message}`);
      await api('/api/subscription-agent/worker/fail', {
        job_id: job.id,
        claim_token: job.claim_token,
        error: err.message,
      }).catch(() => {});
    }
  }
  return true;
}

async function main() {
  const scope = MAX_PRIORITY ? ` (priority <= ${MAX_PRIORITY})` : '';
  console.log(`[subscription-agent-worker] starting ${WORKER_ID}${scope} against ${HUB_URL}`);
  let backoffMs = IDLE_MS;
  for (;;) {
    let worked = false;
    try {
      worked = await tick();
      backoffMs = IDLE_MS;
    } catch (err) {
      console.error(`[subscription-agent-worker] tick error: ${err.message}`);
      // Back off hard on rate limits / upstream blips so we do not stampede the VPS.
      if (err.retryAfterSec > 0) {
        backoffMs = Math.min(Math.max(err.retryAfterSec * 1000, IDLE_MS), 5 * 60 * 1000);
      } else if (/too many requests|429|502|503|fetch failed/i.test(err.message) || err.status === 429) {
        backoffMs = Math.min(backoffMs * 2, 5 * 60 * 1000);
      }
    }
    if (ONCE) break;
    // After real work, brief pause then claim again — not sub-second hammering.
    await new Promise(r => setTimeout(r, worked ? 3000 : backoffMs));
  }
}

main().catch(err => {
  console.error(`[subscription-agent-worker] ${err.message}`);
  process.exitCode = 1;
});
