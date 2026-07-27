'use strict';

// Builds a source-backed, independent quality comparison for the first Nakai
// briefing produced through the Mac subscription route. The result is compiled
// into a knowledge receipt and emailed to Douglas.

const fs = require('fs');
const { briefingMeta, listStoredBriefings } = require('./build-nakai-daily-briefing');
const { enqueue } = require('../lib/subscription-agent-jobs');
const { writeAgentReceipt } = require('../lib/agent-receipts');
const { sendEmail } = require('../lib/gmail');

const SYSTEM_PROMPT = `You are an independent editorial quality reviewer. Compare three consecutive Nakai Daily Briefings. The target is the newest briefing and was produced after moving the writer to Claude Opus at high effort. The two baselines used the prior route.

Judge only what is evidenced in the supplied briefing texts. Do not reward verbosity. Assess:
- source grounding and traceability
- regulatory/audit relevance
- prioritisation and judgement
- specificity and actionability
- continuity without repetition
- clarity and executive readability
- hallucination, unsupported-claim, or stale-context risk

Return one JSON object only:
{
  "verdict": "improved|mixed|unchanged|worse",
  "confidence": 0.0,
  "target_score": 0,
  "baseline_scores": [{"edition":"000","score":0},{"edition":"000","score":0}],
  "dimensions": [{"name":"source_grounding","target":0,"baseline_average":0,"change":0,"evidence":"brief comparison"}],
  "material_improvements": ["specific evidenced change"],
  "regressions": ["specific evidenced change"],
  "model_change_assessment": "what can and cannot reasonably be attributed to the route change",
  "recommendation": "keep|adjust_prompt|revert|collect_more_evidence",
  "summary": "concise executive conclusion"
}
Use 0-100 scores. Include all seven dimensions.`;

function targetMeta(targetDate) {
  const date = targetDate
    ? new Date(`${targetDate}T08:30:00+01:00`)
    : new Date();
  return briefingMeta(date);
}

function enqueueReview({ targetDate, attempt = 0 } = {}) {
  const meta = targetMeta(targetDate);
  const stored = listStoredBriefings();
  const targetIndex = stored.findIndex(item => item.edition === meta.edition);
  if (targetIndex < 0) {
    return { waiting: true, reason: `Daily Briefing ${meta.edition} is not archived yet`, attempt };
  }
  const selected = stored.slice(targetIndex, targetIndex + 3);
  if (selected.length < 3) {
    return { waiting: true, reason: `Need target briefing plus two previous archived briefings; found ${selected.length}`, attempt };
  }

  const editions = selected.map(item => item.edition);
  const userPrompt = selected.map((item, index) => {
    const role = index === 0 ? 'TARGET — Claude Opus high subscription route' : `BASELINE ${index} — previous route`;
    const markdown = fs.readFileSync(item.mdPath, 'utf8').slice(0, 30000);
    return `## ${role}\nEdition: ${item.edition}\nDate: ${item.date}\n\n${markdown}`;
  }).join('\n\n---\n\n');

  return enqueue({
    feature: 'nakai_briefing_quality_review',
    dedupeKey: `nakai-quality:${meta.edition}`,
    payload: {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      targetEdition: meta.edition,
      targetDate: meta.iso,
      editions,
      requestedModel: { runner: 'codex', model: 'gpt-5.6-luna', effort: 'medium' },
    },
  });
}

function parseReview(output) {
  const raw = String(output || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const review = JSON.parse(raw);
  const verdicts = new Set(['improved', 'mixed', 'unchanged', 'worse']);
  if (!verdicts.has(review.verdict)) throw new Error('quality review returned an invalid verdict');
  if (!Number.isFinite(Number(review.target_score))) throw new Error('quality review did not return a target score');
  if (!Array.isArray(review.dimensions) || review.dimensions.length < 7) throw new Error('quality review did not score all dimensions');
  return review;
}

function reviewEmail(payload, review) {
  const baseline = (review.baseline_scores || []).map(item => `${item.edition}: ${item.score}/100`).join(', ');
  const lines = [
    `Nakai Daily Briefing ${payload.targetEdition} quality comparison`,
    '',
    `Verdict: ${String(review.verdict).toUpperCase()}`,
    `Target score: ${review.target_score}/100`,
    `Previous briefings: ${baseline || payload.editions.slice(1).join(', ')}`,
    `Confidence: ${review.confidence}`,
    '',
    review.summary || '',
    '',
    'Material improvements:',
    ...(review.material_improvements || []).map(item => `- ${item}`),
    '',
    'Regressions / cautions:',
    ...((review.regressions || []).length ? review.regressions.map(item => `- ${item}`) : ['- None identified']),
    '',
    `Model-route assessment: ${review.model_change_assessment || ''}`,
    `Recommendation: ${review.recommendation || 'collect_more_evidence'}`,
    '',
    'Dimension scores:',
    ...(review.dimensions || []).map(item => `- ${item.name}: target ${item.target}, prior average ${item.baseline_average}, change ${item.change} — ${item.evidence}`),
  ];
  return lines.join('\n');
}

async function completeReview(payload, output) {
  const review = parseReview(output);
  const sourceId = `nakai-briefing:${payload.targetEdition}:route-change-review`;
  const receiptId = writeAgentReceipt({
    user: 'douglas',
    sourceKind: 'hub_quality',
    sourceId,
    stage: 'agent:quality_board:nakai_daily_briefing',
    status: review.verdict === 'worse' ? 'fail' : review.verdict === 'mixed' ? 'warn' : 'pass',
    summary: `Nakai Briefing ${payload.targetEdition}: ${review.verdict.toUpperCase()} (${review.target_score}/100) after Claude Opus high route change`,
    payload: { ...review, comparedEditions: payload.editions, route: payload.requestedModel },
    modelKey: 'nakai_briefing_quality_review',
    modelId: 'gpt-5.6-luna',
  });
  await sendEmail(
    'douglas',
    process.env.DOUGLAS_GOOGLE_EMAIL || process.env.GOOGLE_EMAIL || 'douglas@mclellan.scot',
    `Nakai Briefing ${payload.targetEdition} quality review — ${String(review.verdict).toUpperCase()}`,
    reviewEmail(payload, review),
  );
  return {
    receiptId,
    targetEdition: payload.targetEdition,
    comparedEditions: payload.editions,
    verdict: review.verdict,
    targetScore: review.target_score,
    execution: 'subscription_remote',
    runner: 'codex',
    model: 'gpt-5.6-luna',
    effort: 'medium',
  };
}

module.exports = { enqueueReview, completeReview, parseReview, SYSTEM_PROMPT };
