'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemPromptOverride } = require('./settings');
const { requestModelObject } = require('./model-request');
const { currentInfoSearch } = require('./current-info-search');
const { sendEmail } = require('./gmail');
const { openRouterHeaders } = require('./openrouter-attribution');
const { readGovernanceReport } = require('./model-governance-review');

const APP_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.join(APP_ROOT, 'data');
const REPORT_PATH = process.env.MODEL_EFFECTIVENESS_REPORT_PATH
  || path.join(DATA_ROOT, 'model-effectiveness-review.json');
const ARCHIVE_ROOT = process.env.MODEL_EFFECTIVENESS_ARCHIVE_ROOT
  || path.join(DATA_ROOT, 'model-effectiveness-reviews');
const PROGRESS_PATH = process.env.MODEL_EFFECTIVENESS_PROGRESS_PATH
  || path.join(DATA_ROOT, '.model-effectiveness-review.progress.json');
const REPORT_TO = process.env.MODEL_EFFECTIVENESS_EMAIL
  || process.env.SYSTEM_REPORT_EMAIL
  || 'douglas@mclellan.scot';
const REVIEW_DAY = Number(process.env.MODEL_EFFECTIVENESS_DAY || 18);
const REVIEW_HOUR = Number(process.env.MODEL_EFFECTIVENESS_HOUR || 5);
const REVIEW_MINUTE = Number(process.env.MODEL_EFFECTIVENESS_MINUTE || 0);
const APPEAL_THRESHOLD = Number(process.env.MODEL_EFFECTIVENESS_APPEAL_THRESHOLD || 75);
const BATCH_SIZE = Math.max(1, Math.min(8, Number(process.env.MODEL_EFFECTIVENESS_BATCH_SIZE || 8)));
const LOOKBACK_DAYS = Math.max(7, Number(process.env.MODEL_EFFECTIVENESS_LOOKBACK_DAYS || 30));

const PANEL = Object.freeze([
  {
    key: 'luna',
    label: 'OpenAI GPT-5.6 Luna',
    modelId: 'openai/gpt-5.6-luna',
    provider: 'openai',
    familyTerms: ['gpt', '5.6', 'luna'],
  },
  {
    key: 'grok',
    label: 'xAI Grok 4.5',
    modelId: 'x-ai/grok-4.5',
    provider: 'x-ai',
    familyTerms: ['grok', '4.5'],
  },
  {
    key: 'sonnet',
    label: 'Anthropic Claude Sonnet 5',
    modelId: 'anthropic/claude-sonnet-5',
    provider: 'anthropic',
    familyTerms: ['claude', 'sonnet', '5'],
  },
]);

const RUBRIC = Object.freeze({
  observed_effectiveness: 30,
  prompt_quality: 25,
  model_task_fit: 20,
  reliability: 10,
  cost_latency: 10,
  governance: 5,
});

const FAILURE_CATEGORIES = new Set([
  'none', 'prompt_contract', 'model_fit', 'reliability', 'cost_latency',
  'governance', 'insufficient_evidence', 'multiple',
]);
const REMEDY_CLASSES = new Set([
  'none', 'prompt_revision', 'model_change', 'prompt_and_model_change',
  'instrumentation', 'operational_fix', 'human_review',
]);

// Prompt-only slots share the execution model of their named parent slot.
const PARENT_MODEL_FEATURE = Object.freeze({
  task_rule_learner: 'task_extractor',
  suggestion_travel: 'suggestions',
  suggestion_contact: 'suggestions',
  suggestion_opportunity: 'suggestions',
  salience_search_plan: 'suggestions',
  travel_price_extract: 'suggestions',
  suggestion_rule_learner: 'suggestions',
  work_brief_recap: 'work_daily_brief',
  work_brief_today: 'work_daily_brief',
  work_brief_project_salience: 'work_daily_brief',
  spiciness_challenging_drafter: 'linkedin_drafter',
  spiciness_provocative_drafter: 'linkedin_drafter',
  spiciness_challenging_refiner: 'linkedin_refiner',
  spiciness_provocative_refiner: 'linkedin_refiner',
  spiciness_challenging_carousel: 'linkedin_carousel',
  spiciness_provocative_carousel: 'linkedin_carousel',
  newsletter_extractor_full: 'newsletter_extractor',
  newsletter_extractor_minimal: 'newsletter_extractor',
  newsletter_retrieval: 'newsletter_extractor',
  email_classifier_sent: 'email_classifier',
  hub_chat_research: 'hub_chat',
});

