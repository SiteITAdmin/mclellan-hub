'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const {
  classifyPrompt,
  normalizePurpose,
  buildAuditAgentPack,
  parsePromptKitMarkdown,
  inferPromptTitleFromText,
  extractNotionPageId,
  notionRecordMapToMarkdown,
  mergeNotionRecordMaps,
  savePrompt,
  listPrompts,
  normalizeImportSourceUrl,
  existingImportForUrl,
  senseCheckPrompt,
  parseOptimizerExamples,
} = require('../lib/prompt-library');

test('classifyPrompt recognises source-grounded audit memo prompts', () => {
  const c = classifyPrompt({
    title: 'AML audit postponement memo',
    rawPrompt: `You are a senior internal audit professional. Write a memo to the Audit Committee.
Use the attached meeting notes as the only source. Explain the regulator's AML inspection and Deloitte independent review.`,
    purpose: 'report-generation',
  });

  assert.equal(c.purpose, 'report-generation');
  assert.equal(c.domain, 'Internal Audit / Financial Services');
  assert.equal(c.artifact_type, 'Memo');
  assert.equal(c.risk_level, 'high');
  assert.match(c.tool_needs, /document reader/);
  assert.equal(c.minimum_model_tier, 'general-reasoning');
  assert.equal(c.recommended_model_tier, 'source-grounded');
  assert.equal(c.verification_type, 'source trace + human review');
});

test('classifyPrompt routes repository review prompts to coding agents', () => {
  const c = classifyPrompt({
    rawPrompt: 'Review this PR diff for blast radius, cross-service side effects, credentials, and missing tests in the repo.',
  });

  assert.equal(c.purpose, 'coding-harness');
  assert.equal(c.domain, 'Software Engineering');
  assert.equal(c.recommended_model_tier, 'coding-agent');
  assert.match(c.tool_needs, /repository tools/);
});

test('classifyPrompt routes Lovable app builder prompts to coding harness', () => {
  const c = classifyPrompt({
    title: 'Habit Tracker with Streak Insights',
    rawPrompt: `Context: You are building a personal habit tracker.

Task: Create a simple habit tracking app where I check off daily habits and see streaks.

Guidelines:
- React/TypeScript with clean design
- Lovable Cloud for data storage
- Lovable AI for pattern analysis
- Works on mobile and desktop`,
  });

  assert.equal(c.purpose, 'coding-harness');
  assert.equal(c.domain, 'Software Engineering');
  assert.equal(c.function_type, 'generate');
  assert.equal(c.artifact_type, 'Coding prompt');
  assert.equal(c.minimum_model_tier, 'coding-agent');
  assert.equal(c.recommended_model_tier, 'coding-agent');
  assert.match(c.tool_needs, /app builder\/coding harness/);
  assert.equal(c.input_types, 'free text');
  assert.equal(c.verification_type, 'app preview/manual test');
});

test('updatePrompt allows manual classification correction', () => {
  const user = `test-${Date.now()}-update-prompt`;
  const saved = savePrompt(user, {
    title: 'Misclassified',
    raw_prompt: 'Evaluate this thing.',
    purpose: 'rubric-evaluation',
  });

  try {
    const updated = require('../lib/prompt-library').updatePrompt(user, saved.id, {
      ...saved,
      purpose: 'coding-harness',
      function_type: 'generate',
      domain: 'Software Engineering',
      artifact_type: 'Coding prompt',
      input_types: 'repository/code',
      tool_needs: 'repository tools',
      minimum_model_tier: 'coding-agent',
      recommended_model_tier: 'coding-agent',
      risk_level: 'medium',
      verification_type: 'tests/static review',
      tags: 'manual-fix, lovable',
    });
    assert.equal(updated.purpose, 'coding-harness');
    assert.equal(updated.recommended_model_tier, 'coding-agent');
    assert.deepEqual(updated.tags.sort(), ['lovable', 'manual-fix'].sort());
  } finally {
    db.hub().prepare('DELETE FROM prompt_library WHERE user = ?').run(user);
  }
});

