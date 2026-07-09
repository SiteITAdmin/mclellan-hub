'use strict';

// The consigliere's voice. The family's checks are deterministic; the report TO
// Douglas is judgment and writing, so this is the one place a model belongs. It
// takes the structured escalations (facts) and writes a plain-English brief:
// what needs him, what was handled, what's being watched, what's running fine —
// no UUIDs, no raw JSON, no internal identifiers, and each problem carries a
// recommended fix tagged by who can do it. Raw receipts stay in the drill-down.

const { getSystemModelId } = require('./settings');
const { openRouterHeaders, TASK_CODES } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');

const BRIEF_FEATURE = 'consigliere_brief';
const BRIEF_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';

// Human labels for the internal source_kind:source_id pairs the escalations carry.
const AREA_LABELS = {
  'hub_quality:crm:meeting_intake': 'Meeting intake',
  'hub_quality:crm:people': 'CRM people',
  'hub_quality:crm:tasks': 'Tasks & actions',
  'hub_quality:crm:project_context': 'Project tagging',
  'hub_module:crm': 'CRM knowledge',
  'hub_module:documents_projects': 'Documents & projects',
  'hub_module:linkedin_content': 'LinkedIn content',
  'hub_module:flights': 'Flights',
  'hub_module:email': 'Email',
};

function friendlyArea(item) {
  const key = `${item.source_kind}:${item.source_id}`;
  if (AREA_LABELS[key]) return AREA_LABELS[key];
  if (AREA_LABELS[item.source_kind]) return AREA_LABELS[item.source_kind];
  return String(item.source_id || item.source_kind || 'Hub').replace(/_/g, ' ');
}

// A self-referential governance ask — the boss layer or the daily router
// flagging its own failure because a downstream item is open. Noise to a human.
function isCircularGovernanceAsk(item) {
  return item.source_kind === 'hub_governance'
    && (item.source_id === 'boss_layer' || item.source_id === 'daily_consigliere');
}

function clarificationToText(req) {
  if (typeof req === 'string') return req;
  if (req && typeof req === 'object') {
    return req.task || req.evidence || req.reason || req.title || req.type
      || Object.entries(req).filter(([, v]) => v && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(', ');
  }
  return String(req || '');
}

// Compact, human-ish view of the escalations for the model — no UUIDs, JSON
// pre-flattened to short strings, circular governance asks removed.
function summarizeForModel(report, context) {
  const asks = (report.asks_douglas || []).filter(item => !isCircularGovernanceAsk(item)).map(item => ({
    area: friendlyArea(item),
    severity: item.severity,
    concern: item.summary || item.evidence || item.question || '',
    samples: (item.clarification_requests || []).slice(0, 3).map(clarificationToText).filter(Boolean),
  }));
  const corrections = (report.agent_corrections || []).slice(0, 8).map(c => ({
    area: friendlyArea(c),
    was: c.previous_summary || 'failing',
    now: c.summary || 'passing',
  }));
  const watching = (report.monitoring || []).slice(0, 8).map(m => ({
    area: friendlyArea(m),
    note: m.summary || m.evidence || '',
  }));
  const runtimeErrors = dedupe(context.runtimeErrors || []).slice(0, 8);
  return {
    asks,
    corrections,
    watching,
    runtime_errors: runtimeErrors,
    remediation: context.remediation
      ? { fixed: context.remediation.fixed || [], dispatched: context.remediation.dispatched || [] }
      : null,
    activity_summary: context.activityLine || null,
  };
}

function dedupe(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = String(line).replace(/\d{6,}|[0-9a-f]{8}-[0-9a-f-]+/g, '#').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(line));
  }
  return out;
}

