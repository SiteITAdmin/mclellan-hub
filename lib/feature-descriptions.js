'use strict';

/**
 * Plain-English descriptions of the LLM features (model_key / task feature) that
 * appear in request_logs, so the daily report can explain itself instead of
 * showing bare snake_case keys. Grounded in the actual prompts and pipelines —
 * see lib/prompts.js and the named pipeline modules. Descriptions are
 * documentation, not derived data, so a static map is the right home.
 *
 * Keys are matched loosely: case, hyphens, and underscores are ignored, so both
 * `email-classifier` and `email_classifier` resolve to the same entry.
 */

const FEATURE_DESCRIPTIONS = {
  // CRM knowledge engine — the prompt operating system (lib/crm-knowledge-engine.js)
  crm_source_triage:
    'CRM engine gatekeeper — inspects a new source and decides what knowledge work it needs; writes no CRM rows itself.',
  crm_duplicate_review:
    'CRM engine de-duplicator — is a candidate claim new, a duplicate, a correction, or a supersession of existing knowledge?',
  crm_atom_duplicate_review:
    'CRM atom-pair adjudicator — decides whether two candidate facts are the same claim; exact repeats are circuit-protected.',
  crm_action_projection:
    'CRM engine task-maker — promotes only genuinely outstanding actions into visible tasks/reminders.',
  attribution_reconciliation:
    'Recurring whole-source reviewer — repairs missing or contradicted person, fact, action-owner, atom, and task links from the complete meeting transcript.',

  // Nightly knowledge layer (lib/knowledge-synthesis.js)
  cross_entity_synthesis:
    'Nightly — reads every active atom and finds patterns, workflows, non-obvious connections, and blind spots across entities.',
  live_thread_synthesis:
    'Nightly — notices when unrelated sources circle the same idea, risk, or opportunity and maintains them as live threads.',
  interest_synthesis:
    'Distils recurring interests/themes from ingested signals for content and suggestions.',

  // Inbox (lib/email-processor.js)
  email_classifier:
    'Inbox front door — classifies each incoming email against known contacts and projects for the CRM.',

  // Briefings
  nakai_daily_briefing:
    "Nakai's premium daily briefing — the one job deliberately run on Claude Opus.",
  project_report:
    'Narrative status summary for a project from its linked knowledge and tasks.',

  // Content / LinkedIn (lib/linkedin-pipeline.js)
  linkedin_synthesiser:
    'LinkedIn research analyst with live web search — briefs current source material to write posts from.',
  linkedin_planner: 'LinkedIn pipeline — plans the post/carousel structure.',
  linkedin_drafter: 'LinkedIn pipeline — writes the first draft.',
  linkedin_refiner: 'LinkedIn pipeline — refines a draft against the scoring rubric.',
  linkedin_scorer: 'LinkedIn pipeline — scores a draft on expertise, signal/noise, recruiter view.',
  linkedin_carousel: 'LinkedIn pipeline — builds carousel slides.',
  linkedin_carousel_reviewer: 'LinkedIn pipeline — quality-reviews the carousel.',
  linkedin_title: 'LinkedIn pipeline — writes the post title/teaser.',
  linkedin_image_prompt: 'LinkedIn pipeline — writes the image-generation prompt.',

  // Suggestion engine
  suggestion_contact:
    'Proposes one evidence-backed or explicitly hypothetical outreach reason per CRM contact without an open task; candidate only until accepted.',
  suggestion_travel:
    'Suggests travel actions from extracted price signals; advisory only, never books.',

  // Newsletters (lib/newsletter-pipeline.js)
  newsletter_extractor:
    'Splits each newsletter email into every distinct topic — high-volume bulk extraction on a cheap model.',
  newsletter_briefing: 'Newsletter pipeline — composes the weekly intelligence briefing.',
  newsletter_retrieval: 'Newsletter pipeline — retrieves relevant stored topics for a query.',

  // Regulatory (lib/regulatory-monitor.js)
  regulatory_monitor:
    'Watches regulatory/reference sites for changes relevant to Nakai and surfaces what moved.',

  // Travel (lib/suggestion-engine.js)
  travel_price_extract:
    'Pulls structured flight-price data out of Skyscanner alert emails to feed the travel suggester.',

  // Knowledge substrate
  atom_extractor:
    'Extracts durable knowledge atoms from ingested source text.',
  recall_tagging:
    'Tags content for later recall/retrieval in the knowledge layer.',
  prompt_adapter:
    'Shapes a system prompt for a target model family (style profiles).',
  embeddings:
    'Vector embeddings for semantic search across the knowledge layer — background indexing, near-zero cost.',
  clarification_answer:
    'Turns a CRM/governance clarification Q&A into one durable knowledge sentence before writing an atom.',
  consigliere_brief:
    'Writes the plain-English daily Consigliere brief Douglas reads each evening.',
  remediation_advisor:
    'Picks a reversible job from the remediation whitelist when a family health check fails with no fixer.',
  repair_triage:
    'Mac-mini self-repair: confirms or downgrades fixable-narrow verdicts before Grok CLI runs.',
  repair_agent:
    'Mac-mini self-repair coding agent system prompt (Grok CLI session).',
  daily_digest:
    'Vault daily topic digest — summarises journal + email activity per project.',
  wiki_search:
    'Wiki natural-language search synthesiser — answers from private sources only.',
  newsletter_retrieval:
    'Ranks newsletter/publication candidates for a free-form briefing focus.',
  agentmail_extractor:
    'Extracts people, facts and actions from AgentMail messages.',
};

function normaliseFeatureKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const NORMALISED = new Map(
  Object.entries(FEATURE_DESCRIPTIONS).map(([key, desc]) => [normaliseFeatureKey(key), desc])
);

function describeFeature(key) {
  return NORMALISED.get(normaliseFeatureKey(key)) || null;
}

module.exports = { FEATURE_DESCRIPTIONS, describeFeature, normaliseFeatureKey };
