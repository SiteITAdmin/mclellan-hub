'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-crm-activity-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;

const db = require('../lib/db');
const { admitSource } = require('../lib/source-admission');
const { recordEffect } = require('../lib/effect-gate');
const { ingestTrend, pipelineFunnel, contentInventory, buildCrmActivity } = require('../lib/crm-activity');

const user = 'crm-activity-test';
let seq = 0;

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function email({ body = 'Please approve before Friday.', ingester = 'agentmail' } = {}) {
  const id = `activity-email-${++seq}`;
  db.hub().prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at, summary, body_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, user, `${id}-msg`, 'Outstanding items', 'Neil Brennan', 'neil@beaconhospital.ie', Math.floor(Date.now() / 1000), 'items', body);
  admitSource(user, 'email_summary', id, { ingester });
  return id;
}

test('ingest trend buckets source_admitted receipts per Dublin day, latest per source', () => {
  for (let i = 0; i < 3; i++) email();
  const trend = ingestTrend(user, 14);
  assert.equal(trend.length, 14);
  const today = trend[trend.length - 1];
  assert.ok(today.captured >= 3);
  assert.equal(today.complete, 3);
  assert.equal(typeof today.ingesters.agentmail, 'number');
  assert.ok(today.ingesters.agentmail >= 3);
});

test('a repaired source is not double counted in the trend day', () => {
  const id = email();
  const second = db.hub().prepare(`
    UPDATE email_summaries SET body_text = 'A longer replacement body with more detail this time.' WHERE id = ?
  `).run(id);
  assert.equal(second.changes, 1);
  admitSource(user, 'email_summary', id, { ingester: 'agentmail' });
  const trend = ingestTrend(user, 14);
  const today = trend[trend.length - 1];
  assert.ok(today.captured >= 4, 'expected at least 4 distinct sources today');
});

test('pipeline funnel separates source-scoped stages from per-effect external effects', () => {
  const stages = pipelineFunnel(user);
  const byKey = new Map(stages.map(s => [s.key, s]));
  const admitted = byKey.get('source_admitted');
  assert.ok(admitted, 'admission stage present');
  assert.ok(admitted.total >= 4);

  recordEffect(user, { effect: 'google_task', origin: 'meeting-intake', source: 'meeting-intake', sourceId: 'm1', title: 'Draft proposal', outcome: 'created' });
  recordEffect(user, { effect: 'google_task', origin: 'meeting-intake', source: 'meeting-intake', sourceId: 'm1', title: 'Book room', outcome: 'refused' });
  const after = pipelineFunnel(user);
  const effect = new Map(after.map(s => [s.key, s])).get('external_effect');
  assert.equal(effect.total, 2, 'external effects count every row, not one per source');
  assert.equal(effect.processed, 1);
  assert.equal(effect.skipped, 1);
  assert.ok(effect.effectOrigins[0].origin === 'meeting-intake');
});

test('content inventory aggregates content families from existing tables', () => {
  const content = contentInventory(user);
  assert.ok(content.emails.received >= 4);
  assert.ok(Array.isArray(content.meetings));
  assert.ok(Array.isArray(content.inbound));
  assert.equal(typeof content.documents, 'number');
  assert.equal(typeof content.rssArticles, 'number');
});

test('buildCrmActivity returns the full dashboard snapshot', () => {
  const activity = buildCrmActivity(user);
  assert.ok(activity.ingest.totals.captured >= 4);
  assert.ok(activity.trend.length === 14);
  assert.ok(activity.funnel.length >= 2);
  assert.equal(typeof activity.people.contacts, 'number');
  assert.equal(typeof activity.tasks.totals.total, 'number');
  assert.ok(Array.isArray(activity.knowledge.byStatus));
});
