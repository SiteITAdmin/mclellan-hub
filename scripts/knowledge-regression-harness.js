'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fetch = require('../lib/fetch');
const { PROMPTS } = require('../lib/prompts');
const { getSystemModelId, getSystemPrompt } = require('../lib/settings');
const { openRouterHeaders, TASK_CODES } = require('../lib/openrouter-attribution');
const { parseModelObject } = require('../lib/model-response');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULTS = {
  email_classifier: 'google/gemini-2.5-pro-preview',
  agentmail_extractor: 'google/gemini-3.1-pro-preview',
  entity_linker: 'anthropic/claude-haiku-4-5',
  crm_duplicate_review: 'anthropic/claude-haiku-4-5',
  task_extractor: 'google/gemini-2.5-pro-preview',
  wiki_page_writer: 'google/gemini-2.5-pro-preview',
  knowledge_query: 'anthropic/claude-haiku-4-5',
};

function sha(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function parseArgs(argv) {
  const args = { live: false, json: false, only: null };
  for (const arg of argv) {
    if (arg === '--live') args.live = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--only=')) args.only = new Set(arg.slice('--only='.length).split(',').map(s => s.trim()).filter(Boolean));
  }
  return args;
}

function getPrompt(feature) {
  return getSystemPrompt(feature, 'system', PROMPTS[feature] || '');
}

function getModel(feature) {
  return getSystemModelId(feature, 'system', DEFAULTS[feature]);
}

async function callModel({ feature, messages, json = true, temperature = 0.1, timeout = 180_000 }) {
  const model = getModel(feature);
  const started = Date.now();
  const body = {
    model,
    messages,
    temperature,
  };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.TESTBENCH),
    body: JSON.stringify(body),
    timeout,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return {
    model,
    actualModel: data.model || model,
    ms: Date.now() - started,
    content: data.choices?.[0]?.message?.content || '',
    usage: data.usage || {},
  };
}

function ok(label, pass, detail = '') {
  return { label, pass: Boolean(pass), detail: detail || null };
}

function contains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

function asJson(content, defaults, label) {
  return parseModelObject(content, defaults, label);
}