let activeRun = null;

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function reviewerIndexForDate(date) {
  // July 2026 is the agreed first Luna month; the rotation is stable in both directions.
  const monthsFromAnchor = (date.getFullYear() - 2026) * 12 + date.getMonth() - 6;
  return ((monthsFromAnchor % PANEL.length) + PANEL.length) % PANEL.length;
}

function reviewerForDate(date) {
  return PANEL[reviewerIndexForDate(date)];
}

function readEffectivenessReport() {
  try {
    return { report: JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')), error: null, path: REPORT_PATH };
  } catch (err) {
    if (err.code === 'ENOENT') return { report: null, error: null, path: REPORT_PATH };
    return { report: null, error: err.message, path: REPORT_PATH };
  }
}

function readEffectivenessProgress() {
  try {
    return { progress: JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')), error: null, path: PROGRESS_PATH };
  } catch (err) {
    if (err.code === 'ENOENT') return { progress: null, error: null, path: PROGRESS_PATH };
    return { progress: null, error: err.message, path: PROGRESS_PATH };
  }
}

function isMonthlyEffectivenessReviewDue(now, report, progress = null) {
  if (now.getDate() < REVIEW_DAY) return false;
  if (now.getDate() === REVIEW_DAY) {
    const currentMinute = now.getHours() * 60 + now.getMinutes();
    const dueMinute = REVIEW_HOUR * 60 + REVIEW_MINUTE;
    if (currentMinute < dueMinute) return false;
  }
  if (report?.month === monthKey(now)) return false;
  if (progress?.month === monthKey(now) && progress.retry_after) {
    const retryAfter = new Date(progress.retry_after);
    if (!Number.isNaN(retryAfter.getTime()) && retryAfter > now) return false;
  }
  return true;
}

function atomicWriteJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  fs.renameSync(temp, target);
}

function readProgress(month, primaryReviewerKey) {
  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    if (progress.month === month && progress.primary_reviewer_key === primaryReviewerKey) return progress;
  } catch (_) {}
  return null;
}

function mergeReviews(existing, incoming) {
  const byFeature = new Map((existing || []).map(row => [row.feature, row]));
  for (const row of incoming || []) byFeature.set(row.feature, row);
  return [...byFeature.values()].sort((a, b) => a.feature.localeCompare(b.feature));
}

