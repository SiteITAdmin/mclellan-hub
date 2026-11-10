'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krisp-'));
process.env.CRM_DB_PATH = path.join(tmp, 'crm.db');
process.env.HUB_DISABLE_JOBS = '1';
const db = require('../lib/crm/db');
const krisp = require('../lib/crm/krisp');
const atoms = require('../lib/crm/atoms');
after(() => { db._reset(); fs.rmSync(tmp, { recursive: true, force: true }); });
test('authenticated local HTTP intake preserves telephone evidence and feeds existing atom pipeline', async () => {
  process.env.KRISP_WEBHOOK_SECRET = 'synthetic-test-secret';
  delete process.env.KRISP_WEBHOOK_SPACE;
  assert.equal(krisp.authenticate('Bearer synthetic-test-secret').status, 503);
  process.env.KRISP_WEBHOOK_SPACE = 'work';
  const app = require('express')(); app.use(require('express').json()); app.use(require('../routes/krisp-capture'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const payload = { event_id: 'delivery-1', meeting: { id: 'phone-1', title: 'Telephone', started_at: '2026-11-10T09:00:00Z' }, transcript: 'Speaker 1 | 00:00\nWe agreed to deliver the financial report on Friday morning.', space: 'personal' };
  const post = async (body, token = 'synthetic-test-secret') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/krisp/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await post(payload, 'wrong')).status, 401);
    assert.equal(db.crm().prepare('SELECT count(*) n FROM sources').get().n, 0);
    const r = await post(payload); assert.equal(r.status, 200); assert.equal(r.body.created, true);
    const s = db.crm().prepare('SELECT * FROM sources WHERE id = ?').get(r.body.sources[0]);
    assert.equal(s.space, 'work'); assert.equal(s.text, payload.transcript); assert.deepEqual(JSON.parse(s.raw_ref), payload); assert.equal(s.atomise_status, 'pending');
    assert.equal((await post({ ...payload, event_id: 'delivery-2' })).body.created, false);
    assert.equal(db.crm().prepare('SELECT count(*) n FROM source_addresses').get().n, 0);
    atoms.applyAtoms(s.id, [{ statement: 'The financial report is due Friday morning', quote: 'deliver the financial report on Friday morning', people: ['Speaker 1'], kind: 'fact' }]);
    assert.equal(db.crm().prepare('SELECT count(*) n FROM atom_sources WHERE source_id = ?').get(s.id).n, 1);
    assert.equal(db.crm().prepare('SELECT count(*) n FROM people').get().n, 0);
    const empty = await post({ event_id: 'empty', notes: 'A summary is not a transcript' });
    assert.equal(empty.body.readable, false);
    assert.equal(db.crm().prepare('SELECT atomise_status FROM sources WHERE id = ?').get(empty.body.sources[0]).atomise_status, 'skipped');
    const corrected = await post({ ...payload, transcript: payload.transcript + '\nCorrection: Monday.' }); assert.equal(corrected.body.created, true);
    const long = await post({ meeting: { id: 'long' }, transcript: payload.transcript.repeat(600) });
    assert.ok(long.body.sources.length > 1);
    assert.equal(db.crm().prepare('SELECT sum(length(text)) n FROM sources WHERE id IN (' + long.body.sources.map(() => '?').join(',') + ')').get(...long.body.sources).n > 40000, true);
  } finally { await new Promise(r => server.close(r)); }
});
