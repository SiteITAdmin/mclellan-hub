'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractionPrompt, isGeneratedDocument } = require('../lib/document-tasks');

test('generated project memory documents are excluded from task extraction', () => {
  assert.equal(isGeneratedDocument({ filename: '_Project Memory.md', markdown: '# Project Memory' }), true);
  assert.equal(isGeneratedDocument({
    filename: 'notes.md',
    markdown: '---\nauto_generated: true\n---\n# Notes',
  }), true);
  assert.equal(isGeneratedDocument({
    filename: 'Saved answer [chat].md',
    markdown: '---\nauto_generated: true\ngenerated_kind: "chat-answer"\n---\n# Saved answer',
  }), true);
  assert.equal(isGeneratedDocument({
    filename: 'Legacy answer [chat].md',
    markdown: '# Legacy answer\n\n**Q:** What now?\n\n**A:** A prior assistant answer.',
  }), true);
  assert.equal(isGeneratedDocument({
    filename: '2026-08-02 [meeting].md',
    markdown: '# Meeting\n\n## Action Register\n- Send the pack\n\n## Transcript\nPlease send the pack.',
  }), true);
  assert.equal(isGeneratedDocument({
    filename: 'raw-notes.md',
    markdown: '# Raw notes\n\n## Action Register\nThis is a human-authored checklist, not a rendered meeting register.',
  }), false);
  assert.equal(isGeneratedDocument({ filename: 'tracker.xlsx', markdown: 'Open tasks' }), false);
});

test('task prompt excludes rubrics, recommendations, and unaccepted suggestions', () => {
  const prompt = extractionPrompt({ filename: 'Rubric.pdf' }, 'Score posts against these criteria.');
  assert.match(prompt, /Do not convert advice, recommendations, scoring feedback, rubrics/);
  assert.match(prompt, /explicitly records that the user accepted it/);
});
