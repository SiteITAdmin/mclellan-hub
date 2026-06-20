'use strict';

const db = require('./db');

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dublinDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function topicMatches(row, wanted) {
  if (!wanted) return true;
  const needle = slug(wanted);
  const haystack = [row.category, row.title, row.summary, row.item_type].map(slug).join(' ');
  return haystack.includes(needle) || needle.includes(slug(row.category));
}

function buildContentTopicPlan(user, { days = 7, suggestionsPerDay = 3, dayPrefs = {} } = {}) {
  const hub = db.hub();
  const horizonDays = Math.min(30, Math.max(1, parseInt(days, 10) || 7));
  const perDay = Math.min(10, Math.max(1, parseInt(suggestionsPerDay, 10) || 3));
  const limit = horizonDays * perDay;

  const existingPosts = hub.prepare(`
    SELECT topic FROM linkedin_posts
    WHERE user = ? AND status IN ('processing','draft','scheduled','published')
    ORDER BY created_at DESC LIMIT 200
  `).all(user).map(r => slug(r.topic)).filter(Boolean);

  const existingSuggestionTitles = hub.prepare(`
    SELECT title FROM suggestions
    WHERE user = ? AND domain = 'content' AND status = 'open'
    ORDER BY created_at DESC LIMIT 100
  `).all(user).map(r => slug(r.title)).filter(Boolean);

  const blocked = [...existingPosts, ...existingSuggestionTitles];
  const rows = hub.prepare(`
    SELECT i.id, i.title, i.summary, i.category, i.item_type, i.source_url,
           i.published_at, i.created_at, d.sender_name AS source_name, d.title AS source_title
    FROM intel_items i
    JOIN intel_documents d ON d.id = i.document_id
    WHERE i.user = ? AND i.selected = 1
    ORDER BY COALESCE(i.published_at, i.created_at) DESC
    LIMIT 300
  `).all(user);

  const seenGlobal = new Set();
  const used = new Set();
  const candidates = [];
  for (const row of rows) {
    const key = slug(row.title);
    if (!key || seenGlobal.has(key)) continue;
    if (blocked.some(existing => existing && (existing.includes(key) || key.includes(existing)))) continue;
    seenGlobal.add(key);
    candidates.push(row);
  }

  const daysOut = [];
  for (let i = 0; i < horizonDays; i++) {
    const date = dublinDate(i);
    const preference = dayPrefs[date] || { topic: '', tone: 'professional' };
    const suggestions = [];
    for (const candidate of candidates) {
      if (suggestions.length >= perDay) break;
      if (used.has(candidate.id)) continue;
      if (!topicMatches(candidate, preference.topic)) continue;
      used.add(candidate.id);
      suggestions.push(candidate);
    }
    daysOut.push({
      date,
      label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Dublin',
      }),
      preference: {
        topic: preference.topic || '',
        tone: ['professional', 'challenging', 'provocative'].includes(preference.tone) ? preference.tone : 'professional',
      },
      suggestions,
    });
  }

  return {
    days: daysOut,
    available: candidates.length,
    requested: limit,
    excluded: blocked.length,
  };
}

module.exports = { buildContentTopicPlan };
