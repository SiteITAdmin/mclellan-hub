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
  // Opus 5.5 at medium beats Opus 5 at high on coding and analysis, and at a
  // given level it thinks more per turn than Opus 5 did — so high here spent
  // extra quota for no measured gain (Anthropic migration notes, Oct 2026).
  opus: Object.freeze({ runner: 'claude', model: 'opus', effort: 'medium' }),
  grok: Object.freeze({ runner: 'claude', model: 'haiku', effort: 'high' }),
  // Grok CLI frontier lane — the availability fallback when Opus is at
  // capacity (e.g. 20 Aug 2026 briefing failures). Same subscription-CLI
  // plane as everything else here; still zero OpenRouter.
  grok_frontier: Object.freeze({ runner: 'grok', model: 'grok-4.7', effort: 'high' }),
  // Stand-ins for when a whole subscription is unavailable (a usage limit, an
  // expired sign-in, an outage): Claude → ChatGPT → Grok (Douglas, 12 Nov 2026).
  gpt_standin: Object.freeze({ runner: 'codex', model: 'gpt-5.6-luna', effort: 'high', fallbackTo: 'grok_frontier' }),
  claude_standin: Object.freeze({ runner: 'claude', model: 'sonnet', effort: 'medium', fallbackTo: 'gpt_standin' }),
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
    // Keep provider order: Claude → ChatGPT → Grok, without cycling back.
    fallbackTo: overrides.fallbackTo !== undefined ? overrides.fallbackTo
      : ({ claude: 'gpt_standin', codex: 'grok_frontier' }[overrides.runner || base.runner] || null),
    externalEffects: overrides.externalEffects === true,
    jsonMode: overrides.jsonMode !== false,
    allowTools: overrides.allowTools === true,
  });
}

// Active feature slots for the current Hub (CRM, Money, House, Work Briefing,
// Portfolio chat/JD analyser) plus baseline compatibility tiers.
const FEATURE_RUNNERS = Object.freeze({
  // ── Personal CRM & Knowledge ─────────────────────────────────────────────
  crm_atomise: slot('sonnet', { effort: 'medium', maxInputChars: 60000, maxEvidenceRecords: 1, timeoutMs: 300000 }),
  crm_boox_read: slot('sonnet', { effort: 'medium', maxInputChars: 16000, maxOutputChars: 32000, timeoutMs: 300000 }),
  crm_report: slot('opus', { effort: 'high', maxInputChars: 100000, maxOutputChars: 40000, timeoutMs: 300000 }),

  // ── Work briefing (two-step: private themes → public web search) ─────────
  crm_briefing_themes: slot('sonnet', { effort: 'medium', maxInputChars: 60000, maxOutputChars: 16000, timeoutMs: 300000 }),
  crm_briefing_search: slot('sonnet', { effort: 'medium', allowTools: true, maxInputChars: 20000, maxOutputChars: 40000, timeoutMs: 600000, fallbackTo: 'grok_frontier' }),

  // ── Standalone tools: Personal Money & House hunting ─────────────────────
  crm_money_read: slot('sonnet', { effort: 'medium', maxInputChars: 30000, maxOutputChars: 40000, timeoutMs: 300000 }),
  crm_money_mail: slot('sonnet', { effort: 'medium', maxInputChars: 80000, maxOutputChars: 32000, timeoutMs: 300000 }),
  crm_money_deals: slot('sonnet', { effort: 'medium', allowTools: true, maxInputChars: 20000, maxOutputChars: 32000, timeoutMs: 600000, fallbackTo: 'grok_frontier' }),
  crm_money_challenge: slot('opus', { effort: 'high', maxInputChars: 100000, maxOutputChars: 40000, timeoutMs: 300000 }),
  crm_house_mail: slot('sonnet', { effort: 'medium', maxInputChars: 70000, maxOutputChars: 30000, timeoutMs: 300000 }),

  // ── Portfolio site chat & JD analyser ────────────────────────────────────
  chat: slot('sonnet', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat: slot('sonnet', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_luna: slot('luna', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_terra: slot('terra', { jsonMode: false, timeoutMs: 240000 }),
  hub_chat_opus: slot('opus', { jsonMode: false, timeoutMs: 300000 }),

  // ── Baseline tier / failover test slots ──────────────────────────────────
  crm_parser: slot('luna'),
  nakai_daily_briefing: slot('opus', { jsonMode: false, timeoutMs: 360000 }),
  embeddings: slot('local_embed', { timeoutMs: 120000, jsonMode: false }),
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
