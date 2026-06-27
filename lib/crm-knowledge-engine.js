'use strict';

/**
 * CRM knowledge engine.
 *
 * This is the prompt-led bridge between raw CRM-adjacent sources and compiled
 * knowledge. It deliberately leaves receipts so the prompt operating system is
 * inspectable: source triage -> synthesis -> compiled atoms.
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

const TRIAGE_FALLBACK = 'anthropic/claude-haiku-4-5';
const ACTION_FALLBACK = 'anthropic/claude-haiku-4-5';
const ENGINE_SOURCE_KINDS = ['email_summary', 'meeting_intake', 'document', 'completed_task', 'crm_fact'];

function now() { return Math.floor(Date.now() / 1000); }

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

  if (decision.candidate_actions.length) {
    try {
      const projected = await projectActions(user, row, decision.candidate_actions);
      if (projected) {
        const actions = projected.parsed.actions || [];
        writeReceipt(user, sourceKind, row.id, 'crm_action_projected', {
          status: actions.length ? 'proposed' : 'skipped',
          summary: actions.length
            ? `${actions.length} source-backed action candidate(s) projected for review.`
            : 'No action candidates survived projection.',
          payload: projected.parsed,
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