function canonical(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function loadOperationalEvidence(sinceEpoch) {
  const hub = db.hub();
  let logs = [];
  let receipts = [];
  try {
    logs = hub.prepare(`
      SELECT ts, user, model_key, model_id, endpoint, tokens_in, tokens_out,
             cost_usd, duration_ms, status, error_msg, rating
      FROM request_logs
      WHERE ts >= ?
        AND COALESCE(endpoint, '') NOT LIKE 'model-effectiveness-review%'
        AND COALESCE(model_key, '') NOT LIKE 'model-effectiveness-review%'
    `).all(sinceEpoch);
  } catch (_) {}
  try {
    receipts = hub.prepare(`
      SELECT created_at, source_kind, stage, status, summary, model_key, model_id
      FROM knowledge_receipts
      WHERE created_at >= ? AND source_kind <> 'model_effectiveness_review'
    `).all(sinceEpoch);
  } catch (_) {}
  return { logs, receipts };
}

function aggregateEvidence(feature, parentFeature, operational) {
  const keys = new Set([feature, parentFeature].filter(Boolean).map(canonical));
  const logs = operational.logs.filter(row => keys.has(canonical(row.model_key)) || keys.has(canonical(row.endpoint)));
  const receipts = operational.receipts.filter(row =>
    keys.has(canonical(row.stage)) || keys.has(canonical(row.model_key)) || keys.has(canonical(row.source_kind)),
  );
  const durations = logs.map(row => Number(row.duration_ms)).filter(Number.isFinite);
  const ratings = logs.map(row => Number(row.rating)).filter(value => Number.isFinite(value) && value > 0);
  const statusCounts = {};
  for (const row of logs) statusCounts[row.status || 'unknown'] = (statusCounts[row.status || 'unknown'] || 0) + 1;
  const receiptCounts = {};
  for (const row of receipts) receiptCounts[row.status || 'unknown'] = (receiptCounts[row.status || 'unknown'] || 0) + 1;
  return {
    lookback_days: LOOKBACK_DAYS,
    direct_call_count: logs.length,
    statuses: statusCounts,
    success_rate: logs.length
      ? Number(((statusCounts.ok || 0) + (statusCounts.retried || 0)) / logs.length).toFixed(3)
      : null,
    retry_rate: logs.length ? Number(((statusCounts.retried || 0) / logs.length).toFixed(3)) : null,
    mean_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    p95_duration_ms: percentile(durations, 0.95),
    tokens_in: logs.reduce((sum, row) => sum + Number(row.tokens_in || 0), 0),
    tokens_out: logs.reduce((sum, row) => sum + Number(row.tokens_out || 0), 0),
    cost_usd: Number(logs.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0).toFixed(6)),
    user_rating_count: ratings.length,
    mean_user_rating: ratings.length ? Number((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2)) : null,
    receipt_count: receipts.length,
    receipt_statuses: receiptCounts,
  };
}

function promptForSlot(slot) {
  const scope = slot.scope === 'user' ? 'douglas' : 'system';
  const override = getSystemPromptOverride(slot.feature, scope);
  const full = override || PROMPTS[slot.feature] || '';
  return {
    source: override ? `override:${scope}` : full ? 'default' : 'not-declared',
    sha256: full ? crypto.createHash('sha256').update(full).digest('hex') : null,
    chars: full.length,
    text: full.slice(0, 12000),
    truncated: full.length > 12000,
  };
}

function buildEvidencePackets(governanceReport, now = new Date()) {
  const slots = governanceReport?.slots || [];
  const byFeature = new Map(slots.map(slot => [slot.feature, slot]));
  const operational = loadOperationalEvidence(Math.floor(now.getTime() / 1000) - LOOKBACK_DAYS * 86400);
  return slots.map(slot => {
    const parentFeature = PARENT_MODEL_FEATURE[slot.feature] || null;
    const parent = parentFeature ? byFeature.get(parentFeature) : null;
    const prompt = promptForSlot(slot);
    return {
      feature: slot.feature,
      label: slot.label,
      group: slot.group,
      scope: slot.scope,
      purpose: slot.note,
      model_id: slot.effective_model_id || parent?.effective_model_id || null,
      model_source: slot.effective_model_id ? slot.effective_source : parent ? `parent:${parentFeature}` : slot.effective_source,
      model_health: slot.effective_model_id ? slot.live_health : parent?.live_health || slot.live_health,
      capability_contract: slot.capability_contract || parent?.capability_contract || {},
      prompt,
      observed: aggregateEvidence(slot.feature, parentFeature, operational),
      admin_links: slot.admin_links,
      reviewable: Boolean(prompt.text && (slot.effective_model_id || parent?.effective_model_id)),
      not_reviewable_reason: !prompt.text
        ? 'No governed prompt text is declared for this model slot.'
        : !(slot.effective_model_id || parent?.effective_model_id)
          ? 'No effective execution model could be resolved for this prompt.'
          : null,
    };
  });
}

