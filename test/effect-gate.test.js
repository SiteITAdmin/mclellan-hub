'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-effect-gate-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { recordEffect, detectFlood, effectHealth, FLOOD_THRESHOLD } = require('../lib/effect-gate');
const { effectsSection } = require('../lib/system-report');

const user = 'effect-gate-test';

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('every task records who asked for it and why', () => {
  recordEffect(user, {
    origin: 'crm-knowledge-engine:action-projection',
    source: 'crm-engine',
    sourceId: 'crm-action:abc',
    title: 'Send the signed contractor agreement',
    outcome: 'created',
    externalId: 'google-1',
  });

  const { totals, origins, unattributed } = effectHealth(user);
  assert.equal(totals.created, 1);
  assert.equal(unattributed, 0);
  assert.equal(origins[0].origin, 'crm-knowledge-engine:action-projection');
  assert.equal(origins[0].declared, true);
});

test('a call site that never declared an origin is visible, not silently absorbed', () => {
  const other = 'effect-gate-undeclared';
  recordEffect(other, { source: 'some-old-module', title: 'Mystery task', outcome: 'created' });

  const health = effectHealth(other);
  assert.equal(health.unattributed, 1);
  assert.equal(health.origins[0].origin, 'some-old-module', 'falls back to the free-text source');
  assert.equal(health.origins[0].declared, false);
});

test('a burst from one origin is detected — the 3 August shape', () => {
  const flooder = 'effect-gate-flood';
  // Nakai's Rolling Watchlist became eight tasks in one pass.
  for (let i = 0; i < 8; i += 1) {
    recordEffect(flooder, {
      origin: 'nakai-briefing:watchlist',
      source: 'sent-mail',
      sourceId: `watchlist-row-${i}`,
      title: `Respond to watchlist item ${i}`,
      outcome: 'created',
    });
  }

  const flood = detectFlood(flooder, 'nakai-briefing:watchlist');
  assert.ok(flood, 'eight tasks from one origin in one pass must be detected');
  assert.equal(flood.count, 8);
  assert.ok(flood.count > FLOOD_THRESHOLD);
});

test('a normal working day is not mistaken for a flood', () => {
  const quiet = 'effect-gate-quiet';
  for (let i = 0; i < 3; i += 1) {
    recordEffect(quiet, {
      origin: 'mycelium:flight-prep',
      source: 'mycelium',
      sourceId: `flight-${i}`,
      title: `Pre-flight: FR${i}`,
      outcome: 'created',
    });
  }
  assert.equal(detectFlood(quiet, 'mycelium:flight-prep'), null);
});

test('a refused duplicate is recorded without counting as a created task', () => {
  const dupUser = 'effect-gate-duplicate';
  recordEffect(dupUser, {
    origin: 'm365-briefing:read-task',
    source: 'm365-briefing',
    sourceId: 'edition-42',
    title: 'Read M365 Operations & Security Brief 42',
    outcome: 'refused',
    reason: 'duplicate_source_id',
  });

  const health = effectHealth(dupUser);
  assert.equal(health.totals.created, 0);
  assert.equal(health.totals.refused, 1);
});

test('the daily report names the flooding module in plain words', () => {
  const reportUser = 'effect-gate-report';
  for (let i = 0; i < 8; i += 1) {
    recordEffect(reportUser, {
      origin: 'nakai-briefing:watchlist',
      source: 'sent-mail',
      sourceId: `row-${i}`,
      title: `Respond to watchlist item ${i}`,
      outcome: 'created',
    });
  }

  const section = effectsSection(reportUser);
  assert.match(section, /EFFECTS/);
  assert.match(section, /nakai-briefing:watchlist: 8 created/);
  assert.match(section, /NEEDS YOU — nakai-briefing:watchlist created 8 tasks in 24h/);
});

test('recording an effect never throws, even on a bad write', () => {
  // An effect that happened must not be lost because its receipt failed.
  assert.doesNotThrow(() => recordEffect(null, { title: 'no user' }));
  assert.equal(recordEffect('', { title: 'blank user' }), null);
});
