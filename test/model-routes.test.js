'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-routes-'));
process.env.HUB_DB_PATH = path.join(tmp, 'hub.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/db');
const routes = require('../lib/model-routes');
const jobs = require('../lib/subscription-agent-jobs');
const agent = require('../lib/subscription-agent');
const script = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!/bin/bash\ncat >/dev/null\n${body}\n`, { mode: 0o755 }); return p; };
const keys = ['CLAUDE_CLI_PATH', 'CODEX_CLI_PATH', 'GROK_CLI_PATH', 'AGY_CLI_PATH'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeEach(() => db.hub().exec('DELETE FROM model_routes; DELETE FROM subscription_agent_jobs; DELETE FROM model_workers;'));
after(() => { for (const k of keys) original[k] === undefined ? delete process.env[k] : process.env[k] = original[k]; fs.rmSync(tmp, { recursive: true, force: true }); });

test('every queued job is matched to its function and carries today’s lanes unchanged', () => {
  const lanes = (feature, meta) => routes.forJob(feature, { meta }).lanes.map(l => `${l.runner}/${l.model}/${l.effort}`);
  assert.deepEqual(lanes('crm_atomise', { taskHelp: 't1' }), ['claude/opus/medium', 'codex/gpt-5.6-luna/high', 'grok/grok-4.7/high']);
  assert.deepEqual(lanes('crm_atomise', { sourceId: 's1' }), ['claude/sonnet/medium', 'codex/gpt-5.6-luna/high', 'grok/grok-4.7/high']);
  assert.deepEqual(lanes('crm_report', { digest: 'd1' }), ['claude/opus/high', 'codex/gpt-5.6-luna/high', 'grok/grok-4.7/high']);
  assert.deepEqual(lanes('crm_briefing_search', {}), ['claude/sonnet/medium', 'grok/grok-4.7/high']);
  assert.equal(routes.forJob('crm_report', { meta: { report: 'r1' } }).fn, 'report');
  assert.equal(routes.forJob('crm_money_mail', { meta: { moneyOrders: 'b' } }).fn, 'money_orders');
  assert.equal(routes.forJob('crm_money_mail', { meta: { moneyMail: 'b' } }).fn, 'money_mail');
  assert.equal(routes.forJob('hub_chat', null).fn, 'site_chat');
  assert.equal(routes.forJob('crm_atomise', { meta: { somethingNew: 1 } }), null, 'an unlisted job keeps its old routing');
  for (const def of routes.FUNCTIONS) assert.ok(routes.choices(def.fn).includes(def.lanes[0]), def.fn);
});

test('a saved choice reaches the queued job; models that cannot do the job are refused', () => {
  routes.save('digest', ['gemini-neon', 'claude-opus', 'grok']);
  const q = jobs.enqueue({ feature: 'crm_report', dedupeKey: 'digest-1', payload: { systemPrompt: 's', userPrompt: 'u', meta: { digest: 'd1' }, runner: 'claude', model: 'opus' } });
  const p = JSON.parse(db.hub().prepare('SELECT payload FROM subscription_agent_jobs WHERE id = ?').get(q.jobId).payload);
  assert.equal(p.fn, 'digest');
  assert.deepEqual(p.lanes.map(l => l.key), ['gemini-neon', 'claude-opus', 'grok']);
  assert.deepEqual([p.runner, p.model, p.effort], ['antigravity', 'gemini-4-neon', 'high'], 'old workers still run the main choice');
  assert.throws(() => routes.save('money_read', ['gemini-neon']), /can only|choose a main model/);
  assert.throws(() => routes.save('briefing_search', ['chatgpt']), /choose a main model/);
  assert.throws(() => routes.save('digest', ['grok', 'grok']), /each model once/);
  assert.deepEqual(routes.save('digest', ['claude-opus', 'chatgpt']), ['claude-opus', 'chatgpt']);
  assert.deepEqual(routes.laneKeys('digest'), ['claude-opus', 'chatgpt']);
  routes.save('digest', ['claude-opus', 'chatgpt', 'grok']);
  assert.equal(db.hub().prepare('SELECT COUNT(*) n FROM model_routes').get().n, 0, 'the default is not stored');
});

test('workers report what they have installed; activity counts the model and machine that answered', () => {
  jobs.claim({ workerId: 'dev-server-fast', available: { claude: true, codex: true, grok: true, antigravity: false, evil: true } });
  const w = routes.workers();
  assert.equal(w[0].machine, 'Dev server');
  assert.deepEqual(w[0].available, { claude: true, codex: true, grok: true, antigravity: false });
  const add = (id, feature, meta, status, result, by) => db.hub().prepare(`INSERT INTO subscription_agent_jobs(id, feature, dedupe_key, payload, status, claimed_by, result_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`).run(id, feature, id, JSON.stringify({ meta }), status, by, result ? JSON.stringify({ meta: result }) : null);
  add('a', 'crm_atomise', { taskHelp: 1 }, 'completed', { runner: 'claude', model: 'opus' }, 'mac:douglass-mini.home.arpa');
  add('b', 'crm_atomise', { taskHelp: 2 }, 'completed', { runner: 'codex', model: 'gpt-5.6-luna', fallbackFrom: 'claude/opus' }, 'dev-server-fast');
  add('c', 'crm_atomise', { taskHelp: 3 }, 'failed', null, 'mac:douglass-mini.home.arpa');
  const a = routes.activity().task_help;
  assert.deepEqual([a.runs, a.done, a.failed, a.standIn], [3, 2, 1, 1]);
  assert.deepEqual(a.models, { 'Claude Opus': 1, ChatGPT: 1 });
  assert.deepEqual(a.machines, { 'Mac mini': 1, 'Dev server': 1 });
});

test('the worker walks the chosen lanes: a missing CLI and a failure pass to the next choice, with the chain kept', async () => {
  process.env.AGY_CLI_PATH = path.join(tmp, 'agy-not-installed');
  process.env.CLAUDE_CLI_PATH = script('claude-down', `echo '{"type":"result","is_error":true,"result":"You have hit your limit"}'; exit 1`);
  process.env.GROK_CLI_PATH = script('grok-up', `echo '{"text":"{\\"lane\\":\\"grok\\"}"}'`);
  const lanes = ['gemini-neon', 'claude-opus', 'grok'].map(k => ({ key: k, ...routes.MODELS[k], effort: 'high' }));
  const r = await agent.runSubscriptionText({ feature: 'crm_report', systemPrompt: 's', userPrompt: 'u', force: true, timeoutMs: 10000,
    config: { feature: 'crm_report', runner: 'antigravity', model: 'gemini-4-neon', effort: 'high', lanes } });
  assert.deepEqual([r.runner, r.text], ['grok', '{"lane":"grok"}']);
  assert.deepEqual(r.fallbackChain, ['antigravity/gemini-4-neon', 'claude/opus', 'grok/grok-4.7']);
  assert.equal(r.fallbackFrom, 'antigravity/gemini-4-neon');
  process.env.GROK_CLI_PATH = script('grok-down', `echo 'at capacity' >&2; exit 1`);
  await assert.rejects(agent.runSubscriptionText({ feature: 'crm_report', systemPrompt: 's', userPrompt: 'u', force: true, timeoutMs: 10000,
    config: { feature: 'crm_report', runner: 'antigravity', model: 'gemini-4-neon', lanes } }), /not installed on this machine.*hit your limit.*capacity/s);
});

test('Antigravity gets the prompt on stdin in an empty folder; a blocked tool or empty answer is a failure', async () => {
  const seen = path.join(tmp, 'agy-seen.json');
  const fake = (name, result) => { const p = path.join(tmp, name); fs.writeFileSync(p, `#!${process.execPath}
let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(seen)},JSON.stringify({input,args:process.argv.slice(2),cwd:process.cwd(),files:require('fs').readdirSync('.')}));
console.log(JSON.stringify({event:'step_update',step_update:{text_delta:'x'}}));console.log(JSON.stringify({event:'result',result:${JSON.stringify(result)}}));});`, { mode: 0o755 }); return p; };
  const call = () => agent.runSubscriptionText({ feature: 'crm_report', systemPrompt: 'Be brief.', userPrompt: 'x'.repeat(200000), force: true, timeoutMs: 10000,
    config: { feature: 'crm_report', runner: 'antigravity', model: 'gemini-4-neon', effort: 'high', maxInputChars: 400000, lanes: [{ key: 'gemini-neon', runner: 'antigravity', model: 'gemini-4-neon', effort: 'high' }] } });
  process.env.AGY_CLI_PATH = fake('agy-ok', { status: 'SUCCESS', response: '{"ok":true}\n' });
  const r = await call();
  assert.deepEqual([r.runner, r.model, r.text], ['antigravity', 'gemini-4-neon', '{"ok":true}']);
  const s = JSON.parse(fs.readFileSync(seen, 'utf8'));
  const msg = JSON.parse(s.input);
  assert.equal(msg.event, 'user'); assert.match(msg.message.content, /^Be brief\.\n\n--- Task input ---\nx{1000}/);
  assert.ok(msg.message.content.length > 200000, 'a prompt past 128 KB is not cut');
  assert.deepEqual(s.files, []); assert.notEqual(path.resolve(s.cwd), process.cwd());
  assert.ok(s.args.includes('plan') && s.args.includes('gemini-4-neon'));
  process.env.AGY_CLI_PATH = fake('agy-denied', { status: 'SUCCESS', response: '', denied_actions: [{ action: 'command' }] });
  await assert.rejects(call(), /tried to use a tool/);
  process.env.AGY_CLI_PATH = fake('agy-empty', { status: 'SUCCESS', response: '\n' });
  await assert.rejects(call(), /empty answer/);
  process.env.AGY_CLI_PATH = fake('agy-error', { status: 'ERROR', finished_reason: 'error' });
  await assert.rejects(call(), /did not finish: ERROR/);
});
