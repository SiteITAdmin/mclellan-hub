'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  gatherInterestSignals, parseTopics, applyInterestTopics, getInterestRadar,
  RADAR_CONTEXT_KEY,
} = require('../lib/interest-synthesis');
const {
  radarSectionHtml,
  radarSectionText,
  projectSalienceSectionHtml,
  projectSalienceSectionText,
  liveThreadSectionHtml,
  liveThreadSectionText,
} = require('../lib/work-daily-brief');

const USER = '__test_radar';

function cleanup() {
  const hub = db.hub();
  hub.prepare('DELETE FROM meeting_intakes WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM meetings WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM knowledge_atoms WHERE user = ?').run(USER);
  hub.prepare('DELETE FROM crm_context WHERE user = ?').run(USER);
}

test.before(cleanup);
test.after(cleanup);

function seedScenario() {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO meeting_intakes (id, user, title, transcript, summary, created_at)
    VALUES ('mi-cyber', ?, 'Ops weekly', 'transcript text',
            'Douglas was invited to the cyber security training on Monday, covering phishing defence and Microsoft 365 hardening.',
            unixepoch())
  `).run(USER);
  const monday = new Date(Date.now() + 4 * 86400 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Dublin' });
  hub.prepare(`
    INSERT INTO meetings (id, user, title, meeting_date, meeting_time)
    VALUES ('m-training', ?, 'Cyber Security Training', ?, '09:30')
  `).run(USER, monday);
}

test('signals include the recent transcript and the upcoming training', () => {
  seedScenario();
  const signals = gatherInterestSignals(USER);
  assert.ok(signals.some(s => s.id === 'meeting_intake:mi-cyber' && s.detail.includes('cyber security training')));
  assert.ok(signals.some(s => s.id === 'meeting:m-training' && s.label.includes('Cyber Security Training')));
});

test('model output is parsed tolerantly', () => {
  const topics = parseTopics('Here you go:\n{"topics":[{"topic":"cyber security in Microsoft 365","why":"invited to Monday training","confidence":0.9,"signal_ids":["meeting_intake:mi-cyber","meeting:m-training"]}]}');
  assert.equal(topics.length, 1);
  assert.equal(parseTopics('not json').length, 0);
  assert.equal(parseTopics('{"topics": "nope"}').length, 0);
});

test('applying topics compiles interest atoms with provenance and a radar cache', () => {
  const signals = gatherInterestSignals(USER);
  const compiled = applyInterestTopics(USER, [{
    topic: 'cyber security in Microsoft 365',
    why: 'Invited to cyber security training at Ops weekly; training in the calendar for Monday.',
    confidence: 0.9,
    signal_ids: ['meeting_intake:mi-cyber', 'meeting:m-training'],
  }], signals);

  assert.equal(compiled.length, 1);
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(compiled[0].atomId);
  assert.equal(atom.subject_kind, 'interest');
  assert.equal(atom.predicate, 'active_interest');
  assert.equal(atom.status, 'active');
  const refs = JSON.parse(atom.source_refs);
  assert.ok(refs.some(r => r.kind === 'meeting_intake' && r.id === 'mi-cyber'));
  assert.ok(refs.some(r => r.kind === 'meeting' && r.id === 'm-training'));

  const cache = db.hub().prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?')
    .get(USER, RADAR_CONTEXT_KEY);
  assert.ok(cache);
});

test('applying topics infers provenance when the model omits signal ids', () => {
  cleanup();
  seedScenario();
  const signals = gatherInterestSignals(USER);
  const compiled = applyInterestTopics(USER, [{
    topic: 'cyber security in Microsoft 365',
    why: 'Ops weekly invited Douglas to cyber security training, and Cyber Security Training is in the Monday calendar.',
    confidence: 0.9,
  }], signals);

  assert.equal(compiled.length, 1);
  assert.ok(compiled[0].signals.some(s => s.includes('Ops weekly')));
  assert.ok(compiled[0].signals.some(s => s.includes('Cyber Security Training')));
  const atom = db.hub().prepare('SELECT * FROM knowledge_atoms WHERE id = ?').get(compiled[0].atomId);
  const refs = JSON.parse(atom.source_refs);
  assert.ok(refs.some(r => r.kind === 'meeting_intake' && r.id === 'mi-cyber'));
  assert.ok(refs.some(r => r.kind === 'meeting' && r.id === 'm-training'));
});

test('the radar surfaces fresh active interests and drops retired ones', () => {
  const radar = getInterestRadar(USER);
  assert.equal(radar.length, 1);
  assert.equal(radar[0].topic, 'cyber security in Microsoft 365');
  assert.match(radar[0].why, /training/);

  db.hub().prepare(`UPDATE knowledge_atoms SET status = 'retired' WHERE user = ? AND subject_kind = 'interest'`).run(USER);
  assert.equal(getInterestRadar(USER).length, 0);
  db.hub().prepare(`UPDATE knowledge_atoms SET status = 'active' WHERE user = ? AND subject_kind = 'interest'`).run(USER);
});

test('the brief renders a radar section with stories and the why line', () => {
  const items = [{
    topic: 'cyber security in Microsoft 365',
    why: 'Invited to cyber security training at Ops weekly; training Monday.',
    stories: [
      { title: 'New phishing wave targets M365 tenants', url: 'https://example.com/a', snippet: 'Attackers are abusing OAuth consent…' },
      { title: 'Microsoft hardens Entra defaults', url: 'https://example.com/b', snippet: 'Conditional access changes roll out…' },
    ],
  }];
  const html = radarSectionHtml(items);
  assert.match(html, /On your radar/);
  assert.match(html, /cyber security in Microsoft 365/);
  assert.match(html, /Why: Invited to cyber security training/);
  assert.match(html, /https:\/\/example.com\/a/);

  const text = radarSectionText(items).join('\n');
  assert.match(text, /ON YOUR RADAR/);
  assert.match(text, /phishing wave/);

  assert.equal(radarSectionHtml([]), '');
  assert.deepEqual(radarSectionText([]), []);
});

test('the brief renders project salience highlights with matching evidence', () => {
  const highlights = [{
    project_slug: 'm365-modernisation',
    title: 'M365 change work resembles a new Entra hardening signal',
    body: 'The project has a recent meeting note about conditional access sequencing, and the radar stream includes a related Entra defaults rollout.',
    matching_signal: 'Microsoft hardens Entra defaults',
    project_evidence: ['conditional access sequencing discussed in Ops weekly'],
  }];

  const html = projectSalienceSectionHtml(highlights);
  assert.match(html, /Project Signals/);
  assert.match(html, /m365-modernisation/);
  assert.match(html, /Microsoft hardens Entra defaults/);

  const text = projectSalienceSectionText(highlights).join('\n');
  assert.match(text, /PROJECT SIGNALS/);
  assert.match(text, /conditional access sequencing/);

  assert.equal(projectSalienceSectionHtml([]), '');
  assert.deepEqual(projectSalienceSectionText([]), []);
});

test('the brief renders live threads as cross-source ideas', () => {
  const threads = [{
    title: 'Managing change across M365',
    type: 'theme',
    body: 'M365 adoption material, a Masterclass email, and hospital department meeting notes all point at change management as a live topic.',
    whyNow: 'The theme appeared in separate email, newsletter, and meeting streams this week.',
  }];

  const html = liveThreadSectionHtml(threads);
  assert.match(html, /Live Threads/);
  assert.match(html, /Managing change across M365/);
  assert.match(html, /Why now/);

  const text = liveThreadSectionText(threads).join('\n');
  assert.match(text, /LIVE THREADS/);
  assert.match(text, /Masterclass email/);

  assert.equal(liveThreadSectionHtml([]), '');
  assert.deepEqual(liveThreadSectionText([]), []);
});
