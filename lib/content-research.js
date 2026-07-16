'use strict';

const path = require('path');
const os = require('os');
const { driveLast30DaysResearch } = require('./grok-research-driver');
const { getContentCadencePolicy } = require('./content-cadence-policy');
const {
  dublinDate,
  normalizeTone,
  buildResearchQuery,
  suggestionsFromSearch,
  replaceSuggestions,
  researchViaWebSearch,
} = require('./content-research-core');
const {
  useMacWorkerDriver,
  enqueueContentResearchJob,
  recoverStaleClaims,
  fallbackStaleRemoteJobs,
} = require('./content-research-jobs');

function useGrokDriver() {
  return process.env.CONTENT_RESEARCH_DRIVER === 'grok' && !!process.env.OPENROUTER_API_KEY;
}

async function researchPlannedTopic(user, { date = dublinDate(), topic, tone = 'professional', limit = 3 } = {}) {
  const planDate = String(date || dublinDate()).slice(0, 10);
  const cleanTopic = String(topic || '').trim().slice(0, 80);
  const normalizedTone = normalizeTone(tone);
  if (!cleanTopic) return { ok: false, skipped: true, reason: 'no topic selected', count: 0 };

  // VPS path: enqueue for the Mac pull-worker (Grok+last30days lives on the mini).
  if (useMacWorkerDriver()) {
    const queued = enqueueContentResearchJob(user, {
      planDate,
      topic: cleanTopic,
      tone: normalizedTone,
      limit,
    });
    if (!queued.ok) return { ok: false, error: queued.error, count: 0, driver: 'mac' };
    return {
      ok: true,
      queued: true,
      jobId: queued.jobId,
      existing: !!queued.existing,
      status: queued.status,
      count: 0,
      driver: 'mac',
    };
  }

  if (useGrokDriver()) {
    const saveDir = path.join(os.homedir(), 'Documents/Last30Days');
    const driven = await driveLast30DaysResearch({
      user,
      topic: cleanTopic,
      tone: normalizedTone,
      planDate,
      saveDir,
      limit,
    });
    if (!driven.ok) {
      console.error('[content-research] grok driver failed, falling back to web search:', driven.error);
    } else {
      const count = replaceSuggestions(user, {
        planDate,
        topic: cleanTopic,
        tone: normalizedTone,
        suggestions: driven.suggestions,
      });
      return { ok: true, count, driver: 'grok', turns: driven.turns };
    }
  }

  return researchViaWebSearch(user, {
    planDate,
    topic: cleanTopic,
    tone: normalizedTone,
    limit,
  });
}

async function runDueContentResearch(user, { date = dublinDate() } = {}) {
  // Always recover stuck claims / fall back stale remote jobs when the daily
  // job runs, even if today's topic is missing — keeps the queue healthy.
  if (useMacWorkerDriver()) {
    try {
      recoverStaleClaims();
      const fb = await fallbackStaleRemoteJobs();
      if (fb.processed) {
        console.log('[content-research] stale remote fallback:', fb);
      }
    } catch (err) {
      console.error('[content-research] remote queue maintenance failed:', err.message);
    }
  }

  const policy = getContentCadencePolicy(user);
  if (!policy.topicPlan.researchEnabled) return { ok: true, skipped: true, reason: 'disabled', count: 0 };
  const pref = policy.topicPlan.dayPrefs[date];
  if (!pref?.topic) return { ok: true, skipped: true, reason: 'no planned topic', count: 0 };
  return researchPlannedTopic(user, {
    date,
    topic: pref.topic,
    tone: pref.tone,
    limit: policy.topicPlan.suggestionsPerDay,
  });
}

module.exports = {
  buildResearchQuery,
  dublinDate,
  researchPlannedTopic,
  replaceSuggestions,
  runDueContentResearch,
  suggestionsFromSearch,
  useGrokDriver,
  useMacWorkerDriver,
  researchViaWebSearch,
};
