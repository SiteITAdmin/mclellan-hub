'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  REPAIR_MAX_TURNS,
  grokCliModel,
  checkScope,
  autoDeployEnabled,
  AUTODEPLOY_ENV,
} = require('../lib/repair-venue');

test('self-repair uses the bounded local Grok CLI model', () => {
  assert.equal(REPAIR_MAX_TURNS, 12);
  assert.equal(grokCliModel('grok-4.5'), 'grok-4.5');
  assert.equal(grokCliModel('x-ai/grok-4.5'), 'grok-4.5');
  assert.throws(() => grokCliModel('google/gemini-2.5-pro-preview'), /must be Grok 4.5/);
});

test('self-repair still rejects an executor that makes no change', () => {
  const scope = checkScope({ constraints: { allowed_paths: ['lib/example.js'], forbidden: [] } }, []);
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /Grok made no changes/);
});

test('auto-deploy is off unless explicitly turned on, and the env override works without touching a DB', () => {
  const original = process.env[AUTODEPLOY_ENV];
  try {
    delete process.env[AUTODEPLOY_ENV];
    // No prod snapshot in this checkout, so the crm_context lookup must fail
    // closed rather than throw.
    assert.equal(autoDeployEnabled(), false);
    process.env[AUTODEPLOY_ENV] = '1';
    assert.equal(autoDeployEnabled(), true);
    process.env[AUTODEPLOY_ENV] = '0';
    assert.equal(autoDeployEnabled(), false);
  } finally {
    if (original === undefined) delete process.env[AUTODEPLOY_ENV];
    else process.env[AUTODEPLOY_ENV] = original;
  }
});

// NOTE: mergeAndSyncMain / runDeployScript / waitForHealthyDeploy /
// revertAndRedeploy / autoDeployAndVerify all shell out to real git, gh, ssh,
// and scripts/deploy.sh against the actual VPS. They are deliberately not
// exercised here — running them in a test would mean actually merging
// branches, pushing to main, and deploying to production. These need a real
// dry run (REPAIR_VENUE_AUTODEPLOY=1, node scripts/run-repair.js --reproducer
// <a harmless test reproducer>) on the Mac mini, against a throwaway branch,
// before Douglas trusts this path for real.