test('normalizePurpose falls back to general for unknown values', () => {
  assert.equal(normalizePurpose('deep-research'), 'deep-research');
  assert.equal(normalizePurpose('made up'), 'general');
});

test('buildAuditAgentPack creates stage-specific Goose and reviewer prompts', () => {
  const pack = buildAuditAgentPack('nakai', {
    audit_name: 'AML thematic review',
    stage: 'peer-review',
    business_area: 'Financial crime compliance',
    audit_objective: 'Assess whether draft findings are supported before management sharing.',
    source_folders: '/audit/evidence\n/audit/report-drafts',
    output_folder: '/audit/ai-outputs',
    frameworks: 'Internal audit methodology\nAML policy',
    desired_outcomes: 'Peer review notes and unsupported claim list',
    harnesses: ['goose', 'chatgpt', 'codex'],
  });

  assert.equal(pack.stage, 'peer-review');
  assert.match(pack.markdown, /Peer Review/);
  assert.match(pack.markdown, /Goose Agent Prompt/);
  assert.match(pack.markdown, /ChatGPT 5\.5 Prompt/);
  assert.match(pack.markdown, /Codex\/OpenCode Harness Prompt/);
  assert.match(pack.markdown, /Do not move, rename, delete, overwrite, or transmit source evidence/);
  assert.match(pack.markdown, /unsupported, overstated, duplicated, or inconsistent/i);
});

test('parsePromptKitMarkdown splits Nate-style prompt kits into prompts', () => {
  const kit = parsePromptKitMarkdown(`---
title: "Example Kit"
type: "promptkit"
label: "Prompt Kit"
project: "Example Project"
---

# Prompt Kit: Example

Intro text.

### First Prompt

**Job:** Score something.

**When to use:** Before a meeting.

\`\`\`prompt
<role>
You are a scorer.
</role>
<output>
Return a score.
</output>
\`\`\`

### Second Prompt

**Job:** Draft something.

\`\`\`prompt
<role>
You are a drafter.
</role>
\`\`\`
`, 'https://promptkit.example/test');

  assert.equal(kit.title, 'Example Kit');
  assert.equal(kit.prompts.length, 2);
  assert.equal(kit.prompts[0].title, 'First Prompt');
  assert.match(kit.prompts[0].description, /Score something/);
  assert.match(kit.prompts[1].raw_prompt, /drafter/);
});

test('parsePromptKitMarkdown infers titles when imported headings are generic', () => {
  const kit = parsePromptKitMarkdown(`---
title: "Picking Your AI Stack - Prompts"
type: "promptkit"
label: "Prompt Kit"
---

# Picking Your AI Stack - Prompts

### Prompt

\`\`\`prompt
I need to evaluate whether to switch from one AI tool to another for a recurring workflow.
Ask me for the workflow, current tool, candidate tool, and constraints.
\`\`\`

### Prompt

\`\`\`prompt
I'm a product manager writing a PRD. Help me produce a clear document for engineers and leadership.
\`\`\`
`);

  assert.equal(kit.prompts.length, 2);
  assert.equal(kit.prompts[0].title, 'Tool Switch Evaluation');
  assert.equal(kit.prompts[0].meta.inferredTitle, true);
  assert.equal(kit.prompts[1].title, 'Product Manager PRD');
});

test('parsePromptKitMarkdown repairs generic prompt kit source titles', () => {
  const kit = parsePromptKitMarkdown(`---
title: "** Prompt Kit"
type: "promptkit"
---

# ** Prompt Kit

Prompt Kit: Map Your AI Difficulty Axes and Build a Smarter Workflow

### Prompt 1: Problem Difficulty Decomposition

\`\`\`prompt
<role>
You are an organizational psychologist and AI strategist.
</role>
\`\`\`
`);

  assert.equal(kit.title, 'Prompt Kit: Map Your AI Difficulty Axes and Build a Smarter Workflow');
  assert.equal(kit.prompts[0].title, 'Prompt 1: Problem Difficulty Decomposition');
});

