'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { linkableCandidates, resolveByName } = require('../lib/synthesis');

const entities = [
  { kind: 'contact', id: 'contact-m365', label: 'M365 Rollout', aliases: [] },
  { kind: 'project', id: 'project-m365', label: 'M365 Rollout', aliases: ['m365-rollout'] },
  { kind: 'project', id: 'project-agent', label: 'Agent', aliases: ['agent'] },
];

test('synthesis resolves duplicate labels to the source-routed project', () => {
  const matched = resolveByName('M365 Rollout', entities, {
    projectId: 'project-m365',
    preferKind: 'project',
  });

  assert.equal(matched.kind, 'project');
  assert.equal(matched.id, 'project-m365');
});

test('synthesis does not offer unrelated entities to the LLM linker', () => {
  const candidates = linkableCandidates({
    subject: 'Mistral AI SAS',
    predicate: 'fact',
    value: 'Issued invoice #MSTRL-API-833752-002 on June 1, 2026',
  }, entities, {});

  assert.deepEqual(candidates, []);
});

test('synthesis keeps source-routed project as a candidate for project emails', () => {
  const candidates = linkableCandidates({
    subject: 'licensing decision',
    predicate: 'fact',
    value: 'E3 licence decision is due by 30 June 2026',
  }, entities, {
    projectId: 'project-m365',
    preferKind: 'project',
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['project-m365']);
});
