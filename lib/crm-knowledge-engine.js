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
const fetch = require('./fetch');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');
const {
  loadEntities,
  buildEntityFacts,
  sourceContext,
  synthesiseSource,
} = require('./synthesis');
const { createTask } = require('./google-tasks');

const TRIAGE_FALLBACK = 'anthropic/claude-haiku-4-5';
const DUPLICATE_FALLBACK = 'anthropic/claude-haiku-4-5';
const ACTION_FALLBACK = 'anthropic/claude-haiku-4-5';
const ENGINE_SOURCE_KINDS = ['email_summary', 'meeting_intake', 'document', 'open_task', 'completed_task', 'crm_fact'];
const ACTION_CONFIDENCE_THRESHOLD = 0.75;

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
    ORDER BY created_at DESC LIMIT 1
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

function sourceRows(user, sourceKind) {
  const hub = db.hub();
  if (sourceKind === 'email_summary') {
    return hub.prepare(`
      SELECT id, gmail_message_id, subject, from_name, from_email, project_slug, contact_id,
             (COALESCE(subject,'') || '. ' || COALESCE(summary,'')) AS text,
             received_at AS ts
      FROM email_summaries
      WHERE user = ?
      ORDER BY received_at DESC
      LIMIT 300
    `).all(user);
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
  return [];
}

function candidateSources(user, limit) {
  const rows = [];
  for (const kind of ENGINE_SOURCE_KINDS) {
    for (const row of sourceRows(user, kind)) {
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
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_SYNTHESIS),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`CRM source triage OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'crm-source-triage',
    modelKey: 'crm_source_triage',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
  });
  const parsed = parseModelObject(data.choices?.[0]?.message?.content, {
    should_synthesise: false,
    source_summary: '',
    knowledge_value: 'none',
    candidate_entities: [],
    candidate_relationships: [],
    candidate_actions: [],
    routing_notes: '',
    confidence: 0,
  }, 'CRM source triage response');
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
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_SYNTHESIS),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`CRM duplicate review OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'crm-duplicate-review',
    modelKey: 'crm_duplicate_review',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
  });
  const parsed = parseModelObject(data.choices?.[0]?.message?.content, {
    decision: 'uncertain',
    target_id: null,
    reason: '',
    confidence: 0,
  }, 'CRM duplicate review response');
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

function openTasksForActionProjection(user) {
  return db.hub().prepare(`
    SELECT title, notes, due, project_slug
    FROM google_tasks
    WHERE user = ?
      AND status = 'needsAction'
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT 80
  `).all(user).map(t => {
    const bits = [t.title];
    if (t.project_slug) bits.push(`project:${t.project_slug}`);
    if (t.due) bits.push(`due:${t.due}`);
    if (t.notes) bits.push(String(t.notes).slice(0, 140));
    return `- ${bits.filter(Boolean).join(' | ')}`;
  }).join('\n') || '(none)';
}

async function projectActions(user, row, candidates) {
  if (!candidates?.length) return null;
  const modelId = getSystemModelId('crm_action_projection', 'system', ACTION_FALLBACK);
  const prompt = getSystemPrompt('crm_action_projection', 'system', PROMPTS.crm_action_projection)
    .replaceAll('[SOURCE_TEXT]', String(row.text || '').slice(0, 12000))
    .replaceAll('[CANDIDATES]', JSON.stringify(candidates, null, 2).slice(0, 6000))
    .replaceAll('[TASKS]', openTasksForActionProjection(user));
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_SYNTHESIS),
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });
  if (!resp.ok) throw new Error(`CRM action projection OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'crm-action-projection',
    modelKey: 'crm_action_projection',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
  });
  const parsed = parseModelObject(data.choices?.[0]?.message?.content, { actions: [] }, 'CRM action projection response');
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

function existingOpenTaskByTitle(user, title) {
  const normalized = String(title || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.hub().prepare(`
    SELECT id, title
    FROM google_tasks
    WHERE user = ?
      AND status = 'needsAction'
      AND deleted_at IS NULL
      AND lower(title) = ?
    LIMIT 1
  `).get(user, normalized);
}

async function createProjectedTasks(user, sourceKind, sourceId, actions, entities) {
  if (sourceKind === 'open_task') {
    return { created: 0, skipped: actions.length, reason: 'source is already an open task' };
  }
  let created = 0, skipped = 0, errors = 0;
  const details = [];
  for (const action of actions || []) {
    const confidence = Number(action.confidence) || 0;
    if (!action.title || confidence < ACTION_CONFIDENCE_THRESHOLD || action.duplicate_of) {
      skipped++;
      details.push({ title: action.title || '', skipped: true, reason: action.duplicate_of ? 'duplicate' : 'low_confidence', confidence });
      continue;
    }
    const existingTitle = existingOpenTaskByTitle(user, action.title);
    if (existingTitle) {
      skipped++;
      details.push({ title: action.title, skipped: true, reason: 'existing_open_task_title', existingTaskId: existingTitle.id, confidence });
      continue;
    }
    const contact = findEntityByName(entities, 'contact', action.person);
    const company = findEntityByName(entities, 'company', action.company);
    const project = findEntityByName(entities, 'project', action.project_slug)
      || findEntityByName(entities, 'project', action.project);
    const projectSlug = action.project_slug || project?.aliases?.[0] || null;
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
  return { created, skipped, errors, details };
}

async function processSource(user, sourceKind, row, context) {
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
    try {
      const projected = await projectActions(user, row, decision.candidate_actions);
      if (projected) {
        const actions = projected.parsed.actions || [];
        const created = await createProjectedTasks(user, sourceKind, row.id, actions, context.entities);
        writeReceipt(user, sourceKind, row.id, 'crm_action_projected', {
          status: created.errors ? 'error' : actions.length ? 'done' : 'skipped',
          summary: actions.length
            ? `${actions.length} source-backed action candidate(s); ${created.created} task(s) created, ${created.skipped} skipped.`
            : 'No action candidates survived projection.',
          payload: { ...projected.parsed, task_projection: created },
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

  if (!decision.should_synthesise) {
    markSynthesisProcessed(sourceKind, row.id, user, 0);
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
  writeReceipt,
  sourceReceipt,
  shouldSkipByReceipt,
  ENGINE_SOURCE_KINDS,
};
