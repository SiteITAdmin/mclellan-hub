#!/usr/bin/env node
'use strict';

// Mac mini pull-worker for LinkedIn content research.
// Claims jobs from the VPS Hub, runs Grok+last30days locally, posts results.
//
// Env (Mac):
//   HUB_URL                         e.g. https://dchat.mclellan.scot
//   CONTENT_RESEARCH_WORKER_SECRET  shared with VPS .env
//   OPENROUTER_API_KEY              for Grok driver
//   LAST30DAYS_ENGINE_PATH          optional; defaults to ~/.claude/skills/last30days
//   LAST30DAYS_PYTHON               optional Python 3.12+ binary
//   CONTENT_RESEARCH_WORKER_ID      optional label (default: mac)
//   CONTENT_RESEARCH_WORKER_LIMIT   jobs per poll (default: 1)

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load local Hub .env when present (Mac checkout), without overriding real env.
const rootEnv = path.join(__dirname, '..', '.env');
if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv, override: false });
}

const HUB_URL = String(process.env.HUB_URL || process.env.CONTENT_RESEARCH_HUB_URL || '').replace(/\/$/, '');
const SECRET = String(process.env.CONTENT_RESEARCH_WORKER_SECRET || '').trim();
const WORKER_ID = String(process.env.CONTENT_RESEARCH_WORKER_ID || 'mac').slice(0, 80);
const LIMIT = Math.max(1, Math.min(5, Number(process.env.CONTENT_RESEARCH_WORKER_LIMIT) || 1));

function die(msg, code = 1) {
  console.error(`[content-research-worker] ${msg}`);
  process.exit(code);
}

if (!HUB_URL) die('HUB_URL (or CONTENT_RESEARCH_HUB_URL) is required');
if (!SECRET) die('CONTENT_RESEARCH_WORKER_SECRET is required');
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('[content-research-worker] OPENROUTER_API_KEY not set — Grok driver will fail');
}

// Force local Grok path for the driver regardless of VPS driver mode.
process.env.CONTENT_RESEARCH_DRIVER = 'grok';

const { driveLast30DaysResearch } = require('../lib/grok-research-driver');

async function api(method, pathname, body) {
  const url = `${HUB_URL}${pathname}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function processJob(job) {
  const started = Date.now();
  console.log(`[content-research-worker] running job ${job.id}: ${job.topic} (${job.tone}) ${job.plan_date}`);
  const saveDir = path.join(os.homedir(), 'Documents/Last30Days');
  try {
    fs.mkdirSync(saveDir, { recursive: true });
  } catch (_) { /* ignore */ }

  const driven = await driveLast30DaysResearch({
    user: job.user,
    topic: job.topic,
    tone: job.tone,
    planDate: job.plan_date,
    saveDir,
    limit: job.limit_n,
  });

  if (!driven.ok || !driven.suggestions?.length) {
    const error = driven.error || 'no suggestions produced';
    console.error(`[content-research-worker] job ${job.id} failed:`, error);
    await api('POST', '/api/content-research/worker/fail', {
      job_id: job.id,
      claim_token: job.claim_token,
      error,
    });
    return { ok: false, jobId: job.id, error };
  }

  const result = await api('POST', '/api/content-research/worker/complete', {
    job_id: job.id,
    claim_token: job.claim_token,
    suggestions: driven.suggestions,
  });
  console.log(
    `[content-research-worker] job ${job.id} completed: ${result.count} suggestion(s) in ${Date.now() - started}ms`
  );
  return { ok: true, jobId: job.id, count: result.count };
}

async function main() {
  console.log(`[content-research-worker] poll start worker=${WORKER_ID} hub=${HUB_URL}`);

  try {
    await api('POST', '/api/content-research/worker/heartbeat', {
      worker_id: WORKER_ID,
      detail: { host: os.hostname(), pid: process.pid },
    });
  } catch (err) {
    die(`heartbeat failed: ${err.message}`);
  }

  let claim;
  try {
    claim = await api('POST', '/api/content-research/worker/claim', {
      worker_id: WORKER_ID,
      limit: LIMIT,
    });
  } catch (err) {
    die(`claim failed: ${err.message}`);
  }

  const jobs = claim.jobs || [];
  if (!jobs.length) {
    console.log('[content-research-worker] no pending jobs');
    return;
  }

  const outcomes = [];
  for (const job of jobs) {
    try {
      outcomes.push(await processJob(job));
    } catch (err) {
      console.error(`[content-research-worker] job ${job.id} error:`, err.message);
      try {
        await api('POST', '/api/content-research/worker/fail', {
          job_id: job.id,
          claim_token: job.claim_token,
          error: err.message,
        });
      } catch (failErr) {
        console.error('[content-research-worker] fail report also failed:', failErr.message);
      }
      outcomes.push({ ok: false, jobId: job.id, error: err.message });
    }
  }

  const ok = outcomes.filter((o) => o.ok).length;
  console.log(`[content-research-worker] done: ${ok}/${outcomes.length} ok`);
  if (ok < outcomes.length) process.exitCode = 2;
}

main().catch((err) => {
  console.error('[content-research-worker] fatal:', err);
  process.exit(1);
});
