'use strict';

/**
 * CRM knowledge engine.
 *
 * This is the prompt-led bridge between raw CRM-adjacent sources and compiled
 * knowledge. It deliberately leaves receipts so the prompt operating system is
 * inspectable: source triage -> duplicate/supersession review -> synthesis
 * -> action projection -> compiled atoms/events/tasks.
 */

const db = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');
const { getCrmKnowledgeHealth } = require('./crm-knowledge-health');
const {
  loadEntities,
  buildEntityFacts,
  sourceContext,
  synthesiseSource,
} = require('./synthesis');
const { createTask } = require('./google-tasks');
const { createCalendarEvent } = require('./google-calendar');
const { buildEvidenceText, routingMetadata } = require('./messaging-capture');

const TRIAGE_FALLBACK = 'anthropic/claude-haiku-4-5';
const DUPLICATE_FALLBACK = 'anthropic/claude-haiku-4-5';
const ACTION_FALLBACK = 'anthropic/claude-haiku-4-5';
const ENGINE_SOURCE_KINDS = [
  'email_summary',
  'meeting_intake',
  'document',
  'open_task',
  'completed_task',
  'crm_fact',
  'messaging_message', // WhatsApp (and future chat) via Hermes capture
];
// Confidence is reliability, not a permission gate. An explicit ask or a commitment
// becomes a task regardless of confidence (an ask forwarded into the CRM is a to-do by
// definition). Confidence only decides how an *implied* action surfaces: at/above the
// task threshold it becomes a task; between the review floor and the threshold it is
// surfaced for review rather than silently dropped; below the floor it is set aside.
const ACTION_CONFIDENCE_THRESHOLD = 0.6;
const ACTION_REVIEW_FLOOR = 0.35;

// The Hub emails its own governance/status reports (Daily Consigliere Report,
// Hub Daily Report) to Douglas. Those arrive back in the inbox and get
// summarised into email_summaries. Feeding them to this engine as fresh
// "evidence" is a feedback loop: the Hub's own report about a low-confidence
// hunch becomes a projected task. That is exactly how a nightly near-name
// clarification about Alan Garland / Alec Hirst turned into a real "investigate
// possible duplicate contact" task. Exclude anything the Hub authored — mail
// from our own AgentMail address, or carrying one of our report subjects.
const HUB_REPORT_SUBJECT_PREFIXES = [
  'Daily Consigliere Report',
  'Hub Daily Report',
  'Hub Report',
  'Daily System Report',
];
const ACTION_STATE_GUARD = `Runtime task-state rule:
- The supplied task list is history, with each row labelled open, completed, deleted, or wrong.
- Completed, deleted, and wrong are authoritative human decisions. Do not recreate or paraphrase those tasks unless this source contains clearly newer evidence that explicitly makes the action outstanding again.
- A completed task source is a terminal state event, not a request for a replacement follow-up task.`;
// Appended the same way as ACTION_STATE_GUARD so a saved admin prompt override
// (lib/settings.js getSystemPrompt) still gets asked for the event field even
// if it predates this schema addition.
const ACTION_EVENT_GUARD = `Runtime event-field rule:
- Every action object in "actions" must include an "event" field, even if the response schema you were given doesn't show one.
- "event": { "start": "YYYY-MM-DDTHH:MM or null", "end": "YYYY-MM-DDTHH:MM or null", "location": "string or null" }.
- Set start/end only when the source states BOTH a specific date and a specific time Douglas must personally attend (interview, appointment, meeting). Leave them null for a plain due-by deadline with no attendance component.`;

function now() { return Math.floor(Date.now() / 1000); }

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'item';
}

function entityList(entities) {
  return entities
    .map(e => `- ${e.kind}:${e.id} ${e.label}${e.aliases?.length ? ` (aka ${e.aliases.join(', ')})` : ''}`)
    .join('\n') || '(none)';
}

function sourceReceipt(user, sourceKind, sourceId, stage) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ? AND stage = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(user, sourceKind, sourceId, stage);
}

