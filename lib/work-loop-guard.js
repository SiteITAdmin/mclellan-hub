'use strict';

const crypto = require('crypto');
const db = require('./db');
const { uuid } = require('./id');
const { writeAgentReceipt } = require('./agent-receipts');

const PROMPT_POLICIES = {
  crm_atom_duplicate_review: {
    label: 'CRM atom duplicate review',
    maxSuccesses: 3,
    windowSeconds: 6 * 3600,
  },
};

const JOB_CADENCE_POLICIES = {
  synthesis_run: {
    label: 'CRM nightly synthesis',
    maxRuns: 2,
    windowSeconds: 86400,
    recurrence: 'daily:03:00',
  },
};

const FEATURE_DAILY_LIMITS = {
  crm_duplicate_review: 250,
  crm_atom_duplicate_review: 100,
};
const DEFAULT_FEATURE_DAILY_LIMIT = 500;
const REMEDIATION_SOURCE = 'hub_remediation';
const REMEDIATION_STAGE = 'agent:remediation:model_governance';
const REMEDIATION_CHECK = 'successful_work_loop';

function now() {
  return Math.floor(Date.now() / 1000);
}

function nextDailyDublinOccurrence(spec, afterEpoch) {
  const match = /^daily:(\d{2}):(\d{2})$/.exec(String(spec || ''));
  if (!match) return afterEpoch + 86400;
  const wantedHour = Number(match[1]);
  const wantedMinute = Number(match[2]);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const base = Math.floor(afterEpoch / 60) * 60;
  const currentParts = formatter.formatToParts(new Date(base * 1000));
  const current = Object.fromEntries(currentParts.map(part => [part.type, part.value]));
  const currentMinute = Number(current.hour) * 60 + Number(current.minute);
  const wanted = wantedHour * 60 + wantedMinute;
  let delta = (wanted - currentMinute + 24 * 60) % (24 * 60);
  if (!delta || base + delta * 60 <= afterEpoch) delta += 24 * 60;
  const estimate = base + delta * 60;
  const candidates = [estimate, estimate - 3600, estimate + 3600]
    .filter(candidate => candidate > afterEpoch)
    .sort((a, b) => a - b);
  for (const candidate of candidates) {
    const parts = formatter.formatToParts(new Date(candidate * 1000));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    if (Number(values.hour) === wantedHour && Number(values.minute) === wantedMinute) {
      return candidate;
    }
  }
  return estimate;
}

function promptFingerprint({ systemPrompt = '', userPrompt = '' } = {}) {
  return crypto.createHash('sha256')
    .update(String(systemPrompt))
    .update('\0')
    .update(String(userPrompt))
    .digest('hex');
}

function hasColumn(hub, table, column) {
  try {
    return hub.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  } catch (_) {
    return false;
  }
}

function blockKey(feature, fingerprint) {
  return `work_loop_block:${String(feature).slice(0, 60)}:${String(fingerprint).slice(0, 24)}`;
}

