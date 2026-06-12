'use strict';

const db = require('./db');
const fetch = require('./fetch');
const { uuid } = require('./id');
const { getSystemModelId } = require('./settings');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');

const LEARNABLE_SOURCES = new Set(['document', 'email', 'agentmail']);

function normalizeKey(value) {
  return String(value || 'explicit-ownership-required')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'explicit-ownership-required';
}

function documentIdFromSourceId(sourceId) {
  return String(sourceId || '').match(/^doc:([^:]+):/)?.[1] || null;
}

function excerptAroundTask(content, title, notes = '', maxLength = 12000) {
  const text = String(content || '');
  if (text.length <= maxLength) return text;
  const needles = [
    String(title || '').trim(),
    ...String(title || '').toLowerCase().split(/\s+/).filter(word => word.length >= 6),
    ...String(notes || '').toLowerCase().split(/\s+/).filter(word => word.length >= 8),
  ].filter(Boolean);
  const lower = text.toLowerCase();
  let index = -1;
  for (const needle of needles) {
    index = lower.indexOf(needle.toLowerCase());
    if (index >= 0) break;
  }
  if (index < 0) return text.slice(0, maxLength);
  const start = Math.max(0, index - Math.floor(maxLength / 2));
  return text.slice(start, start + maxLength);
}

function taskEvidence(user, taskId) {
  const hub = db.hub();
  const task = hub.prepare(
    'SELECT * FROM google_tasks WHERE id = ? AND user = ?'
  ).get(taskId, user);
  if (!task) return null;

  const evidence = {
    task,
    sourceScope: LEARNABLE_SOURCES.has(task.source) ? task.source : 'other',
    sourceLabel: task.source || 'unknown',
    sourceContent: task.notes || '',
    documentId: null,
    documentFilename: null,
    projectSlug: task.project_slug || null,
  };

  if (task.source === 'document') {
    evidence.documentId = documentIdFromSourceId(task.source_id);
    const doc = evidence.documentId
      ? hub.prepare(`
          SELECT d.*, p.slug AS project_slug
          FROM documents d
          LEFT JOIN projects p ON p.id = d.project_id
          WHERE d.id = ? AND d.user = ?
        `).get(evidence.documentId, user)
      : null;
    if (doc) {
      evidence.documentFilename = doc.filename;
      evidence.projectSlug = doc.project_slug || evidence.projectSlug;
      evidence.sourceLabel = `document:${doc.filename}`;
      evidence.sourceContent = excerptAroundTask(
        doc.markdown,
        task.title,
        task.notes,
      );
    }
  } else if (task.source === 'email') {
    const row = hub.prepare(`
      SELECT subject, from_name, from_email, summary
      FROM email_summaries
      WHERE user = ? AND gmail_message_id = ?
    `).get(user, task.source_id);
    if (row) {
      evidence.sourceLabel = `email:${row.subject}`;
      evidence.sourceContent = [
        `From: ${row.from_name || ''} <${row.from_email || ''}>`,
        `Subject: ${row.subject || ''}`,
        `Summary: ${row.summary || ''}`,
        `Task notes: ${task.notes || ''}`,
      ].join('\n');
    }
  } else if (task.source === 'agentmail') {
    const externalId = String(task.source_id || '')
      .replace(/^agentmail:(?:action|owner):/, '')
      .replace(/:[^:]+$/, '');
    const row = hub.prepare(`
      SELECT subject, from_name, from_email, summary, classification
      FROM inbound_email_records
      WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
    `).get(user, externalId);
    if (row) {
      evidence.sourceLabel = `agentmail:${row.subject}`;
      evidence.sourceContent = [
        `From: ${row.from_name || ''} <${row.from_email || ''}>`,
        `Subject: ${row.subject || ''}`,
        `Summary: ${row.summary || ''}`,
        `Classification: ${row.classification || ''}`,
        `Task notes: ${task.notes || ''}`,
      ].join('\n');
    }
  }

  return evidence;
}

function learnedTaskRules(user, sourceScope, limit = 8) {
  return db.hub().prepare(`
    SELECT lesson_key, category, rule, applies_to, evidence_count
    FROM task_extraction_lessons
    WHERE user = ? AND active = 1
      AND source_scope IN (?, 'all')
    ORDER BY evidence_count DESC, updated_at DESC
    LIMIT ?
  `).all(user, sourceScope, limit);
}

function formatLearnedTaskRules(user, sourceScope) {
  const lessons = learnedTaskRules(user, sourceScope);
  if (!lessons.length) return '';
  return `\n\nLearned task-creation rules from user corrections:
${lessons.map(item => `- ${item.rule} [evidence: ${item.evidence_count}]`).join('\n')}
Apply these rules to the current source. They override generic extraction instincts.`;
}

function fallbackLesson(evidence, userReason) {
  const guidanceLike = /\b(rubric|score|scoring|criteria|recommend|example|template|guidance)\b/i.test(
    `${evidence.documentFilename || ''}\n${evidence.sourceContent}`
  );
  return {
    lesson_key: guidanceLike ? 'guidance-is-not-assignment' : 'require-explicit-current-ownership',
    category: guidanceLike ? 'guidance_as_task' : 'false_assignment',
    rule: guidanceLike
      ? 'Treat rubrics, scoring criteria, examples, templates, recommendations and guidance as reference material, not tasks, unless the source explicitly assigns a current action to the user.'
      : 'Create a task only when the source explicitly records a current outstanding action owned by the user; an imperative phrase or recommendation alone is insufficient.',
    applies_to: {
      source_scope: evidence.sourceScope,
      document_filename: evidence.documentFilename,
      user_reason: userReason || null,
    },
    explanation: 'Fallback lesson created because automated lesson analysis was unavailable.',
  };
}

