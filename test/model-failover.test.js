'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-'));
const script = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/bash\ncat >/dev/null\n${body}\n`, { mode: 0o755 }); return p; };
const claudeDown = script('claude-down', `echo '{"type":"result","is_error":true,"api_error":"usage_limit_reached","result":"You have hit your 5-hour limit"}'; exit 1`);
const claudeUp = script('claude-up', `echo '{"type":"result","result":"{\\"lane\\":\\"claude\\"}"}'`);
const codexDown = script('codex-down', `echo "You've hit your usage limit. Try again later." >&2; exit 1`);
const codexUp = script('codex-up', `echo '{"lane":"chatgpt"}'`);
const { resolveFeatureRunner } = require('../lib/feature-runners');
const agent = require('../lib/subscription-agent');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (feature, claude, codex) => {
  process.env.CLAUDE_CLI_PATH = claude; process.env.CODEX_CLI_PATH = codex;
  const f = resolveFeatureRunner(feature);
  return agent.runSubscriptionText({ feature, systemPrompt: 'Reply with JSON.', userPrompt: 'Which lane?', force: true, timeoutMs: 10000, config: { ...f, feature } });
};

test('every Claude lane stands in on ChatGPT and every ChatGPT lane on Claude; PDF reading has no stand-in', () => {
  assert.equal(resolveFeatureRunner('crm_atomise').fallbackTo, 'gpt_standin');
  assert.equal(resolveFeatureRunner('hub_chat').fallbackTo, 'gpt_standin');
  assert.equal(resolveFeatureRunner('nakai_daily_briefing').fallbackTo, 'gpt_standin');
  assert.equal(resolveFeatureRunner('crm_parser').fallbackTo, 'claude_standin');
  assert.equal(resolveFeatureRunner('something_unlisted').fallbackTo, 'claude_standin');
  assert.equal(resolveFeatureRunner('crm_boox_read').fallbackTo, null);
  assert.equal(resolveFeatureRunner('embeddings').fallbackTo, null);
});

test('Claude at its usage limit: ChatGPT answers and the result says so', async () => {
  const r = await run('crm_atomise', claudeDown, codexUp);
  assert.deepEqual([r.text, r.runner, r.model, r.fallbackFrom], ['{"lane":"chatgpt"}', 'codex', 'gpt-5.6-luna', 'claude/sonnet']);
});

test('ChatGPT unavailable: Claude answers and the result says so', async () => {
  const r = await run('crm_parser', claudeUp, codexDown);
  assert.deepEqual([r.text, r.runner, r.fallbackFrom], ['{"lane":"claude"}', 'claude', 'codex/gpt-5.6-luna']);
});

test('the first lane is used when it works, and both reasons are reported when neither does', async () => {
  const ok = await run('crm_atomise', claudeUp, codexDown);
  assert.deepEqual([ok.runner, ok.fallbackFrom], ['claude', undefined]);
  await assert.rejects(run('crm_atomise', claudeDown, codexDown), err => {
    assert.match(err.message, /usage_limit_reached/);
    assert.match(err.message, /then codex\/gpt-5\.6-luna also failed: .*usage limit/);
    assert.equal(require('../lib/crm/atoms').transientError(err.message), true);
    return true;
  });
});
