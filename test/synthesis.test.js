'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canResolveByName, linkableCandidates, resolveByName, shouldExcludeEmailSummaryFromKnowledge } = require('../lib/synthesis');

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

test('synthesis refuses hallucinated contact subjects absent from the source', () => {
  const matched = resolveByName('M365 Rollout', entities, {});

  assert.equal(matched.id, 'contact-m365');
  assert.equal(canResolveByName({ subject: 'M365 Rollout' }, matched, {}, 'Mistral AI issued an invoice.'), false);
});

test('synthesis allows contact resolution when the source actually names the contact', () => {
  const ken = { kind: 'contact', id: 'ken', label: 'Ken Murray', aliases: [] };
  const matched = resolveByName('Ken Murray', [ken], {});

  assert.equal(canResolveByName(
    { subject: 'Ken Murray' },
    matched,
    {},
    'Ken Murray approved the Vault 365 setup for VIP Backups.'
  ), true);
});

test('synthesis keeps source-routed project as a candidate for project emails', () => {
  const candidates = linkableCandidates({
    subject: 'licensing decision',
    predicate: 'fact',
    value: 'E3 licence decision is due by 30 June 2026',
  }, entities, {
    projectId: 'project-m365',
    preferKind: 'project',
  }, '');

  assert.deepEqual(candidates.map(candidate => candidate.id), ['project-m365']);
});

test('knowledge synthesis excludes unrouted newsletter email summaries', () => {
  assert.equal(shouldExcludeEmailSummaryFromKnowledge('douglas', {
    subject: 'Weekly AI digest',
    from_name: 'Nate Newsletter',
    from_email: 'natesnewsletter@substack.com',
    summary: 'A roundup of AI model news.',
    project_slug: null,
    contact_id: null,
  }), true);
});

test('knowledge synthesis keeps routed personal email summaries even with invitation wording', () => {
  assert.equal(shouldExcludeEmailSummaryFromKnowledge('douglas', {
    subject: 'Invitation to Kelty',
    from_name: 'Aunt Liz',
    from_email: 'liz@example.test',
    summary: 'Liz invited Douglas to Kelty next weekend.',
    project_slug: null,
    contact_id: 'contact-liz',
  }), false);
});

test('knowledge synthesis excludes unrouted automated account noise', () => {
  assert.equal(shouldExcludeEmailSummaryFromKnowledge('douglas', {
    subject: 'Your Apple receipt',
    from_name: 'Apple Support',
    from_email: 'no-reply@apple.com',
    summary: 'Monthly iCloud subscription renewal receipt.',
    project_slug: null,
    contact_id: null,
  }), true);
});

test('knowledge synthesis keeps routed care-related emails', () => {
  assert.equal(shouldExcludeEmailSummaryFromKnowledge('douglas', {
    subject: 'Care plan update for Dad',
    from_name: 'Care at Home',
    from_email: 'support@care.example.test',
    summary: 'Care at Home confirmed a medication visit for Alister.',
    project_slug: 'dad',
    contact_id: null,
  }), false);
});
