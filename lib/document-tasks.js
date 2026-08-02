'use strict';

const { getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const {
  isGeneratedCanonicalDocument,
  canonicalDocumentTaskText,
} = require('./source-evidence');

function isGeneratedDocument(doc) {
  return isGeneratedCanonicalDocument(doc);
}

function extractionPrompt(doc, markdown, learnedRules = '') {
  const canonicalMarkdown = canonicalDocumentTaskText(doc, markdown);
  return `${getSystemPrompt('task_extractor', 'system', PROMPTS.task_extractor)}

Document: ${doc.filename}${doc.project_name ? ` (project: ${doc.project_name})` : ''}

${canonicalMarkdown.slice(0, 8000)}${learnedRules}`;
}

module.exports = { extractionPrompt, isGeneratedDocument };
