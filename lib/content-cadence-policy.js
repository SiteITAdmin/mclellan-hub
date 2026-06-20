'use strict';

const db = require('./db');
const { uuid } = require('./id');

const POLICY_KEY = 'content_cadence_policy';

const DEFAULT_POLICY = Object.freeze({
  linkedin: {
    enabled: true,
    cadenceDays: 7,
    recur: 'daily:10:00',
  },
  newsletter: {
    enabled: true,
    minTopics: 3,
    recur: 'weekly:wed:10:00',
  },
  topicPlan: {
    days: 7,
    suggestionsPerDay: 3,
    dayPrefs: {},
  },
});

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY));
}

function intInRange(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validRecur(value, fallback) {
  const recur = String(value || '').trim().toLowerCase();
  if (/^daily:([01]\d|2[0-3]):[0-5]\d$/.test(recur)) return recur;
  if (/^weekly:(sun|mon|tue|wed|thu|fri|sat):([01]\d|2[0-3]):[0-5]\d$/.test(recur)) return recur;
  return fallback;
}

function normalizeTone(value) {
  return ['professional', 'challenging', 'provocative'].includes(value) ? value : 'professional';
}

function normalizeDayPrefs(value) {
  let raw = value || {};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch (_) { raw = {}; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [date, pref] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !pref || typeof pref !== 'object') continue;
    const topic = String(pref.topic || '').trim().slice(0, 80);
    out[date] = {
      topic,
      tone: normalizeTone(pref.tone),
    };
  }
  return out;
}

function normalizePolicy(input = {}) {
  const base = cloneDefaults();
  const li = input.linkedin || {};
  const nl = input.newsletter || {};
  const plan = input.topicPlan || {};
  return {
    linkedin: {
      enabled: li.enabled !== false && li.enabled !== 'false' && li.enabled !== 0 && li.enabled !== '0',
      cadenceDays: intInRange(li.cadenceDays, base.linkedin.cadenceDays, 1, 60),
      recur: validRecur(li.recur, base.linkedin.recur),
    },
    newsletter: {
      enabled: nl.enabled !== false && nl.enabled !== 'false' && nl.enabled !== 0 && nl.enabled !== '0',
      minTopics: intInRange(nl.minTopics, base.newsletter.minTopics, 1, 25),
      recur: validRecur(nl.recur, base.newsletter.recur),
    },
    topicPlan: {
      days: intInRange(plan.days, base.topicPlan.days, 1, 30),
      suggestionsPerDay: intInRange(plan.suggestionsPerDay, base.topicPlan.suggestionsPerDay, 1, 10),
      dayPrefs: normalizeDayPrefs(plan.dayPrefs),
    },
  };
}

function getContentCadencePolicy(user) {
  try {
    const row = db.hub().prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, POLICY_KEY);
    if (!row?.value) return cloneDefaults();
    return normalizePolicy(JSON.parse(row.value));
  } catch (_) {
    return cloneDefaults();
  }
}

function setContentCadencePolicy(user, policy) {
  const normalized = normalizePolicy(policy);
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, POLICY_KEY, JSON.stringify(normalized));
  return normalized;
}

function describeRecur(recur) {
  const parts = String(recur || '').split(':');
  if (parts[0] === 'daily') return `Daily at ${parts[1]}:${parts[2]}`;
  if (parts[0] === 'weekly') {
    const day = parts[1].slice(0, 1).toUpperCase() + parts[1].slice(1);
    return `${day} at ${parts[2]}:${parts[3]}`;
  }
  return recur || '';
}

module.exports = {
  DEFAULT_POLICY,
  getContentCadencePolicy,
  setContentCadencePolicy,
  normalizePolicy,
  describeRecur,
};
