'use strict';

const db = require('./db');
const { uuid } = require('./id');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');

function normalizeKey(value) {
  return String(value || 'user-rejected-suggestion')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'user-rejected-suggestion';
}

function suggestionLessons(user, domain, limit = 8) {
  return db.hub().prepare(`
    SELECT lesson_key, category, rule, applies_to, evidence_count
    FROM suggestion_lessons
    WHERE user = ? AND active = 1 AND domain IN (?, 'all')
    ORDER BY evidence_count DESC, updated_at DESC
    LIMIT ?
  `).all(user, domain, limit);
}

function formatSuggestionLessons(user, domain) {
  const lessons = suggestionLessons(user, domain);
  if (!lessons.length) return '';
  return `\n\nLearned relevance rules from Douglas's corrections:
${lessons.map(item => `- ${item.rule} [evidence: ${item.evidence_count}]`).join('\n')}
Apply these rules when appraising the current evidence. They override generic suggestion instincts.`;
}

function fallbackLesson(suggestion, userReason) {
  const reason = String(userReason || '').trim();
  return {
    lesson_key: `user-correction-${normalizeKey(reason).slice(0, 55)}`,
    category: 'other',
    rule: `Do not surface ${suggestion.domain} suggestions matching this correction unless materially different evidence resolves it: ${reason}`,
    applies_to: { domain: suggestion.domain, user_reason: reason },
    explanation: 'A conservative rule was retained directly from the user correction because automated analysis was unavailable.',
  };
}

async function deriveLesson(user, suggestion, userReason) {
  const existing = suggestionLessons(user, suggestion.domain, 12);
  const prompt = `${getSystemPrompt('suggestion_rule_learner', 'system', PROMPTS.suggestion_rule_learner)}

Suggestion domain: ${suggestion.domain}
Rejected suggestion: #${suggestion.short_code || '?'} ${suggestion.title}
Suggestion body: ${suggestion.body}
User explanation: ${userReason}

Stored evidence:
${String(suggestion.evidence || '(none)').slice(0, 12000)}

Existing learned rules:
${existing.length ? existing.map(item => `- ${item.lesson_key}: ${item.rule}`).join('\n') : '(none)'}`;

  return requestModelObject({
    modelId: getSystemModelId('suggestions', 'system', 'google/gemini-2.5-flash'),
    messages: [{ role: 'user', content: prompt }],
    user,
    feature: 'suggestion-wrong-learning',
    modelKey: 'suggestions',
    taskCode: TASK_CODES.SUGGESTIONS,
    defaults: {
      lesson_key: '', category: 'other', rule: '',
      applies_to: { domain: suggestion.domain }, explanation: '',
    },
    label: 'Suggestion-learning response',
  });
}

async function learnFromWrongSuggestion(user, suggestionId, userReason, { derive = deriveLesson } = {}) {
  const hub = db.hub();
  const suggestion = hub.prepare(
    'SELECT * FROM suggestions WHERE id = ? AND user = ?'
  ).get(suggestionId, user);
  if (!suggestion) throw new Error('Suggestion not found');
  const reason = String(userReason || '').trim();
  if (!reason) throw new Error('Please explain why the suggestion is wrong');

  let lesson;
  let analysisError = null;
  try {
    lesson = await derive(user, suggestion, reason);
    if (!lesson?.rule?.trim()) throw new Error('Lesson analysis returned no rule');
  } catch (err) {
    analysisError = err.message;
    lesson = fallbackLesson(suggestion, reason);
  }

  const lessonKey = normalizeKey(lesson.lesson_key);
  const lessonId = uuid();
  hub.transaction(() => {
    hub.prepare(`
      INSERT INTO suggestion_lessons
        (id, user, domain, lesson_key, category, rule, applies_to,
         evidence_count, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, unixepoch(), unixepoch())
      ON CONFLICT(user, domain, lesson_key) DO UPDATE SET
        category = excluded.category,
        rule = excluded.rule,
        applies_to = excluded.applies_to,
        evidence_count = suggestion_lessons.evidence_count + 1,
        active = 1,
        updated_at = unixepoch()
    `).run(
      lessonId, user, suggestion.domain, lessonKey,
      String(lesson.category || 'other').slice(0, 60),
      String(lesson.rule).trim().slice(0, 1200),
      JSON.stringify(lesson.applies_to || {}),
    );
    const stored = hub.prepare(`
      SELECT id FROM suggestion_lessons
      WHERE user = ? AND domain = ? AND lesson_key = ?
    `).get(user, suggestion.domain, lessonKey);
    hub.prepare(`
      INSERT INTO suggestion_feedback
        (id, user, suggestion_id, suggestion_code, suggestion_domain,
         suggestion_title, suggestion_body, suggestion_evidence, user_reason,
         analysis, analysis_error, lesson_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      uuid(), user, suggestion.id, suggestion.short_code, suggestion.domain,
      suggestion.title, suggestion.body, suggestion.evidence, reason.slice(0, 2000),
      String(lesson.explanation || '').slice(0, 2000) || null,
      analysisError, stored.id,
    );
    hub.prepare("UPDATE suggestions SET status = 'wrong' WHERE id = ? AND user = ?")
      .run(suggestion.id, user);
    hub.prepare(`
      UPDATE knowledge_atoms SET status = 'retired', updated_at = unixepoch()
      WHERE user = ? AND derived_by = 'suggestion_opportunity'
        AND status = 'active' AND source_refs LIKE ?
    `).run(user, `%${suggestion.id}%`);
  })();

  const storedLesson = hub.prepare(`
    SELECT * FROM suggestion_lessons
    WHERE user = ? AND domain = ? AND lesson_key = ?
  `).get(user, suggestion.domain, lessonKey);
  return { lesson: storedLesson, usedFallback: Boolean(analysisError) };
}

module.exports = {
  formatSuggestionLessons,
  learnFromWrongSuggestion,
  normalizeKey,
  suggestionLessons,
};
