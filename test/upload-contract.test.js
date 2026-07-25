'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadedFiles } = require('../routes/hub-shared');

test('upload contract accepts the existing project button field name', () => {
  const file = { originalname: 'M365 plan.pdf' };
  assert.deepEqual(uploadedFiles({ file: [file] }), [file]);
});

test('upload contract retains the multi-file chat field name', () => {
  const files = [{ originalname: 'one.pdf' }, { originalname: 'two.pdf' }];
  assert.deepEqual(uploadedFiles({ files }), files);
});
