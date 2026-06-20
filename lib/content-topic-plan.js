'use strict';

const db = require('./db');
const { listContentTopicNames } = require('./content-taxonomy');

const TOPIC_ALIASES = Object.freeze({
  'AI & Technology': ['AI & Machine Learning', 'Artificial Intelligence', 'Automation', 'Technology'],
  'M365 & Microsoft': ['Microsoft 365 & Azure', 'Microsoft 365', 'M365', 'Copilot', 'Teams', 'SharePoint', 'Power Platform', 'Azure'],
  'Healthcare IT': ['Healthcare IT', 'Digital Health', 'Health Data', 'NHS', 'HSE', 'Clinical Systems'],
  'Digital Transformation': ['Transformation', 'Operating Model', 'Change Management', 'Business Process', 'Process Redesign'],
  'EU Policy & Regulation': ['Ireland & EU Policy', 'EU Policy', 'Regulation', 'Compliance', 'Privacy', 'Data Protection', 'AI Governance'],
  'Leadership & Management': ['Career & Leadership', 'Leadership', 'Management', 'Stakeholder Management', 'Delivery Culture'],
  'Industry Analysis': ['Industry', 'Market Shift', 'Market Trend', 'Vendor Strategy', 'Sector Trend'],
  'Product Review': ['Product', 'Review', 'Tooling', 'Platform', 'Software'],
  'Case Study': ['Case Study', 'Implementation', 'Lessons Learned', 'Outcome'],
  'Career & Development': ['Career', 'Professional Development', 'Learning', 'Hiring', 'Role Transition'],
});

const INTERNAL_TITLE_PATTERNS = [
  'mclellan hub daily system report',
  'hub daily report',
  'newsletter digest ready',
  'daily operational metrics',
  'system report',
];

const BLOCKED_ITEM_TYPES = new Set([
  'advertisement',
  'digest',
  'internal',
  'operational_report',
  'prompt',
  'reminder',
  'system_report',
]);

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dublinDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
}

function topicTerms(topic) {
  const base = String(topic || '').trim();
  return [base, ...(TOPIC_ALIASES[base] || [])].map(slug).filter(Boolean);
}

function rowText(row) {
  return [
    row.category,
    row.title,
    row.summary,
    row.item_type,
  ].map(slug).filter(Boolean).join(' ');
}

function hasTerm(text, term) {
  if (!text || !term) return false;
  return text === term || text.startsWith(`${term} `) || text.endsWith(` ${term}`) || text.includes(` ${term} `);
}

function rowMatchesAnyTopic(row, topics = Object.keys(TOPIC_ALIASES)) {
  const text = rowText(row);
  return topics.some(topic =>
    topicTerms(topic).some(term => hasTerm(text, term))
  );
}

function topicMatches(row, wanted) {
  if (!wanted) return true;
  const haystack = rowText(row);
  const category = slug(row.category);
  return topicTerms(wanted).some(term =>
    hasTerm(haystack, term) || (category && (term === category || hasTerm(term, category)))
  );
}

function isInternalOperationalItem(row) {
  const titleText = [row.title, row.source_title, row.summary].map(slug).join(' ');
  if (INTERNAL_TITLE_PATTERNS.some(pattern => titleText.includes(pattern))) return true;

  const sourceName = slug(row.source_name);
  const sourceTitle = slug(row.source_title);
  if (sourceName === 'agentmail') return true;
  if (!row.source_url && sourceName.includes('mclellan hub')) return true;
  if (!row.source_url && sourceTitle.includes('hub daily')) return true;

  return false;
}

function isContentCandidate(row, topics = Object.keys(TOPIC_ALIASES)) {
  if (isInternalOperationalItem(row)) return false;
  if (BLOCKED_ITEM_TYPES.has(slug(row.item_type))) return false;

  const category = slug(row.category);
  if (category === 'other' && !rowMatchesAnyTopic(row, topics)) return false;

  return rowMatchesAnyTopic(row, topics);
}

function buildContentTopicPlan(user, { days = 7, suggestionsPerDay = 3, dayPrefs = {}, showIntelFallback = false } = {}) {
  const hub = db.hub();
  const horizonDays = Math.min(30, Math.max(1, parseInt(days, 10) || 7));
  const perDay = Math.min(10, Math.max(1, parseInt(suggestionsPerDay, 10) || 3));
  const limit = horizonDays * perDay;
  const topics = listContentTopicNames(user);

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

  const researchRows = hub.prepare(`
    SELECT id, plan_date, topic, tone, title, summary, source_url, source_title,
           source_provider, researched_at
    FROM content_research_suggestions
    WHERE user = ?
    ORDER BY plan_date ASC, researched_at DESC, created_at ASC
  `).all(user);
  const researchByDate = new Map();
  for (const row of researchRows) {
    if (!researchByDate.has(row.plan_date)) researchByDate.set(row.plan_date, []);
    researchByDate.get(row.plan_date).push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      category: row.topic,
      item_type: 'researched',
      source_url: row.source_url,
      source_name: row.source_provider || 'web',
      source_title: row.source_title,
      researched_at: row.researched_at,
      tone: row.tone,
      plan_date: row.plan_date,
      source_kind: 'web research',
    });
  }

  const seenGlobal = new Set();
  const used = new Set();
  const candidates = [];
  if (showIntelFallback) {
    for (const row of rows) {
      const key = slug(row.title);
      if (!key || seenGlobal.has(key)) continue;
      if (!isContentCandidate(row, topics)) continue;
      if (blocked.some(existing => existing && (existing.includes(key) || key.includes(existing)))) continue;
      seenGlobal.add(key);
      candidates.push(row);
    }
  }

  const daysOut = [];
  for (let i = 0; i < horizonDays; i++) {
    const date = dublinDate(i);
    const preference = dayPrefs[date] || { topic: '', tone: 'professional' };
    const suggestions = [];
    for (const candidate of researchByDate.get(date) || []) {
      if (suggestions.length >= perDay) break;
      if (preference.topic && candidate.category !== preference.topic) continue;
      suggestions.push(candidate);
    }
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
    available: candidates.length + researchRows.length,
    requested: limit,
    excluded: blocked.length,
  };
}

module.exports = {
  buildContentTopicPlan,
  isContentCandidate,
  topicMatches,
};
