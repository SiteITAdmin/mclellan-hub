'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelObject } = require('../lib/model-response');

test('parseModelObject fills optional fields from defaults', () => {
  assert.deepEqual(
    parseModelObject('{"summary":"Useful"}', { summary: '', project_slug: null }),
    { summary: 'Useful', project_slug: null }
  );
});

test('parseModelObject rejects null and array responses', () => {
  assert.throws(() => parseModelObject('null', {}), /must be a JSON object/);
  assert.throws(() => parseModelObject('[]', {}), /must be a JSON object/);
});

test('parseModelObject reports malformed JSON clearly', () => {
  assert.throws(() => parseModelObject('{bad', {}, 'Classifier response'), /Classifier response was not valid JSON/);
});

test('parseModelObject repairs an unescaped quote inside a string value', () => {
  const raw = '{"humanized_text": "He said "no" to that plan.", "changes": []}';
  assert.deepEqual(parseModelObject(raw, {}), {
    humanized_text: 'He said "no" to that plan.',
    changes: [],
  });
});

test('parseModelObject repairs several unescaped quotes, including before commas', () => {
  const raw = '{"a": "She replied "stop", then "go" twice.", "b": "plain"}';
  assert.deepEqual(parseModelObject(raw, {}), {
    a: 'She replied "stop", then "go" twice.',
    b: 'plain',
  });
});

test('parseModelObject repairs unescaped quotes in array elements', () => {
  const raw = '{"items": ["said "yes" loudly", "ok"]}';
  assert.deepEqual(parseModelObject(raw, {}), { items: ['said "yes" loudly', 'ok'] });
});

test('parseModelObject repairs unescaped quotes combined with raw newlines (humanizer failure shape)', () => {
  // Mirrors the production error: value on line 2, stray quotes deep into the string.
  const padding = 'x'.repeat(560);
  const raw = `{\n"humanized_text": "${padding} they call it "the gap" here.", "changes": []}`;
  const parsed = parseModelObject(raw, {}, 'AI humanizer response');
  assert.equal(parsed.humanized_text, `${padding} they call it "the gap" here.`);
});

test('parseModelObject leaves already-escaped quotes alone', () => {
  const raw = '{"a": "properly \\"quoted\\" text"}';
  assert.deepEqual(parseModelObject(raw, {}), { a: 'properly "quoted" text' });
});

test('parseModelObject still rejects structurally broken JSON', () => {
  assert.throws(() => parseModelObject('{"a": 1 2}', {}, 'X'), /X was not valid JSON/);
  assert.throws(() => parseModelObject('{"a": "unterminated', {}, 'X'), /X was not valid JSON/);
});