const fixtures = [
  {
    id: 'email_classifier_sender_action',
    feature: 'email_classifier',
    json: true,
    messages() {
      const prompt = getPrompt('email_classifier')
        .replaceAll('[FROM_NAME]', 'Sarah Patel')
        .replaceAll('[FROM_EMAIL]', 'sarah.patel@example.test')
        .replaceAll('[SUBJECT]', 'Contract review for Beacon migration')
        .replaceAll('[BODY]', 'Hi Douglas, can you please send me the revised Beacon migration contract by Friday? Sarah')
        .replaceAll('[CONTACTS]', 'Sarah Patel <sarah.patel@example.test>\nKen Murray <ken@example.test>')
        .replaceAll('[PROJECTS]', 'beacon-migration: Beacon migration\nfamily-care: Family care')
        .replaceAll('[LABELS]', 'Action Required\nProjects/Beacon\nNewsletters');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, {
        contact_name: null, project_slug: null, summary: '', fact: null, move_label: null, action_task: null,
      }, 'email_classifier');
      return {
        parsed: out,
        checks: [
          ok('sender matched exactly', out.contact_name === 'Sarah Patel', JSON.stringify(out)),
          ok('project routed to Beacon', out.project_slug === 'beacon-migration', JSON.stringify(out)),
          ok('action created for explicit ask', contains(out.action_task, 'contract') && contains(out.action_task, 'Sarah'), JSON.stringify(out)),
          ok('no invented label', out.move_label == null || ['Action Required', 'Projects/Beacon', 'Newsletters'].includes(out.move_label), JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'agentmail_forwarded_multi_action',
    feature: 'agentmail_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('agentmail_extractor')}

From: Ops Digest <ops@example.test>
Subject: Forwarded actions from Beacon migration
Body:
Forwarded message from Sarah Patel:
Douglas, please review the revised migration contract by Friday.

Forwarded message from Ken Murray:
I approved the Vault 365 pilot yesterday. Please schedule the stakeholder demo for next Tuesday.

Known people: Sarah Patel <sarah.patel@example.test>, Ken Murray <ken@example.test>
Known projects:
beacon-migration: Beacon migration
vault-365: Vault 365
Companies linked to projects (use sender domain/name to infer project_slug):
Beacon Ltd -> beacon-migration`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, {
        is_work_content: false, summary: '', project_slug: null, fact_type: 'fact', action_tasks: [], people: [],
      }, 'agentmail_extractor');
      const tasks = Array.isArray(out.action_tasks) ? out.action_tasks : [];
      const people = Array.isArray(out.people) ? out.people : [];
      return {
        parsed: out,
        checks: [
          ok('work content detected', out.is_work_content === true, JSON.stringify(out)),
          ok('extracts contract review task', tasks.some(t => contains(t.title, 'contract') && contains(t.evidence, 'review')), JSON.stringify(tasks)),
          ok('extracts demo scheduling task', tasks.some(t => contains(t.title, 'demo') && contains(t.evidence, 'schedule')), JSON.stringify(tasks)),
          ok('captures named people from forwarded content', people.some(p => p.name === 'Sarah Patel') && people.some(p => p.name === 'Ken Murray'), JSON.stringify(people)),
          ok('does not collapse distinct actions', tasks.length >= 2, JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'entity_linker_refuse_wrong_entity',
    feature: 'entity_linker',
    json: true,
    messages() {
      const prompt = getPrompt('entity_linker')
        .replaceAll('[SUBJECT]', 'Mistral AI SAS')
        .replaceAll('[PREDICATE]', 'invoice')
        .replaceAll('[VALUE]', 'Issued invoice #MSTRL-API-833752-002 on June 1, 2026')
        .replaceAll('[CANDIDATES]', [
          'contact-m365 — M365 Rollout — known: project contact record accidentally shares a label',
          'project-vault — Vault 365 — known: Microsoft 365 migration for Beacon',
          'contact-sarah — Sarah Patel — known: Beacon migration contract owner',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { entity_id: null, confidence: 0, reason: '' }, 'entity_linker');
      return {
        parsed: out,
        checks: [
          ok('refuses unrelated candidates', out.entity_id == null || out.entity_id === 'null', JSON.stringify(out)),
          ok('confidence remains conservative', Number(out.confidence || 0) <= 0.5, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'crm_duplicate_review_semantic_duplicate',
    feature: 'crm_duplicate_review',
    json: true,
    messages() {
      const prompt = getPrompt('crm_duplicate_review')
        .replaceAll('[CANDIDATE]', JSON.stringify({
          source_kind: 'email',
          source_summary: 'Sarah asked Douglas to send the revised Beacon migration contract by Friday.',
          knowledge_value: 'actions',
          candidate_entities: [{ kind: 'contact', name: 'Sarah Patel', reason: 'sender' }],
          candidate_relationships: [],
          candidate_actions: [{ owner: 'Douglas', action: 'Send Sarah Patel the revised Beacon migration contract by Friday', evidence: 'please send me the revised Beacon migration contract by Friday' }],
          routing_notes: 'Compare against existing open tasks before creating a new one.',
        }, null, 2))
        .replaceAll('[EXISTING]', [
          'TASK task-123: Send revised Beacon migration contract to Sarah /beacon-migration due 2026-07-10 — source email from Sarah',
          'ATOM atom-9: [contact:Sarah Patel] role = Beacon migration contract owner (status active, confidence 0.9)',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { decision: 'uncertain', target_id: null, reason: '', confidence: 0 }, 'crm_duplicate_review');
      return {
        parsed: out,
        checks: [
          ok('semantic duplicate or confirmation detected', ['duplicate', 'confirms_existing'].includes(out.decision), JSON.stringify(out)),
          ok('targets existing task', out.target_id === 'task-123', JSON.stringify(out)),
          ok('reasonable confidence', Number(out.confidence || 0) >= 0.6, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'task_extractor_skip_advice_extract_open',
    feature: 'task_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('task_extractor')}

Document: Beacon migration tracker

Row 1 | Status: Open | Owner: Douglas | Task ID: BM-17 | Action: Review Application Portfolio by 12 July.
Row 2 | Status: Done | Owner: Douglas | Task ID: BM-18 | Action: Upload source workbook.
Recommendation: Teams should generally document rollback plans before migration.
Rubric: Score the implementation on completeness, risk and clarity.`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { tasks: [] }, 'task_extractor');
      const tasks = Array.isArray(out.tasks) ? out.tasks : [];
      return {
        parsed: out,
        checks: [
          ok('extracts the open assigned task', tasks.some(t => contains(t.title, 'Review Application Portfolio') && t.source_ref === 'BM-17'), JSON.stringify(tasks)),
          ok('skips completed task', !tasks.some(t => t.source_ref === 'BM-18' || contains(t.title, 'Upload source workbook')), JSON.stringify(tasks)),
          ok('skips recommendation/rubric advice', !tasks.some(t => contains(t.title, 'rollback') || contains(t.title, 'score')), JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'wiki_page_writer_grounded_json',
    feature: 'wiki_page_writer',
    json: true,
    messages() {
      const sys = getPrompt('wiki_page_writer');
      const user = [
        'Existing wiki pages (slug: title):',
        'beacon-migration: Beacon Migration',
        '',
        'Question: What did the Beacon migration kickoff decide?',
        '',
        'Answer: The kickoff decided that Douglas owns the application portfolio review. Sarah Patel owns contract sign-off. Ken Murray approved the Vault 365 pilot yesterday. No go-live date was agreed.',
      ].join('\n');
      return [{ role: 'system', content: sys }, { role: 'user', content: user }];
    },
    assess(content) {
      const out = asJson(content, {}, 'wiki_page_writer');
      const text = JSON.stringify(out);
      return {
        parsed: out,
        checks: [
          ok('returns JSON object', out && typeof out === 'object' && !Array.isArray(out), text),
          ok('includes grounded named facts', contains(text, 'Sarah Patel') && contains(text, 'Ken Murray') && contains(text, 'Douglas'), text),
          ok('does not invent a concrete go-live date', !/go[- ]live[^.]{0,40}(?:\\b\\d{1,2}\\b|2026|January|February|March|April|May|June|July|August|September|October|November|December)/i.test(text), text),
        ],
      };
    },
  },
  {
    id: 'knowledge_query_surfaces_open_commitment',
    feature: 'knowledge_query',
    json: false,
    messages() {
      const evidence = [
        'Question: What is the status of the Beacon migration?',
        '',
        'ATOMS MATCHING QUERY',
        'ATOM a1: [project:Beacon migration] completed_action = Source mailboxes exported for all pilot users (status active, confidence 0.95)',
        'ATOM a2: [project:Beacon migration] completed_action = Initial stakeholder workshop completed on 2026-07-01 (status active, confidence 0.9)',
        'ATOM a3: [contact:Sarah Patel] open_commitment = Sarah Patel will send signed contract pack for Beacon migration (status active, confidence 0.92)',
        '',
        'SEMANTICALLY RELATED CONTENT',
        'Meeting note: Ken Murray approved the Vault 365 pilot, but contract pack is still outstanding.',
      ].join('\n');
      return [{ role: 'system', content: getPrompt('knowledge_query') }, { role: 'user', content: evidence }];
    },
    assess(content) {
      return {
        parsed: content,
        checks: [
          ok('answers from evidence', contains(content, 'Beacon') && contains(content, 'Sarah Patel'), content),
          ok('surfaces open commitment as outstanding', contains(content, 'outstanding') || contains(content, 'still') || contains(content, 'not complete'), content),
          ok('mentions completed work', contains(content, 'mailboxes') || contains(content, 'workshop'), content),
          ok('does not claim project complete', !/project (is )?complete|migration (is )?complete/i.test(content), content),
        ],
      };
    },
  },
  {
    id: 'email_classifier_body_mention_not_sender',
    feature: 'email_classifier',
    json: true,
    messages() {
      const prompt = getPrompt('email_classifier')
        .replaceAll('[FROM_NAME]', 'Automated Billing')
        .replaceAll('[FROM_EMAIL]', 'billing@example.test')
        .replaceAll('[SUBJECT]', 'Receipt mentioning Sarah Patel')
        .replaceAll('[BODY]', 'Receipt for workspace subscription. Sarah Patel is listed as the billing contact, but no reply is required.')
        .replaceAll('[CONTACTS]', 'Sarah Patel <sarah.patel@example.test>\nKen Murray <ken@example.test>')
        .replaceAll('[PROJECTS]', 'beacon-migration: Beacon migration\nvault-365: Vault 365')
        .replaceAll('[LABELS]', 'Receipts\nAction Required\nNewsletters');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { contact_name: null, project_slug: null, summary: '', fact: null, move_label: null, action_task: null }, 'email_classifier');
      return {
        parsed: out,
        checks: [
          ok('does not match body-mentioned person as sender', out.contact_name == null, JSON.stringify(out)),
          ok('does not create action for receipt', out.action_task == null, JSON.stringify(out)),
          ok('does not force project from incidental name', out.project_slug == null, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'email_classifier_newsletter_no_action',
    feature: 'email_classifier',
    json: true,
    messages() {
      const prompt = getPrompt('email_classifier')
        .replaceAll('[FROM_NAME]', 'AI Strategy Weekly')
        .replaceAll('[FROM_EMAIL]', 'news@example.test')
        .replaceAll('[SUBJECT]', 'AI governance links for the week')
        .replaceAll('[BODY]', 'This issue rounds up three public articles about AI governance. Read more on our website.')
        .replaceAll('[CONTACTS]', 'Sarah Patel <sarah.patel@example.test>\nKen Murray <ken@example.test>')
        .replaceAll('[PROJECTS]', 'beacon-migration: Beacon migration\nvault-365: Vault 365')
        .replaceAll('[LABELS]', 'Newsletters\nAction Required\nProjects/Beacon');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { contact_name: null, project_slug: null, summary: '', fact: null, move_label: null, action_task: null }, 'email_classifier');
      return {
        parsed: out,
        checks: [
          ok('no contact for newsletter sender absent from contacts', out.contact_name == null, JSON.stringify(out)),
          ok('no action for passive reading', out.action_task == null, JSON.stringify(out)),
          ok('label is allowed or null', out.move_label == null || ['Newsletters', 'Action Required', 'Projects/Beacon'].includes(out.move_label), JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'email_classifier_sender_fact_no_action',
    feature: 'email_classifier',
    json: true,
    messages() {
      const prompt = getPrompt('email_classifier')
        .replaceAll('[FROM_NAME]', 'Ken Murray')
        .replaceAll('[FROM_EMAIL]', 'ken@example.test')
        .replaceAll('[SUBJECT]', 'Vault 365 pilot approved')
        .replaceAll('[BODY]', 'Douglas, quick note that I approved the Vault 365 pilot yesterday. No action needed from you.')
        .replaceAll('[CONTACTS]', 'Sarah Patel <sarah.patel@example.test>\nKen Murray <ken@example.test>')
        .replaceAll('[PROJECTS]', 'beacon-migration: Beacon migration\nvault-365: Vault 365')
        .replaceAll('[LABELS]', 'Action Required\nProjects/Vault 365\nNewsletters');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { contact_name: null, project_slug: null, summary: '', fact: null, move_label: null, action_task: null }, 'email_classifier');
      return {
        parsed: out,
        checks: [
          ok('matches sender contact', out.contact_name === 'Ken Murray', JSON.stringify(out)),
          ok('routes to Vault 365', out.project_slug === 'vault-365', JSON.stringify(out)),
          ok('captures approval fact', contains(out.fact, 'approved') && contains(out.fact, 'Vault 365'), JSON.stringify(out)),
          ok('does not create task when no action needed', out.action_task == null, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'email_classifier_unknown_sender_uncertain',
    feature: 'email_classifier',
    json: true,
    messages() {
      const prompt = getPrompt('email_classifier')
        .replaceAll('[FROM_NAME]', 'Jordan')
        .replaceAll('[FROM_EMAIL]', 'jordan@unknown.example')
        .replaceAll('[SUBJECT]', 'Following up')
        .replaceAll('[BODY]', 'Hi Douglas, following up on the thing we discussed. Can you send it over?')
        .replaceAll('[CONTACTS]', 'Sarah Patel <sarah.patel@example.test>\nKen Murray <ken@example.test>')
        .replaceAll('[PROJECTS]', 'beacon-migration: Beacon migration\nvault-365: Vault 365')
        .replaceAll('[LABELS]', 'Action Required\nProjects/Vault 365\nNewsletters');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { contact_name: null, project_slug: null, summary: '', fact: null, move_label: null, action_task: null }, 'email_classifier');
      return {
        parsed: out,
        checks: [
          ok('unknown sender is not forced to known contact', out.contact_name == null, JSON.stringify(out)),
          ok('ambiguous project remains null', out.project_slug == null, JSON.stringify(out)),
          ok('action can be captured without invented object', out.action_task == null || !contains(out.action_task, 'Beacon') && !contains(out.action_task, 'Vault'), JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'agentmail_newsletter_ignored',
    feature: 'agentmail_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('agentmail_extractor')}

From: Vendor Newsletter <newsletter@example.test>
Subject: Five tips for better migrations
Body:
This week's newsletter recommends documenting rollback plans and aligning stakeholders before migration.

Known people: Sarah Patel <sarah.patel@example.test>, Ken Murray <ken@example.test>
Known projects:
beacon-migration: Beacon migration
vault-365: Vault 365
Companies linked to projects (use sender domain/name to infer project_slug):
(none)`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { is_work_content: false, summary: '', project_slug: null, fact_type: 'fact', action_tasks: [], people: [] }, 'agentmail_extractor');
      return {
        parsed: out,
        checks: [
          ok('newsletter marked non-work', out.is_work_content === false, JSON.stringify(out)),
          ok('no tasks from advice', !Array.isArray(out.action_tasks) || out.action_tasks.length === 0, JSON.stringify(out)),
          ok('no people from generic content', !Array.isArray(out.people) || out.people.length === 0, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'agentmail_decision_no_task',
    feature: 'agentmail_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('agentmail_extractor')}

From: Ken Murray <ken@example.test>
Subject: Pilot decision
Body:
Douglas, I approved the Vault 365 pilot yesterday. This is just confirmation; no action needed.

Known people: Sarah Patel <sarah.patel@example.test>, Ken Murray <ken@example.test>
Known projects:
beacon-migration: Beacon migration
vault-365: Vault 365
Companies linked to projects (use sender domain/name to infer project_slug):
(none)`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { is_work_content: false, summary: '', project_slug: null, fact_type: 'fact', action_tasks: [], people: [] }, 'agentmail_extractor');
      const people = Array.isArray(out.people) ? out.people : [];
      return {
        parsed: out,
        checks: [
          ok('work content detected', out.is_work_content === true, JSON.stringify(out)),
          ok('decision type or approval fact captured', out.fact_type === 'decision' || people.some(p => contains(p.fact, 'approved')), JSON.stringify(out)),
          ok('no task for no-action confirmation', !Array.isArray(out.action_tasks) || out.action_tasks.length === 0, JSON.stringify(out)),
          ok('Ken fact captured', people.some(p => p.name === 'Ken Murray' && contains(p.fact, 'approved')), JSON.stringify(people)),
        ],
      };
    },
  },
  {
    id: 'agentmail_open_commitment_not_douglas_task',
    feature: 'agentmail_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('agentmail_extractor')}

From: Sarah Patel <sarah.patel@example.test>
Subject: Contract pack timing
Body:
Ken will send the signed contract pack on Monday. This is an FYI for Douglas; Sarah is not asking Douglas to do anything.

Known people: Sarah Patel <sarah.patel@example.test>, Ken Murray <ken@example.test>
Known projects:
beacon-migration: Beacon migration
vault-365: Vault 365
Companies linked to projects (use sender domain/name to infer project_slug):
Beacon Ltd -> beacon-migration`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { is_work_content: false, summary: '', project_slug: null, fact_type: 'fact', action_tasks: [], people: [] }, 'agentmail_extractor');
      const people = Array.isArray(out.people) ? out.people : [];
      return {
        parsed: out,
        checks: [
          ok('work content detected', out.is_work_content === true, JSON.stringify(out)),
          ok('Ken commitment captured as person fact', people.some(p => p.name === 'Ken Murray' && contains(p.fact, 'contract pack')), JSON.stringify(people)),
          ok('no Douglas task for FYI', !Array.isArray(out.action_tasks) || out.action_tasks.length === 0, JSON.stringify(out.action_tasks)),
        ],
      };
    },
  },
  {
    id: 'agentmail_empty_test_ignored',
    feature: 'agentmail_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('agentmail_extractor')}

From: Test Sender <test@example.test>
Subject: test
Body:
test

Known people: Sarah Patel <sarah.patel@example.test>, Ken Murray <ken@example.test>
Known projects:
beacon-migration: Beacon migration
vault-365: Vault 365
Companies linked to projects (use sender domain/name to infer project_slug):
(none)`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { is_work_content: false, summary: '', project_slug: null, fact_type: 'fact', action_tasks: [], people: [] }, 'agentmail_extractor');
      return {
        parsed: out,
        checks: [
          ok('empty test marked non-work', out.is_work_content === false, JSON.stringify(out)),
          ok('no tasks', !Array.isArray(out.action_tasks) || out.action_tasks.length === 0, JSON.stringify(out)),
          ok('no people', !Array.isArray(out.people) || out.people.length === 0, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'entity_linker_exact_contact_match',
    feature: 'entity_linker',
    json: true,
    messages() {
      const prompt = getPrompt('entity_linker')
        .replaceAll('[SUBJECT]', 'Sarah Patel')
        .replaceAll('[PREDICATE]', 'role')
        .replaceAll('[VALUE]', 'Beacon migration contract owner')
        .replaceAll('[CANDIDATES]', [
          'contact-sarah — Sarah Patel — known: owns contract sign-off for Beacon migration',
          'contact-ken — Ken Murray — known: approved Vault 365 pilot',
          'project-beacon — Beacon migration — known: active migration project',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { entity_id: null, confidence: 0, reason: '' }, 'entity_linker');
      return {
        parsed: out,
        checks: [
          ok('links exact contact', out.entity_id === 'contact-sarah', JSON.stringify(out)),
          ok('high confidence for exact match', Number(out.confidence || 0) >= 0.8, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'entity_linker_project_alias_match',
    feature: 'entity_linker',
    json: true,
    messages() {
      const prompt = getPrompt('entity_linker')
        .replaceAll('[SUBJECT]', 'Vault 365')
        .replaceAll('[PREDICATE]', 'completed_action')
        .replaceAll('[VALUE]', 'Pilot approved by Ken Murray')
        .replaceAll('[CANDIDATES]', [
          'project-vault — Vault 365 — known: alias vault-365; Microsoft 365 migration pilot',
          'project-beacon — Beacon migration — known: migration contract project',
          'contact-ken — Ken Murray — known: approves pilots',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { entity_id: null, confidence: 0, reason: '' }, 'entity_linker');
      return {
        parsed: out,
        checks: [
          ok('links project by alias/name', out.entity_id === 'project-vault', JSON.stringify(out)),
          ok('not mislinked to person', out.entity_id !== 'contact-ken', JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'entity_linker_ambiguous_low_confidence',
    feature: 'entity_linker',
    json: true,
    messages() {
      const prompt = getPrompt('entity_linker')
        .replaceAll('[SUBJECT]', 'Alex')
        .replaceAll('[PREDICATE]', 'prefers')
        .replaceAll('[VALUE]', 'Friday morning meetings')
        .replaceAll('[CANDIDATES]', [
          'contact-alex-r — Alex Reid — known: Beacon migration analyst',
          'contact-alex-m — Alex Morgan — known: Vault 365 finance lead',
          'project-beacon — Beacon migration — known: active migration project',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { entity_id: null, confidence: 0, reason: '' }, 'entity_linker');
      return {
        parsed: out,
        checks: [
          ok('does not force ambiguous first name', out.entity_id == null || Number(out.confidence || 0) < 0.7, JSON.stringify(out)),
          ok('reason mentions ambiguity or insufficient evidence', contains(out.reason, 'ambig') || contains(out.reason, 'not clear') || contains(out.reason, 'insufficient') || contains(out.reason, 'multiple'), JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'entity_linker_known_fact_disambiguates',
    feature: 'entity_linker',
    json: true,
    messages() {
      const prompt = getPrompt('entity_linker')
        .replaceAll('[SUBJECT]', 'Alex')
        .replaceAll('[PREDICATE]', 'commitment')
        .replaceAll('[VALUE]', 'Will send the Vault 365 finance workbook')
        .replaceAll('[CANDIDATES]', [
          'contact-alex-r — Alex Reid — known: Beacon migration analyst',
          'contact-alex-m — Alex Morgan — known: Vault 365 finance lead; owns finance workbook',
          'project-beacon — Beacon migration — known: active migration project',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { entity_id: null, confidence: 0, reason: '' }, 'entity_linker');
      return {
        parsed: out,
        checks: [
          ok('uses known facts to disambiguate', out.entity_id === 'contact-alex-m', JSON.stringify(out)),
          ok('confidence reflects supporting known fact', Number(out.confidence || 0) >= 0.7, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'crm_duplicate_review_new_action',
    feature: 'crm_duplicate_review',
    json: true,
    messages() {
      const prompt = getPrompt('crm_duplicate_review')
        .replaceAll('[CANDIDATE]', JSON.stringify({
          source_kind: 'meeting',
          source_summary: 'Douglas agreed to draft the migration rollback checklist.',
          knowledge_value: 'actions',
          candidate_actions: [{ owner: 'Douglas', action: 'Draft migration rollback checklist', evidence: 'Douglas agreed to draft the rollback checklist' }],
        }, null, 2))
        .replaceAll('[EXISTING]', [
          'TASK task-123: Send revised Beacon migration contract to Sarah /beacon-migration',
          'ATOM atom-9: [contact:Sarah Patel] role = Beacon migration contract owner',
        ].join('\n'));
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { decision: 'uncertain', target_id: null, reason: '', confidence: 0 }, 'crm_duplicate_review');
      return {
        parsed: out,
        checks: [
          ok('classifies genuinely new action', out.decision === 'new', JSON.stringify(out)),
          ok('no existing target for new action', out.target_id == null, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'crm_duplicate_review_correction',
    feature: 'crm_duplicate_review',
    json: true,
    messages() {
      const prompt = getPrompt('crm_duplicate_review')
        .replaceAll('[CANDIDATE]', JSON.stringify({
          source_kind: 'email',
          source_summary: 'Sarah corrected the contract owner: Priya, not Sarah, owns contract sign-off.',
          knowledge_value: 'durable_claims',
          candidate_entities: [{ kind: 'contact', name: 'Priya Shah', reason: 'new named owner' }],
          candidate_relationships: [{ subject: 'Priya Shah', relationship: 'owns', object: 'Beacon migration contract sign-off', evidence: 'Priya, not Sarah, owns contract sign-off' }],
        }, null, 2))
        .replaceAll('[EXISTING]', 'ATOM atom-9: [contact:Sarah Patel] role = Beacon migration contract owner (status active, confidence 0.9)');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { decision: 'uncertain', target_id: null, reason: '', confidence: 0 }, 'crm_duplicate_review');
      return {
        parsed: out,
        checks: [
          ok('detects correction or supersession', ['corrects_existing', 'supersedes_existing'].includes(out.decision), JSON.stringify(out)),
          ok('targets corrected atom', out.target_id === 'atom-9', JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'crm_duplicate_review_confirmation',
    feature: 'crm_duplicate_review',
    json: true,
    messages() {
      const prompt = getPrompt('crm_duplicate_review')
        .replaceAll('[CANDIDATE]', JSON.stringify({
          source_kind: 'email',
          source_summary: 'Ken repeated that Vault 365 pilot approval is complete.',
          knowledge_value: 'durable_claims',
          candidate_entities: [{ kind: 'contact', name: 'Ken Murray', reason: 'sender' }],
          candidate_relationships: [],
          candidate_actions: [],
          knowledge_value_text: 'Ken Murray approved the Vault 365 pilot.',
        }, null, 2))
        .replaceAll('[EXISTING]', 'ATOM atom-22: [contact:Ken Murray] fact = Approved the Vault 365 pilot yesterday (status active, confidence 0.92)');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { decision: 'uncertain', target_id: null, reason: '', confidence: 0 }, 'crm_duplicate_review');
      return {
        parsed: out,
        checks: [
          ok('detects confirmation or duplicate', ['confirms_existing', 'duplicate'].includes(out.decision), JSON.stringify(out)),
          ok('targets existing atom', out.target_id === 'atom-22', JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'crm_duplicate_review_uncertain_thin_evidence',
    feature: 'crm_duplicate_review',
    json: true,
    messages() {
      const prompt = getPrompt('crm_duplicate_review')
        .replaceAll('[CANDIDATE]', JSON.stringify({
          source_kind: 'email',
          source_summary: 'Someone said the pack is sorted.',
          knowledge_value: 'background',
          candidate_actions: [{ owner: 'unknown', action: 'pack is sorted', evidence: 'sorted' }],
        }, null, 2))
        .replaceAll('[EXISTING]', 'TASK task-123: Send revised Beacon migration contract to Sarah /beacon-migration\nATOM atom-9: [contact:Sarah Patel] role = Beacon migration contract owner');
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { decision: 'uncertain', target_id: null, reason: '', confidence: 0 }, 'crm_duplicate_review');
      return {
        parsed: out,
        checks: [
          ok('uses uncertain for thin evidence', out.decision === 'uncertain' || Number(out.confidence || 0) <= 0.5, JSON.stringify(out)),
          ok('does not confidently target unrelated row', out.target_id == null || Number(out.confidence || 0) <= 0.5, JSON.stringify(out)),
        ],
      };
    },
  },
  {
    id: 'task_extractor_no_tasks_from_rubric',
    feature: 'task_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('task_extractor')}

Document: Review rubric

Score the migration plan on completeness, risk, clarity, and stakeholder alignment.
Good plans should include rollback notes.
Example improvement: document ownership earlier.`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { tasks: [] }, 'task_extractor');
      const tasks = Array.isArray(out.tasks) ? out.tasks : [];
      return {
        parsed: out,
        checks: [
          ok('no tasks from rubric/advice', tasks.length === 0, JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'task_extractor_multiple_open_rows',
    feature: 'task_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('task_extractor')}

Document: Project tracker

ID T-1 | Status Open | Owner Douglas | Action: Confirm DNS cutover window with Sarah.
ID T-2 | Status In Progress | Owner Douglas | Action: Prepare pilot mailbox export checklist.
ID T-3 | Status Closed | Owner Douglas | Action: Create shared folder.`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { tasks: [] }, 'task_extractor');
      const tasks = Array.isArray(out.tasks) ? out.tasks : [];
      return {
        parsed: out,
        checks: [
          ok('extracts DNS task', tasks.some(t => t.source_ref === 'T-1' && contains(t.title, 'DNS')), JSON.stringify(tasks)),
          ok('extracts in-progress checklist task', tasks.some(t => t.source_ref === 'T-2' && contains(t.title, 'checklist')), JSON.stringify(tasks)),
          ok('skips closed task', !tasks.some(t => t.source_ref === 'T-3' || contains(t.title, 'shared folder')), JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'task_extractor_owner_not_douglas',
    feature: 'task_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('task_extractor')}

Document: Meeting actions

Open | Owner Sarah Patel | Action: Send the signed contract pack to Douglas.
Open | Owner Douglas | Action: Review the application inventory once Sarah sends the pack.`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { tasks: [] }, 'task_extractor');
      const tasks = Array.isArray(out.tasks) ? out.tasks : [];
      return {
        parsed: out,
        checks: [
          ok('extracts Douglas-owned action', tasks.some(t => contains(t.title, 'Review') && contains(t.title, 'application')), JSON.stringify(tasks)),
          ok('does not turn Sarah-owned action into Douglas task', !tasks.some(t => contains(t.title, 'Send') && contains(t.title, 'contract pack')), JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'task_extractor_accepted_assistant_suggestion',
    feature: 'task_extractor',
    json: true,
    messages() {
      const prompt = `${getPrompt('task_extractor')}

Document: Chat transcript

Assistant suggested: "You could create a rollout risk register."
Douglas replied: "Yes, add that as an outstanding action for me."
Status: Open.`;
      return [{ role: 'user', content: prompt }];
    },
    assess(content) {
      const out = asJson(content, { tasks: [] }, 'task_extractor');
      const tasks = Array.isArray(out.tasks) ? out.tasks : [];
      return {
        parsed: out,
        checks: [
          ok('extracts explicitly accepted assistant suggestion', tasks.some(t => contains(t.title, 'risk register')), JSON.stringify(tasks)),
        ],
      };
    },
  },
  {
    id: 'wiki_page_writer_no_source_invention',
    feature: 'wiki_page_writer',
    json: true,
    messages() {
      const sys = getPrompt('wiki_page_writer');
      const user = [
        'Existing wiki pages (slug: title):',
        'vault-365: Vault 365',
        '',
        'Question: What is known about the Vault 365 pilot?',
        '',
        'Answer: Ken Murray approved the Vault 365 pilot. The source does not include budget, timeline, vendor, or user-count details.',
      ].join('\n');
      return [{ role: 'system', content: sys }, { role: 'user', content: user }];
    },
    assess(content) {
      const out = asJson(content, {}, 'wiki_page_writer');
      const text = JSON.stringify(out);
      return {
        parsed: out,
        checks: [
          ok('includes approved pilot fact', contains(text, 'Ken Murray') && contains(text, 'approved'), text),
          ok('does not invent budget', !/[£€$]\\s?\\d|budget[^.]{0,40}\\d/i.test(text), text),
          ok('does not invent user count', !/\\b\\d+\\s+(users|mailboxes|people)\\b/i.test(text), text),
        ],
      };
    },
  },
  {
    id: 'wiki_page_writer_preserves_open_question',
    feature: 'wiki_page_writer',
    json: true,
    messages() {
      const sys = getPrompt('wiki_page_writer');
      const user = [
        'Existing wiki pages (slug: title):',
        'family-care: Family Care',
        '',
        'Question: What is unresolved in the care plan?',
        '',
        'Answer: The care plan confirms Tuesday medication visits. It does not state who covers Friday evenings.',
      ].join('\n');
      return [{ role: 'system', content: sys }, { role: 'user', content: user }];
    },
    assess(content) {
      const out = asJson(content, {}, 'wiki_page_writer');
      const text = JSON.stringify(out);
      return {
        parsed: out,
        checks: [
          ok('includes confirmed Tuesday visits', contains(text, 'Tuesday') && contains(text, 'medication'), text),
          ok('preserves Friday gap', contains(text, 'Friday') && (contains(text, 'does not state') || contains(text, 'unresolved') || contains(text, 'unknown')), text),
        ],
      };
    },
  },
  {
    id: 'wiki_page_writer_reuses_related_page',
    feature: 'wiki_page_writer',
    json: true,
    messages() {
      const sys = getPrompt('wiki_page_writer');
      const user = [
        'Existing wiki pages (slug: title):',
        'beacon-migration: Beacon Migration',
        'vault-365: Vault 365',
        '',
        'Question: Where does the contract pack update belong?',
        '',
        'Answer: Sarah Patel said the signed contract pack for the Beacon migration is still outstanding.',
      ].join('\n');
      return [{ role: 'system', content: sys }, { role: 'user', content: user }];
    },
    assess(content) {
      const out = asJson(content, {}, 'wiki_page_writer');
      const text = JSON.stringify(out);
      return {
        parsed: out,
        checks: [
          ok('mentions contract pack and Sarah', contains(text, 'contract pack') && contains(text, 'Sarah Patel'), text),
          ok('relates to Beacon migration page', contains(text, 'beacon-migration') || contains(text, 'Beacon Migration'), text),
        ],
      };
    },
  },
  {
    id: 'wiki_page_writer_structures_source_not_chat',
    feature: 'wiki_page_writer',
    json: true,
    messages() {
      const sys = getPrompt('wiki_page_writer');
      const user = [
        'Existing wiki pages (slug: title):',
        '',
        '',
        'Question: Summarise the note',
        '',
        'Answer: Workday note: Douglas felt blocked by unclear ownership on the data migration. Decision: ask Sarah Patel to name a single contract owner. Action: Douglas to draft the ownership options.',
      ].join('\n');
      return [{ role: 'system', content: sys }, { role: 'user', content: user }];
    },
    assess(content) {
      const out = asJson(content, {}, 'wiki_page_writer');
      const text = JSON.stringify(out);
      return {
        parsed: out,
        checks: [
          ok('captures decision/action/source note', contains(text, 'Decision') || contains(text, 'ownership'), text),
          ok('does not include chatty preamble', !contains(text, 'Sure') && !contains(text, 'Here is'), text),
          ok('returns page-like fields', Object.keys(out).length >= 3, text),
        ],
      };
    },
  },
  {
    id: 'knowledge_query_no_evidence',
    feature: 'knowledge_query',
    json: false,
    messages() {
      const evidence = [
        'Question: What is Douglas doing about the Mars relocation project?',
        '',
        'ATOMS MATCHING QUERY',
        '(none)',
        '',
        'SEMANTICALLY RELATED CONTENT',
        '(none)',
      ].join('\n');
      return [{ role: 'system', content: getPrompt('knowledge_query') }, { role: 'user', content: evidence }];
    },
    assess(content) {
      return {
        parsed: content,
        checks: [
          ok('states evidence cannot answer', contains(content, 'cannot') || contains(content, 'no evidence') || contains(content, 'not enough') || contains(content, 'does not contain'), content),
          ok('does not invent Mars plan', !contains(content, 'relocating') && !contains(content, 'timeline'), content),
        ],
      };
    },
  },
  {
    id: 'knowledge_query_counts_completed_actions',
    feature: 'knowledge_query',
    json: false,
    messages() {
      const evidence = [
        'Question: How much of the mailbox export work is done?',
        '',
        'ATOMS MATCHING QUERY',
        'ATOM m1: [project:Vault 365] completed_action = Mailbox 1 exported (status active, confidence 0.9)',
        'ATOM m2: [project:Vault 365] completed_action = Mailbox 2 exported (status active, confidence 0.9)',
        'ATOM m3: [project:Vault 365] completed_action = Mailbox 3 exported (status active, confidence 0.9)',
        'ATOM m4: [project:Vault 365] open_commitment = Vendor will confirm remaining mailbox count (status active, confidence 0.8)',
      ].join('\n');
      return [{ role: 'system', content: getPrompt('knowledge_query') }, { role: 'user', content: evidence }];
    },
    assess(content) {
      return {
        parsed: content,
        checks: [
          ok('summarises/counts completed exports', contains(content, '3') || contains(content, 'three'), content),
          ok('surfaces remaining open commitment', contains(content, 'remaining') || contains(content, 'outstanding') || contains(content, 'confirm'), content),
        ],
      };
    },
  },
  {
    id: 'knowledge_query_separates_evidence_from_unknown',
    feature: 'knowledge_query',
    json: false,
    messages() {
      const evidence = [
        'Question: Who owns contract sign-off and when is it due?',
        '',
        'ATOMS MATCHING QUERY',
        'ATOM c1: [contact:Sarah Patel] role = Owns Beacon migration contract sign-off (status active, confidence 0.9)',
        '',
        'SEMANTICALLY RELATED CONTENT',
        'Email: Sarah confirmed ownership but did not provide a due date.',
      ].join('\n');
      return [{ role: 'system', content: getPrompt('knowledge_query') }, { role: 'user', content: evidence }];
    },
    assess(content) {
      return {
        parsed: content,
        checks: [
          ok('names owner from evidence', contains(content, 'Sarah Patel'), content),
          ok('says due date is unknown/not provided', contains(content, 'no due date') || contains(content, 'not provided') || contains(content, 'unknown') || contains(content, 'does not') || contains(content, 'did not provide') || contains(content, 'deadline is not'), content),
          ok('does not invent due date', !/due (on|by) [A-Z][a-z]+|due (on|by) \\d/i.test(content), content),
        ],
      };
    },
  },
  {
    id: 'knowledge_query_respects_project_specificity',
    feature: 'knowledge_query',
    json: false,
    messages() {
      const evidence = [
        'Question: Is the Beacon migration blocked?',
        '',
        'ATOMS MATCHING QUERY',
        'ATOM b1: [project:Beacon migration] open_commitment = Sarah Patel will send signed contract pack (status active, confidence 0.9)',
        'ATOM v1: [project:Vault 365] completed_action = Pilot approved by Ken Murray (status active, confidence 0.9)',
      ].join('\n');
      return [{ role: 'system', content: getPrompt('knowledge_query') }, { role: 'user', content: evidence }];
    },
    assess(content) {
      return {
        parsed: content,
        checks: [
          ok('answers Beacon status from Beacon atom', contains(content, 'Beacon') && (contains(content, 'blocked') || contains(content, 'outstanding')), content),
          ok('does not use Vault completion as Beacon completion', !/Beacon migration (?:is |was |appears )?(?:complete|approved)\\b/i.test(content), content),
        ],
      };
    },
  },
];

async function runFixture(fixture, live) {
  const prompt = getPrompt(fixture.feature);
  const model = getModel(fixture.feature);
  if (!live) {
    return {
      id: fixture.id,
      feature: fixture.feature,
      status: 'skipped',
      model,
      prompt_hash: sha(prompt),
      note: 'dry run; pass --live to call models',
    };
  }

  let result;
  try {
    result = await callModel({
      feature: fixture.feature,
      messages: fixture.messages(),
      json: fixture.json,
      temperature: fixture.json ? 0.1 : 0.2,
      timeout: fixture.timeout || 180_000,
    });
  } catch (err) {
    return {
      id: fixture.id,
      feature: fixture.feature,
      status: 'failed',
      model,
      prompt_hash: sha(prompt),
      checks: [ok('model call completed', false, err.message)],
    };
  }
  let assessed;
  try {
    assessed = fixture.assess(result.content);
  } catch (err) {
    assessed = { parsed: null, checks: [ok('parse/assessment failed', false, err.message)] };
  }
  const passed = assessed.checks.every(c => c.pass);
  return {
    id: fixture.id,
    feature: fixture.feature,
    status: passed ? 'passed' : 'failed',
    model: result.model,
    actual_model: result.actualModel,
    prompt_hash: sha(prompt),
    latency_ms: result.ms,
    cost_usd: result.usage.cost == null ? null : Number(result.usage.cost || 0),
    checks: assessed.checks,
    parsed: assessed.parsed,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.live && !process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required for --live');
  }
  const selected = args.only ? fixtures.filter(f => args.only.has(f.feature) || args.only.has(f.id)) : fixtures;
  const results = [];
  for (const fixture of selected) {
    process.stderr.write(`[knowledge-regression] ${args.live ? 'running' : 'dry'} ${fixture.id}\n`);
    results.push(await runFixture(fixture, args.live));
  }

  const summary = {
    generated_at: new Date().toISOString(),
    live: args.live,
    total: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    results,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Knowledge regression harness: ${summary.passed}/${summary.total} passed (${summary.failed} failed, ${summary.skipped} skipped)`);
    for (const r of results) {
      console.log(`\n${r.status.toUpperCase()} ${r.id} [${r.feature}] ${r.model} prompt=${r.prompt_hash}`);
      if (r.note) console.log(`  ${r.note}`);
      for (const c of r.checks || []) {
        console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.label}${c.detail ? ` — ${String(c.detail).slice(0, 220)}` : ''}`);
      }
    }
  }

  if (summary.failed) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
