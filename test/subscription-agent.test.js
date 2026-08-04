'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RUNNERS, configuredRunner, commandFor, textFromOutput } = require('../lib/subscription-agent');

test('Nakai maps to local Claude Opus at high effort', () => {
  const command = commandFor(RUNNERS.nakai_daily_briefing, 'system');
  assert.match(command.command, /(?:^|\/)claude$/);
  assert.deepEqual(command.args.slice(0, 6), ['--print', '--model', 'opus', '--effort', 'high', '--tools']);
  assert.equal(textFromOutput(RUNNERS.nakai_daily_briefing, JSON.stringify({ result: '# Daily Briefing\nBody' })), '# Daily Briefing\nBody');
});

test('cross-entity maps to Claude Sonnet (senior synthesis, not Luna atomisation)', () => {
  assert.equal(RUNNERS.cross_entity_synthesis.runner, 'claude');
  assert.equal(RUNNERS.cross_entity_synthesis.model, 'sonnet');
  const command = commandFor(RUNNERS.cross_entity_synthesis, 'system');
  assert.match(command.command, /(?:^|\/)claude$/);
  assert.deepEqual(command.args.slice(0, 6), ['--print', '--model', 'sonnet', '--effort', 'high', '--tools']);
});

// The invariant is independence, not a particular vendor: the briefing must not
// be marked by the model that wrote it. Naming Codex here made the test fail
// when Luna moved to Grok (4 Aug 2026) even though independence still held.
test('Nakai route-change quality review uses a judge independent of the writer', () => {
  const writer = RUNNERS.nakai_daily_briefing;
  const judge = RUNNERS.nakai_briefing_quality_review;
  assert.notEqual(judge.runner, writer.runner, 'judge must not be the writing runner');
  const command = commandFor(judge, 'system');
  assert.ok(command.command, 'judge resolves to an executable runner');
  assert.ok(command.args.length, 'judge is invoked with arguments');
});

test('a runner can be disabled explicitly', () => {
  const old = process.env.NAKAI_DAILY_BRIEFING_RUNNER;
  process.env.NAKAI_DAILY_BRIEFING_RUNNER = 'off';
  assert.equal(configuredRunner('nakai_daily_briefing'), null);
  if (old === undefined) delete process.env.NAKAI_DAILY_BRIEFING_RUNNER;
  else process.env.NAKAI_DAILY_BRIEFING_RUNNER = old;
});
