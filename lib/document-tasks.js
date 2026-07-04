'use strict';

const { getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const EXCLUDED_FILENAMES = new Set([
  '_project memory.md',
]);

function isGeneratedDocument(doc) {
  const filename = String(doc?.filename || '').trim().toLowerCase();
  const markdown = String(doc?.markdown || '');
  return EXCLUDED_FILENAMES.has(filename)
    || /^---[\s\S]*?\bauto_generated:\s*true\b[\s\S]*?---/i.test(markdown);
}

function extractionPrompt(doc, markdown, learnedRules = '') {
  return `${getSystemPrompt('task_extractor', 'system', PROMPTS.task_extractor)}

Document: ${doc.filename}${doc.project_name ? ` (project: ${doc.project_name})` : ''}

${markdown.slice(0, 8000)}${learnedRules}`;
}

module.exports = { extractionPrompt, isGeneratedDocument };
