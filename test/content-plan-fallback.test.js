'use strict';

const assert = require('assert');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { normalizePolicy } = require('../lib/content-cadence-policy');
const { buildContentTopicPlan } = require('../lib/content-topic-plan');

const USER = 'content-plan-fallback-test';
const hub = db.hub();
const docId = uuid();
const itemId = uuid();
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });

try {
  assert.strictEqual(normalizePolicy({ topicPlan: {} }).topicPlan.showIntelFallback, false);
  assert.strictEqual(normalizePolicy({ topicPlan: { showIntelFallback: 'true' } }).topicPlan.showIntelFallback, true);

  hub.prepare(`
    INSERT INTO intel_documents (id, user, external_id, source_kind, title, content_text)
    VALUES (?, ?, ?, 'test', 'External AI source', 'test')
  `).run(docId, USER, docId);
  hub.prepare(`
    INSERT INTO intel_items
      (id, user, document_id, title, summary, content_text, item_type, category, selected)
    VALUES (?, ?, ?, 'Useful AI topic', 'A relevant AI summary.', 'test', 'analysis', 'AI & Machine Learning', 1)
  `).run(itemId, USER, docId);

  const quiet = buildContentTopicPlan(USER, {
    days: 1,
    suggestionsPerDay: 3,
    showIntelFallback: false,
    dayPrefs: { [today]: { topic: 'AI & Technology', tone: 'professional' } },
  });
  assert.strictEqual(quiet.days[0].suggestions.length, 0);

  const fallback = buildContentTopicPlan(USER, {
    days: 1,
    suggestionsPerDay: 3,
    showIntelFallback: true,
    dayPrefs: { [today]: { topic: 'AI & Technology', tone: 'professional' } },
  });
  assert.strictEqual(fallback.days[0].suggestions.length, 1);
  assert.strictEqual(fallback.days[0].suggestions[0].title, 'Useful AI topic');

  console.log('Content plan fallback tests passed.');
} finally {
  hub.prepare('DELETE FROM intel_items WHERE id = ?').run(itemId);
  hub.prepare('DELETE FROM intel_documents WHERE id = ?').run(docId);
}
