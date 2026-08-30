'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-wiki-knowledge-search-'));
const tempDb = path.join(tempDir, 'hub.db');
const vaultDir = path.join(tempDir, 'vault');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const db = require('../lib/db');
const { searchAll } = require('../lib/wiki-engine');
const {
  answerWikiSearch,
  gatherWikiKnowledgeEvidence,
  queryTerms,
} = require('../lib/wiki-knowledge-search');

const USER = 'wiki-knowledge-search-test';
const CONTACT_ID = 'wiki-knowledge-contact';

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM contacts WHERE user = ?').run(USER);
}

function insertAtom(id, value, confirmedAt) {
  db.hub().prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, first_seen, last_confirmed, updated_at)
    VALUES (?, ?, 'contact', ?, 'Alex Example', 'care_action_completed', ?,
            '[]', 0.9, 'active', ?, ?, ?)
  `).run(id, USER, CONTACT_ID, value, confirmedAt, confirmedAt, confirmedAt);
}

test.beforeEach(() => {
  cleanup();
  db.hub().prepare(`
    INSERT INTO contacts (id, user, name, aliases) VALUES (?, ?, 'Alex Example', '["Dad"]')
  `).run(CONTACT_ID, USER);
});

test.after(() => {
  cleanup();
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('vault fallback search accepts a natural-language question instead of requiring every word', () => {
  const peopleDir = path.join(vaultDir, 'People');
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(path.join(peopleDir, 'Alex Example.md'), '# Alex Example\n\nRecent support update.');

  const matches = searchAll('Tell me about Alex Example, most recent knowledge first');

  assert.equal(matches[0].title, 'Alex Example');
  assert.match(matches[0].excerpt, /Recent support update/);
});

test('a natural-language alias query prioritises recent compiled contact knowledge', async () => {
  insertAtom('wiki-old', 'Older support action.', 1_700_000_000);
  insertAtom('wiki-new', 'Most recent support action.', 1_710_000_000);

  const result = await gatherWikiKnowledgeEvidence(USER, 'Tell me about Dad, most recent knowledge first', {
    semanticSearchFn: async () => [],
  });

  assert.deepEqual(result.directContacts, [{ id: CONTACT_ID, name: 'Alex Example' }]);
  assert.equal(result.evidence[0].type, 'knowledge');
  assert.equal(result.evidence[0].excerpt, 'Most recent support action.');
  assert.equal(result.evidence[0].sourceId, 'A1');
  assert.deepEqual(queryTerms('Tell me about Dad, most recent knowledge first'), ['dad']);
});

test('semantic raw evidence supplements compiled claims without replacing them', async () => {
  insertAtom('wiki-compiled', 'Compiled care action.', 1_710_000_000);
  const result = await gatherWikiKnowledgeEvidence(USER, 'Dad update', {
    semanticSearchFn: async () => [{
      source_kind: 'messaging_message', source_id: 'message-1', chunk_text: 'A newer message update.', score: 0.82,
    }],
    resolveSourceEvidenceFn: () => ({
      complete: true, ts: 1_711_000_000, text: 'A newer message update.', source_kind: 'messaging_message', row: {},
    }),
    sourceDisplayFn: () => ({ title: 'Family chat', meta: 'Alex' }),
  });

  assert.equal(result.evidence[0].type, 'knowledge');
  assert.ok(result.evidence.some(entry => entry.type === 'source' && entry.typeLabel === 'Message'));
  assert.ok(result.evidence.some(entry => entry.sourceId === 'S1'));
});

test('vault notes are used only when compiled and canonical evidence are absent', async () => {
  const result = await gatherWikiKnowledgeEvidence(USER, 'unrelated unusual topic', {
    semanticSearchFn: async () => [],
    vaultFallback: [{
      title: 'Private handwritten note', typeLabel: 'Notes', excerpt: 'Fallback-only material.', created: '2026-08-30',
    }],
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].type, 'vault');
  assert.equal(result.evidence[0].sourceId, 'V1');
});

test('the answerer receives cited compiled evidence and drops invented source IDs', async () => {
  insertAtom('wiki-cited', 'Compiled fact for a cited answer.', 1_710_000_000);
  let modelInput = '';
  const result = await answerWikiSearch(USER, 'What is Dad doing?', {
    semanticSearchFn: async () => [],
    requestModelObjectFn: async ({ messages }) => {
      modelInput = messages.at(-1).content;
      return {
        headline: 'Alex update',
        summary: 'A source-backed answer.',
        facts: [
          { label: 'Known', detail: 'Compiled fact for a cited answer.', source_ids: ['A1', 'invented'] },
        ],
        gaps: [],
        assessment: 'Sufficient for this answer.',
      };
    },
  });

  assert.match(modelInput, /A1: Knowledge claim/);
  assert.match(modelInput, /Compiled fact for a cited answer/);
  assert.deepEqual(result.synthesis.facts[0].source_ids, ['A1']);
});
