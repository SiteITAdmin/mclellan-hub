'use strict';

const db = require('./db');
const { uuid } = require('./id');

const TAXONOMY_KEY = 'content_topic_taxonomy';

const DEFAULT_TOPICS = Object.freeze([
  { name: 'AI & Technology', description: 'AI strategy, emerging platforms, automation, architecture, and practical technology shifts.' },
  { name: 'M365 & Microsoft', description: 'Microsoft 365, Copilot, Teams, SharePoint, Power Platform, and enterprise collaboration.' },
  { name: 'Healthcare IT', description: 'Digital health, NHS/HSE systems, clinical operations, health data, and care technology.' },
  { name: 'Digital Transformation', description: 'Operating model change, adoption, delivery, governance, and business process redesign.' },
  { name: 'EU Policy & Regulation', description: 'EU and Ireland policy, data regulation, AI governance, privacy, compliance, and public-sector rules.' },
  { name: 'Leadership & Management', description: 'Teams, communication, delivery culture, stakeholder management, and practical leadership.' },
  { name: 'Industry Analysis', description: 'Market shifts, vendor strategy, sector trends, and what they imply for technology leaders.' },
  { name: 'Product Review', description: 'Hands-on assessment of tools, platforms, apps, and services from a practitioner perspective.' },
  { name: 'Case Study', description: 'Specific implementation stories, lessons learned, patterns, and measurable outcomes.' },
  { name: 'Career & Development', description: 'Professional growth, learning, role transitions, hiring signals, and career judgment.' },
]);

function defaults() {
  return DEFAULT_TOPICS.map(t => ({ ...t }));
}

function normalizeTopic(topic) {
  const name = String(topic?.name || '').trim().slice(0, 80);
  if (!name) return null;
  const out = {
    name,
    description: String(topic?.description || '').trim().slice(0, 600),
  };
  const searchQuery = String(topic?.searchQuery || '').trim().slice(0, 300);
  if (searchQuery) out.searchQuery = searchQuery;
  return out;
}

function normalizeTopics(input) {
  const seen = new Set();
  const rows = Array.isArray(input) ? input : defaults();
  const out = [];
  for (const row of rows) {
    const topic = normalizeTopic(row);
    if (!topic) continue;
    const key = topic.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out.length ? out : defaults();
}

function getContentTopics(user) {
  try {
    const row = db.hub().prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, TAXONOMY_KEY);
    if (!row?.value) return defaults();
    return normalizeTopics(JSON.parse(row.value));
  } catch (_) {
    return defaults();
  }
}

function setContentTopics(user, topics) {
  const normalized = normalizeTopics(topics);
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, TAXONOMY_KEY, JSON.stringify(normalized));
  return normalized;
}

function listContentTopicNames(user) {
  return getContentTopics(user).map(t => t.name);
}

function addContentTopic(user, topic) {
  const topics = getContentTopics(user);
  const normalized = normalizeTopic(topic);
  if (!normalized) return topics;
  const exists = topics.some(t => t.name.toLowerCase() === normalized.name.toLowerCase());
  return exists ? topics : setContentTopics(user, [...topics, normalized]);
}

function updateContentTopic(user, oldName, patch) {
  const topics = getContentTopics(user);
  const idx = topics.findIndex(t => t.name === oldName);
  if (idx < 0) return topics;
  const next = normalizeTopic({ ...topics[idx], ...patch });
  if (!next) return topics;
  topics[idx] = next;
  return setContentTopics(user, topics);
}

function deleteContentTopic(user, name) {
  return setContentTopics(user, getContentTopics(user).filter(t => t.name !== name));
}

module.exports = {
  DEFAULT_TOPICS,
  getContentTopics,
  setContentTopics,
  listContentTopicNames,
  addContentTopic,
  updateContentTopic,
  deleteContentTopic,
};
