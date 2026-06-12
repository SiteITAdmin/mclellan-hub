'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  documentIdFromSourceId,
  excerptAroundTask,
  normalizeKey,
} = require('../lib/task-learning');

test('document source IDs resolve to their source document', () => {
  assert.equal(documentIdFromSourceId('doc:abc-123:Review report'), 'abc-123');
  assert.equal(documentIdFromSourceId('email:abc'), null);
});

test('lesson keys are stable and bounded', () => {
  assert.equal(normalizeKey(' Guidance as Task '), 'guidance-as-task');
  assert.equal(normalizeKey(''), 'explicit-ownership-required');
});

test('long source evidence is centered around the rejected task', () => {
  const content = `${'before '.repeat(3000)}Redraft the LinkedIn post to score higher${' after'.repeat(3000)}`;
  const excerpt = excerptAroundTask(content, 'Redraft the LinkedIn post to score higher', '', 1000);
  assert.match(excerpt, /Redraft the LinkedIn post/);
  assert(excerpt.length <= 1000);
});
