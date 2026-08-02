'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('document task endpoint queues canonical CRM processing before any direct model/provider path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hub-documents.js'), 'utf8');
  const start = source.indexOf("router.post('/api/documents/:id/extract-tasks'");
  const end = source.indexOf("router.post('/api/documents/:id/delete'", start);
  assert.ok(start >= 0 && end > start, 'extract-tasks route is present');
  const handler = source.slice(start, end);
  const normalStart = handler.indexOf('if (!legacyDirectCrmWritesEnabled())');
  const legacyStart = handler.indexOf('// Rollback-only compatibility path.');
  assert.ok(normalStart >= 0 && legacyStart > normalStart);
  const normalPath = handler.slice(normalStart, legacyStart);

  assert.match(normalPath, /queueCrmKnowledgeEngine/);
  assert.match(normalPath, /sourceKind:\s*'document'/);
  assert.match(normalPath, /sourceId:\s*doc\.id/);
  assert.match(normalPath, /status\(202\)/);
  assert.match(normalPath, /no task was created directly/);
  assert.doesNotMatch(normalPath, /createTask\s*\(/);
  assert.doesNotMatch(normalPath, /openrouter\.ai\/api/);
  assert.match(handler, /const \{ createTask \} = require\('\.\.\/lib\/google-tasks'\)/);
  assert.match(handler, /if \(!legacyDirectCrmWritesEnabled\(\)\)/);
});

test('saved chat answers carry a structural generated-content marker', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'hub-documents.js'), 'utf8');
  const start = source.indexOf("router.post('/api/messages/:msgId/save-to-project'");
  const end = source.indexOf('// ── Save message to wiki', start);
  assert.ok(start >= 0 && end > start, 'save-to-project route is present');
  const handler = source.slice(start, end);
  assert.match(handler, /auto_generated:\s*true/);
  assert.match(handler, /generated_kind:\s*"chat-answer"/);
  assert.match(handler, /assistant_message_id/);
});
