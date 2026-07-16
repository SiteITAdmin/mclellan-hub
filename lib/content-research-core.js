'use strict';

// Shared helpers for content research — kept free of job-queue / driver
// imports so content-research.js and content-research-jobs.js can both use them.

const db = require('./db');
const { uuid } = require('./id');
const { currentInfoSearch } = require('./current-info-search');
const { getContentTopics } = require('./content-taxonomy');

const VALID_TONES = new Set(['professional', 'challenging', 'provocative']);

function dublinDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function normalizeTone(value) {
  return VALID_TONES.has(value) ? value : 'professional';
}

function buildResearchQuery({ topic, tone, date, searchQuery }) {
  const toneHint = tone === 'provocative'
    ? 'contrarian implications risks debate'
    : tone === 'challenging'
      ? 'critical analysis tradeoffs practitioner view'
      : 'professional analysis practical implications';
  if (searchQuery) return `${searchQuery} ${toneHint} ${date}`;
  return `${topic} latest news ${date} ${toneHint} technology leadership LinkedIn`;
}

function cleanText(value, max = 220) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function suggestionsFromSearch({ topic, tone, planDate, searchResult, limit = 3 }) {
  const seen = new Set();
  const out = [];
  for (const source of searchResult?.sources || []) {
    const title = cleanText(source.title || topic, 120);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: uuid(),
      plan_date: planDate,
      topic,
      tone: normalizeTone(tone),
      title,
      summary: cleanText(source.snippet || `Recent source found for ${topic}.`, 260),
      source_url: source.url || null,
      source_title: source.title || null,
      source_provider: source.provider || searchResult.provider || 'web',
      source_json: JSON.stringify(source),
      researched_at: Math.floor(Date.now() / 1000),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function replaceSuggestions(user, { planDate, topic, tone, suggestions }) {
  const hub = db.hub();
  const normalizedTone = normalizeTone(tone);
  const tx = hub.transaction(() => {
    hub.prepare(`
      DELETE FROM content_research_suggestions
      WHERE user = ? AND plan_date = ? AND topic = ? AND tone = ?
    `).run(user, planDate, topic, normalizedTone);

    const ins = hub.prepare(`
      INSERT INTO content_research_suggestions
        (id, user, plan_date, topic, tone, title, summary, source_url, source_title,
         source_provider, source_json, researched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of suggestions) {
      ins.run(
        s.id || uuid(), user, planDate, topic, normalizedTone, s.title,
        s.summary || '', s.source_url || null, s.source_title || null,
        s.source_provider || 'web', s.source_json || '{}',
        s.researched_at || Math.floor(Date.now() / 1000)
      );
    }
  });
  tx();
  return suggestions.length;
}

async function researchViaWebSearch(user, { planDate, topic, tone = 'professional', limit = 3 } = {}) {
  const cleanTopic = String(topic || '').trim().slice(0, 80);
  const normalizedTone = normalizeTone(tone);
  const date = String(planDate || dublinDate()).slice(0, 10);
  const topicObj = getContentTopics(user).find(t => t.name === cleanTopic);
  const query = buildResearchQuery({
    topic: cleanTopic,
    tone: normalizedTone,
    date,
    searchQuery: topicObj?.searchQuery,
  });
  const searchResult = await currentInfoSearch(query, {
    provider: 'auto',
    days: 3,
    limit: Math.max(5, limit * 3),
  });
  const suggestions = suggestionsFromSearch({
    topic: cleanTopic,
    tone: normalizedTone,
    planDate: date,
    searchResult,
    limit,
  });
  const count = replaceSuggestions(user, {
    planDate: date,
    topic: cleanTopic,
    tone: normalizedTone,
    suggestions,
  });
  return {
    ok: true,
    count,
    query,
    provider: searchResult.provider,
    warning: searchResult.warning || null,
    driver: 'web',
  };
}

module.exports = {
  VALID_TONES,
  dublinDate,
  normalizeTone,
  buildResearchQuery,
  cleanText,
  suggestionsFromSearch,
  replaceSuggestions,
  researchViaWebSearch,
};
