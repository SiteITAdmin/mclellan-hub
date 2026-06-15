'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  startExtractionRun,
  finishExtractionRun,
  listIngestionAudit,
  getIngestionAudit,
} = require('../lib/intelligence-audit');

const USER = `intel-audit-test-${Date.now()}`;

function addDocument({ withItem = true, modelId = 'test/model' } = {}) {
  const hub = db.hub();
  const sourceId = uuid();
  const documentId = uuid();
  const senderEmail = `${sourceId}@example.com`;
  hub.prepare(`
    INSERT INTO intel_sources
      (id, user, name, source_kind, match_type, match_value, briefing_priority)
    VALUES (?, ?, 'Test Dispatch', 'email', 'sender_email', ?, 5)
  `).run(sourceId, USER, senderEmail);
  hub.prepare(`
    INSERT INTO intel_documents
      (id, user, source_id, external_id, source_kind, title, sender_name,
       sender_email, published_at, content_text)
    VALUES (?, ?, ?, ?, 'email', 'Test issue', 'Test Dispatch', ?,
            unixepoch(), 'Stored source text')
  `).run(documentId, USER, sourceId, uuid(), senderEmail);
  if (withItem) {
    hub.prepare(`
      INSERT INTO intel_items
        (id, user, document_id, title, summary, content_text, item_type,
         category, extraction_model_id, extraction_model_label,
         extraction_method, extracted_at)
      VALUES (?, ?, ?, 'Extracted item', 'Useful summary', 'Extracted content',
              'analysis', 'Other', ?, 'Test Model', 'ai', unixepoch())
    `).run(uuid(), USER, documentId, modelId);
  }
  return documentId;
}

test.after(() => {
  const hub = db.hub();
  hub.prepare('DELETE FROM intel_extraction_runs WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM intel_items WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM intel_documents WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM intel_sources WHERE user = ?').run(USER);
});

test('records and filters newsletter extraction runs', () => {
  const documentId = addDocument();
  const runId = startExtractionRun({
    user: USER,
    documentId,
    method: 'ai',
    requestedModelId: 'requested/model',
  });
  finishExtractionRun(runId, {
    status: 'complete',
    actualModelId: 'actual/model',
    attemptCount: 2,
    itemCount: 1,
    tokensIn: 120,
    tokensOut: 45,
    costUsd: 0.0012,
    durationMs: 850,
  });

  const rows = listIngestionAudit(USER, {
    sourceKind: 'email',
    status: 'complete',
    model: 'actual/model',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, documentId);
  assert.equal(rows[0].resolved_model_id, 'actual/model');
  assert.equal(rows[0].attempt_count, 2);
  assert.equal(rows[0].tokens_in, 120);

  const detail = getIngestionAudit(USER, documentId);
  assert.equal(detail.document.source_name, 'Test Dispatch');
  assert.equal(detail.items.length, 1);
  assert.equal(detail.runs.length, 1);
  assert.equal(detail.runs[0].actual_model_id, 'actual/model');
});

test('reconstructs historical status and model from item records', () => {
  const documentId = addDocument({ modelId: 'legacy/model' });
  const rows = listIngestionAudit(USER, {
    status: 'complete',
    model: 'legacy/model',
  });
  const row = rows.find(candidate => candidate.id === documentId);

  assert.ok(row);
  assert.equal(row.run_id, null);
  assert.equal(row.resolved_status, 'complete');
  assert.equal(row.resolved_model_id, 'legacy/model');
});
