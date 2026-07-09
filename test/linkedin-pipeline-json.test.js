const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../lib/linkedin-pipeline');

test('LinkedIn JSON parser accepts fenced JSON content', () => {
  const parsed = _test.parseJsonMessage({
    choices: [{
      finish_reason: 'stop',
      message: { content: '```json\n{"overall_score":4,"recruiter_value":"STRONG"}\n```' },
    }],
  }, 'test/model', 'linkedin-scorer');

  assert.deepEqual(parsed, {
    overall_score: 4,
    recruiter_value: 'STRONG',
  });
});

test('LinkedIn JSON parser reports empty model content clearly', () => {
  assert.throws(() => _test.parseJsonMessage({
    choices: [{
      finish_reason: 'stop',
      message: { content: null, reasoning: 'hidden chain' },
    }],
  }, 'test/model', 'linkedin-scorer'), /returned empty content.*linkedin-scorer.*reasoning=present/);
});