async function fetchOpenRouterCatalog() {
  const response = await fetch('hub-model://v1/models', {
    headers: openRouterHeaders('AT-ModelEffectivenessReview'),
    timeout: 30000,
  });
  if (!response.ok) throw new Error(`OpenRouter catalogue ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.data) ? body.data : [];
}

function reviewerCandidateScore(entry, model, now = new Date()) {
  const id = String(model.id || '').toLowerCase();
  if (!id.startsWith(`${entry.provider}/`)) return -Infinity;
  if (/embed|image|audio|moderation|free/.test(id)) return -Infinity;
  if (model.expiration_date && new Date(model.expiration_date) <= now) return -Infinity;
  let score = 50;
  for (const term of entry.familyTerms) if (id.includes(term)) score += 12;
  const params = new Set(model.supported_parameters || []);
  if (params.has('structured_outputs') || params.has('response_format')) score += 8;
  if (params.has('reasoning') || params.has('reasoning_effort')) score += 6;
  score += Math.min(10, Number(model.context_length || 0) / 100000);
  score += Math.min(5, Number(model.created || 0) / 1e9);
  return score;
}

function resolveReviewer(entry, catalog, now = new Date()) {
  const exact = catalog.find(model => model.id === entry.modelId
    && (!model.expiration_date || new Date(model.expiration_date) > now));
  if (exact) return { ...entry, resolvedModelId: entry.modelId, substituted: false, substitutionReason: null };
  const ranked = catalog
    .map(model => ({ model, score: reviewerCandidateScore(entry, model, now) }))
    .filter(row => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || String(b.model.id).localeCompare(String(a.model.id)));
  if (!ranked.length) throw new Error(`Reviewer unavailable and no same-provider equivalent found: ${entry.modelId}`);
  return {
    ...entry,
    resolvedModelId: ranked[0].model.id,
    substituted: true,
    substitutionReason: `${entry.modelId} was absent from the live catalogue; selected the closest same-provider reasoning/structured-output model.`,
  };
}

async function compileBenchmarkDossier(now = new Date()) {
  const queries = [
    'site:artificialanalysis.ai frontier model benchmark GPT-5.6 Luna Grok 4.5 Claude Sonnet 5',
    'site:openai.com OR site:developers.openai.com GPT-5.6 Luna benchmarks',
    'site:x.ai Grok 4.5 benchmarks',
    'site:anthropic.com Claude Sonnet 5 benchmarks',
  ];
  const allowedHosts = new Set(['artificialanalysis.ai', 'www.artificialanalysis.ai', 'openai.com', 'www.openai.com', 'developers.openai.com', 'x.ai', 'www.x.ai', 'anthropic.com', 'www.anthropic.com']);
  const results = [];
  for (const query of queries) {
    const result = await currentInfoSearch(query, { days: 365, limit: 6 });
    results.push(result);
  }
  const seen = new Set();
  const sources = [];
  for (const result of results) {
    for (const source of result.sources || []) {
      let host = '';
      try { host = new URL(source.url).hostname.toLowerCase(); } catch (_) {}
      if (!allowedHosts.has(host) || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push({
        title: String(source.title || source.url).slice(0, 240),
        url: source.url,
        snippet: String(source.snippet || '').slice(0, 1200),
        published_at: source.publishedAt || null,
        checked_at: source.checkedAt || result.checkedAt,
        provider: source.provider || result.provider,
      });
    }
  }
  return {
    checked_at: now.toISOString(),
    policy: 'Vendor sources and Artificial Analysis only. Benchmark evidence informs model-task fit; observed Hub evidence dominates.',
    queries,
    sources: sources.slice(0, 18),
    status: sources.length ? 'available' : 'unavailable',
  };
}

function chunks(rows, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function reviewerSystemPrompt({ appeal = false } = {}) {
  const { getSystemPrompt } = require('./settings');
  const base = getSystemPrompt(
    'model_effectiveness_review',
    'system',
    PROMPTS.model_effectiveness_review,
  );
  return base
    .replace(/\[APPEAL_THRESHOLD\]/g, String(APPEAL_THRESHOLD))
    .replace(
      /\[APPEAL_RULE\]/g,
      appeal
        ? '- This is an independent appeal. You have not been shown another reviewer\'s score or recommendation; do not infer one.'
        : '',
    );
}

function validateReview(raw, packet, reviewer) {
  const evidenceStatus = ['sufficient', 'limited', 'insufficient'].includes(raw?.evidence_status)
    ? raw.evidence_status : 'limited';
  const scores = {};
  let valid = Boolean(packet.reviewable && evidenceStatus !== 'insufficient');
  for (const [axis, maximum] of Object.entries(RUBRIC)) {
    const value = Number(raw?.scores?.[axis]);
    if (!Number.isInteger(value) || value < 0 || value > maximum) valid = false;
    scores[axis] = Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.round(value))) : 0;
  }
  const total = valid ? Object.values(scores).reduce((sum, value) => sum + value, 0) : null;
  return {
    feature: packet.feature,
    evidence_status: valid ? evidenceStatus : 'insufficient',
    scores: valid ? scores : null,
    total_score: total,
    band: total == null ? 'insufficient evidence' : total >= 85 ? 'strong' : total >= 75 ? 'acceptable / watch' : total >= 60 ? 'needs review' : 'serious',
    failure_category: FAILURE_CATEGORIES.has(raw?.failure_category) ? raw.failure_category : total != null && total < APPEAL_THRESHOLD ? 'multiple' : 'none',
    remedy_class: REMEDY_CLASSES.has(raw?.remedy_class) ? raw.remedy_class : total != null && total < APPEAL_THRESHOLD ? 'human_review' : 'none',
    rationale: String(raw?.rationale || packet.not_reviewable_reason || '').slice(0, 1600),
    recommendation: String(raw?.recommendation || '').slice(0, 1600),
    evidence_citations: Array.isArray(raw?.evidence_citations) ? raw.evidence_citations.map(String).slice(0, 12) : [],
    reviewer: {
      key: reviewer.key,
      label: reviewer.label,
      requested_model_id: reviewer.modelId,
      resolved_model_id: reviewer.resolvedModelId,
      substituted: reviewer.substituted,
    },
  };
}

async function reviewPackets(packets, reviewer, benchmarkDossier, { appeal = false, request = requestModelObject, onBatch = null } = {}) {
  const reviews = [];
  for (const batch of chunks(packets)) {
    const payload = {
      benchmark_dossier: benchmarkDossier,
      pairings: batch,
    };
    let response;
    for (let transportAttempt = 1; transportAttempt <= 3; transportAttempt++) {
      try {
        response = await request({
          modelId: reviewer.resolvedModelId,
          messages: [
            { role: 'system', content: reviewerSystemPrompt({ appeal }) },
            { role: 'user', content: JSON.stringify(payload) },
          ],
          feature: appeal ? 'model-effectiveness-review-appeal' : 'model-effectiveness-review-primary',
          modelKey: `model-effectiveness-review-${reviewer.key}`,
          taskCode: 'AT-ModelEffectivenessReview',
          user: 'system',
          defaults: { reviews: [] },
          label: 'Model effectiveness review',
          maxTokens: 9000,
          attempts: 2,
          timeout: 300000,
          extraBody: { reasoning: { effort: 'high' } },
        });
        break;
      } catch (err) {
        const nonRetryable = /OpenRouter (400|401|402|403|404|422)\b/.test(String(err.message || err));
        if (transportAttempt === 3 || nonRetryable) throw err;
        console.warn(`[model-effectiveness] ${reviewer.key} batch transport attempt ${transportAttempt} failed; retrying:`, err.message);
        await new Promise(resolve => setTimeout(resolve, transportAttempt * 5000));
      }
    }
    const byFeature = new Map((Array.isArray(response.reviews) ? response.reviews : []).map(row => [row.feature, row]));
    const batchReviews = batch.map(packet => validateReview(byFeature.get(packet.feature), packet, reviewer));
    reviews.push(...batchReviews);
    if (onBatch) await onBatch(batchReviews);
  }
  return reviews;
}

function buildSkippedReview(packet, reviewer) {
  return validateReview({
    evidence_status: 'insufficient',
    failure_category: 'insufficient_evidence',
    remedy_class: 'instrumentation',
    rationale: packet.not_reviewable_reason,
    recommendation: packet.not_reviewable_reason,
  }, packet, reviewer);
}

function buildAppeals(primaryReviews, secondaryReviewSets) {
  const secondaryMaps = secondaryReviewSets.map(set => new Map(set.map(row => [row.feature, row])));
  return primaryReviews
    .filter(review => review.total_score != null && review.total_score < APPEAL_THRESHOLD)
    .map(primary => {
      const secondary = secondaryMaps.map(map => map.get(primary.feature)).filter(Boolean);
      const all = [primary, ...secondary];
      const unanimous = secondary.length === 2
        && all.every(review => review.total_score != null && review.total_score < APPEAL_THRESHOLD)
        && all.every(review => review.failure_category === primary.failure_category)
        && all.every(review => review.remedy_class === primary.remedy_class);
      return {
        feature: primary.feature,
        primary,
        secondary,
        unanimous,
        agreed_failure_category: unanimous ? primary.failure_category : null,
        agreed_remedy_class: unanimous ? primary.remedy_class : null,
      };
    });
}

function recommendationEmail(report) {
  const packetByFeature = new Map(report.evidence.map(row => [row.feature, row]));
  const agreed = report.appeals.filter(row => row.unanimous);
  const lines = [
    `Monthly prompt/model effectiveness review — ${report.month}`,
    '',
    `Primary reviewer: ${report.primary_reviewer.label} (${report.primary_reviewer.resolvedModelId})`,
    `Reviewed: ${report.summary.scored_count} scored, ${report.summary.insufficient_evidence_count} insufficient evidence`,
    `Appeals: ${report.summary.appeal_count}; unanimous recommendations: ${agreed.length}`,
    '',
    'No prompt or model has been changed automatically.',
    '',
  ];
  for (const appeal of agreed) {
    const packet = packetByFeature.get(appeal.feature) || {};
    const scores = [appeal.primary, ...appeal.secondary]
      .map(review => `${review.reviewer.label}: ${review.total_score}/100`)
      .join('; ');
    lines.push(
      `${packet.label || appeal.feature} (${appeal.feature})`,
      `Scores: ${scores}`,
      `Agreed issue: ${appeal.agreed_failure_category}; remedy: ${appeal.agreed_remedy_class}`,
      `Recommendation: ${appeal.primary.recommendation || appeal.primary.rationale}`,
      `Evidence: ${packet.observed?.direct_call_count || 0} calls, ${packet.observed?.receipt_count || 0} receipts, prompt ${packet.prompt?.chars || 0} chars`,
      `Model: ${packet.model_id || 'unresolved'}`,
      `Admin model: https://dchat.mclellan.scot${packet.admin_links?.system_slot || '/admin/models/system'}`,
      `Admin prompt: https://dchat.mclellan.scot${packet.admin_links?.prompt || '/admin/models/prompts'}`,
      '',
    );
  }
  return {
    subject: `[Hub] ${agreed.length} unanimous prompt/model recommendation${agreed.length === 1 ? '' : 's'} — ${report.month}`,
    text: lines.join('\n'),
  };
}

