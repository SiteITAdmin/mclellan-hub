'use strict';

// Central feature → subscription runner registry.
// Task family first, difficulty second. No OpenRouter routes.

// Model history: Luna/Terra were Codex (gpt-5.6-luna / gpt-5.6-terra), moved to
// Grok on 4 Aug 2026, then to the OpenCode free tier on 8 Aug when Grok credits
// ran out. The 4 Aug "Codex usage limit" turned out not to be the Hub's steady
// load — it was a one-off sol-5.6 retooling job that ate the ChatGPT quota;
// gpt-5.6-luna verified working again 9 Aug. Both bulk tiers now point at
// Codex gpt-5.6-luna — a single Luna lane (no separate gpt-5.6-terra), with the
// effort split kept: bulk extraction at low, operational reasoning at medium.
// Sonnet/Opus stay on Claude; the grok research tier stays on Haiku (it needs
// web/tool capability). Douglas is rationing sol-5.6 to protect this quota.
const MODELS = Object.freeze({
  luna: Object.freeze({ runner: 'codex', model: 'gpt-5.6-luna', effort: 'low' }),
  terra: Object.freeze({ runner: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }),
  sonnet: Object.freeze({ runner: 'claude', model: 'sonnet', effort: 'high' }),
  opus: Object.freeze({ runner: 'claude', model: 'opus', effort: 'high' }),
  grok: Object.freeze({ runner: 'claude', model: 'haiku', effort: 'high' }),
  // Grok CLI frontier lane — the availability fallback when Opus is at
  // capacity (e.g. 20 Aug 2026 briefing failures). Same subscription-CLI
  // plane as everything else here; still zero OpenRouter.
  grok46: Object.freeze({ runner: 'grok', model: 'grok-4.6', effort: 'high' }),
  local_embed: Object.freeze({ runner: 'local', model: 'local-embeddings', effort: 'none' }),
  local_stt: Object.freeze({ runner: 'local', model: 'local-whisper', effort: 'none' }),
  local_tts: Object.freeze({ runner: 'local', model: 'local-tts', effort: 'none' }),
});

// Luna and Terra absorbed Codex's ~80% share on top of their own on 4 August,
// and generation time rose with the extra load — jobs finishing just past the
// old 180s cap were thrown away as timeouts and silently re-run from scratch
// on the next cycle. Give the two overloaded tiers headroom; other tiers keep
// the original default unless a feature overrides it explicitly.
const TIER_DEFAULT_TIMEOUT_MS = Object.freeze({
  luna: 240000,
  terra: 240000,
});

function slot(tier, overrides = {}) {
  const base = MODELS[tier];
  if (!base) throw new Error(`Unknown model tier: ${tier}`);
  return Object.freeze({
    tier,
    runner: overrides.runner || base.runner,
    model: overrides.model || base.model,
    effort: overrides.effort || base.effort,
    timeoutMs: overrides.timeoutMs ?? TIER_DEFAULT_TIMEOUT_MS[tier] ?? 180000,
    maxInputChars: overrides.maxInputChars ?? 120000,
    maxEvidenceRecords: overrides.maxEvidenceRecords ?? 40,
    maxOutputChars: overrides.maxOutputChars ?? 32000,
    retries: overrides.retries ?? 2,
    escalateTo: overrides.escalateTo || null,
    // Availability fallback: used only when the primary runner fails (e.g.
    // "model at capacity"). Opus falls back to Grok 4.6; nothing else by default.
    fallbackTo: overrides.fallbackTo !== undefined ? overrides.fallbackTo : (tier === 'opus' ? 'grok46' : null),
    externalEffects: overrides.externalEffects === true,
    jsonMode: overrides.jsonMode !== false,
    allowTools: overrides.allowTools === true,
  });
}

