'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  autoExtractDocumentTasks,
  connectDocumentsToContacts,
  connectFlightsToTasks,
  connectRegToProjects,
} = require('../lib/mycelium');

const USER = '__test_mycelium_containment';
const hub = () => db.hub();

function cleanup() {
  const h = hub();
  h.prepare('DELETE FROM google_tasks WHERE user = ?').run(USER);
  h.prepare('DELETE FROM flights WHERE user = ?').run(USER);
  h.prepare('DELETE FROM documents WHERE user = ?').run(USER);
  h.prepare('DELETE FROM knowledge_receipts WHERE user = ? AND stage = \'mycelium_document_tasks\'').run(USER);
  h.prepare("DELETE FROM system_jobs WHERE type = 'crm_knowledge_engine' AND json_extract(payload, '$.user') = ?").run(USER);
  h.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
  h.prepare('DELETE FROM projects WHERE user = ?').run(USER);
  h.prepare('DELETE FROM crm_facts WHERE user = ?').run(USER);
}

test.beforeEach(cleanup);
test.after(cleanup);

test('document names do not deterministically create contact_projects links', () => {
  const h = hub();
  const projectId = uuid();
  const contactId = uuid();
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
    .run(projectId, USER, 'Containment Project', 'containment-project');
  h.prepare('INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, ?, ?)')
    .run(contactId, USER, 'A Known Contact', '[]');
  h.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, markdown, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), USER, projectId, 'evidence.md', 'text/markdown', 'A Known Contact is mentioned.', Math.floor(Date.now() / 1000));

  const report = [];
  const result = connectDocumentsToContacts(USER, h, report);
  assert.equal(result.linked, 0);
  assert.equal(h.prepare('SELECT COUNT(*) AS n FROM contact_projects WHERE contact_id = ? AND project_id = ?')
    .get(contactId, projectId).n, 0);
  assert.match(report.join('\n'), /deferred to knowledge synthesis/);
});

test('regulatory keyword matches do not write Douglas crm_facts', () => {
  const h = hub();
  const itemId = uuid();
  h.prepare(`
    INSERT INTO reg_monitor_items (id, site, title, url, synopsis, found_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(itemId, 'test-reg', 'Containment regulation', 'https://example.test/reg', 'Project evidence', Math.floor(Date.now() / 1000));
  const before = h.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'reg-monitor'").get(USER).n;
  const report = [];
  const result = connectRegToProjects(USER, h, report);
  const after = h.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'reg-monitor'").get(USER).n;
  assert.equal(result.tagged, 0);
  assert.equal(after, before);
  assert.ok(h.prepare('SELECT 1 FROM reg_monitor_items WHERE id = ?').get(itemId));
  assert.match(report.join('\n'), /retained .*regulatory item/i);
  h.prepare('DELETE FROM reg_monitor_items WHERE id = ?').run(itemId);
});

test('flight task failures are counted and never reported as created', async () => {
  const h = hub();
  const flightId = uuid();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  h.prepare(`
    INSERT INTO flights (id, user, flight_number, direction, flight_date, status)
    VALUES (?, ?, ?, ?, ?, 'scheduled')
  `).run(flightId, USER, 'TEST1', 'DUB → EDI', today);
  const report = [];
  const result = await connectFlightsToTasks(USER, h, report, {
    createTaskFn: async () => { throw new Error('task service unavailable'); },
  });
  assert.equal(result.created, 0);
  assert.equal(result.errors, 2);
  assert.equal(result.errorDetails.length, 2);
  assert.doesNotMatch(report.join('\n'), /Created prep task/);
});

test('normal document task processing queues canonical review without a shadow extractor', async () => {
  const h = hub();
  const projectId = uuid();
  const documentId = uuid();
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
    .run(projectId, USER, 'Retry Project', 'retry-project');
  h.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, markdown)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(documentId, USER, projectId, 'retry.md', 'text/markdown', '# Retry\nPlease do the task.');

  let createTaskCalls = 0;
  let modelCalls = 0;
  const jobsBefore = h.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").get().n;
  const result = await autoExtractDocumentTasks(USER, h, [], {
    fetchFn: async () => { modelCalls++; throw new Error('shadow extractor must not run'); },
    createTaskFn: async () => { createTaskCalls++; return { id: 'must-not-be-created' }; },
  });
  assert.equal(result.created, 0);
  assert.equal(result.deferred, 1);
  assert.equal(result.status, 'deferred_to_crm_knowledge');
  assert.equal(createTaskCalls, 0);
  assert.equal(modelCalls, 0);
  assert.equal(h.prepare('SELECT task_extracted_at FROM documents WHERE id = ?').get(documentId).task_extracted_at, null);
  assert.equal(h.prepare(`
    SELECT COUNT(*) AS n FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'document' AND source_id = ?
      AND stage = 'mycelium_document_tasks'
  `).get(USER, documentId).n, 0);
  const jobsAfterFirst = h.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").get().n;
  assert.ok(jobsAfterFirst === jobsBefore || jobsAfterFirst === jobsBefore + 1);

  const second = await autoExtractDocumentTasks(USER, h, [], {
    fetchFn: async () => { modelCalls++; throw new Error('shadow extractor must not run'); },
    createTaskFn: async () => { createTaskCalls++; return { id: 'must-not-be-created' }; },
  });
  assert.equal(second.deferred, 1);
  assert.equal(modelCalls, 0);
  assert.equal(createTaskCalls, 0);
  const jobsAfterSecond = h.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type = 'crm_knowledge_engine' AND status IN ('pending','running')").get().n;
  assert.equal(jobsAfterSecond, jobsAfterFirst, 'repeated Mycelium runs reuse one canonical engine job');
  assert.equal(h.prepare(`
    SELECT COUNT(*) AS n FROM knowledge_receipts
    WHERE user = ? AND source_kind = 'document' AND source_id = ?
      AND stage = 'mycelium_document_tasks'
  `).get(USER, documentId).n, 0);
});

test('legacy direct document task projection requires explicit opt-in', async () => {
  const h = hub();
  const projectId = uuid();
  const documentId = uuid();
  h.prepare('INSERT INTO projects (id, user, name, slug) VALUES (?, ?, ?, ?)')
    .run(projectId, USER, 'Legacy Project', 'legacy-project');
  h.prepare(`
    INSERT INTO documents (id, user, project_id, filename, mimetype, markdown)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(documentId, USER, projectId, 'legacy.md', 'text/markdown', '# Legacy\nPlease do the task.');

  const previous = process.env.CRM_LEGACY_DIRECT_WRITES;
  process.env.CRM_LEGACY_DIRECT_WRITES = '1';
  try {
    const result = await autoExtractDocumentTasks(USER, h, [], {
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: [{ title: 'Legacy task' }] }) } }] }),
      }),
      createTaskFn: async () => ({ id: 'legacy-created' }),
    });
    assert.equal(result.created, 1);
    assert.equal(result.deferred, 0);
    assert.equal(result.directWrites, true);
    assert.ok(h.prepare('SELECT task_extracted_at FROM documents WHERE id = ?').get(documentId).task_extracted_at);
  } finally {
    if (previous === undefined) delete process.env.CRM_LEGACY_DIRECT_WRITES;
    else process.env.CRM_LEGACY_DIRECT_WRITES = previous;
  }
});