function writeKnowledgeReceipt(report) {
  try {
    db.hub().prepare(`
      INSERT INTO knowledge_receipts
        (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id)
      VALUES (?, 'douglas', 'model_effectiveness_review', ?, 'monthly_model_effectiveness', ?, ?, ?, ?, ?)
    `).run(
      uuid(), report.month, report.summary.unanimous_recommendation_count ? 'warn' : 'pass',
      `Monthly prompt/model review: ${report.summary.scored_count} scored, ${report.summary.appeal_count} appealed, ${report.summary.unanimous_recommendation_count} unanimous recommendations`,
      JSON.stringify({ schema_version: report.schema_version, month: report.month, summary: report.summary, report_path: REPORT_PATH }),
      `model-effectiveness-review-${report.primary_reviewer.key}`,
      report.primary_reviewer.resolvedModelId,
    );
  } catch (err) {
    console.warn('[model-effectiveness] knowledge receipt skipped:', err.message);
  }
}

async function executeReview({ reason = 'manual', now = new Date(), request = requestModelObject, search = compileBenchmarkDossier, mail = sendEmail, catalogLoader = fetchOpenRouterCatalog } = {}) {
  const { report: governance, error: governanceError } = readGovernanceReport();
  if (!governance) throw new Error(`Weekly governance report is required before monthly effectiveness review${governanceError ? `: ${governanceError}` : ''}`);
  const catalog = await catalogLoader();
  const selected = reviewerForDate(now);
  const primaryReviewer = resolveReviewer(selected, catalog);
  const targetMonth = monthKey(now);
  const savedProgress = readProgress(targetMonth, selected.key);
  const benchmarkDossier = savedProgress?.benchmark_dossier || await search(now);
  const evidence = savedProgress?.evidence || buildEvidencePackets(governance, now);
  const reviewable = evidence.filter(packet => packet.reviewable);
  const skipped = evidence.filter(packet => !packet.reviewable).map(packet => buildSkippedReview(packet, primaryReviewer));
  const progress = savedProgress || {
    schema_version: 1,
    month: targetMonth,
    primary_reviewer_key: selected.key,
    benchmark_dossier: benchmarkDossier,
    evidence,
    primary_reviews: [],
    secondary_reviews: {},
  };
  atomicWriteJson(PROGRESS_PATH, progress);
  let primaryCompleted = progress.primary_reviews || [];
  const primaryDone = new Set(primaryCompleted.map(row => row.feature));
  const primaryRemaining = reviewable.filter(packet => !primaryDone.has(packet.feature));
  await reviewPackets(primaryRemaining, primaryReviewer, benchmarkDossier, {
    request,
    onBatch: batchReviews => {
      primaryCompleted = mergeReviews(primaryCompleted, batchReviews);
      progress.primary_reviews = primaryCompleted;
      atomicWriteJson(PROGRESS_PATH, progress);
    },
  });
  const primaryReviews = mergeReviews(primaryCompleted, skipped);
  progress.primary_reviews = primaryReviews;
  atomicWriteJson(PROGRESS_PATH, progress);
  const appealPackets = evidence.filter(packet => {
    const review = primaryReviews.find(row => row.feature === packet.feature);
    return review?.total_score != null && review.total_score < APPEAL_THRESHOLD;
  });
  const secondaries = PANEL.filter(row => row.key !== selected.key).map(row => resolveReviewer(row, catalog));
  const secondaryReviewSets = [];
  for (const reviewer of secondaries) {
    let completed = progress.secondary_reviews?.[reviewer.key] || [];
    const completedFeatures = new Set(completed.map(row => row.feature));
    const remaining = appealPackets.filter(packet => !completedFeatures.has(packet.feature));
    if (remaining.length) {
      await reviewPackets(remaining, reviewer, benchmarkDossier, {
        appeal: true,
        request,
        onBatch: batchReviews => {
          completed = mergeReviews(completed, batchReviews);
          progress.secondary_reviews = { ...(progress.secondary_reviews || {}), [reviewer.key]: completed };
          atomicWriteJson(PROGRESS_PATH, progress);
        },
      });
    }
    secondaryReviewSets.push(completed);
  }
  const appeals = buildAppeals(primaryReviews, secondaryReviewSets);
  const scores = primaryReviews.map(row => row.total_score).filter(Number.isFinite);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    month: targetMonth,
    reason,
    cadence: `Monthly on day ${REVIEW_DAY} at ${String(REVIEW_HOUR).padStart(2, '0')}:${String(REVIEW_MINUTE).padStart(2, '0')} Europe/Dublin`,
    safety_boundary: 'Evidence and recommendations only. No prompt, model assignment, or enabled state changes automatically.',
    threshold: APPEAL_THRESHOLD,
    rubric: RUBRIC,
    panel: PANEL,
    primary_reviewer: primaryReviewer,
    secondary_reviewers: secondaries,
    benchmark_dossier: benchmarkDossier,
    governance_report_generated_at: governance.generated_at,
    evidence,
    reviews: primaryReviews,
    appeals,
    summary: {
      declared_slot_count: evidence.length,
      reviewable_pairing_count: reviewable.length,
      scored_count: scores.length,
      insufficient_evidence_count: primaryReviews.filter(row => row.total_score == null).length,
      strong_count: primaryReviews.filter(row => row.total_score >= 85).length,
      acceptable_count: primaryReviews.filter(row => row.total_score >= 75 && row.total_score < 85).length,
      appeal_count: appeals.length,
      unanimous_recommendation_count: appeals.filter(row => row.unanimous).length,
      mean_score: scores.length ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null,
    },
    email: { status: 'not_required', to: REPORT_TO, sent_at: null, error: null },
  };
  const archivePath = path.join(ARCHIVE_ROOT, `${report.month}.json`);
  atomicWriteJson(archivePath, report);
  atomicWriteJson(REPORT_PATH, report);
  writeKnowledgeReceipt(report);
  if (report.summary.unanimous_recommendation_count) {
    const message = recommendationEmail(report);
    try {
      await mail('douglas', REPORT_TO, message.subject, message.text);
      report.email = { status: 'sent', to: REPORT_TO, sent_at: new Date().toISOString(), error: null };
    } catch (err) {
      report.email = { status: 'failed', to: REPORT_TO, sent_at: null, error: String(err.message || err).slice(0, 500) };
    }
    atomicWriteJson(archivePath, report);
    atomicWriteJson(REPORT_PATH, report);
  }
  try { fs.unlinkSync(PROGRESS_PATH); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return report;
}

