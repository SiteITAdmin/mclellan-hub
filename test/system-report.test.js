'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../lib/db');
const {
  canonicalOpenRouterModelId,
  categoriseLines,
  compactRepeatedLines,
  crmKnowledgeHealthWarning,
  openRouterPolicyWarnings,
  recentOpenRouterGateViolations,
} = require('../lib/system-report');

const POLICY_PREFIX = `system-report-policy-${Date.now()}`;

test.after(() => {
  const hub = db.hub();
  hub.prepare('DELETE FROM request_logs WHERE id LIKE ?').run(`${POLICY_PREFIX}-%`);
  hub.prepare('DELETE FROM model_config WHERE key LIKE ?').run(`${POLICY_PREFIX}-%`);
  hub.prepare('DELETE FROM crm_context WHERE key LIKE ?').run(`hub_sys_model_${POLICY_PREFIX}%`);
});

test('subsystem failures are also classified as errors', () => {
  const categories = categoriseLines([
    "Jun 11 node[1]: [email] classify error for message abc: bad response",
    "Jun 11 node[1]: [agentmail] failed def: null response",
  ]);
  assert.equal(categories.email.length, 1);
  assert.equal(categories.agentmail.length, 1);
  assert.equal(categories.errors.length, 2);
});

test('punycode warning pairs collapse into one useful summary', () => {
  const categories = categoriseLines([
    "Jun 11 node[1]: (node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
    "Jun 11 node[1]: (Use `node --trace-deprecation ...` to show where the warning was created)",
    "Jun 11 node[2]: (node:2) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
    "Jun 11 node[2]: (Use `node --trace-deprecation ...` to show where the warning was created)",
  ]);
  assert.deepEqual(categories.errors, [
    'DeprecationWarning [DEP0040]: node-fetch loaded deprecated punycode (2 occurrences)',
  ]);
});

test('ordinary prose containing warning is not treated as an error', () => {
  const categories = categoriseLines([
    '[newsletter] extracted topics from "A warning to Washington"',
  ]);
  assert.equal(categories.errors.length, 0);
  assert.equal(categories.newsletter.length, 1);
});

test('repeated journal failures compact into one report line', () => {
  const compacted = compactRepeatedLines([
    "Jul 03 22:20:08 mclellan-hub-1 systemd[1]: hub.service: Failed with result 'exit-code'.",
    "Jul 03 22:20:14 mclellan-hub-1 systemd[1]: hub.service: Failed with result 'exit-code'.",
    "Jul 03 22:20:19 mclellan-hub-1 systemd[1]: hub.service: Failed with result 'exit-code'.",
  ]);
  assert.equal(compacted.length, 1);
  assert.match(compacted[0], /repeated 3 times/);
});

test('CRM health accepts compiled knowledge without legacy facts', () => {
  const warning = crmKnowledgeHealthWarning({
    agentmailSources: 2,
    gmailSources: 1,
    atomsCreated: 4,
    receipts: 6,
    synthesisedSources: 3,
    legacyFacts: 0,
  });
  assert.equal(warning, null);
});

test('CRM health distinguishes stalled synthesis from missing source intake', () => {
  const stalled = crmKnowledgeHealthWarning({
    agentmailSources: 1,
    gmailSources: 0,
    agentmailSummaries: 0,
    atomsCreated: 0,
    receipts: 0,
    synthesisedSources: 0,
    legacyFacts: 0,
  });
  assert.match(stalled, /source item\(s\) arrived/);
  assert.match(stalled, /crm_knowledge_engine may be stalled/);

  const noIntake = crmKnowledgeHealthWarning({
    agentmailSources: 0,
    gmailSources: 0,
    agentmailSummaries: 0,
    atomsCreated: 0,
    receipts: 0,
    synthesisedSources: 0,
    legacyFacts: 0,
  });
  assert.match(noIntake, /no Gmail\/AgentMail source records/);
});