// Feature keys match system-model slots, requestModelObject feature args,
// and subscription job feature names (underscores preferred).
const FEATURE_RUNNERS = Object.freeze({
  // ── Luna: bulk structured extraction (~55–65%) ──────────────────────────
  atom_extractor: slot('luna', { maxInputChars: 80000, maxEvidenceRecords: 1 }),
  completed_task_atom_extractor: slot('luna', { maxInputChars: 40000, maxEvidenceRecords: 5 }),
  crm_parser: slot('luna'),
  'crm-intent': slot('luna'),
  email_classifier: slot('luna', { maxInputChars: 60000, maxEvidenceRecords: 1 }),
  'email-classifier': slot('luna', { maxInputChars: 60000, maxEvidenceRecords: 1 }),
  email_classifier_sent: slot('luna', { maxInputChars: 60000, maxEvidenceRecords: 1 }),
  agentmail_extractor: slot('luna', { maxInputChars: 80000, maxEvidenceRecords: 1 }),
  'agentmail-work-extractor': slot('luna', { maxInputChars: 80000, maxEvidenceRecords: 1 }),
  agentmail_extractor_alias: slot('luna'),
  newsletter_extractor: slot('luna'),
  'newsletter-extractor': slot('luna'),
  task_extractor: slot('luna'),
  'doc-task-extractor': slot('luna'),
  'mycelium-doc-tasks': slot('luna'),
  debrief_extractor: slot('luna'),
  recall_tagger: slot('luna', { effort: 'low', timeoutMs: 180000 }),
  'recall-tagging': slot('luna', { effort: 'low', timeoutMs: 180000 }),
  quality_board_inspect: slot('luna'),
  linkedin_scorer: slot('luna'),
  linkedin_title: slot('luna'),
  travel_price_extract: slot('luna'),
  'travel-price-extract': slot('luna'),
  source_admission_assist: slot('luna', { maxEvidenceRecords: 1 }),
  reg_synopsis: slot('luna'),
  'regulatory-monitor': slot('luna'),
  nakai_ref_extraction: slot('luna'),
  ai_humanizer: slot('luna'),
  'ai-humanizer': slot('luna'),

  // ── Terra: routine operational intelligence (~20–25%) ────────────────────
  crm_source_triage: slot('terra', { maxEvidenceRecords: 8 }),
  crm_duplicate_review: slot('terra', { maxEvidenceRecords: 20 }),
  entity_linker: slot('terra'),
  entity_resolution: slot('terra', { maxEvidenceRecords: 30 }),
  attribution_reconciliation: slot('terra', {
    model: 'gpt-5.6-terra',
    effort: 'high',
    maxInputChars: 240000,
    maxEvidenceRecords: 1,
    maxOutputChars: 64000,
    timeoutMs: 300000,
  }),
  crm_action_projection: slot('terra', { maxEvidenceRecords: 12 }),
  crm_action_resolution: slot('terra', { maxEvidenceRecords: 12 }),
  task_rule_learner: slot('terra'),
  'task-wrong-learning': slot('terra'),
  meeting_intake: slot('terra', { maxInputChars: 100000, maxEvidenceRecords: 1, escalateTo: 'sonnet', timeoutMs: 300000 }),
  'meeting-intake': slot('terra', { maxInputChars: 100000, maxEvidenceRecords: 1, escalateTo: 'sonnet', timeoutMs: 300000 }),
  document_tasks: slot('terra'),
  knowledge_query: slot('terra', { jsonMode: false, maxEvidenceRecords: 30 }),
  opportunity_extractor: slot('terra'),
  suggestion_duplicate_review: slot('terra'),
  suggestions: slot('terra'),
  'suggestion-engine': slot('terra'),
  suggestion_travel: slot('terra'),
  'suggestion-travel': slot('terra'),
  suggestion_contact: slot('terra'),
  suggestion_opportunity: slot('terra'),
  suggestion_rule_learner: slot('terra'),
  salience_search_plan: slot('terra'),
  repair_triage: slot('opus', { model: 'claude-opus-4-8' }),
  remediation_advisor: slot('terra'),
  prompt_adapter: slot('terra', { escalateTo: 'sonnet' }),
  'prompt-adapter': slot('terra', { escalateTo: 'sonnet' }),
  prompt_optimizer: slot('terra'),
  'prompt-optimizer': slot('terra'),
  prompt_improver: slot('terra'),
  'testbench-prompt-improver': slot('terra'),
  clarification_answer: slot('terra'),
  newsletter_retrieval: slot('terra'),
  'newsletter-retrieval': slot('terra'),
  hermes_crm_capture: slot('terra'),
  'hermes-crm-capture': slot('terra'),
  daily_digest: slot('terra', { jsonMode: false }),
  'daily-digest': slot('terra', { jsonMode: false }),
  weekly_digest: slot('terra', { jsonMode: false }),
  'weekly-digest': slot('terra', { jsonMode: false }),
  mycelium: slot('terra'),
  synthesis: slot('terra'),
  admin_synthesiser: slot('terra', { jsonMode: false }),
  hub_dev_constraint: slot('terra'),
  linkedin_drafter: slot('terra', { jsonMode: false }),
  linkedin_carousel: slot('terra'),
  linkedin_image: slot('terra', { jsonMode: false }),
  'linkedin-pipeline': slot('terra'),
  'linkedin-drafter': slot('terra', { jsonMode: false }),
  'linkedin-scorer': slot('terra'),
  'linkedin-carousel': slot('terra'),
  'linkedin-image-prompt': slot('terra', { jsonMode: false }),
  debrief_interviewer: slot('terra', { jsonMode: false }),
  multisearch_planner: slot('terra'),
  interest_synthesis: slot('sonnet', { maxEvidenceRecords: 25, maxInputChars: 100000 }),

  // ── Grok: research / current-information (~10–15%) ───────────────────────
  content_research_driver: slot('grok', { timeoutMs: 300000, allowTools: true, jsonMode: false }),
  content_research: slot('grok', { timeoutMs: 300000, allowTools: true, jsonMode: false }),
  regulatory_discovery: slot('grok', { allowTools: true, jsonMode: false }),
  watchlist_research: slot('grok', { allowTools: true, jsonMode: false }),
  travel_intelligence: slot('grok', { allowTools: true }),
  opportunity_research: slot('grok', { allowTools: true }),
  linkedin_planner: slot('grok', { allowTools: true }),
  'linkedin-planner': slot('grok', { allowTools: true }),
  multisearch_research: slot('grok', { allowTools: true, jsonMode: false }),
  hub_chat_research: slot('grok', { allowTools: true, jsonMode: false, timeoutMs: 240000 }),
  repair_agent: slot('opus', { model: 'claude-opus-4-8', allowTools: true, jsonMode: false, timeoutMs: 300000 }),

  // ── Sonnet: senior synthesis / editorial (~3–7%) ─────────────────────────
  cross_entity_synthesis: slot('sonnet', {
    maxEvidenceRecords: 80,
    maxInputChars: 100000,
    timeoutMs: 300000,
    jsonMode: false,
    effort: 'high',
  }),
  live_thread_synthesis: slot('sonnet', { maxEvidenceRecords: 40, maxInputChars: 80000, jsonMode: false }),
  newsletter_briefing: slot('sonnet', { jsonMode: false, maxInputChars: 100000, timeoutMs: 300000 }),
  // This is the ChatGPT Go/Codex lane. A previous day's complete newsletter
  // source packet can exceed 200KB, and its keep-all editorial briefing can
  // exceed the generic 32KB cap.
  newsletter_digest_briefing: slot('luna', { effort: 'high', jsonMode: false, maxInputChars: 360000, maxOutputChars: 200000, timeoutMs: 900000 }),
  wiki_page_writer: slot('sonnet', { jsonMode: false }),
  'wiki-doc-save': slot('sonnet', { jsonMode: false }),
  'wiki-qa-save': slot('sonnet', { jsonMode: false }),
  wiki_search: slot('sonnet', { jsonMode: false }),
  'wiki-search': slot('sonnet', { jsonMode: false }),
  linkedin_synthesiser: slot('sonnet', { jsonMode: false }),
  'linkedin-synthesiser': slot('sonnet', { jsonMode: false }),
  linkedin_refiner: slot('sonnet', { jsonMode: false }),
  'linkedin-refiner': slot('sonnet', { jsonMode: false }),
  linkedin_carousel_reviewer: slot('sonnet'),
  'linkedin-carousel-reviewer': slot('sonnet'),
  consigliere_brief: slot('sonnet', { jsonMode: false, timeoutMs: 240000 }),
  multisearch_synthesiser: slot('sonnet', { jsonMode: false }),
  m365_daily_briefing: slot('sonnet', { jsonMode: false, timeoutMs: 300000, escalateTo: 'opus' }),
  us_block_special_briefing: slot('sonnet', { jsonMode: false, timeoutMs: 300000, escalateTo: 'opus' }),
  style_distiller: slot('sonnet'),
  prompt_shaper: slot('sonnet'),
  nakai_ref_synthesis: slot('sonnet', { jsonMode: false }),
  project_report: slot('sonnet', { jsonMode: false }),
  debrief_synthesis: slot('sonnet', { jsonMode: false }),
  hub_chat: slot('sonnet', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_luna: slot('luna', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_terra: slot('terra', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_opus: slot('opus', { jsonMode: false, timeoutMs: 300000 }),
  chat: slot('sonnet', { jsonMode: false, timeoutMs: 240000 }),
  testbench: slot('terra', { jsonMode: false }),

  // ── Opus: exceptional adjudication (<2%) ─────────────────────────────────
  nakai_daily_briefing: slot('opus', { jsonMode: false, timeoutMs: 360000 }),
  ontology_architecture: slot('opus', { jsonMode: false }),
  model_governance: slot('opus'),
  model_effectiveness_review: slot('opus', { timeoutMs: 360000 }),
  major_regulatory_report: slot('opus', { jsonMode: false }),
  sensitive_knowledge_decision: slot('opus'),

  // ── Quality board first-pass stays Luna; senior review escalates ─────────
  nakai_briefing_quality_review: slot('luna', { effort: 'medium', timeoutMs: 240000, jsonMode: false }),

  // ── Specialists (local only; no OpenRouter fallback) ─────────────────────
  embeddings: slot('local_embed', { timeoutMs: 120000, jsonMode: false }),
  debrief_transcriber: slot('local_stt', { timeoutMs: 300000, jsonMode: false }),
  workday_transcription: slot('local_stt', { timeoutMs: 300000, jsonMode: false }),
  'workday-transcription': slot('local_stt', { timeoutMs: 300000, jsonMode: false }),
  debrief_tts: slot('local_tts', { timeoutMs: 120000, jsonMode: false }),
  wiki_image_vision: slot('sonnet', { jsonMode: false, maxEvidenceRecords: 1 }),
  'wiki-image-vision': slot('sonnet', { jsonMode: false, maxEvidenceRecords: 1 }),
});

function normalizeFeature(feature) {
  return String(feature || '').trim().replace(/-/g, '_');
}

function resolveFeatureRunner(feature, { escalate = false } = {}) {
  const raw = String(feature || '').trim();
  const underscored = normalizeFeature(raw);
  let config = FEATURE_RUNNERS[raw] || FEATURE_RUNNERS[underscored] || null;
  if (!config) {
    // Unknown features default to Terra (routine operational), never OpenRouter.
    config = slot('terra', { jsonMode: true });
  }
  if (escalate && config.escalateTo && MODELS[config.escalateTo]) {
    const next = MODELS[config.escalateTo];
    return Object.freeze({
      ...config,
      tier: config.escalateTo,
      runner: next.runner,
      model: next.model,
      effort: next.effort,
      escalateTo: null,
    });
  }
  return config;
}

function listFeatureRunners() {
  return Object.entries(FEATURE_RUNNERS).map(([feature, config]) => ({ feature, ...config }));
}

function isKnownFeature(feature) {
  const raw = String(feature || '').trim();
  return Boolean(FEATURE_RUNNERS[raw] || FEATURE_RUNNERS[normalizeFeature(raw)]);
}

module.exports = {
  MODELS,
  FEATURE_RUNNERS,
  resolveFeatureRunner,
  listFeatureRunners,
  isKnownFeature,
  normalizeFeature,
  slot,
};