function runModelEffectivenessReview(options = {}) {
  if (activeRun) return activeRun;
  activeRun = executeReview(options).catch(err => {
    const now = options.now || new Date();
    const selected = reviewerForDate(now);
    const { progress } = readEffectivenessProgress();
    const nonRetryable = /OpenRouter (400|401|402|403|404|422)\b/.test(String(err.message || err));
    const retryDelayMs = nonRetryable ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    atomicWriteJson(PROGRESS_PATH, {
      ...(progress || {
        schema_version: 1,
        month: monthKey(now),
        primary_reviewer_key: selected.key,
        primary_reviews: [],
        secondary_reviews: {},
      }),
      last_error: String(err.message || err).slice(0, 500),
      last_error_at: new Date().toISOString(),
      retry_after: new Date(Date.now() + retryDelayMs).toISOString(),
    });
    throw err;
  }).finally(() => { activeRun = null; });
  return activeRun;
}

module.exports = {
  APPEAL_THRESHOLD,
  PANEL,
  REPORT_PATH,
  RUBRIC,
  aggregateEvidence,
  buildAppeals,
  buildEvidencePackets,
  compileBenchmarkDossier,
  executeReview,
  isMonthlyEffectivenessReviewDue,
  monthKey,
  readEffectivenessReport,
  readEffectivenessProgress,
  recommendationEmail,
  reviewPackets,
  reviewerSystemPrompt,
  resolveReviewer,
  reviewerForDate,
  runModelEffectivenessReview,
  validateReview,
};
