'use strict';

// Douglas's own dated brief for the morning email: his current priorities, the
// decisions that stay his, and what he has deliberately put off until a date.
// It is optional. Each space keeps its own, and each draft reads only its own.
// A deferral lapses on its date, so nothing parked stays hidden for ever.

const { setting, setSetting, now, SPACES } = require('./db');
const planner = require('./planner');

const MAX_DEFERRED = 12;
const clip = (s, n) => String(s || '').replace(/\r\n/g, '\n').trim().slice(0, n);
const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;
const key = space => `current_brief:${space}`;

function get(space) {
  let v = null;
  try { v = JSON.parse(setting(key(space)) || 'null'); } catch { v = null; }
  return {
    priorities: v?.priorities || '',
    mine: v?.mine || '',
    deferred: Array.isArray(v?.deferred) ? v.deferred : [],
    updated_at: v?.updated_at || null,
  };
}

const list = v => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function save(space, body = {}, t = now()) {
  if (!SPACES.includes(space)) throw new Error('Unknown space');
  const today = planner.local(t).date;
  const whats = list(body.defer_what), untils = list(body.defer_until);
  const deferred = [];
  whats.forEach((w, i) => {
    const what = clip(w, 200).replace(/\s+/g, ' ');
    if (!what) return;
    const until = String(untils[i] || '').trim();
    if (!validDay(until)) throw new Error(`Give a date to put off "${what}" until`);
    if (until <= today) return; // already lapsed
    deferred.push({ what, until });
  });
  if (deferred.length > MAX_DEFERRED) throw new Error(`Keep it to ${MAX_DEFERRED} things put off at once`);
  deferred.sort((a, b) => a.until.localeCompare(b.until));
  const value = { priorities: clip(body.priorities, 1500), mine: clip(body.mine, 1000), deferred, updated_at: t };
  setSetting(key(space), JSON.stringify(value));
  return value;
}

// What a morning draft sees: only deferrals still running, and nothing if the brief is empty.
function forDraft(space, t = now()) {
  const b = get(space), today = planner.local(t).date;
  const deferred = b.deferred.filter(d => d.until > today);
  if (!b.priorities && !b.mine && !deferred.length) return null;
  return {
    written: b.updated_at ? planner.local(b.updated_at).date : null,
    ...(b.priorities ? { priorities: b.priorities } : {}),
    ...(b.mine ? { decisions_that_stay_mine: b.mine } : {}),
    ...(deferred.length ? { deferred } : {}),
  };
}

module.exports = { get, save, forDraft };
