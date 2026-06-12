'use strict';

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
  return `Extract only explicit, currently assigned action items from this document. Return only JSON.

Document: ${doc.filename}${doc.project_name ? ` (project: ${doc.project_name})` : ''}

${markdown.slice(0, 8000)}

Return:
{
  "tasks": [
    {
      "title": "short imperative task title",
      "notes": "phase, priority, or context — one line",
      "source_ref": "task ID or row number if present, otherwise null"
    }
  ]
}

Rules:
- A task requires direct evidence of a real outstanding commitment, assignment, owner, due action, checklist item, or Open/In Progress tracker row.
- Only extract tasks that are Open or not yet completed; skip Done/Closed/Completed rows.
- Do not convert advice, recommendations, scoring feedback, rubrics, evaluation criteria, examples, templates, instructions, policy requirements, hypothetical actions, questions, or descriptive prose into tasks.
- Do not extract an assistant suggestion or an old conversation statement unless the document explicitly records that the user accepted it as an outstanding action.
- Do not infer that Douglas owns an action merely because an imperative sentence appears.
- Title should be imperative: "Review Application Portfolio", not "Application Portfolio Review".
- Keep notes to one line and include the evidence for ownership or status.
- If no explicit outstanding tasks exist, return { "tasks": [] }.${learnedRules}`;
}

module.exports = { extractionPrompt, isGeneratedDocument };
