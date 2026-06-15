'use strict';

const TASK_CODES = Object.freeze({
  CHAT: 'UT-Chat',
  CHAT_RESEARCH: 'UT-ChatResearch',
  IMAGE: 'UT-Image',
  TESTBENCH: 'UT-Testbench',
  NEWSLETTER: 'UT-Newsletter',
  DEBRIEF: 'UT-Debrief',
  DOCUMENT_TASKS: 'UT-DocumentTasks',
  DOCUMENT_ANALYSIS: 'UT-DocumentAnalysis',
  CRM: 'UT-CRM',
  CONTENT: 'UT-Content',
  WIKI: 'UT-Wiki',
  ADMIN: 'UT-Admin',
  NEWSLETTER_INGEST: 'AT-NewsletterIngest',
  AGENTMAIL: 'AT-AgentMail',
  EMAIL_CLASSIFICATION: 'AT-EmailClassification',
  SUGGESTIONS: 'AT-Suggestions',
  TASK_LEARNING: 'AT-TaskLearning',
  WEEKLY_DIGEST: 'AT-WeeklyDigest',
  DAILY_DIGEST: 'AT-DailyDigest',
  REGULATORY_MONITOR: 'AT-RegulatoryMonitor',
  MYCELIUM: 'AT-Mycelium',
  WORKDAY_INGEST: 'AT-WorkdayIngest',
  WIKI_INGEST: 'AT-WikiIngest',
  RECALL_TAGGING: 'AT-RecallTagging',
});

const FEATURE_TASK_CODES = Object.freeze({
  'agentmail-work-extractor': TASK_CODES.AGENTMAIL,
  'crm-intent': TASK_CODES.CRM,
  'doc-task-extractor': TASK_CODES.DOCUMENT_TASKS,
  'email-classifier': TASK_CODES.EMAIL_CLASSIFICATION,
  'linkedin-pipeline': TASK_CODES.CONTENT,
  'mycelium-doc-tasks': TASK_CODES.MYCELIUM,
  'newsletter-extractor': TASK_CODES.NEWSLETTER_INGEST,
  'newsletter_briefing': TASK_CODES.NEWSLETTER,
  'recall-tagging': TASK_CODES.RECALL_TAGGING,
  'regulatory-monitor': TASK_CODES.REGULATORY_MONITOR,
  'suggestion-engine': TASK_CODES.SUGGESTIONS,
  'task-wrong-learning': TASK_CODES.TASK_LEARNING,
  'weekly-digest': TASK_CODES.WEEKLY_DIGEST,
  'wiki-save': TASK_CODES.WIKI,
  'wiki-doc-save': TASK_CODES.WIKI_INGEST,
  'wiki-image-vision': TASK_CODES.WIKI_INGEST,
  'workday-transcription': TASK_CODES.WORKDAY_INGEST,
});

function normalizeTaskCode(value, fallback = 'AT-Unclassified') {
  const taskCode = String(value || fallback).trim();
  if (/^(AT|UT)-[A-Za-z0-9][A-Za-z0-9-]*$/.test(taskCode)) return taskCode;
  return fallback;
}

function taskCodeForFeature(feature, fallback = 'AT-Unclassified') {
  return FEATURE_TASK_CODES[feature] || normalizeTaskCode(feature, fallback);
}

function openRouterHeaders(taskCode, {
  apiKey = process.env.OPENROUTER_API_KEY,
  baseUrl = 'https://dchat.mclellan.scot',
  contentType = 'application/json',
} = {}) {
  const code = normalizeTaskCode(taskCode);
  const slug = code.toLowerCase();
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': contentType,
    'HTTP-Referer': `${baseUrl.replace(/\/$/, '')}/openrouter-task/${slug}`,
    'X-OpenRouter-Title': code,
    'X-Title': code,
  };
}

module.exports = {
  TASK_CODES,
  normalizeTaskCode,
  taskCodeForFeature,
  openRouterHeaders,
};