function buildPrompt(input) {
  return [
    'You are the Consigliere for Douglas\'s personal AI hub. Write his daily brief.',
    'Douglas has ADHD and reads this in under a minute. Lead with what matters. Be plain, direct, and human — no jargon.',
    '',
    'Hard rules:',
    '- NEVER include UUIDs, receipt IDs, raw JSON, or internal identifiers like "hub_module:" or "source_kind".',
    '- Translate everything into plain English a busy person understands.',
    '- Rank "needs_you" by real-world impact. A recurring runtime error (e.g. a classifier failing to return valid data, so items may not be filed) is HIGH priority even if it was not in the formal ask list — promote it.',
    '- Merge duplicates. If several clarifications are the same kind of thing (e.g. unnamed meeting speakers who own tasks), state it once with the specifics.',
    '- For each needs_you item, give a concrete recommended_fix and a fix_type:',
    '    "you_decide"  — needs Douglas\'s knowledge or a decision only he can make;',
    '    "hub_action"  — the Hub can do it itself (re-run a job, re-sync);',
    '    "needs_code"  — a bug that needs a code change; say what looks broken and where.',
    '- Keep it tight. Most days have 0-3 real needs_you items.',
    '- For "running_fine", use the provided activity_summary numbers verbatim; do not invent activity.',
    '',
    'Return ONE JSON object only:',
    '{',
    '  "headline": "one sentence on the overall state, plain English",',
    '  "needs_you": [{"title": string, "detail": string, "recommended_fix": string, "fix_type": "you_decide|hub_action|needs_code"}],',
    '  "handled": [string],',
    '  "watching": [string],',
    '  "running_fine": "one line with the key activity numbers",',
    '  "ignore": "optional one line naming any scary-looking but ignorable signals, or empty string"',
    '}',
    '',
    'Data (already de-identified):',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

const FIX_TAGS = { you_decide: 'you decide', hub_action: 'Hub can do this', needs_code: 'needs code' };

function renderBriefMarkdown(brief) {
  const lines = [];
  if (brief.headline) lines.push(brief.headline, '');
  if (brief.needs_you?.length) {
    lines.push(`**Needs you (${brief.needs_you.length}):**`);
    brief.needs_you.forEach((item, i) => {
      lines.push(`${i + 1}. **${item.title}** — ${item.detail}`);
      const tag = FIX_TAGS[item.fix_type] || item.fix_type || '';
      lines.push(`   Fix${tag ? ` (${tag})` : ''}: ${item.recommended_fix}`);
    });
    lines.push('');
  } else {
    lines.push('**Needs you:** nothing today.', '');
  }
  if (brief.handled?.length) {
    lines.push('**I handled these:**');
    brief.handled.forEach(h => lines.push(`- ${h}`));
    lines.push('');
  }
  if (brief.watching?.length) {
    lines.push('**Worth a glance, not urgent:**');
    brief.watching.forEach(w => lines.push(`- ${w}`));
    lines.push('');
  }
  if (brief.running_fine) lines.push(`**Running fine:** ${brief.running_fine}`);
  if (brief.ignore) lines.push('', `_${brief.ignore}_`);
  return lines.join('\n').trim();
}

// If the model is unavailable, still produce something far more readable than the
// raw receipt dump: grouped, UUID-free, JSON-flattened.
function fallbackBrief(report, context) {
  const input = summarizeForModel(report, context);
  const needs = input.asks.map(a => ({
    title: a.area,
    detail: [a.concern, ...(a.samples || [])].filter(Boolean).slice(0, 3).join('; '),
    recommended_fix: a.severity === 'question' ? 'Review and clarify in the Hub.' : 'Review and decide in the Hub.',
    fix_type: 'you_decide',
  }));
  // Promote recurring runtime errors the formal asks missed.
  for (const err of input.runtime_errors.slice(0, 3)) {
    needs.push({ title: 'Runtime error', detail: err, recommended_fix: 'Likely a code fix; hand to Codex with this error.', fix_type: 'needs_code' });
  }
  const rem = context.remediation || { fixed: [], dispatched: [], counts: {} };
  const handled = [
    ...input.corrections.map(c => `${c.area}: was ${c.was}, now ${c.now}.`),
    ...(rem.fixed || []),
  ];
  const watching = [
    ...input.watching.map(w => `${w.area}: ${w.note}`),
    ...(rem.dispatched || []),
  ];
  const brief = {
    headline: needs.length ? `${needs.length} thing(s) need you; the rest ran on its own.` : 'All quiet — nothing needs you today.',
    needs_you: needs,
    handled,
    watching,
    running_fine: context.activityLine || '',
    ignore: (report.asks_douglas || []).some(isCircularGovernanceAsk)
      ? 'The governance "FAIL" is the system flagging itself because a clarification above is open, not a separate problem.'
      : '',
  };
  return { brief, markdown: renderBriefMarkdown(brief), usedModel: false };
}

async function composeConsigliereBrief(report, context = {}) {
  const input = summarizeForModel(report, context);
  if (!process.env.OPENROUTER_API_KEY) return fallbackBrief(report, context);

  const modelId = getSystemModelId(BRIEF_FEATURE, 'system', BRIEF_FALLBACK_MODEL);
  const started = Date.now();
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders(TASK_CODES.ADMIN),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: buildPrompt(input) }],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });
    if (!resp.ok) return fallbackBrief(report, context);
    const data = await resp.json();
    logUsageFromResponse({
      user: report.user || 'douglas',
      feature: BRIEF_FEATURE,
      modelKey: 'consigliere-brief',
      fallbackModelId: modelId,
      data,
      taskCode: TASK_CODES.ADMIN,
      durationMs: Date.now() - started,
    });
    const brief = parseModelObject(
      data.choices?.[0]?.message?.content,
      { headline: '', needs_you: [], handled: [], watching: [], running_fine: '', ignore: '' },
      'consigliere brief',
    );
    if (!Array.isArray(brief.needs_you)) brief.needs_you = [];
    return { brief, markdown: renderBriefMarkdown(brief), usedModel: true, modelId };
  } catch (_) {
    return fallbackBrief(report, context);
  }
}

module.exports = {
  composeConsigliereBrief,
  renderBriefMarkdown,
  fallbackBrief,
  summarizeForModel,
  isCircularGovernanceAsk,
  friendlyArea,
};