test('inferPromptTitleFromText falls back to a useful source title', () => {
  assert.equal(
    inferPromptTitleFromText('You are conducting a diagnostic interview to assess whether an AI system has a durable harnessing layer.', 'A Moat Audit for 2026'),
    'Moat Audit Diagnostic'
  );
  assert.equal(
    inferPromptTitleFromText('Use this prompt to assess lifecycle maturity.', 'Prompt Lifecycle Assessment'),
    'Prompt Lifecycle Assessment'
  );
  assert.equal(
    inferPromptTitleFromText("You're going to help me assess my judgment skills across 10 principles and identify specific areas where I need to improve.", 'Good Judgement in the Age of AI - Prompt'),
    'Good Judgement Self-Assessment'
  );
  assert.equal(
    inferPromptTitleFromText("I'm a commercial litigation attorney drafting responses to interrogatories. Audience is opposing counsel and potentially a judge.", 'Professional Writing Prompts'),
    'Commercial Litigation Attorney Responses to Interrogatories'
  );
});

test('listPrompts searches imported kit provenance', () => {
  const user = `test-${Date.now()}-provenance`;
  const saved = savePrompt(user, {
    title: 'Prompt 1: Evidence Mapper',
    raw_prompt: 'Map evidence to claims.',
    source_type: 'promptkit-url',
    source_ref: 'https://promptkit.example/kit#1',
    source_title: 'Dark Code Prompt Kit',
    source_author: 'Nate B. Jones',
    source_url: 'https://promptkit.example/kit',
  });

  try {
    assert.equal(saved.title, 'Prompt 1: Evidence Mapper');
    assert.equal(listPrompts(user, { q: 'Dark Code Prompt Kit' }).length, 1);
    assert.equal(listPrompts(user, { q: 'Nate B. Jones' }).length, 1);
    assert.equal(listPrompts(user, { q: 'promptkit.example' }).length, 1);
  } finally {
    db.hub().prepare('DELETE FROM prompt_library WHERE user = ?').run(user);
  }
});

test('existingImportForUrl detects duplicate kit URLs before re-import', () => {
  const user = `test-${Date.now()}-duplicate-url`;
  const sourceUrl = normalizeImportSourceUrl('https://promptkit.example/kit/?utm_source=newsletter');
  savePrompt(user, {
    title: 'Prompt 1: Evidence Mapper',
    raw_prompt: 'Map evidence to claims.',
    source_type: 'promptkit-url',
    source_ref: `${sourceUrl}#1-evidence-mapper`,
    source_title: 'Dark Code Prompt Kit',
    source_author: 'Nate B. Jones',
    source_url: sourceUrl,
  });

  try {
    const duplicate = existingImportForUrl(user, 'https://promptkit.example/kit?utm_source=another');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.count, 1);
    assert.equal(duplicate.title, 'Dark Code Prompt Kit');
    assert.equal(existingImportForUrl(user, 'https://promptkit.example/other'), null);
  } finally {
    db.hub().prepare('DELETE FROM prompt_library WHERE user = ?').run(user);
  }
});

test('senseCheckPrompt explains task fit before prompt adaptation', () => {
  const user = `test-${Date.now()}-sense`;
  const example = savePrompt(user, {
    title: 'Agent Workflow Layer Mapper',
    raw_prompt: 'Map coding agents across a repository and dispatch work.',
    purpose: 'coding-harness',
    source_type: 'manual',
  });

  try {
    const check = senseCheckPrompt(user, {
      roughPrompt: 'A report on the complete range of services included in E3 and F3 Microsoft licenses, then separate functions from hospital use cases.',
      purpose: 'general',
      mode: 'workflow',
      sourcePromptIds: [example.id],
    });

    assert.equal(check.verdict, 'needs-attention');
    assert.equal(check.recommended.purpose, 'report-generation');
    assert.match(check.taskSummary, /Report/);
    assert.ok(check.issues.some(i => /external facts|source verification/i.test(i)));
    assert.ok(check.issues.some(i => /Selected purpose/i.test(i)));
    assert.ok(check.issues.some(i => /Selected example mismatch/i.test(i)));
    assert.ok(check.education.some(i => /not doing the underlying task/i.test(i)));
  } finally {
    db.hub().prepare('DELETE FROM prompt_library WHERE user = ?').run(user);
  }
});