function writeReceipt(user, sourceKind, sourceId, stage, {
  status = 'done',
  summary = '',
  payload = {},
  modelKey = null,
  modelId = null,
} = {}) {
  const id = uuid();
  db.hub().prepare(`
    INSERT INTO knowledge_receipts
      (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, user, sourceKind, sourceId, stage, status, summary || null,
    JSON.stringify(payload || {}), modelKey, modelId, now()
  );
  return id;
}

function isSynthesisProcessed(sourceKind, sourceId) {
  return !!db.hub().prepare(
    'SELECT 1 FROM synthesis_state WHERE source_kind = ? AND source_id = ? LIMIT 1'
  ).get(sourceKind, sourceId);
}

function markSynthesisProcessed(sourceKind, sourceId, user, atomCount = 0) {
  db.hub().prepare(`
    INSERT INTO synthesis_state (source_kind, source_id, user, processed_at, atom_count)
    VALUES (?, ?, ?, unixepoch(), ?)
    ON CONFLICT(source_kind, source_id) DO UPDATE SET processed_at = unixepoch(), atom_count = excluded.atom_count
  `).run(sourceKind, sourceId, user, atomCount);
}

function sourceRows(user, sourceKind, { untriagedOnly = false } = {}) {
  const hub = db.hub();
  if (sourceKind === 'email_summary') {
    const hubAddress = String(process.env.AGENTMAIL_INBOX_ID || '').toLowerCase();
    const subjectSql = HUB_REPORT_SUBJECT_PREFIXES.map(() => 'es.subject LIKE ?').join(' OR ');
    const subjectLikes = HUB_REPORT_SUBJECT_PREFIXES.map(p => `${p}%`);
    const selfAuthoredSql = hubAddress
      ? `lower(COALESCE(es.from_email,'')) = ? OR ${subjectSql}`
      : subjectSql;
    const params = hubAddress ? [user, hubAddress, ...subjectLikes] : [user, ...subjectLikes];
    // Read the full forwarded body when we captured it (AgentMail records store it);
    // fall back to the summary only when there is no raw body (e.g. Gmail summaries).
    return hub.prepare(`
      SELECT es.id, es.gmail_message_id, es.subject, es.from_name, es.from_email, es.project_slug, es.contact_id,
             (COALESCE(es.subject,'') || char(10) ||
              CASE WHEN COALESCE(ier.body_text,'') != '' THEN ier.body_text ELSE COALESCE(es.summary,'') END) AS text,
             es.received_at AS ts
      FROM email_summaries es
      LEFT JOIN inbound_email_records ier
        ON ier.user = es.user
       AND ier.source = 'agentmail'
       AND ('agentmail:' || ier.external_message_id) = es.gmail_message_id
      WHERE es.user = ?
        AND NOT (${selfAuthoredSql})
      ORDER BY es.received_at DESC
      LIMIT 300
    `).all(...params);
  }
  if (sourceKind === 'meeting_intake') {
    return hub.prepare(`
      SELECT id, extraction, project_slug,
             (COALESCE(title,'') || '. ' || COALESCE(summary,'') || ' ' || COALESCE(transcript,'')) AS text,
             created_at AS ts
      FROM meeting_intakes
      WHERE user = ? AND status = 'processed'
      ORDER BY created_at DESC
      LIMIT 200
    `).all(user);
  }
  if (sourceKind === 'document') {
    return hub.prepare(`
      SELECT id, project_id, filename, markdown AS text, uploaded_at AS ts
      FROM documents
      WHERE user = ?
      ORDER BY uploaded_at DESC
      LIMIT 200
    `).all(user);
  }
  if (sourceKind === 'completed_task') {
    return hub.prepare(`
      SELECT t.id, t.contact_id, t.company_id, t.project_slug,
             ('Completed task: ' || COALESCE(t.title,'') || char(10) ||
              'Notes: ' || COALESCE(t.notes,'') || char(10) ||
              'Source: ' || COALESCE(t.source,'manual') || char(10) ||
              'Completed at: ' || datetime(COALESCE(t.completed_at, t.synced_at, t.created_at), 'unixepoch') || char(10) ||
              'Linked person: ' || COALESCE(c.name,'') || char(10) ||
              'Linked company: ' || COALESCE(co.name,'') || char(10) ||
              'Linked project: ' || COALESCE(p.name, t.project_slug, '')) AS text,
             COALESCE(t.completed_at, t.synced_at, t.created_at) AS ts
      FROM google_tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = t.company_id
      LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
      WHERE t.user = ?
        AND t.status = 'completed'
        AND t.deleted_at IS NULL
        AND COALESCE(t.title, '') != ''
      ORDER BY ts DESC
      LIMIT 200
    `).all(user);
  }
  if (sourceKind === 'open_task') {
    return hub.prepare(`
      SELECT t.id, t.contact_id, t.company_id, t.project_slug,
             ('Open task: ' || COALESCE(t.title,'') || char(10) ||
              'Notes: ' || COALESCE(t.notes,'') || char(10) ||
              'Source: ' || COALESCE(t.source,'manual') || char(10) ||
              'Due: ' || COALESCE(t.due,'') || char(10) ||
              'Linked person: ' || COALESCE(c.name,'') || char(10) ||
              'Linked company: ' || COALESCE(co.name,'') || char(10) ||
              'Linked project: ' || COALESCE(p.name, t.project_slug, '')) AS text,
             t.created_at AS ts
      FROM google_tasks t
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = t.company_id
      LEFT JOIN projects p ON p.user = t.user AND p.slug = t.project_slug
      WHERE t.user = ?
        AND t.status = 'needsAction'
        AND t.deleted_at IS NULL
        AND COALESCE(t.title, '') != ''
      ORDER BY t.created_at DESC
      LIMIT 200
    `).all(user);
  }
  if (sourceKind === 'crm_fact') {
    return hub.prepare(`
      SELECT f.id, f.contact_id, f.company_id, f.project_slug,
             ('CRM fact about ' || COALESCE(c.name,'unknown') || ': ' || f.fact) AS text,
             f.created_at AS ts
      FROM crm_facts f
      LEFT JOIN contacts c ON c.id = f.contact_id
      WHERE f.user = ? AND f.status NOT IN ('wrong', 'archived')
      ORDER BY f.created_at DESC
      LIMIT 300
    `).all(user);
  }
  if (sourceKind === 'messaging_message') {
    // Prefer recent unprocessed WhatsApp/chat evidence. Status stays
    // 'received' until synthesis marks it; we do not require status flip
    // here because synthesis_state + receipts already gate reprocessing.
    return hub.prepare(`
      SELECT id, platform, chat_id, chat_name, is_group, sender_id, sender_name, body,
             received_at, raw_json, received_at AS ts
      FROM messaging_messages m
      WHERE m.user = ?
        AND COALESCE(body, '') != ''
        AND length(trim(body)) >= 8
        ${untriagedOnly ? `AND NOT EXISTS (
          SELECT 1 FROM knowledge_receipts r
          WHERE r.user = m.user
            AND r.source_kind = 'messaging_message'
            AND r.source_id = m.id
            AND r.stage = 'crm_source_triage'
        )
        AND NOT EXISTS (
          SELECT 1 FROM synthesis_state s
          WHERE s.source_kind = 'messaging_message'
            AND s.source_id = m.id
        )` : ''}
      ORDER BY received_at DESC
      LIMIT 200
    `).all(user).map(row => ({ ...row, text: buildEvidenceText(row) }));
  }
  return [];
}

function candidateSources(user, limit) {
  const rows = [];
  for (const kind of ENGINE_SOURCE_KINDS) {
    for (const row of sourceRows(user, kind, { untriagedOnly: true })) {
      if (rows.length >= limit * ENGINE_SOURCE_KINDS.length) break;
      if (!String(row.text || '').trim() || String(row.text || '').trim().length < 20) continue;
      if (sourceReceipt(user, kind, row.id, 'crm_source_triage')) continue;
      if (isSynthesisProcessed(kind, row.id)) {
        writeReceipt(user, kind, row.id, 'crm_source_triage', {
          status: 'already_synthesised',
          summary: 'Source had already been handled by synthesis_state before CRM engine triage.',
        });
        continue;
      }
      rows.push({ kind, row });
      if (rows.length >= limit) return rows;
    }
  }
  return rows.slice(0, limit);
}

async function triageSource(user, sourceKind, row, entities) {
  const modelId = getSystemModelId('crm_source_triage', 'system', TRIAGE_FALLBACK);
  const prompt = getSystemPrompt('crm_source_triage', 'system', PROMPTS.crm_source_triage)
    .replaceAll('[SOURCE_KIND]', sourceKind)
    .replaceAll('[ENTITIES]', entityList(entities))
    .replaceAll('[SOURCE_TEXT]', String(row.text || '').slice(0, 12000));
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    user,
    feature: 'crm-source-triage',
    modelKey: 'crm_source_triage',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: {
      should_synthesise: false,
      source_summary: '',
      knowledge_value: 'none',
      candidate_entities: [],
      candidate_relationships: [],
      candidate_actions: [],
      routing_notes: '',
      confidence: 0,
    },
    label: 'CRM source triage response',
  });
  parsed.candidate_entities = Array.isArray(parsed.candidate_entities) ? parsed.candidate_entities : [];
  parsed.candidate_relationships = Array.isArray(parsed.candidate_relationships) ? parsed.candidate_relationships : [];
  parsed.candidate_actions = Array.isArray(parsed.candidate_actions) ? parsed.candidate_actions : [];
  return { parsed, modelId };
}

function existingKnowledgeForReview(user, decision, row) {
  const hub = db.hub();
  const names = [
    ...(decision.candidate_entities || []).map(e => e.name),
    ...(decision.candidate_relationships || []).flatMap(r => [r.subject, r.object]),
    ...(decision.candidate_actions || []).flatMap(a => [a.owner, a.action]),
  ].map(v => String(v || '').trim().toLowerCase()).filter(v => v.length >= 3);
  const atoms = hub.prepare(`
    SELECT id, subject_kind, subject_label, predicate, value, confidence, status
    FROM knowledge_atoms
    WHERE user = ? AND status IN ('active','proposed')
    ORDER BY updated_at DESC
    LIMIT 400
  `).all(user).filter(a => {
    if (!names.length) return true;
    const haystack = `${a.subject_label} ${a.predicate} ${a.value}`.toLowerCase();
    return names.some(name => haystack.includes(name) || name.includes(String(a.subject_label || '').toLowerCase()));
  }).slice(0, 40);
  const openTasks = hub.prepare(`
    SELECT id, title, notes, project_slug, due
    FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 40
  `).all(user);
  const atomLines = atoms.map(a =>
    `ATOM ${a.id}: [${a.subject_kind}:${a.subject_label}] ${a.predicate} = ${a.value} (status ${a.status}, confidence ${a.confidence})`
  );
  const taskLines = openTasks.map(t =>
    `TASK ${t.id}: ${t.title}${t.project_slug ? ` /${t.project_slug}` : ''}${t.due ? ` due ${t.due}` : ''}${t.notes ? ` — ${String(t.notes).slice(0, 120)}` : ''}`
  );
  const sourceLine = row?.text ? `SOURCE EXCERPT: ${String(row.text).slice(0, 800)}` : '';
  return [sourceLine, 'EXISTING ATOMS', ...(atomLines.length ? atomLines : ['(none)']), 'OPEN TASKS', ...(taskLines.length ? taskLines : ['(none)'])].join('\n');
}

async function reviewDuplicate(user, sourceKind, row, decision) {
  const modelId = getSystemModelId('crm_duplicate_review', 'system', DUPLICATE_FALLBACK);
  const prompt = getSystemPrompt('crm_duplicate_review', 'system', PROMPTS.crm_duplicate_review)
    .replaceAll('[CANDIDATE]', JSON.stringify({
      source_kind: sourceKind,
      source_summary: decision.source_summary,
      knowledge_value: decision.knowledge_value,
      candidate_entities: decision.candidate_entities,
      candidate_relationships: decision.candidate_relationships,
      candidate_actions: decision.candidate_actions,
      routing_notes: decision.routing_notes,
    }, null, 2).slice(0, 8000))
    .replaceAll('[EXISTING]', existingKnowledgeForReview(user, decision, row).slice(0, 12000));
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    user,
    feature: 'crm-duplicate-review',
    modelKey: 'crm_duplicate_review',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: {
      decision: 'uncertain',
      target_id: null,
      reason: '',
      confidence: 0,
    },
    label: 'CRM duplicate review response',
  });
  return { parsed, modelId };
}

function mergeSourceRefIntoAtom(user, atomId, sourceKind, sourceId, confidence = 0.7) {
  const hub = db.hub();
  const atom = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND user = ?').get(atomId, user);
  if (!atom) return false;
  let refs = [];
  try { refs = JSON.parse(atom.source_refs || '[]'); } catch (_) { refs = []; }
  if (!Array.isArray(refs)) refs = [];
  if (!refs.some(r => r?.kind === sourceKind && r?.id === sourceId)) {
    refs.push({ kind: sourceKind, id: sourceId });
  }
  const nextConfidence = Math.min(0.99, Math.max(Number(atom.confidence) || 0.6, Number(confidence) || 0.7) + 0.02);
  hub.prepare(`
    UPDATE knowledge_atoms
       SET source_refs = ?, confidence = ?, last_confirmed = unixepoch(), updated_at = unixepoch()
     WHERE id = ? AND user = ?
  `).run(JSON.stringify(refs), nextConfidence, atomId, user);
  return true;
}

function taskState(task) {
  if (task.deleted_at) return task.status === 'wrong' ? 'wrong' : 'deleted';
  return task.status === 'completed' ? 'completed' : 'open';
}

function taskHistoryForActionProjection(user) {
  return db.hub().prepare(`
    SELECT title, notes, due, project_slug, status, deleted_at, completed_at, created_at
    FROM google_tasks
    WHERE user = ?
    ORDER BY COALESCE(completed_at, deleted_at, created_at) DESC
    LIMIT 120
  `).all(user).map(t => {
    const bits = [`[${taskState(t)}] ${t.title}`];
    if (t.project_slug) bits.push(`project:${t.project_slug}`);
    if (t.due) bits.push(`due:${t.due}`);
    if (t.notes) bits.push(String(t.notes).slice(0, 140));
    return `- ${bits.filter(Boolean).join(' | ')}`;
  }).join('\n') || '(none)';
}

async function projectActions(user, row, candidates) {
  if (!candidates?.length) return null;
  const modelId = getSystemModelId('crm_action_projection', 'system', ACTION_FALLBACK);
  const basePrompt = getSystemPrompt('crm_action_projection', 'system', PROMPTS.crm_action_projection)
    .replaceAll('[SOURCE_TEXT]', String(row.text || '').slice(0, 12000))
    .replaceAll('[CANDIDATES]', JSON.stringify(candidates, null, 2).slice(0, 6000))
    .replaceAll('[TASKS]', taskHistoryForActionProjection(user));
  // Append this after any admin-managed prompt override so production cannot
  // silently fall back to the former open-tasks-only behaviour.
  const prompt = `${basePrompt}\n\n${ACTION_STATE_GUARD}\n\n${ACTION_EVENT_GUARD}`;
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    user,
    feature: 'crm-action-projection',
    modelKey: 'crm_action_projection',
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
    defaults: { actions: [] },
    label: 'CRM action projection response',
  });
  parsed.actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  return { parsed, modelId };
}

function findEntityByName(entities, kind, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  return entities.find(entity => {
    if (kind && entity.kind !== kind) return false;
    const names = [entity.label, ...(entity.aliases || [])]
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean);
    return names.some(n => n === wanted || (wanted.length >= 4 && (n.includes(wanted) || wanted.includes(n))));
  }) || null;
}

function existingBlockingTaskByTitle(user, title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.hub().prepare(`
    SELECT id, title, status, deleted_at
    FROM google_tasks
    WHERE user = ?
      AND (
        (status = 'needsAction' AND deleted_at IS NULL)
        OR deleted_at IS NOT NULL
        OR status = 'wrong'
      )
      AND lower(title) = ?
    ORDER BY
      CASE
        WHEN deleted_at IS NOT NULL OR status = 'wrong' THEN 0
        ELSE 1
      END,
      created_at DESC
    LIMIT 1
  `).get(user, normalized);
}

function actionProjectionBlockReason(sourceKind, duplicateDecision, row = null) {
  // A user's completion is authoritative task state, not fresh evidence from
  // which the engine may manufacture a follow-up to the same task.
  if (sourceKind === 'completed_task') return 'completed_task_is_terminal';

  if (sourceKind === 'messaging_message' && routingMetadata(row).historical_backfill) {
    return 'historical_backfill_requires_current_evidence';
  }

  if (
    duplicateDecision
    && ['duplicate', 'confirms_existing'].includes(duplicateDecision.decision)
    && Number(duplicateDecision.confidence) >= 0.85
  ) {
    return `duplicate_review_${duplicateDecision.decision}`;
  }
  return null;
}

// Returns { start, end, location } when an action clearly describes a
// specific-time attendance commitment, or null otherwise. Both start and end
// must be present and parse as real, ordered datetimes — a bare date with no
// time is a due-by deadline, not a meeting, and doesn't qualify.
function eventFromAction(action) {
  const ev = action?.event;
  if (!ev || !ev.start || !ev.end) return null;
  const start = new Date(ev.start);
  const end = new Date(ev.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  return { start: ev.start, end: ev.end, location: ev.location || null };
}

// Pure disposition for one projected action. This is where "confidence is not a gate"
// lives: an explicit ask or a commitment is always created (a request forwarded into
// the CRM is a to-do by definition); an implied action is created when reliable, or
// surfaced for review when borderline, and only truly weak signals are set aside.
// Nothing actionable is ever silently dropped.
function actionDisposition(action) {
  const confidence = Number(action?.confidence) || 0;
  const actionability = String(action?.actionability || '').toLowerCase();
  if (!action?.title) return { disposition: 'skip', reason: 'no_title', confidence };
  if (action.duplicate_of) return { disposition: 'skip', reason: 'duplicate', confidence };
  if (actionability === 'fyi') return { disposition: 'skip', reason: 'fyi_not_actionable', confidence };
  const isAsk = actionability === 'explicit_ask' || actionability === 'commitment';
  if (isAsk || confidence >= ACTION_CONFIDENCE_THRESHOLD) {
    return { disposition: 'create', reason: isAsk ? 'ask' : 'confident_implied', confidence };
  }
  if (confidence >= ACTION_REVIEW_FLOOR) return { disposition: 'review', reason: 'implied_needs_review', confidence };
  return { disposition: 'skip', reason: 'below_review_floor', confidence };
}

async function createProjectedTasks(user, sourceKind, sourceId, actions, entities) {
  if (sourceKind === 'open_task') {
    return { created: 0, skipped: actions.length, reason: 'source is already an open task' };
  }
  let created = 0, skipped = 0, errors = 0, review = 0;
  let eventsCreated = 0, eventsSkipped = 0, eventErrors = 0;
  const details = [];
  const eventDetails = [];
  for (const action of actions || []) {
    const { disposition, reason, confidence } = actionDisposition(action);
    if (disposition === 'skip') {
      skipped++;
      details.push({ title: action.title || '', skipped: true, reason, confidence });
      continue;
    }
    if (disposition === 'review') {
      review++;
      details.push({ title: action.title, needs_review: true, reason, actionability: action.actionability, confidence });
      continue;
    }
    // disposition === 'create' → build and create the task below
    const contact = findEntityByName(entities, 'contact', action.person);
    const company = findEntityByName(entities, 'company', action.company);
    const project = findEntityByName(entities, 'project', action.project_slug)
      || findEntityByName(entities, 'project', action.project);
    const projectSlug = action.project_slug || project?.aliases?.[0] || null;

    // A matching existing task title blocks a *second* task, but a scheduled
    // meeting/interview may still be missing its calendar event even when the
    // task was already created on an earlier run — don't let this skip the
    // event below, only the task.
    const existingTitle = existingBlockingTaskByTitle(user, action.title);
    if (existingTitle) {
      skipped++;
      details.push({
        title: action.title,
        skipped: true,
        reason: existingTitle.deleted_at || existingTitle.status === 'wrong'
          ? 'matching_deleted_task'
          : 'existing_open_task_title',
        existingTaskId: existingTitle.id,
        confidence,
      });
    } else {
      const sourceTaskId = `crm-engine:${sourceKind}:${sourceId}:${slugify(action.title)}`;
      try {
        const task = await createTask(user, {
          title: String(action.title).trim().slice(0, 240),
          notes: [`Evidence: ${action.evidence || 'CRM knowledge engine projection'}`, `Source: ${sourceKind}/${sourceId}`].join('\n'),
          due: /^\d{4}-\d{2}-\d{2}$/.test(action.due_date || '') ? action.due_date : undefined,
          source: 'crm-engine',
          sourceId: sourceTaskId,
          contactId: contact?.id || null,
          companyId: company?.id || null,
          projectSlug,
        });
        if (task) {
          created++;
          details.push({ title: action.title, created: true, localId: task.localId, confidence });
        } else {
          skipped++;
          details.push({ title: action.title, skipped: true, reason: 'existing_source_id', confidence });
        }
      } catch (err) {
        errors++;
        details.push({ title: action.title, error: err.message, confidence });
      }
    }

    const event = eventFromAction(action);
    if (!event) continue;
    const sourceEventId = `crm-engine:${sourceKind}:${sourceId}:calendar:${slugify(action.title)}`;
    try {
      const calendarEvent = await createCalendarEvent(user, {
        title: String(action.title).trim().slice(0, 240),
        description: [`Evidence: ${action.evidence || 'CRM knowledge engine projection'}`, `Source: ${sourceKind}/${sourceId}`].join('\n'),
        location: event.location,
        startAt: event.start,
        endAt: event.end,
        source: 'crm-engine',
        sourceId: sourceEventId,
        contactId: contact?.id || null,
        companyId: company?.id || null,
      });
      if (calendarEvent) {
        eventsCreated++;
        eventDetails.push({ title: action.title, created: true, localId: calendarEvent.localId, confidence });
      } else {
        eventsSkipped++;
        eventDetails.push({ title: action.title, skipped: true, reason: 'existing_source_id', confidence });
      }
    } catch (err) {
      eventErrors++;
      eventDetails.push({ title: action.title, error: err.message, confidence });
    }
  }
  return {
    created, skipped, errors, review, details,
    events: { created: eventsCreated, skipped: eventsSkipped, errors: eventErrors, details: eventDetails },
  };
}

async function processSource(user, sourceKind, row, context, { retry = false } = {}) {
  const { entities, entityFacts, budget } = context;
  let triage;
  try {
    triage = await triageSource(user, sourceKind, row, entities);
  } catch (err) {
    writeReceipt(user, sourceKind, row.id, 'crm_source_triage', {
      status: 'error',
      summary: err.message,
      payload: { error: err.message },
      modelKey: 'crm_source_triage',
    });
    return { triaged: 0, synthesised: 0, skipped: 0, errors: 1 };
  }

  const decision = triage.parsed;
  writeReceipt(user, sourceKind, row.id, 'crm_source_triage', {
    status: decision.should_synthesise ? 'done' : 'skipped',
    summary: decision.source_summary || decision.routing_notes || 'CRM source triaged.',
    payload: decision,
    modelKey: 'crm_source_triage',
    modelId: triage.modelId,
  });

  let duplicateDecision = null;
  if (decision.should_synthesise || decision.candidate_actions.length) {
    try {
      const duplicate = await reviewDuplicate(user, sourceKind, row, decision);
      duplicateDecision = duplicate.parsed;
      writeReceipt(user, sourceKind, row.id, 'crm_duplicate_reviewed', {
        status: duplicateDecision.decision || 'uncertain',
        summary: duplicateDecision.reason || `Duplicate review: ${duplicateDecision.decision || 'uncertain'}`,
        payload: duplicateDecision,
        modelKey: 'crm_duplicate_review',
        modelId: duplicate.modelId,
      });
    } catch (err) {
      writeReceipt(user, sourceKind, row.id, 'crm_duplicate_reviewed', {
        status: 'error',
        summary: err.message,
        payload: { error: err.message },
        modelKey: 'crm_duplicate_review',
      });
    }
  }

  if (decision.candidate_actions.length) {
    const blockReason = actionProjectionBlockReason(sourceKind, duplicateDecision, row);
    if (blockReason) {
      writeReceipt(user, sourceKind, row.id, 'crm_action_projected', {
        status: 'skipped',
        summary: `Action projection blocked: ${blockReason}.`,
        payload: {
          block_reason: blockReason,
          candidates: decision.candidate_actions,
          duplicate_review: duplicateDecision,
        },
      });
    } else {
      try {
        const projected = await projectActions(user, row, decision.candidate_actions);
        if (projected) {
          const actions = projected.parsed.actions || [];
          const created = await createProjectedTasks(user, sourceKind, row.id, actions, context.entities);
          const eventsSummary = created.events?.created
            ? ` ${created.events.created} calendar event(s) created.`
            : '';
          // 'review' when nothing was auto-created but at least one action needs a look —
          // an actionable item must never disappear behind a green "done".
          const projectionStatus = (created.errors || created.events?.errors) ? 'error'
            : created.created ? 'done'
            : created.review ? 'review'
            : 'skipped';
          writeReceipt(user, sourceKind, row.id, 'crm_action_projected', {
            status: projectionStatus,
            summary: actions.length
              ? `${actions.length} action candidate(s); ${created.created} task(s) created, ${created.review} flagged for review, ${created.skipped} skipped.${eventsSummary}`
              : 'No action candidates survived projection.',
            payload: { ...projected.parsed, task_projection: created, event_projection: created.events },
            modelKey: 'crm_action_projection',
            modelId: projected.modelId,
          });
        }
      } catch (err) {
        writeReceipt(user, sourceKind, row.id, 'crm_action_projected', {
          status: 'error',
          summary: err.message,
          payload: { error: err.message, candidates: decision.candidate_actions },
          modelKey: 'crm_action_projection',
        });
      }
    }
  }

  if (!decision.should_synthesise) {
    markSynthesisProcessed(sourceKind, row.id, user, 0);
    return { triaged: 1, synthesised: 0, skipped: 1, errors: 0 };
  }

  if (retry && isSynthesisProcessed(sourceKind, row.id)) {
    writeReceipt(user, sourceKind, row.id, 'crm_knowledge_synthesised', {
      status: 'already_synthesised',
      summary: 'Retry rechecked the source; compiled knowledge already exists, so synthesis was not duplicated.',
      payload: { triage: decision, duplicate_review: duplicateDecision, retry: true },
    });
    return { triaged: 1, synthesised: 0, skipped: 1, errors: 0 };
  }

  if (sourceKind === 'open_task') {
    markSynthesisProcessed(sourceKind, row.id, user, 0);
    writeReceipt(user, sourceKind, row.id, 'crm_knowledge_synthesised', {
      status: 'skipped',
      summary: 'Open tasks are action state. They are routed/projected, but not promoted to durable knowledge until completion.',
      payload: { triage: decision, duplicate_review: duplicateDecision },
    });
    return { triaged: 1, synthesised: 0, skipped: 1, errors: 0 };
  }

  if (
    duplicateDecision
    && ['duplicate', 'confirms_existing'].includes(duplicateDecision.decision)
    && duplicateDecision.target_id
    && Number(duplicateDecision.confidence) >= 0.85
    && mergeSourceRefIntoAtom(user, duplicateDecision.target_id, sourceKind, row.id, duplicateDecision.confidence)
  ) {
    markSynthesisProcessed(sourceKind, row.id, user, 1);
    writeReceipt(user, sourceKind, row.id, 'crm_knowledge_synthesised', {
      status: 'merged',
      summary: `Merged source provenance into existing atom ${duplicateDecision.target_id}.`,
      payload: { triage: decision, duplicate_review: duplicateDecision },
      modelKey: 'crm_duplicate_review',
    });
    return { triaged: 1, synthesised: 0, skipped: 0, errors: 0, atomsStored: 1, proposed: 0 };
  }

  try {
    const result = await synthesiseSource(
      user,
      sourceKind,
      row.id,
      String(row.text || '').trim(),
      entities,
      budget,
      entityFacts,
      sourceContext(user, sourceKind, row)
    );
    writeReceipt(user, sourceKind, row.id, 'crm_knowledge_synthesised', {
      status: 'done',
      summary: `${result.stored} atom(s) stored; ${result.proposed} proposed.`,
      payload: { ...result, triage: decision },
      modelKey: 'atom_extractor/entity_linker',
    });
    return { triaged: 1, synthesised: 1, skipped: 0, errors: 0, atomsStored: result.stored, proposed: result.proposed };
  } catch (err) {
    writeReceipt(user, sourceKind, row.id, 'crm_knowledge_synthesised', {
      status: 'error',
      summary: err.message,
      payload: { error: err.message, triage: decision },
      modelKey: 'atom_extractor/entity_linker',
    });
    return { triaged: 1, synthesised: 0, skipped: 0, errors: 1 };
  }
}

async function runCrmKnowledgeEngine(user, { limit = 8, linkBudget = 12 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    return { considered: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, reason: 'OPENROUTER_API_KEY not set' };
  }
  const sources = candidateSources(user, limit);
  if (!sources.length) return { considered: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0 };

  const context = {
    entities: loadEntities(user),
    entityFacts: buildEntityFacts(user),
    budget: { n: linkBudget },
  };
  const totals = { considered: sources.length, triaged: 0, synthesised: 0, skipped: 0, errors: 0, atomsStored: 0, proposed: 0 };
  for (const source of sources) {
    const result = await processSource(user, source.kind, source.row, context);
    for (const key of Object.keys(totals)) totals[key] += result[key] || 0;
  }
  return totals;
}

async function retryCrmKnowledgeErrors(user, { limit = 8, linkBudget = 12 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    return { considered: 0, retried: 0, errors: 0, reason: 'OPENROUTER_API_KEY not set' };
  }

  const health = getCrmKnowledgeHealth(user);
  const sourceGroups = new Map();
  for (const receipt of health.currentErrors) {
    const key = `${receipt.source_kind}\u0000${receipt.source_id}`;
    if (!sourceGroups.has(key)) {
      sourceGroups.set(key, {
        sourceKind: receipt.source_kind,
        sourceId: receipt.source_id,
        errors: [],
        latestAt: Number(receipt.created_at || 0),
      });
    }
    sourceGroups.get(key).errors.push(receipt);
  }
  const selected = [...sourceGroups.values()]
    .sort((a, b) => b.latestAt - a.latestAt)
    .slice(0, Math.max(1, Math.min(25, Number(limit) || 8)));
  if (!selected.length) return { considered: 0, retried: 0, errors: 0 };

  const rowsByKind = new Map();
  for (const item of selected) {
    if (!rowsByKind.has(item.sourceKind)) {
      rowsByKind.set(item.sourceKind, new Map(sourceRows(user, item.sourceKind).map(row => [String(row.id), row])));
    }
  }

  const context = {
    entities: loadEntities(user),
    entityFacts: buildEntityFacts(user),
    budget: { n: linkBudget },
  };
  const totals = { considered: selected.length, retried: 0, triaged: 0, synthesised: 0, skipped: 0, errors: 0, atomsStored: 0, proposed: 0 };

  for (const item of selected) {
    const row = rowsByKind.get(item.sourceKind)?.get(String(item.sourceId));
    if (!row) {
      for (const receipt of item.errors) {
        writeReceipt(user, item.sourceKind, item.sourceId, receipt.stage, {
          status: 'skipped',
          summary: 'Retry closed this error because the original raw source no longer exists.',
          payload: { retry_of: receipt.id, reason: 'raw_source_missing' },
        });
      }
      totals.skipped += 1;
      continue;
    }

    const result = await processSource(user, item.sourceKind, row, context, { retry: true });
    totals.retried += 1;
    for (const key of ['triaged', 'synthesised', 'skipped', 'errors', 'atomsStored', 'proposed']) {
      totals[key] += result[key] || 0;
    }

    for (const receipt of item.errors) {
      const latest = sourceReceipt(user, item.sourceKind, item.sourceId, receipt.stage);
      if (latest?.id === receipt.id) {
        writeReceipt(user, item.sourceKind, item.sourceId, receipt.stage, {
          status: 'skipped',
          summary: 'Retry completed; this stage was not required by the latest triage decision.',
          payload: { retry_of: receipt.id, reason: 'stage_not_required' },
        });
      }
    }
  }

  return totals;
}

function shouldSkipByReceipt(user, sourceKind, sourceId) {
  const r = sourceReceipt(user, sourceKind, sourceId, 'crm_source_triage');
  if (!r || r.status !== 'skipped') return false;
  try {
    const payload = JSON.parse(r.payload || '{}');
    return payload && payload.should_synthesise === false;
  } catch (_) {
    return true;
  }
}

module.exports = {
  runCrmKnowledgeEngine,
  retryCrmKnowledgeErrors,
  writeReceipt,
  sourceReceipt,
  shouldSkipByReceipt,
  ENGINE_SOURCE_KINDS,
  _test: {
    ACTION_STATE_GUARD,
    ACTION_EVENT_GUARD,
    actionProjectionBlockReason,
    actionDisposition,
    ACTION_CONFIDENCE_THRESHOLD,
    ACTION_REVIEW_FLOOR,
    taskState,
    eventFromAction,
    sourceRows,
  },
};
