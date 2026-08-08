'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {
  REPAIR_MAX_TURNS,
  grokCliModel,
  checkScope,
  autoDeployEnabled,
  AUTODEPLOY_ENV,
} = require('../lib/repair-venue');

// A throwaway snapshot dir so the auto-deploy gate can be exercised against a
// known crm_context state instead of whatever prod snapshot happens to be on
// disk. `flag` null means "no flag row"; a string writes that value.
function makeSnapshotDir(flag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-venue-autodeploy-'));
  if (flag !== undefined) {
    const db = new Database(path.join(dir, 'hub.db'));
    db.exec("CREATE TABLE crm_context (user TEXT, key TEXT, value TEXT)");
    if (flag !== null) {
      db.prepare("INSERT INTO crm_context (user, key, value) VALUES ('system', 'repair_venue_autodeploy_enabled', ?)").run(flag);
    }
    db.close();
  }
  return dir;
}

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

test('auto-deploy is off unless explicitly turned on, and the env override wins', () => {
  const original = process.env[AUTODEPLOY_ENV];
  const noDb = makeSnapshotDir(undefined);          // snapshot missing -> fail closed
  const flagAbsent = makeSnapshotDir(null);         // snapshot present, no flag row
  const flagOn = makeSnapshotDir('1');              // prod switch turned on
  try {
    delete process.env[AUTODEPLOY_ENV];
    // Default is OFF: a missing snapshot fails closed, and a present snapshot
    // with no flag row stays off. Neither may read as enabled.
    assert.equal(autoDeployEnabled({ snapshotDir: noDb }), false);
    assert.equal(autoDeployEnabled({ snapshotDir: flagAbsent }), false);
    // The prod crm_context switch is the only DB path that turns it on.
    assert.equal(autoDeployEnabled({ snapshotDir: flagOn }), true);

    // The env override forces on regardless of snapshot state...
    process.env[AUTODEPLOY_ENV] = '1';
    assert.equal(autoDeployEnabled({ snapshotDir: noDb }), true);
    assert.equal(autoDeployEnabled({ snapshotDir: flagAbsent }), true);
    // ...and any other env value falls through to the snapshot verdict.
    process.env[AUTODEPLOY_ENV] = '0';
    assert.equal(autoDeployEnabled({ snapshotDir: flagAbsent }), false);
    assert.equal(autoDeployEnabled({ snapshotDir: flagOn }), true);
  } finally {
    if (original === undefined) delete process.env[AUTODEPLOY_ENV];
    else process.env[AUTODEPLOY_ENV] = original;
    for (const dir of [noDb, flagAbsent, flagOn]) fs.rmSync(dir, { recursive: true, force: true });
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