test('OpenRouter policy warnings flag missing attribution and unapproved models', () => {
  const hub = db.hub();
  const since = Math.floor(Date.now() / 1000) - 60;
  const now = Math.floor(Date.now() / 1000);

  hub.prepare(`
    INSERT INTO model_config (key, label, endpoint, model_id, tier, search, enabled)
    VALUES (?, 'Approved Test Model', 'openrouter', 'approved/model', 'test', 'none', 1)
  `).run(`${POLICY_PREFIX}-approved`);

  const insert = hub.prepare(`
    INSERT INTO request_logs (
      id, ts, user, model_key, model_id, endpoint,
      tokens_in, tokens_out, cost_usd, status, task_code
    )
    VALUES (?, ?, 'system', ?, ?, 'openrouter', 1, 1, 0, 'ok', ?)
  `);
  insert.run(`${POLICY_PREFIX}-missing-task`, now, `${POLICY_PREFIX}-approved`, 'approved/model', null);
  insert.run(`${POLICY_PREFIX}-bad-model`, now, 'wiki_overview', 'unapproved/model', 'AT-WikiIngest');
  insert.run(`${POLICY_PREFIX}-ok`, now, `${POLICY_PREFIX}-approved`, 'approved/model', 'AT-WikiIngest');

  const warnings = openRouterPolicyWarnings(hub, since);

  assert.ok(warnings.some(w => w.includes('OpenRouter attribution: 1 request')));
  assert.ok(warnings.some(w => w.includes('unapproved/model') && w.includes('not enabled on /admin/models')));
  const modelPolicyWarning = warnings.find(w => w.includes('OpenRouter model policy'));
  assert.ok(modelPolicyWarning);
  assert.ok(!modelPolicyWarning.includes('Approved Test Model'));
});

test('OpenRouter model policy accepts dated provider permaslugs for configured models', () => {
  const hub = db.hub();
  hub.prepare('DELETE FROM request_logs WHERE id LIKE ?').run(`${POLICY_PREFIX}-%`);
  const since = Math.floor(Date.now() / 1000) - 60;
  const now = Math.floor(Date.now() / 1000);

  hub.prepare(`
    INSERT INTO model_config (key, label, endpoint, model_id, tier, search, enabled)
    VALUES (?, 'Canonical Test Model', 'openrouter', 'provider/model-name', 'test', 'none', 1)
  `).run(`${POLICY_PREFIX}-canonical`);
  hub.prepare(`
    INSERT INTO request_logs (
      id, ts, user, model_key, model_id, endpoint,
      tokens_in, tokens_out, cost_usd, status, task_code
    )
    VALUES (?, ?, 'system', 'some_feature', 'provider/model-name-20260622', 'openrouter', 1, 1, 0, 'ok', 'AT-WikiIngest')
  `).run(`${POLICY_PREFIX}-dated-model`, now);

  assert.equal(canonicalOpenRouterModelId('provider/model-name-20260622'), 'provider/model-name');
  assert.deepEqual(openRouterPolicyWarnings(hub, since), []);
});

test('OpenRouter policy warnings include recent gate violations', () => {
  const logPath = path.join(os.tmpdir(), `openrouter-gate-report-${Date.now()}.jsonl`);
  const originalLog = process.env.OPENROUTER_GATE_LOG;
  process.env.OPENROUTER_GATE_LOG = logPath;
  const since = Math.floor(Date.now() / 1000) - 60;

  try {
    fs.writeFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      ok: false,
      violation: 'missing_openrouter_attribution',
      model: 'test/missing-app',
    }) + '\n');

    const violations = recentOpenRouterGateViolations(since);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].model, 'test/missing-app');
    assert.ok(openRouterPolicyWarnings(db.hub(), since).some(w =>
      w.includes('OpenRouter gate: 1 request') && w.includes('test/missing-app')
    ));
  } finally {
    if (originalLog == null) delete process.env.OPENROUTER_GATE_LOG;
    else process.env.OPENROUTER_GATE_LOG = originalLog;
    try { fs.unlinkSync(logPath); } catch (_) {}
  }
});
