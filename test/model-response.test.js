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