function readPromptBlock(feature, fingerprint, nowTs = now()) {
  try {
    const row = db.hub().prepare(
      'SELECT value FROM crm_context WHERE user = ? AND key = ? LIMIT 1',
    ).get('system', blockKey(feature, fingerprint));
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    return Number(parsed.expires_at || 0) > nowTs ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeContainmentReceipt(summary, payload, user = 'douglas') {
  try {
    writeAgentReceipt({
      user,
      sourceKind: REMEDIATION_SOURCE,
      sourceId: REMEDIATION_CHECK,
      stage: REMEDIATION_STAGE,
      status: 'pass',
      summary,
      payload: {
        agent: 'work_loop_guard',
        reversible: true,
        ...payload,
      },
    });
  } catch (err) {
    console.warn('[work-loop-guard] containment receipt failed:', err.message);
  }
}

function activatePromptBlock({ feature, fingerprint, calls, nowTs = now(), user = 'douglas' }) {
  const existing = readPromptBlock(feature, fingerprint, nowTs);
  if (existing) return existing;
  const policy = PROMPT_POLICIES[feature];
  if (!policy) return null;
  const value = {
    feature,
    fingerprint,
    calls,
    detected_at: nowTs,
    expires_at: nowTs + policy.windowSeconds,
  };
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value, created_at)
    VALUES (?, 'system', ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
  `).run(uuid(), blockKey(feature, fingerprint), JSON.stringify(value), nowTs);
  writeContainmentReceipt(
    `Remediation: contained repeated ${feature} prompt after ${calls} successful calls; identical work blocked for six hours`,
    {
      action: 'block_identical_prompt',
      feature,
      prompt_fingerprint: fingerprint,
      successful_calls: calls,
      expires_at: value.expires_at,
      run_at: new Date(nowTs * 1000).toISOString(),
    },
    user === 'system' ? 'douglas' : user,
  );
  return value;
}

function inspectModelWork({ feature, fingerprint, user = 'douglas', nowTs = now() } = {}) {
  const policy = PROMPT_POLICIES[feature];
  if (!policy || !fingerprint) return { allowed: true, protected: false };

  const active = readPromptBlock(feature, fingerprint, nowTs);
  if (active) {
    return {
      allowed: false,
      protected: true,
      reason: 'active_block',
      calls: Number(active.calls || 0),
      blockedUntil: Number(active.expires_at),
    };
  }

  let calls = 0;
  try {
    if (!hasColumn(db.hub(), 'request_logs', 'prompt_fingerprint')) {
      return { allowed: true, protected: true, calls: 0 };
    }
    const row = db.hub().prepare(`
      SELECT COUNT(*) AS n
      FROM request_logs
      WHERE model_key = ? AND prompt_fingerprint = ? AND ts >= ? AND status = 'ok'
    `).get(feature, fingerprint, nowTs - policy.windowSeconds);
    calls = Number(row?.n || 0);
  } catch (_) {
    return { allowed: true, protected: true, calls: 0 };
  }

  if (calls < policy.maxSuccesses) {
    return { allowed: true, protected: true, calls };
  }
  const block = activatePromptBlock({ feature, fingerprint, calls, nowTs, user });
  return {
    allowed: false,
    protected: true,
    reason: 'repeat_threshold',
    calls,
    blockedUntil: block?.expires_at || nowTs + policy.windowSeconds,
  };
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function featureVolumeStats(nowTs = now()) {
  const hub = db.hub();
  const since = nowTs - 86400;
  const priorSince = since - 7 * 86400;
  let recent = [];
  let prior = [];
  try {
    recent = hub.prepare(`
      SELECT model_key, COUNT(*) AS calls,
             SUM(COALESCE(tokens_in, 0)) AS tokens_in,
             SUM(COALESCE(tokens_out, 0)) AS tokens_out
      FROM request_logs
      WHERE ts >= ? AND status = 'ok' AND COALESCE(endpoint, '') != 'local'
      GROUP BY model_key
    `).all(since);
    prior = hub.prepare(`
      SELECT model_key, COUNT(*) AS calls
      FROM request_logs
      WHERE ts >= ? AND ts < ? AND status = 'ok' AND COALESCE(endpoint, '') != 'local'
      GROUP BY model_key
    `).all(priorSince, since);
  } catch (_) {
    return [];
  }

  const priorByFeature = new Map(prior.map(row => [row.model_key, Number(row.calls || 0) / 7]));
  const fingerprints = new Map();
  if (hasColumn(hub, 'request_logs', 'prompt_fingerprint')) {
    try {
      const rows = hub.prepare(`
        SELECT model_key, prompt_fingerprint, COUNT(*) AS calls, MAX(ts) AS latest
        FROM request_logs
        WHERE ts >= ? AND status = 'ok' AND prompt_fingerprint IS NOT NULL
        GROUP BY model_key, prompt_fingerprint
      `).all(since);
      for (const row of rows) {
        const current = fingerprints.get(row.model_key) || { fingerprintedCalls: 0, uniquePrompts: 0, maxRepeated: 0, repeatedFingerprint: null, latest: 0 };
        current.fingerprintedCalls += Number(row.calls || 0);
        current.uniquePrompts += 1;
        if (Number(row.calls || 0) > current.maxRepeated) {
          current.maxRepeated = Number(row.calls || 0);
          current.repeatedFingerprint = row.prompt_fingerprint;
        }
        current.latest = Math.max(current.latest, Number(row.latest || 0));
        fingerprints.set(row.model_key, current);
      }
    } catch (_) {}
  }

  const durations = new Map();
  try {
    for (const row of hub.prepare(`
      SELECT model_key, duration_ms
      FROM request_logs
      WHERE ts >= ? AND status = 'ok' AND duration_ms IS NOT NULL
        AND COALESCE(endpoint, '') != 'local'
    `).all(since)) {
      const list = durations.get(row.model_key) || [];
      list.push(Number(row.duration_ms || 0));
      durations.set(row.model_key, list);
    }
  } catch (_) {}

  return recent.map(row => {
    const calls = Number(row.calls || 0);
    const priorDailyAverage = Number(priorByFeature.get(row.model_key) || 0);
    const fingerprint = fingerprints.get(row.model_key) || {};
    const limit = FEATURE_DAILY_LIMITS[row.model_key] || DEFAULT_FEATURE_DAILY_LIMIT;
    const surge = calls >= 50 && priorDailyAverage >= 5 && calls >= priorDailyAverage * 4;
    return {
      feature: row.model_key || 'unknown',
      calls,
      tokensIn: Number(row.tokens_in || 0),
      tokensOut: Number(row.tokens_out || 0),
      priorDailyAverage: Number(priorDailyAverage.toFixed(1)),
      limit,
      overLimit: calls > limit,
      surge,
      p50Ms: percentile(durations.get(row.model_key) || [], 0.5),
      p95Ms: percentile(durations.get(row.model_key) || [], 0.95),
      ...fingerprint,
    };
  }).sort((a, b) => b.calls - a.calls);
}

function jobCadenceStats(nowTs = now()) {
  const hub = db.hub();
  const out = [];
  for (const [jobType, policy] of Object.entries(JOB_CADENCE_POLICIES)) {
    try {
      const runs = Number(hub.prepare(`
        SELECT COUNT(*) AS n FROM system_jobs
        WHERE type = ? AND status = 'done' AND ran_at >= ?
      `).get(jobType, nowTs - policy.windowSeconds)?.n || 0);
      const pending = hub.prepare(`
        SELECT id, status, run_at, created_at
        FROM system_jobs
        WHERE type = ? AND status IN ('pending', 'running')
        ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, run_at, created_at, id
      `).all(jobType);
      const nextExpected = nextDailyDublinOccurrence(policy.recurrence, nowTs);
      const safelyHeld = pending.length === 1
        && pending[0].status === 'pending'
        && Number(pending[0].run_at) >= nextExpected - 300;
      out.push({
        jobType,
        label: policy.label,
        runs,
        maxRuns: policy.maxRuns,
        overactive: runs > policy.maxRuns,
        pending,
        nextExpected,
        contained: runs > policy.maxRuns && safelyHeld,
        active: runs > policy.maxRuns && !safelyHeld,
      });
    } catch (err) {
      out.push({ jobType, label: policy.label, unavailable: err.message, active: false, overactive: false });
    }
  }
  return out;
}

function subscriptionQueueHealth(nowTs = now()) {
  try {
    const row = db.hub().prepare(`
      SELECT COUNT(*) AS open,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             MIN(CASE WHEN status IN ('pending','claimed') THEN created_at END) AS oldest
      FROM subscription_agent_jobs
      WHERE status IN ('pending','claimed')
    `).get();
    const oldestAgeSeconds = row?.oldest ? Math.max(0, nowTs - Number(row.oldest)) : 0;
    const open = Number(row?.open || 0);
    return {
      open,
      pending: Number(row?.pending || 0),
      oldestAgeSeconds,
      unhealthy: open >= 10 || oldestAgeSeconds >= 30 * 60,
    };
  } catch (_) {
    return null;
  }
}

function repeatedPromptStats(featureStats, nowTs = now()) {
  const rows = [];
  for (const stat of featureStats) {
    if (!stat.repeatedFingerprint || !stat.maxRepeated) continue;
    const policy = PROMPT_POLICIES[stat.feature];
    const threshold = policy?.maxSuccesses || 10;
    if (stat.maxRepeated < threshold) continue;
    const block = readPromptBlock(stat.feature, stat.repeatedFingerprint, nowTs);
    rows.push({
      feature: stat.feature,
      calls: stat.maxRepeated,
      fingerprint: stat.repeatedFingerprint,
      protected: Boolean(policy),
      contained: Boolean(block),
      active: Boolean(policy) && !block && Number(stat.latest || 0) >= nowTs - policy.windowSeconds,
      blockedUntil: block?.expires_at || null,
    });
  }
  return rows;
}

function workLoopHealth(nowTs = now()) {
  const features = featureVolumeStats(nowTs);
  const cadence = jobCadenceStats(nowTs);
  const repeatedPrompts = repeatedPromptStats(features, nowTs);
  const queue = subscriptionQueueHealth(nowTs);
  const featureVolume = features.filter(row => row.overLimit || row.surge);
  const active = [
    ...cadence.filter(row => row.active),
    ...repeatedPrompts.filter(row => row.active),
    ...(queue?.unhealthy ? [{ kind: 'subscription_queue', ...queue }] : []),
  ];
  const noteworthy = featureVolume.length
    || cadence.some(row => row.overactive)
    || repeatedPrompts.length
    || queue?.unhealthy;
  return {
    verdict: active.length ? 'fail' : noteworthy ? 'warn' : 'pass',
    features,
    featureVolume,
    cadence,
    repeatedPrompts,
    queue,
    active,
  };
}

function formatNext(ts) {
  return new Date(Number(ts || 0) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function workLoopReportLines(nowTs = now()) {
  const health = workLoopHealth(nowTs);
  const lines = [];
  for (const row of health.cadence.filter(item => item.overactive)) {
    if (row.contained) {
      lines.push(`RECENT LOOP — ${row.jobType} ran ${row.runs}× in 24h (expected at most ${row.maxRuns}); now held until ${formatNext(row.pending[0].run_at)}.`);
    } else {
      lines.push(`NEEDS YOU — ${row.jobType} ran ${row.runs}× in 24h (expected at most ${row.maxRuns}) and is not safely held to its next scheduled window.`);
    }
  }
  for (const row of health.repeatedPrompts) {
    if (row.contained) {
      lines.push(`AUTO-CONTAINED — ${row.feature} repeated one identical prompt ${row.calls}×; further identical calls are blocked until ${formatNext(row.blockedUntil)}.`);
    } else if (row.active) {
      lines.push(`NEEDS YOU — ${row.feature} repeated one identical prompt ${row.calls}× and has not been contained.`);
    } else {
      lines.push(`RECENT LOOP — ${row.feature} repeated one identical prompt ${row.calls}× in 24h.`);
    }
  }
  for (const row of health.featureVolume.slice(0, 5)) {
    const unique = row.fingerprintedCalls
      ? `; ${row.uniquePrompts} unique prompt(s) across ${row.fingerprintedCalls} fingerprinted call(s)`
      : '';
    const baseline = row.priorDailyAverage
      ? `; prior daily average ${row.priorDailyAverage}`
      : '';
    lines.push(`WATCH — ${row.feature}: ${row.calls} successful call(s), ${Math.round(row.tokensIn / 1000)}k input tokens${unique}${baseline}.`);
  }
  if (health.queue?.unhealthy) {
    lines.push(`NEEDS YOU — subscription queue has ${health.queue.open} open job(s); oldest has waited ${Math.round(health.queue.oldestAgeSeconds / 60)} minutes.`);
  }
  return lines;
}

function activeWorkLoopAlerts(nowTs = now()) {
  return workLoopReportLines(nowTs)
    .filter(line => line.startsWith('NEEDS YOU — '))
    .map(line => line.replace(/^NEEDS YOU — /, ''));
}

function containJobCadenceLoops(nowTs = now(), user = 'douglas') {
  const hub = db.hub();
  const actions = [];
  for (const row of jobCadenceStats(nowTs).filter(item => item.active)) {
    const pending = row.pending.filter(item => item.status === 'pending');
    let survivor = pending[0];
    if (!survivor) {
      survivor = { id: uuid() };
      hub.prepare(`
        INSERT INTO system_jobs (id, type, payload, run_at, status, source)
        VALUES (?, ?, '{}', ?, 'pending', 'work-loop-guard')
      `).run(survivor.id, row.jobType, row.nextExpected);
    } else {
      hub.prepare(`
        UPDATE system_jobs SET run_at = ?, source = 'work-loop-guard'
        WHERE id = ? AND status = 'pending'
      `).run(row.nextExpected, survivor.id);
    }
    const extras = pending.slice(1);
    for (const extra of extras) {
      hub.prepare(`
        UPDATE system_jobs
        SET status = 'failed', ran_at = ?, error = 'contained duplicate job chain by work-loop guard'
        WHERE id = ? AND status = 'pending'
      `).run(nowTs, extra.id);
    }
    const action = {
      kind: 'job_cadence',
      jobType: row.jobType,
      runs: row.runs,
      nextRunAt: row.nextExpected,
      retiredPending: extras.length,
    };
    actions.push(action);
    writeContainmentReceipt(
      `Remediation: contained ${row.jobType} after ${row.runs} runs in 24h; kept one successor at ${formatNext(row.nextExpected)}`,
      {
        action: 'restore_documented_job_cadence',
        job_type: row.jobType,
        observed_runs: row.runs,
        allowed_runs: row.maxRuns,
        next_run_at: row.nextExpected,
        retired_pending_jobs: extras.length,
        run_at: new Date(nowTs * 1000).toISOString(),
      },
      user,
    );
  }
  return actions;
}

function containRepeatedPrompts(nowTs = now(), user = 'douglas') {
  const actions = [];
  const features = featureVolumeStats(nowTs);
  for (const row of repeatedPromptStats(features, nowTs)) {
    if (!row.active || !row.protected) continue;
    const block = activatePromptBlock({
      feature: row.feature,
      fingerprint: row.fingerprint,
      calls: row.calls,
      nowTs,
      user,
    });
    actions.push({
      kind: 'prompt_repeat',
      feature: row.feature,
      calls: row.calls,
      blockedUntil: block?.expires_at || null,
    });
  }
  return actions;
}

function runWorkLoopGuard({ nowTs = now(), user = 'douglas' } = {}) {
  const actions = [
    ...containJobCadenceLoops(nowTs, user),
    ...containRepeatedPrompts(nowTs, user),
  ];
  return { checkedAt: nowTs, actions, health: workLoopHealth(nowTs) };
}

module.exports = {
  DEFAULT_FEATURE_DAILY_LIMIT,
  FEATURE_DAILY_LIMITS,
  JOB_CADENCE_POLICIES,
  PROMPT_POLICIES,
  activeWorkLoopAlerts,
  containJobCadenceLoops,
  containRepeatedPrompts,
  featureVolumeStats,
  inspectModelWork,
  jobCadenceStats,
  promptFingerprint,
  readPromptBlock,
  runWorkLoopGuard,
  subscriptionQueueHealth,
  workLoopHealth,
  workLoopReportLines,
};
