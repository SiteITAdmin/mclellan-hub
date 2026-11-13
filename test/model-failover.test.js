'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-'));
const script = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/bash\ncat >/dev/null\n${body}\n`, { mode: 0o755 }); return p; };
const nodeScript = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!${process.execPath}\n${body}\n`, { mode: 0o755 }); return p; };
const claudeDown = script('claude-down', `echo '{"type":"result","is_error":true,"api_error":"usage_limit_reached","result":"You have hit your 5-hour limit"}'; exit 1`);
const claudeUp = script('claude-up', `echo '{"type":"result","result":"{\\"lane\\":\\"claude\\"}"}'`);
const codexDown = script('codex-down', `echo "You've hit your usage limit. Try again later." >&2; exit 1`);
const codexUp = script('codex-up', `echo '{"lane":"chatgpt"}'`);
const grokDown = script('grok-down', `echo 'Grok is at capacity' >&2; exit 1`);
const grokUp = script('grok-up', `echo '{"text":"{\\"lane\\":\\"grok\\"}"}'`);
const { resolveFeatureRunner } = require('../lib/feature-runners');
const agent = require('../lib/subscription-agent');
const keys = ['CLAUDE_CLI_PATH', 'CODEX_CLI_PATH', 'GROK_CLI_PATH', 'PDFTOPPM_PATH'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
after(() => { for (const k of keys) original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

const run = (feature, claude, codex, grok = grokDown, extra = {}) => {
  process.env.CLAUDE_CLI_PATH = claude; process.env.CODEX_CLI_PATH = codex; process.env.GROK_CLI_PATH = grok;
  const f = resolveFeatureRunner(feature);
  return agent.runSubscriptionText({ feature, systemPrompt: 'Reply with JSON.', userPrompt: 'Which lane?', force: true, timeoutMs: 10000, config: { ...f, feature }, ...extra });
};

test('Claude → ChatGPT → Grok is ordered, including Boox; local specialists have no fallback', () => {
  for (const f of ['crm_atomise', 'hub_chat', 'nakai_daily_briefing', 'crm_boox_read']) {
    const first = resolveFeatureRunner(f), second = agent.fallbackConfig(first), third = agent.fallbackConfig(second);
    assert.deepEqual([first.runner, second.runner, third.runner], ['claude', 'codex', 'grok']);
    assert.equal(agent.fallbackConfig(third), null);
  }
  assert.equal(resolveFeatureRunner('crm_parser').fallbackTo, 'grok_frontier');
  assert.equal(resolveFeatureRunner('something_unlisted').fallbackTo, 'grok_frontier');
  assert.equal(resolveFeatureRunner('embeddings').fallbackTo, null);
});

test('Claude at its limit: ChatGPT answers and the receipt records both lanes', async () => {
  const r = await run('crm_atomise', claudeDown, codexUp);
  assert.deepEqual([r.text, r.runner, r.model, r.fallbackFrom], ['{"lane":"chatgpt"}', 'codex', 'gpt-5.6-luna', 'claude/sonnet']);
  assert.deepEqual(r.fallbackChain, ['claude/sonnet', 'codex/gpt-5.6-luna']);
});

test('Claude and ChatGPT unavailable: Grok answers with the entire attempted chain', async () => {
  const r = await run('crm_atomise', claudeDown, codexDown, grokUp);
  assert.deepEqual([r.text, r.runner], ['{"lane":"grok"}', 'grok']);
  assert.deepEqual(r.fallbackChain, ['claude/sonnet', 'codex/gpt-5.6-luna', 'grok/grok-4.7']);
  const startingAtGPT = await run('crm_parser', claudeUp, codexDown, grokUp);
  assert.deepEqual(startingAtGPT.fallbackChain, ['codex/gpt-5.6-luna', 'grok/grok-4.7']);
});

test('the first working lane wins; all failures and missing binaries remain visible', async () => {
  const ok = await run('crm_atomise', claudeUp, codexDown, grokUp);
  assert.deepEqual([ok.runner, ok.fallbackFrom], ['claude', undefined]);
  await assert.rejects(run('crm_atomise', claudeDown, codexDown), err => {
    assert.match(err.message, /usage_limit_reached/); assert.match(err.message, /codex\/gpt-5\.6-luna/); assert.match(err.message, /grok\/grok-4\.7.*capacity/);
    assert.equal(require('../lib/crm/atoms').transientError(err.message), true); return true;
  });
  const missing = path.join(tmp, 'not-installed');
  assert.equal((await run('crm_atomise', missing, missing, grokUp)).runner, 'grok');
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const renderer = nodeScript('pdftoppm', `const fs=require('fs'),a=process.argv.slice(2); if(!fs.readFileSync(a.at(-2)).toString().startsWith('%PDF-'))process.exit(2);fs.writeFileSync(a.at(-1)+'.png',Buffer.from('${png}','base64'));`);
const documents = [{ data: Buffer.from('%PDF-1.7\nsynthetic page').toString('base64') }];
const transcription = { text: 'Boox connection test. No actions.', uncertain: false, reason: '' };
const imageCodex = nodeScript('image-codex', `const fs=require('fs'),a=process.argv.slice(2),p=a[a.indexOf('--image')+1];if(!p||!fs.existsSync(p))process.exit(2);console.log(JSON.stringify(${JSON.stringify(transcription)}));`);
const imageGrok = nodeScript('image-grok', `const fs=require('fs'),a=process.argv.slice(2),p=a[a.indexOf('--prompt-file')+1];const b=JSON.parse(fs.readFileSync(p));if(a.includes('--single')||b.content[1].type!=='image'||b.content[1].mimeType!=='image/png'||b.content[1].data!=='${png}')process.exit(2);console.log(JSON.stringify({text:JSON.stringify(${JSON.stringify(transcription)})}));`);

test('the same PDF is rendered for ChatGPT and Grok; scratch attachments are removed', async () => {
  process.env.PDFTOPPM_PATH = renderer;
  const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('hub-notebook-')).sort();
  const gpt = await run('crm_boox_read', claudeDown, imageCodex, imageGrok, { documents });
  assert.equal(gpt.runner, 'codex'); assert.deepEqual(JSON.parse(gpt.text), transcription);
  const grok = await run('crm_boox_read', claudeDown, codexDown, imageGrok, { documents });
  assert.equal(grok.runner, 'grok'); assert.deepEqual(JSON.parse(grok.text), transcription);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('hub-notebook-')).sort(), before);
});

test('invalid PDF input stops before any lane; invalid transcription falls through to Grok', async () => {
  await assert.rejects(run('crm_boox_read', claudeUp, imageCodex, imageGrok, { documents: [{ data: 'invalid' }] }), /Invalid or oversized/);
  process.env.PDFTOPPM_PATH = renderer;
  const result = await run('crm_boox_read', claudeDown, codexUp, imageGrok, { documents });
  assert.equal(result.runner, 'grok');
  process.env.PDFTOPPM_PATH = path.join(tmp, 'missing-renderer');
  await assert.rejects(run('crm_boox_read', claudeDown, imageCodex, imageGrok, { documents }), /ENOENT/);
});
