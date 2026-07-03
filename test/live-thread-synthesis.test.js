'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  writeLiveThreadAtoms,
  getLiveThreadAtoms,
} = require('../lib/knowledge-synthesis');

const USER = '__test_live_threads';

function cleanup() {
  db.hub().prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
}

test.beforeEach(cleanup);
test.after(cleanup);

test('live thread synthesis writes source-backed thread atoms', () => {
  const signals = [
    {
      id: 'email_summary:email-masterclass',
      kind: 'email_summary',
      source_id: 'email-masterclass',
      title: 'Masterclass on managing change',
      text: 'Masterclass email offered a course about managing change.',
    },
    {
      id: 'meeting_intake:meeting-hospital',
      kind: 'meeting_intake',
      source_id: 'meeting-hospital',
      title: 'Hospital departments change approach',
      text: 'Meeting notes discussed how different hospital departments approach operational change.',
    },
    {
      id: 'intel_item:intel-m365',
      kind: 'intel_item',
      source_id: 'intel-m365',
      title: 'M365 adoption and change management',
      text: 'Newsletter item discussed Microsoft 365 adoption risk and change management.',
    },
  ];

  const result = writeLiveThreadAtoms(USER, [{
    type: 'theme',
    title: 'Managing change across M365',
    detail: 'M365 adoption, Masterclass material, and hospital department meetings are all circling the practical work of managing change.',
    evidence_ids: signals.map(signal => signal.id),
    why_now: 'The theme appeared in three otherwise separate streams.',
    suggested_surface: 'briefing',
    confidence: 0.82,
  }], signals);

  assert.equal(result.written, 1);

  const rows = getLiveThreadAtoms(USER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject_kind, 'thread');
  assert.equal(rows[0].predicate, 'theme');
  assert.match(rows[0].value, /hospital department meetings/);
  const refs = JSON.parse(rows[0].source_refs);
  assert.deepEqual(refs.map(ref => ref.kind).sort(), ['email_summary', 'intel_item', 'meeting_intake']);
});

test('live thread synthesis rejects single-source pseudo-threads', () => {
  const signals = [
    { id: 'email_summary:e1', kind: 'email_summary', source_id: 'e1', title: 'One email', text: 'A single source.' },
    { id: 'email_summary:e2', kind: 'email_summary', source_id: 'e2', title: 'Another email', text: 'Same source kind.' },
  ];

  const result = writeLiveThreadAtoms(USER, [{
    type: 'theme',
    title: 'Email-only thread',
    detail: 'This should not become a live thread because it does not cross source types.',
    evidence_ids: signals.map(signal => signal.id),
    confidence: 0.9,
  }], signals);

  assert.equal(result.written, 0);
  assert.equal(getLiveThreadAtoms(USER).length, 0);
});
