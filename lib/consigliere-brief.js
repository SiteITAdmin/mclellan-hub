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
const { normaliseLogLine } = require('./system-report');

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

// Subsystem keys survive the collapse of a capo failure, its remediation
// attempt and its board veto into one item, so they need their own labels.
const SUBSYSTEM_LABELS = {
  model_governance: 'Model quality',
  // token_burn capo retired 9 Aug 2026; label kept for the flattener until the
  // full dashboard/auditor excision (which also updates the fixtures that use it).
  token_burn: 'Token burn',
  documents_projects: 'Documents & projects',
  linkedin_content: 'LinkedIn content',
  crm: 'CRM knowledge',
  'crm:meeting_intake': 'Meeting intake',
  'crm:people': 'CRM people',
  'crm:tasks': 'Tasks & actions',
  'crm:project_context': 'Project tagging',
  rss_watchlist: 'Newsletter sources',
  mycelium: 'Connectivity',
  infrastructure: 'Jobs',
  system_report: 'Hub logs',
  crm_underboss: 'CRM oversight',
  operations_underboss: 'Operations oversight',
  content_underboss: 'Content oversight',
};

function friendlyArea(item) {
  if (item.subsystem && SUBSYSTEM_LABELS[item.subsystem]) return SUBSYSTEM_LABELS[item.subsystem];
  const key = `${item.source_kind}:${item.source_id}`;
  if (AREA_LABELS[key]) return AREA_LABELS[key];
  if (AREA_LABELS[item.source_kind]) return AREA_LABELS[item.source_kind];
  const raw = item.subsystem || item.source_id || item.source_kind || 'Hub';
  return String(raw).replace(/^(capo|underboss):/, '').replace(/_/g, ' ');
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

// One problem, one item. A failing capo check, the remediation pass that could
// not heal it, and the quality board it holds in veto are three receipts about
// one thing; presented separately they read as three problems, and the two
// derived ones carry no cause, so the brief had nothing to recommend but
// "override it" — an action that does not exist in the Hub. The cause wins the
// item; the derived receipts become properties of it.
function askGroups(report) {
  const groups = new Map();
  for (const item of askableItems(report)) {
    const key = item.subsystem || `${item.source_kind}:${item.source_id}`;
    const group = groups.get(key) || {
      subsystem: item.subsystem || '',
      source_kind: item.source_kind,
      source_id: item.source_id,
      severity: item.severity,
      members: [],
      root_check: '',
      root_evidence: '',
      diagnosis: '',
      cause_kind: '',
      cause_reason: '',
      board_blocked: false,
      self_heal_failed: false,
      clarification_requests: [],
      summary: item.summary || '',
    };

    group.members.push(item);
    if (severityRank(item.severity) < severityRank(group.severity)) group.severity = item.severity;
    if (item.reason === 'veto') group.board_blocked = true;
    if (item.self_heal_attempted) group.self_heal_failed = true;
    if (Array.isArray(item.clarification_requests)) {
      group.clarification_requests.push(...item.clarification_requests);
    }
    // A veto's own "failing check" is the board rule it tripped, and its evidence
    // counts the failures beneath it — both describe the board, not the problem,
    // so a derived receipt can never supply the cause.
    if (causeRank(item) < 3) {
      const better = causeRank(item) < causeRank({ source_kind: group.cause_kind, reason: group.cause_reason })
        || (item.root_evidence.length > group.root_evidence.length && causeRank(item) === causeRank({ source_kind: group.cause_kind, reason: group.cause_reason }));
      if (item.root_evidence && better) {
        group.root_evidence = item.root_evidence;
        group.cause_kind = item.source_kind;
        group.cause_reason = item.reason;
        group.source_kind = item.source_kind;
        group.source_id = item.source_id;
        group.summary = item.summary || group.summary;
      }
      if (item.root_check && (!group.root_check || better)) group.root_check = item.root_check;
      if (!group.diagnosis && item.diagnosis) group.diagnosis = item.diagnosis;
    }

    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

// Which receipt is allowed to speak for the problem. The capo ran the check and
// holds its evidence; the remediation pass adds the advisor's diagnosis; the
// board only knows that something beneath it failed.
function causeRank(item = {}) {
  if (item.reason === 'veto') return 3;
  if (item.source_kind === 'hub_module') return 0;
  if (item.source_kind === 'hub_remediation') return 1;
  if (item.source_kind === 'hub_quality' || item.source_kind === 'hub_underboss') return 3;
  return 2;
}

function severityRank(value) {
  return { blocker: 0, decision: 1, question: 2, watch: 3 }[value] ?? 4;
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
  askGroups(report).forEach((group, i) => {
    // Every receipt that folded into this problem can contribute a link — the
    // capo knows the area page, the remediation receipt knows the check.
    const seen = new Set();
    const links = [];
    for (const member of [group, ...group.members]) {
      for (const link of fixLinksForItem(member, { user })) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        links.push(link);
      }
    }
    index[askRef(i)] = { area: friendlyArea(group), links };
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
  const asks = askGroups(report).map((group, i) => ({
    ref: askRef(i),
    area: friendlyArea(group),
    severity: group.severity,
    // What actually failed, in the check's own words — this is the sentence the
    // brief has to turn into a fix, so it must reach the model intact.
    concern: group.root_evidence || group.diagnosis || group.summary || group.members[0]?.evidence || '',
    failing_check: group.root_check || null,
    diagnosis: group.diagnosis && group.diagnosis !== group.root_evidence ? group.diagnosis : null,
    tried_to_self_heal: group.self_heal_failed || undefined,
    blocking_quality_board: group.board_blocked || undefined,
    samples: group.clarification_requests.slice(0, 3).map(clarificationToText).filter(Boolean),
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
  const runtimeErrorGroups = groupRuntimeErrors(dedupe(context.runtimeErrors || [])).slice(0, 8);
  const runtimeErrors = runtimeErrorGroups.map(g =>
    g.count > 1 ? `${g.example} (and ${g.count - 1} more occurrence(s) of the same cause)` : g.example);
  return {
    asks,
    corrections,
    watching,
    runtime_errors: runtimeErrors,
    // Operational alerts computed live by the daily system report (silently
    // failing ingesters, a flood of tasks from one origin, a runner failing
    // most of its calls) — these carry their own "NEEDS YOU" line in the
    // report sections below the brief, but were never fed into the brief
    // itself, so the top-of-email ask count silently undercounted them.
    ops_alerts: (context.opsAlerts || []).slice(0, 5),
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
    const key = normaliseLogLine(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(line));
  }
  return out;
}

// Two runtime errors that both come from the local embedding server crashing
// are one incident, whatever backfill target (meeting_intake, document, task)
// happened to be running when it went down. Grouping on the message after the
// entity id, not the whole line, is what stops the same incident from filling
// three slots in "Needs you".
function runtimeErrorSignature(line) {
  const text = String(line || '');
  if (/local embeddings|llama-server/i.test(text)) return 'local_embeddings_down';
  return normaliseLogLine(text).replace(/^\[[^\]]+\]\s*/, '').replace(/\b[a-z_]+ [0-9a-f-]{8,}:/i, '#:');
}

function groupRuntimeErrors(lines) {
  const groups = new Map();
  for (const line of lines) {
    const sig = runtimeErrorSignature(line);
    const group = groups.get(sig);
    if (group) group.count++;
    else groups.set(sig, { example: String(line), count: 1 });
  }
  return [...groups.values()];
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

// Without the model there is no rewriting, so the fix has to come from the check
// itself. Several checks already end their evidence with the instruction ("—
// change the model slot in /admin/models/system"); that trailing clause is a
// better fix line than anything generic, so it is lifted verbatim.
function fallbackFix(ask) {
  const instruction = fixInstruction(ask.concern);
  if (instruction) return instruction.charAt(0).toUpperCase() + instruction.slice(1).replace(/\.?$/, '.');
  if (ask.severity === 'question') return 'Review and clarify on the page below.';
  return 'Open the page below and fix the failing check; the Hub could not do this one itself.';
}

// Several checks end their evidence with the repair ("— change the model slot in
// /admin/models/system"), repeated once per affected slot. That clause is the fix
// line; leaving it in the detail as well says the same thing four times.
function fixInstruction(concern) {
  const tail = String(concern || '').split(/\s+[—–]\s+/).pop().trim();
  return /^(change|set|re-?run|refresh|import|update|swap|remove|add|reconcile)\b/i.test(tail) ? tail : '';
}

function stripRepeatedInstruction(concern) {
  const instruction = fixInstruction(concern);
  if (!instruction) return String(concern || '');
  return String(concern)
    .split(/\s*;\s*/)
    .map(part => part.replace(new RegExp(`\\s+[—–]\\s+${instruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?$`), ''))
    .join('; ');
}

// The clauses are written as separate sentences, so they need to end like them.
function sentence(text) {
  const clean = String(text || '').trim();
  if (!clean) return '';
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

// If the model is unavailable, still produce something far more readable than the
// raw receipt dump: grouped, UUID-free, JSON-flattened.
function fallbackBrief(report, context) {
  const input = summarizeForModel(report, context);
  const needs = input.asks.map(a => ({
    title: a.area,
    detail: [
      // The remediation advisor already wrote a plain-English diagnosis; without
      // a model to rewrite it, that beats the check's raw telemetry.
      a.diagnosis || stripRepeatedInstruction(a.concern),
      a.tried_to_self_heal ? 'The Hub tried to fix this itself and could not' : '',
      a.blocking_quality_board ? 'It is also holding the quality board, which clears once this passes' : '',
      ...(a.samples || []),
    ].filter(Boolean).slice(0, 4).map(sentence).join(' '),
    recommended_fix: fallbackFix(a),
    fix_type: 'you_decide',
    refs: [a.ref],
  }));
  // Promote recurring runtime errors the formal asks missed. Already grouped by
  // root cause in summarizeForModel, so one entry here is one incident, not one
  // log line.
  for (const err of input.runtime_errors.slice(0, 3)) {
    needs.push({ title: 'Runtime error', detail: err, recommended_fix: 'Likely a code fix; hand to Codex with this error.', fix_type: 'needs_code', refs: [] });
  }
  // Operational alerts the daily report already computed (silent ingest
  // failures, task floods, a runner failing most of its calls) but that never
  // reached the brief, so "Needs you" undercounted what was actually flagged
  // further down the same email.
  for (const alert of input.ops_alerts) {
    needs.push({ title: 'Operational alert', detail: alert, recommended_fix: 'Check the relevant module/job; this is computed live from today\'s activity, not a formal ask.', fix_type: 'you_decide', refs: [] });
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
      ? 'The governance "FAIL" is the system flagging itself because the items above are open, not a separate problem.'
      : '',
  };
  return { brief, markdown: renderBriefMarkdown(brief, buildLinkIndex(report)), usedModel: false };
}

async function composeConsigliereBrief(report, context = {}) {
  const input = summarizeForModel(report, context);
  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1') return fallbackBrief(report, context);

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
  askGroups,
  friendlyArea,
  buildLinkIndex,
  linksForBriefItem,
};
