'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../lib/db');
const { requestModelObject, modelShapeHealth } = require('../lib/model-request');

const PREFIX = `model-request-test-${Date.now()}`;

function logsFor(feature) {
  return db.hub().prepare(
    'SELECT status, error_msg, endpoint FROM request_logs WHERE search_provider = ? ORDER BY ts, rowid'
  ).all(feature);
}

test.after(() => {
  db.hub().prepare("DELETE FROM request_logs WHERE search_provider LIKE ?").run(`${PREFIX}%`);
  db.hub().prepare("DELETE FROM request_logs WHERE model_key LIKE ?").run(`${PREFIX}%`);
});

function mockRunner(queue) {
  return async ({ feature, userPrompt }) => {
    void feature;
    const next = queue.shift();
    if (next && typeof next === 'object' && next.error) throw new Error(next.error);
    return {
      text: typeof next === 'string' ? next : JSON.stringify(next),
      runner: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'low',
      durationMs: 5,
      inputChars: String(userPrompt || '').length,
    };
  };
}

test('clean first attempt logs ok and returns the object', async () => {
  const feature = `${PREFIX}-clean`;
  const result = await requestModelObject({
    modelId: 'ignored/openrouter-id',
    messages: [{ role: 'user', content: 'classify' }],
    feature,
    defaults: { label: null },
    label: 'test response',
    backoffMs: 0,
    _runner: mockRunner(['{"label": "work"}']),
  });
  assert.equal(result.label, 'work');
  const logs = logsFor(feature);
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].status, 'ok');
  assert.notEqual(logs[0].endpoint, 'openrouter');
});

test('bad shape then recovery logs shape_failure + retried', async () => {
  const feature = `${PREFIX}-recover`;
  const result = await requestModelObject({
    modelId: 'ignored',
    messages: [{ role: 'user', content: 'classify' }],
    feature,
    defaults: { label: null },
    label: 'test response',
    backoffMs: 0,
    _runner: mockRunner(['null', '{"label": "personal"}']),
  });
  assert.equal(result.label, 'personal');
  const statuses = logsFor(feature).map(l => l.status);
  assert.ok(statuses.includes('shape_failure'));
  assert.ok(statuses.includes('retried') || statuses.includes('ok'));
});

test('exhausted attempts throw with parseModelObject wording preserved', async () => {
  const feature = `${PREFIX}-exhaust`;
  await assert.rejects(
    requestModelObject({
      modelId: 'ignored',
      messages: [{ role: 'user', content: 'classify' }],
      feature,
      defaults: {},
      label: 'Email classifier response',
      backoffMs: 0,
      _runner: mockRunner(['[]', '"still not an object"']),
    }),
    /Email classifier response must be a JSON object/,
  );
});

test('transport failure fails closed without OpenRouter fallback', async () => {
  const feature = `${PREFIX}-http`;
  await assert.rejects(
    requestModelObject({
      modelId: 'ignored',
      messages: [{ role: 'user', content: 'x' }],
      feature,
      backoffMs: 0,
      _runner: mockRunner([{ error: 'CLI unavailable' }]),
    }),
    /CLI unavailable/,
  );
});

test('meta mode returns model and attempt count', async () => {
  const feature = `${PREFIX}-meta`;
  const result = await requestModelObject({
    modelId: 'ignored',
    messages: [{ role: 'user', content: 'extract' }],
    feature,
    defaults: { items: [] },
    label: 'test response',
    backoffMs: 0,
    meta: true,
    _runner: mockRunner(['null', '{"items": [1]}']),
  });
  assert.deepEqual(result.object.items, [1]);
  assert.equal(result.attempts, 2);
  assert.match(result.modelId, /codex\//);
});

test('modelShapeHealth flags a slot over the threshold and ignores thin traffic', () => {
  const hub = db.hub();
  const insert = hub.prepare(`
    INSERT INTO request_logs (id, ts, user, model_key, model_id, endpoint, tokens_in, tokens_out, cost_usd, status)
    VALUES (?, unixepoch(), 'system', ?, ?, ?, 1, 1, 0, ?)
  `);
  const badKey = `${PREFIX}-bad-slot`;
  const thinKey = `${PREFIX}-thin-slot`;
  for (let i = 0; i < 12; i++) {
    insert.run(`id-bad-${i}-${Date.now()}`, badKey, 'codex/luna', 'codex', i < 3 ? 'shape_failure' : 'ok');
  }
  insert.run(`id-thin-${Date.now()}`, thinKey, 'codex/luna', 'codex', 'shape_failure');
  const health = modelShapeHealth({ minCalls: 10 });
  assert.ok(health.unhealthy.some(u => u.model_key === badKey));
  assert.ok(!health.unhealthy.some(u => u.model_key === thinKey));
});
