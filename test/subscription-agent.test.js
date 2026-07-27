'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RUNNERS, configuredRunner, commandFor, textFromOutput } = require('../lib/subscription-agent');

test('Nakai maps to local Claude Opus at high effort', () => {
  const command = commandFor(RUNNERS.nakai_daily_briefing, 'system');
  assert.equal(command.command, 'claude');
  assert.deepEqual(command.args.slice(0, 6), ['--print', '--model', 'opus', '--effort', 'high', '--tools']);
  assert.equal(textFromOutput(RUNNERS.nakai_daily_briefing, JSON.stringify({ result: '# Daily Briefing\nBody' })), '# Daily Briefing\nBody');
});

test('cross-entity maps to local Codex Luna at medium effort', () => {
  const command = commandFor(RUNNERS.cross_entity_synthesis, 'system');
  assert.equal(command.command, 'codex');
  assert.deepEqual(command.args.slice(0, 7), ['exec', '--model', 'gpt-5.6-luna', '--config', 'model_reasoning_effort=medium', '--sandbox', 'read-only']);
});

test('a runner can be disabled explicitly', () => {
  const old = process.env.NAKAI_DAILY_BRIEFING_RUNNER;
  process.env.NAKAI_DAILY_BRIEFING_RUNNER = 'off';
  assert.equal(configuredRunner('nakai_daily_briefing'), null);
  if (old === undefined) delete process.env.NAKAI_DAILY_BRIEFING_RUNNER;
  else process.env.NAKAI_DAILY_BRIEFING_RUNNER = old;
});
