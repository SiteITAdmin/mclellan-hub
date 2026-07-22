'use strict';

const db = require('./db');
const { uuid } = require('./id');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');

const SUGGESTION_OUTCOMES = Object.freeze({
  accepted: Object.freeze({ status: 'accepted', score: 100, label: 'Task created' }),
  not_this_time: Object.freeze({ status: 'not_this_time', score: 60, label: 'Not this time' }),
  dismissed: Object.freeze({ status: 'dismissed', score: 25, label: 'Dismissed' }),
  wrong: Object.freeze({ status: 'wrong', score: 0, label: 'Wrong' }),
});

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

function suggestionOutcomeSummary(user, domain, recentLimit = 8) {
  const hub = db.hub();
  const rows = hub.prepare(`
    SELECT suggestion_id, suggestion_evidence, outcome, quality_score,
           suggestion_title, created_at
    FROM suggestion_feedback
    WHERE user = ? AND suggestion_domain = ?
      AND outcome IS NOT NULL AND quality_score IS NOT NULL
    ORDER BY created_at DESC, rowid DESC
  `).all(user, domain);
  // A repeated proposal from the same source signal is one learning example,
  // not several enthusiastic votes for the model to repeat itself.
  const seen = new Set();
  const judged = rows.filter(row => {
    let key = `suggestion:${row.suggestion_id}`;
    if (domain === 'opportunity') {
      try {
        const evidence = JSON.parse(row.suggestion_evidence || '{}');
        const ids = (evidence.signals || []).map(signal => signal?.id).filter(Boolean).sort();
        if (ids.length) key = `signals:${ids.join('+')}`;
      } catch (_) {}
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const totalsByOutcome = new Map();
  for (const row of judged) {
    const current = totalsByOutcome.get(row.outcome) || { outcome: row.outcome, count: 0, average_score: 0 };
    current.count++;
    current.average_score += (Number(row.quality_score) - current.average_score) / current.count;
    totalsByOutcome.set(row.outcome, current);
  }
  const totals = [...totalsByOutcome.values()];
  const recent = judged.slice(0, recentLimit);
  const count = totals.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const scoreTotal = totals.reduce(
    (sum, row) => sum + Number(row.average_score || 0) * Number(row.count || 0),
    0,
  );
  return {
    count,
    averageScore: count ? Math.round(scoreTotal / count) : null,
    totals,
    recent,
  };
}

function formatSuggestionOutcomeSummary(user, domain) {
  const summary = suggestionOutcomeSummary(user, domain);
  if (!summary.count) return '';
  const byOutcome = new Map(summary.totals.map(row => [row.outcome, Number(row.count)]));
  const counts = Object.entries(SUGGESTION_OUTCOMES)
    .filter(([outcome]) => byOutcome.has(outcome))
    .map(([outcome, definition]) => `${definition.label}: ${byOutcome.get(outcome)} at ${definition.score}/100`)
    .join('; ');
  const recent = summary.recent.map(item => {
    const definition = SUGGESTION_OUTCOMES[item.outcome];
    const label = definition?.label || item.outcome;
    return `- [${item.quality_score}/100 · ${label}] ${String(item.suggestion_title || '').slice(0, 180)}`;
  }).join('\n');
  return `\n\nObserved feedback calibration from Douglas's choices (implicit statistical signals, not hard rejection rules):
- ${summary.count} judged suggestion${summary.count === 1 ? '' : 's'}; mean quality ${summary.averageScore}/100.
- ${counts}.
Recent scored outcomes:
${recent}
Use these outcomes only to learn transferable qualities of useful suggestions. Every scored example is historical and terminal: never repeat or paraphrase its concrete action. "Task created" means that action is now tracked and already handled by the suggestion system. "Not this time", "Dismissed", and "Wrong" also do not authorise retrying the same idea. Only materially new evidence may justify a genuinely different action. Only an explicit Wrong outcome can produce a hard correction.`;
}

function formatSuggestionLessons(user, domain) {
  const lessons = suggestionLessons(user, domain);
  const feedback = formatSuggestionOutcomeSummary(user, domain);
  if (!lessons.length) return feedback;
  return `${feedback}\n\nLearned relevance rules from Douglas's explicit Wrong corrections:
${lessons.map(item => `- ${item.rule} [evidence: ${item.evidence_count}]`).join('\n')}
Apply these rules when appraising the current evidence. They override generic suggestion instincts.`;
}

function recordSuggestionOutcome(user, suggestionId, outcome) {
  const definition = SUGGESTION_OUTCOMES[outcome];
  if (!definition || outcome === 'wrong') throw new Error('Unsupported implicit suggestion outcome');
  const hub = db.hub();
  return hub.transaction(() => {
    const suggestion = hub.prepare(`
      SELECT * FROM suggestions
      WHERE id = ? AND user = ? AND status = 'open'
        AND domain IN ('opportunity', 'travel', 'contact')
    `).get(suggestionId, user);
    if (!suggestion) return { ok: false, message: 'No open suggestion found.' };
    hub.prepare('UPDATE suggestions SET status = ? WHERE id = ? AND user = ?')
      .run(definition.status, suggestion.id, user);
    hub.prepare(`
      INSERT INTO suggestion_feedback
        (id, user, suggestion_id, suggestion_code, suggestion_domain,
         suggestion_title, suggestion_body, suggestion_evidence, outcome,
         quality_score, user_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', unixepoch())
    `).run(
      uuid(), user, suggestion.id, suggestion.short_code, suggestion.domain,
      suggestion.title, suggestion.body, suggestion.evidence, outcome, definition.score,
    );
    return { ok: true, suggestion, outcome, score: definition.score, label: definition.label };
  })();
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
    `SELECT * FROM suggestions
     WHERE id = ? AND user = ? AND status = 'open'
       AND domain IN ('opportunity', 'travel', 'contact')`
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
    const transitioned = hub.prepare(`
      UPDATE suggestions SET status = 'wrong'
      WHERE id = ? AND user = ? AND status = 'open'
    `).run(suggestion.id, user);
    if (!transitioned.changes) throw new Error('Suggestion not found');
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
         suggestion_title, suggestion_body, suggestion_evidence, outcome,
         quality_score, user_reason, analysis, analysis_error, lesson_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wrong', ?, ?, ?, ?, ?, unixepoch())
    `).run(
      uuid(), user, suggestion.id, suggestion.short_code, suggestion.domain,
      suggestion.title, suggestion.body, suggestion.evidence, SUGGESTION_OUTCOMES.wrong.score,
      reason.slice(0, 2000),
      String(lesson.explanation || '').slice(0, 2000) || null,
      analysisError, stored.id,
    );
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
  SUGGESTION_OUTCOMES,
  formatSuggestionOutcomeSummary,
  formatSuggestionLessons,
  learnFromWrongSuggestion,
  normalizeKey,
  recordSuggestionOutcome,
  suggestionOutcomeSummary,
  suggestionLessons,
};
