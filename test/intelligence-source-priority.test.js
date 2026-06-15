'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { retrieveIntelligenceItems } = require('../lib/newsletter-pipeline');

const USER = `intel-priority-test-${Date.now()}`;
const DATE = '2026-06-15';
const PUBLISHED_AT = Date.parse(`${DATE}T12:00:00.000Z`) / 1000;

function addItem(name, priority, publishedOffset = 0) {
  const hub = db.hub();
  const sourceId = uuid();
  const documentId = uuid();
  const itemId = uuid();
  hub.prepare(`
    INSERT INTO intel_sources
      (id, user, name, source_kind, match_type, match_value, briefing_priority)
    VALUES (?, ?, ?, 'email', 'sender_email', ?, ?)
  `).run(sourceId, USER, name, `${sourceId}@example.com`, priority);
  hub.prepare(`
    INSERT INTO intel_documents
      (id, user, source_id, external_id, source_kind, title, sender_name,
       sender_email, published_at, content_text)
    VALUES (?, ?, ?, ?, 'email', ?, ?, ?, ?, ?)
  `).run(
    documentId, USER, sourceId, uuid(), `${name} issue`, name,
    `${sourceId}@example.com`, PUBLISHED_AT + publishedOffset, 'Relevant source content.'
  );
  hub.prepare(`
    INSERT INTO intel_items
      (id, user, document_id, title, summary, content_text, item_type,
       category, published_at)
    VALUES (?, ?, ?, ?, ?, ?, 'analysis', 'Other', ?)
  `).run(
    itemId, USER, documentId, `${name} headline`, 'Relevant summary',
    'Relevant source content.', PUBLISHED_AT + publishedOffset
  );
  return itemId;
}

test.after(() => {
  const hub = db.hub();
  hub.prepare('DELETE FROM intel_items WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM intel_documents WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM intel_sources WHERE user = ?').run(USER);
});

test('source priority orders briefing candidates and excludes priority 1', async () => {
  addItem('Never Source', 1, 100);
  const normalId = addItem('Normal Source', 3, 50);
  const preferredId = addItem('Preferred Source', 5, 0);

  const items = await retrieveIntelligenceItems({
    user: USER,
    focus: '',
    dateFrom: DATE,
    dateTo: DATE,
    limit: 10,
  });

  assert.deepEqual(items.map(item => item.id), [preferredId, normalId]);
  assert.deepEqual(items.map(item => item.source_priority), [5, 3]);
});
