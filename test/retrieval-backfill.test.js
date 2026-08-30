'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retrieval-backfill-'));
const tempDb = path.join(tempDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tempDb);
process.env.HUB_DB_PATH = tempDb;

const { backfillEmbeddings } = require('../lib/retrieval');

test.after(() => {
  try { require('../lib/db').hub().close(); } catch (_) {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function evidence(id, { complete = true, sourceKind = 'email_summary' } = {}) {
  return {
    source_kind: sourceKind,
    source_id: id,
    revision_hash: `revision-${id}`,
    complete,
    chunks: complete ? [{ text: `body ${id}` }] : [],
  };
}

test('incomplete raw evidence is visible but not counted as actionable embedding backlog', async () => {
  const indexed = [];
  const result = await backfillEmbeddings('backfill-incomplete', {
    limit: 1,
    compiledSources: [],
    listSourceEvidenceFn: () => [
      evidence('missing-body', { complete: false }),
      evidence('ready-1'),
      evidence('ready-2'),
    ],
    isIndexedFn: () => false,
    indexSourceFn: async (_user, _kind, id) => { indexed.push(id); return 1; },
  });

  assert.deepEqual(indexed, ['ready-1']);
  assert.equal(result.skippedIncomplete, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.remaining, 1, 'only the second complete source remains actionable');
});

test('an unavailable embedder respects the attempt limit and leaves retryable work visible', async () => {
  let attempts = 0;
  const result = await backfillEmbeddings('backfill-failure-cap', {
    limit: 1,
    compiledSources: [],
    listSourceEvidenceFn: () => [evidence('ready-1'), evidence('ready-2')],
    isIndexedFn: () => false,
    indexSourceFn: async () => { attempts += 1; throw new Error('embedding transport unavailable'); },
  });

  assert.equal(attempts, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.retryableFailures, 1);
  assert.equal(result.remaining, 2);
});

test('a source-kind-limited backfill preserves only the requested canonical evidence lane', async () => {
  const requestedKinds = [];
  const indexed = [];
  const result = await backfillEmbeddings('backfill-communications-only', {
    limit: 10,
    sourceKinds: ['email_summary', 'messaging_message'],
    compiledSources: [],
    listSourceEvidenceFn: (_user, kind) => {
      requestedKinds.push(kind);
      return [evidence(`${kind}-1`, { sourceKind: kind })];
    },
    isIndexedFn: () => false,
    indexSourceFn: async (_user, kind, id) => {
      indexed.push(`${kind}:${id}`);
      return 1;
    },
  });

  assert.deepEqual(requestedKinds, ['email_summary', 'messaging_message']);
  assert.deepEqual(indexed, ['email_summary:email_summary-1', 'messaging_message:messaging_message-1']);
  assert.equal(result.processed, 2);
});
