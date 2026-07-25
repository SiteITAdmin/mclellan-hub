'use strict';

// The consigliere's voice. The family's checks are deterministic; the report TO
// Douglas is judgment and writing, so this is the one place a model belongs. It
// takes the structured escalations (facts) and writes a plain-English brief:
// what needs him, what was handled, what's being watched, what's running fine —
// no UUIDs, no raw JSON, no internal identifiers, and each problem carries a
// recommended fix tagged by who can do it. Raw receipts stay in the drill-down.

const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');
const { fixLinksForItem, renderLinksMarkdown } = require('./consigliere-links');

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
function askableItems(report) {
  return (report.asks_douglas || []).filter(item => !isCircularGovernanceAsk(item));
}

function askRef(index) {
  return `A${index + 1}`;
}

// ref -> the real Hub URLs for that escalation. Built from the escalation payload,
// never from model output, so the brief cannot carry a link to a record that the
// checks did not actually flag.
function buildLinkIndex(report) {
  const index = {};
  const user = report.user || 'douglas';
  askableItems(report).forEach((item, i) => {
    index[askRef(i)] = { area: friendlyArea(item), links: fixLinksForItem(item, { user }) };
  });
  return index;
}

// A label is only usable as evidence if it names a specific record — the record
// title minus its "Meeting:"/"Project:" prefix. Generic area labels would match
// half the brief.
function labelNeedle(link) {
  return String(link.label || '')
    .replace(/^(meeting|project|task|re-tag|contact)\s*:\s*/i, '')
    .trim()
    .toLowerCase();
}

// The model merges and rewrites items, so it hands back the refs it used. It is a
// small model and it does mis-assign them, so refs are combined with the names it
// actually wrote in the prose: if an item talks about Alan Garland, Alan Garland's
// record is linked whether or not the ref was right.
function linksForBriefItem(item, linkIndex) {
  if (!linkIndex) return [];
  const refs = Array.isArray(item?.refs) ? item.refs : [];
  const entries = Object.values(linkIndex);
  const haystack = `${item?.title || ''} ${item?.detail || ''}`.toLowerCase();

  // Records the item actually names beat records its ref merely points at, and
  // the area landing page is only worth a slot once the specifics are in.
  const named = [];
  const fromRefs = [];
  const areaLinks = [];

  for (const entry of entries) {
    for (const link of entry.links || []) {
      if (!link.specific) continue;
      const needle = labelNeedle(link);
      if (needle.length >= 4 && haystack.includes(needle)) named.push(link);
    }
  }
  for (const ref of refs) {
    const entry = linkIndex[String(ref).trim().toUpperCase()];
    for (const link of entry?.links || []) (link.specific ? fromRefs : areaLinks).push(link);
  }
  if (!named.length && !fromRefs.length) {
    for (const entry of entries) {
      if (!entry.area || !haystack.includes(entry.area.toLowerCase())) continue;
      for (const link of entry.links || []) (link.specific ? fromRefs : areaLinks).push(link);
    }
  }

  const seen = new Set();
  const links = [];
  for (const link of [...named, ...fromRefs, ...areaLinks]) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    links.push(link);
  }
  return links.slice(0, 5);
}

function summarizeForModel(report, context) {
  const asks = askableItems(report).map((item, i) => ({
    ref: askRef(i),
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
  const system = getSystemPrompt(BRIEF_FEATURE, 'system', PROMPTS.consigliere_brief);
  return [
    system,
    '',
    'Data (already de-identified):',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

const FIX_TAGS = { you_decide: 'you decide', hub_action: 'Hub can do this', needs_code: 'needs code' };

function renderBriefMarkdown(brief, linkIndex = null) {
  const lines = [];
  if (brief.headline) lines.push(brief.headline, '');
  if (brief.needs_you?.length) {
    lines.push(`**Needs you (${brief.needs_you.length}):**`);
    brief.needs_you.forEach((item, i) => {
      lines.push(`${i + 1}. **${item.title}** — ${item.detail}`);
      const tag = FIX_TAGS[item.fix_type] || item.fix_type || '';
      lines.push(`   Fix${tag ? ` (${tag})` : ''}: ${item.recommended_fix}`);
      const links = renderLinksMarkdown(linksForBriefItem(item, linkIndex));
      if (links) lines.push(`   Go here: ${links}`);
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
    refs: [a.ref],
  }));
  // Promote recurring runtime errors the formal asks missed.
  for (const err of input.runtime_errors.slice(0, 3)) {
    needs.push({ title: 'Runtime error', detail: err, recommended_fix: 'Likely a code fix; hand to Codex with this error.', fix_type: 'needs_code', refs: [] });
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
  return { brief, markdown: renderBriefMarkdown(brief, buildLinkIndex(report)), usedModel: false };
}

async function composeConsigliereBrief(report, context = {}) {
  const input = summarizeForModel(report, context);
  if (!process.env.OPENROUTER_API_KEY) return fallbackBrief(report, context);

  const modelId = getSystemModelId(BRIEF_FEATURE, 'system', BRIEF_FALLBACK_MODEL);
  try {
    const brief = await requestModelObject({
      modelId,
      messages: [{ role: 'user', content: buildPrompt(input) }],
      user: report.user || 'douglas',
      feature: BRIEF_FEATURE,
      modelKey: BRIEF_FEATURE,
      taskCode: TASK_CODES.ADMIN,
      temperature: 0.3,
      defaults: { headline: '', needs_you: [], handled: [], watching: [], running_fine: '', ignore: '' },
      label: 'consigliere brief',
    });
    if (!Array.isArray(brief.needs_you)) brief.needs_you = [];
    return { brief, markdown: renderBriefMarkdown(brief, buildLinkIndex(report)), usedModel: true, modelId };
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
  buildLinkIndex,
  linksForBriefItem,
};