test('notionRecordMapToMarkdown converts public Notion prompt libraries into prompt fences', () => {
  const pageId = '2c65a2cc-b526-8028-b24e-c0dcbdaaa4a1';
  const codeId = '2c65a2cc-b526-8098-936b-cad4564f9ff1';
  const recordMap = {
    block: {
      [pageId]: { value: { value: {
        id: pageId,
        type: 'page',
        properties: { title: [['The Knowledge Worker Practice Gym: Prompt Library']] },
        content: ['h1', 'intro', codeId],
      } } },
      h1: { value: { value: { id: 'h1', type: 'sub_header', properties: { title: [['1. Decision Document Evaluator']] } } } },
      intro: { value: { value: { id: 'intro', type: 'text', properties: { title: [['Use this when you have a decision doc.']] } } } },
      [codeId]: { value: { value: { id: codeId, type: 'code', properties: { title: [['You are a rigorous evaluator.']] } } } },
    },
  };
  const md = notionRecordMapToMarkdown(recordMap, pageId, 'https://www.notion.so/example-2c65a2ccb5268028b24ec0dcbdaaa4a1');
  const kit = parsePromptKitMarkdown(md);

  assert.equal(extractNotionPageId('https://www.notion.so/x-2c65a2ccb5268028b24ec0dcbdaaa4a1'), pageId);
  assert.match(md, /```prompt/);
  assert.equal(kit.prompts.length, 1);
  assert.equal(kit.prompts[0].title, '1. Decision Document Evaluator');
  assert.match(kit.prompts[0].raw_prompt, /rigorous evaluator/);
});

test('mergeNotionRecordMaps preserves prompts split across Notion chunks', () => {
  const pageId = '2c65a2cc-b526-8028-b24e-c0dcbdaaa4a1';
  const firstCodeId = '2c65a2cc-b526-8098-936b-cad4564f9ff1';
  const secondCodeId = '2c65a2cc-b526-8098-936b-cad4564f9ff2';
  const chunkOne = {
    block: {
      [pageId]: { value: { value: {
        id: pageId,
        type: 'page',
        properties: { title: [['Agent Prompt Library']] },
        content: ['h1', firstCodeId, 'h2', secondCodeId],
      } } },
      h1: { value: { value: { id: 'h1', type: 'sub_header', properties: { title: [['1. First Agent Mission']] } } } },
      [firstCodeId]: { value: { value: { id: firstCodeId, type: 'code', properties: { title: [['First prompt body.']] } } } },
    },
  };
  const chunkTwo = {
    block: {
      h2: { value: { value: { id: 'h2', type: 'sub_header', properties: { title: [['2. Second Agent Mission']] } } } },
      [secondCodeId]: { value: { value: { id: secondCodeId, type: 'code', properties: { title: [['Second prompt body.']] } } } },
    },
  };

  const recordMap = mergeNotionRecordMaps(mergeNotionRecordMaps({}, chunkOne), chunkTwo);
  const kit = parsePromptKitMarkdown(notionRecordMapToMarkdown(recordMap, pageId));

  assert.equal(kit.prompts.length, 2);
  assert.equal(kit.prompts[0].title, '1. First Agent Mission');
  assert.equal(kit.prompts[1].title, '2. Second Agent Mission');
});

test('parseOptimizerExamples extracts reusable prompt test cases', () => {
  const examples = parseOptimizerExamples(`Example 1:
Input: Meeting transcript with decisions
Output: Decisions, actions, owners

---

Example 2:
Input: Audit note
Output: Committee-ready memo`);

  assert.equal(examples.length, 2);
  assert.match(examples[0].input, /Meeting transcript/);
  assert.match(examples[1].output, /Committee-ready memo/);
});
