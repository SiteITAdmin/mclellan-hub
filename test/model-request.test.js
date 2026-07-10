'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Stub the fetch wrapper before the module under test loads it, so no test
// ever touches the network. Each test sets `responses` to a queue of model
// message contents (or {httpStatus} for transport failures).
const fetchPath = require.resolve('../lib/fetch');
let responses = [];
let requestsSeen = [];
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: async (url, options) => {
    requestsSeen.push(JSON.parse(options.body));
    const next = responses.shift();
    if (next && typeof next === 'object' && next.httpStatus) {
      return { ok: false, status: next.httpStatus, text: async () => 'upstream error' };
    }
    return {
      ok: true,
      json: async () => ({
        model: 'test/model-1',
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        choices: [{ message: { content: next } }],
      }),
    };
  },
};

const db = require('../lib/db');
const { requestModelObject, modelShapeHealth } = require('../lib/model-request');
const { capoChecks } = require('../lib/hub-family-agents');

const PREFIX = `model-request-test-${Date.now()}`;

function logsFor(feature) {
  return db.hub().prepare(
    'SELECT status, error_msg FROM request_logs WHERE search_provider = ? ORDER BY ts, rowid'
  ).all(feature);
}

test.after(() => {
  db.hub().prepare("DELETE FROM request_logs WHERE search_provider LIKE ?").run(`${PREFIX}%`);
  db.hub().prepare("DELETE FROM request_logs WHERE model_key LIKE ?").run(`${PREFIX}%`);
});

test.beforeEach(() => {
  responses = [];
  requestsSeen = [];
});

test('clean first attempt logs ok and returns the object', async () => {
  responses = ['{"label": "work"}'];
  const feature = `${PREFIX}-clean`;
  const result = await requestModelObject({
    modelId: 'test/model-1',
    messages: [{ role: 'user', content: 'classify' }],
    feature,
    defaults: { label: null },
    label: 'test response',
    backoffMs: 0,
  });
  assert.equal(result.label, 'work');
  const logs = logsFor(feature);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'ok');
});

test('bad shape then recovery logs shape_failure + retried and adds the corrective instruction', async () => {
  responses = ['null', '{"label": "personal"}'];
  const feature = `${PREFIX}-recover`;
  const result = await requestModelObject({
    modelId: 'test/model-1',
    messages: [{ role: 'user', content: 'classify' }],
    feature,
    defaults: { label: null },
    label: 'test response',
    backoffMs: 0,
  });
  assert.equal(result.label, 'personal');
  const logs = logsFor(feature);
  assert.deepEqual(logs.map(l => l.status), ['shape_failure', 'retried']);
  assert.match(logs[0].error_msg, /must be a JSON object/);
  assert.match(logs[1].error_msg, /recovered after 1 bad-shape/);
  // The retry prompt restates the shape contract.
  assert.match(requestsSeen[1].messages[0].content, /Retry instruction/);
  assert.doesNotMatch(requestsSeen[0].messages[0].content, /Retry instruction/);
});

test('exhausted attempts throw with parseModelObject wording preserved', async () => {
  responses = ['[]', '"still not an object"'];
  const feature = `${PREFIX}-exhaust`;
  await assert.rejects(
    requestModelObject({
      modelId: 'test/model-1',
      messages: [{ role: 'user', content: 'classify' }],
      feature,
      defaults: {},
      label: 'Email classifier response',
      backoffMs: 0,
    }),
    /Email classifier response must be a JSON object/,
  );
  const logs = logsFor(feature);
  assert.deepEqual(logs.map(l => l.status), ['shape_failure', 'shape_failure']);
});

test('HTTP errors throw immediately without shape rows', async () => {
  responses = [{ httpStatus: 502 }];
  const feature = `${PREFIX}-http`;
  await assert.rejects(
    requestModelObject({
      modelId: 'test/model-1',
      messages: [{ role: 'user', content: 'x' }],
      feature,
      backoffMs: 0,
    }),
    /OpenRouter 502/,
  );
  assert.equal(logsFor(feature).length, 0);
});

test('meta mode returns model, usage totals, and attempt count', async () => {
  responses = ['null', '{"items": [1]}'];
  const feature = `${PREFIX}-meta`;
  const result = await requestModelObject({
    modelId: 'test/model-1',
    messages: [{ role: 'user', content: 'extract' }],
    feature,
    defaults: { items: [] },
    label: 'test response',
    backoffMs: 0,
    meta: true,
  });
  assert.deepEqual(result.object.items, [1]);
  assert.equal(result.attempts, 2);
  assert.equal(result.usage.tokensIn, 20); // both attempts counted
});

test('modelShapeHealth flags a slot over the threshold and ignores thin traffic', () => {
  const hub = db.hub();
  const insert = hub.prepare(`
    INSERT INTO request_logs (id, ts, user, model_key, model_id, endpoint, tokens_in, tokens_out, cost_usd, status)
    VALUES (?, unixepoch(), 'system', ?, ?, ?, 1, 1, 0, ?)
  `);
  const badKey = `${PREFIX}-bad-slot`;
  const thinKey = `${PREFIX}-thin-slot`;
  for (let i = 0; i < 8; i++) insert.run(`${badKey}-${i}`, badKey, 'test/degrading-model', badKey, 'ok');
  for (let i = 0; i < 4; i++) insert.run(`${badKey}-f${i}`, badKey, 'test/degrading-model', badKey, 'shape_failure');
  insert.run(`${thinKey}-0`, thinKey, 'test/rare-model', thinKey, 'shape_failure');

  const { unhealthy } = modelShapeHealth({ sinceEpoch: Math.floor(Date.now() / 1000) - 3600 });
  const flagged = unhealthy.find(u => u.model_key === badKey);
  assert.ok(flagged, 'degrading slot should be flagged');
  assert.equal(flagged.shape_failures, 4);
  assert.ok(!unhealthy.find(u => u.model_key === thinKey), 'thin-traffic slot must not be flagged');

  hub.prepare('DELETE FROM request_logs WHERE model_key IN (?, ?)').run(badKey, thinKey);
});

test('model_governance capo includes the shape health check', () => {
  const checks = capoChecks('model_governance', 'douglas');
  const shapeCheck = checks.find(c => c.name === 'model_response_shape_health');
  assert.ok(shapeCheck, 'model_response_shape_health check must exist');
  assert.ok(['pass', 'warn', 'fail'].includes(shapeCheck.verdict));
});