async function deriveLesson(user, evidence, userReason) {
  const existingRules = learnedTaskRules(user, evidence.sourceScope, 12);
  const prompt = `A task-creation system produced a task that the user marked WRONG.
Analyze the task, its source, and the creation process. Generalize the mistake into one reusable decision rule.
Do not merely repeat the rejected title. The rule must help prevent similar false tasks while preserving legitimate tasks.

Creation process: ${evidence.sourceScope}
Rejected task: ${evidence.task.title}
Task notes: ${evidence.task.notes || '(none)'}
Source: ${evidence.sourceLabel}
Project: ${evidence.projectSlug || '(none)'}
User explanation: ${userReason || '(none supplied; infer from the evidence)'}

Source content:
${evidence.sourceContent.slice(0, 12000)}

Existing learned rules:
${existingRules.length ? existingRules.map(item => `- ${item.lesson_key}: ${item.rule}`).join('\n') : '(none)'}

Return only JSON:
{
  "lesson_key": "stable short key; reuse an existing key when this is the same underlying mistake",
  "category": "false_assignment | guidance_as_task | historical_task | completed_task | wrong_owner | duplicate | other",
  "rule": "one precise instruction future task extractors can apply",
  "applies_to": {
    "source_scope": "${evidence.sourceScope}",
    "content_signals": ["short signal"],
    "exclusions": ["short exclusion"]
  },
  "explanation": "why this task was wrong and how the rule addresses the process failure"
}`;

  const modelId = getSystemModelId('task_extractor', 'system', 'google/gemini-2.5-pro-preview');
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://dchat.mclellan.scot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
  const data = await response.json();
  logUsageFromResponse({
    user,
    feature: 'task-wrong-learning',
    modelKey: 'task_extractor',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
  });
  return parseModelObject(data.choices?.[0]?.message?.content, {
    lesson_key: '',
    category: 'other',
    rule: '',
    applies_to: { source_scope: evidence.sourceScope },
    explanation: '',
  }, 'Task-learning response');
}

async function learnFromWrongTask(user, taskId, userReason = '') {
  const hub = db.hub();
  const evidence = taskEvidence(user, taskId);
  if (!evidence) throw new Error('Task not found');
  if (!LEARNABLE_SOURCES.has(evidence.sourceScope)) {
    throw new Error('Only automatically generated document and email tasks can train the learning system');
  }

  let lesson;
  let analysisError = null;
  try {
    lesson = await deriveLesson(user, evidence, userReason);
    if (!lesson.rule?.trim()) throw new Error('Lesson analysis returned no rule');
  } catch (err) {
    analysisError = err.message;
    lesson = fallbackLesson(evidence, userReason);
  }

  const lessonKey = normalizeKey(lesson.lesson_key);
  const lessonId = uuid();
  hub.prepare(`
    INSERT INTO task_extraction_lessons
      (id, user, source_scope, lesson_key, category, rule, applies_to,
       evidence_count, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, unixepoch(), unixepoch())
    ON CONFLICT(user, source_scope, lesson_key) DO UPDATE SET
      category = excluded.category,
      rule = excluded.rule,
      applies_to = excluded.applies_to,
      evidence_count = task_extraction_lessons.evidence_count + 1,
      active = 1,
      updated_at = unixepoch()
  `).run(
    lessonId,
    user,
    evidence.sourceScope,
    lessonKey,
    String(lesson.category || 'other').slice(0, 60),
    String(lesson.rule).trim().slice(0, 1200),
    JSON.stringify(lesson.applies_to || {}),
  );
  const storedLesson = hub.prepare(`
    SELECT * FROM task_extraction_lessons
    WHERE user = ? AND source_scope = ? AND lesson_key = ?
  `).get(user, evidence.sourceScope, lessonKey);

  const feedbackId = uuid();
  hub.prepare(`
    INSERT INTO task_extraction_feedback
      (id, user, task_id, task_title, task_notes, source_scope, source_id,
       document_id, document_filename, project_slug, source_excerpt, user_reason,
       analysis, analysis_error, lesson_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).run(
    feedbackId,
    user,
    evidence.task.id,
    evidence.task.title,
    evidence.task.notes || null,
    evidence.sourceScope,
    evidence.task.source_id || null,
    evidence.documentId,
    evidence.documentFilename,
    evidence.projectSlug,
    evidence.sourceContent.slice(0, 12000),
    String(userReason || '').trim().slice(0, 1000) || null,
    String(lesson.explanation || '').slice(0, 2000) || null,
    analysisError,
    storedLesson.id,
  );

  return {
    feedbackId,
    lesson: storedLesson,
    usedFallback: Boolean(analysisError),
  };
}

module.exports = {
  LEARNABLE_SOURCES,
  documentIdFromSourceId,
  excerptAroundTask,
  formatLearnedTaskRules,
  learnFromWrongTask,
  learnedTaskRules,
  normalizeKey,
  taskEvidence,
};
