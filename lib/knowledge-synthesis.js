'use strict';

/**
 * Knowledge layer — cross-entity synthesis and free-form query.
 *
 * runCrossEntitySynthesis: reads all active atoms across every entity, asks the
 * LLM to find patterns, workflows, connections, and gaps, then writes the
 * findings back as subject_kind = 'insight' atoms. Runs nightly.
 *
 * textSearchAtoms: SQL LIKE fallback for knowledge queries when embeddings
 * haven't been indexed yet.
 *
 * answerKnowledgeQuery: takes a free-form question, gathers relevant evidence
 * (text search + semantic search + insight atoms), and returns a narrative answer.
 */

const db      = require('./db');
const { uuid } = require('./id');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const fetch   = require('./fetch');

const INSIGHT_KIND = 'insight';

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAtomsForSynthesis(atoms) {
  return atoms
    .map(a => `[${a.subject_kind}:${a.subject_label}] ${a.predicate}: ${a.value}`)
    .join('\n');
}

function parseModelJson(raw, defaults) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start < 0 || end <= start) return defaults;
  try { return { ...defaults, ...JSON.parse(text.slice(start, end + 1)) }; } catch { return defaults; }
}

// ── Cross-entity synthesis ─────────────────────────────────────────────────────

async function runCrossEntitySynthesis(user) {
  const hub = db.hub();

  const atoms = hub.prepare(`
    SELECT subject_kind, subject_label, predicate, value, confidence
      FROM knowledge_atoms
     WHERE user = ? AND status = 'active' AND subject_kind != ?
     ORDER BY subject_kind, subject_label, confidence DESC
     LIMIT 600
  `).all(user, INSIGHT_KIND);

  if (atoms.length < 5) {
    console.log('[knowledge-synthesis] skipped — fewer than 5 atoms');
    return { atomsRead: atoms.length, insights: 0, reason: 'insufficient_atoms' };
  }

  const atomText = formatAtomsForSynthesis(atoms);
  const modelId  = getSystemModelId('cross_entity_synthesis', 'system', 'anthropic/claude-haiku-4-5');
  const started  = Date.now();

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_SYNTHESIS),
    body:    JSON.stringify({
      model:           modelId,
      messages: [
        { role: 'system', content: getSystemPrompt('cross_entity_synthesis', 'system', PROMPTS.cross_entity_synthesis) },
        { role: 'user',   content: atomText },
      ],
      response_format: { type: 'json_object' },
      temperature:     0.3,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature: 'cross-entity-synthesis', modelKey: 'cross_entity_synthesis',
    fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
  });

  const { insights = [] } = parseModelJson(data.choices?.[0]?.message?.content, { insights: [] });

  // Hard-replace insight atoms — they are entirely derived, no information loss.
  hub.prepare(`DELETE FROM knowledge_atoms WHERE user = ? AND subject_kind = ?`).run(user, INSIGHT_KIND);

  const now    = Math.floor(Date.now() / 1000);
  const insert = hub.prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
  `);

  let written = 0;
  for (const ins of insights) {
    if (!ins.title || !ins.detail) continue;
    const conf = Math.min(0.99, Math.max(0.3, Number(ins.confidence) || 0.7));
    insert.run(
      uuid(), user, INSIGHT_KIND,
      String(ins.title).slice(0, 200),
      String(ins.type || 'pattern').slice(0, 80),
      String(ins.detail).slice(0, 1000),
      JSON.stringify((ins.entities || []).map(e => ({ kind: 'label', id: String(e) }))),
      conf, 'active', 'cross_entity_synthesis', now, now, now
    );
    written++;
  }

  console.log(`[knowledge-synthesis] ${atoms.length} atoms → ${written} insights`);
  return { atomsRead: atoms.length, insights: written };
}

// ── Free-form query ────────────────────────────────────────────────────────────

function getInsightAtoms(user) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_atoms
     WHERE user = ? AND subject_kind = ? AND status = 'active'
     ORDER BY confidence DESC
     LIMIT 40
  `).all(user, INSIGHT_KIND);
}

// SQL LIKE search — always works even when the embeddings index is empty.
function textSearchAtoms(user, query, limit = 40) {
  const hub   = db.hub();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length > 2).slice(0, 6);
  if (!terms.length) return [];
  const cond   = terms.map(() => `(lower(subject_label) LIKE ? OR lower(predicate) LIKE ? OR lower(value) LIKE ?)`).join(' OR ');
  const params = [user, 'active', ...terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`])];
  return hub.prepare(
    `SELECT * FROM knowledge_atoms WHERE user = ? AND status = ? AND (${cond}) ORDER BY confidence DESC LIMIT ${limit}`
  ).all(...params);
}

async function answerKnowledgeQuery(user, query) {
  if (!query || !query.trim()) return null;

  const hub = db.hub();

  // 1. Text search atoms
  const textAtoms = textSearchAtoms(user, query, 40);

  // 2. Semantic search (graceful fallback — returns [] if index is empty)
  let semanticAtoms = [];
  try {
    const { semanticSearch } = require('./retrieval');
    const hits = await semanticSearch(user, query, 12, { sourceKinds: ['atom', 'meeting_intake', 'email_summary', 'document'] });
    const seenAtomIds = new Set(textAtoms.map(a => a.id));
    for (const h of hits) {
      if (h.source_kind === 'atom') {
        const a = hub.prepare('SELECT * FROM knowledge_atoms WHERE id = ? AND status = ?').get(h.source_id, 'active');
        if (a && !seenAtomIds.has(a.id)) { semanticAtoms.push({ ...a, _score: h.score }); seenAtomIds.add(a.id); }
      } else {
        semanticAtoms.push({ _chunk: h.chunk_text, _kind: h.source_kind, _score: h.score });
      }
    }
  } catch (_) {}

  // 3. Insight atoms (always included — these are cross-entity patterns)
  const insights = getInsightAtoms(user);

  // 4. Build evidence text
  const fmtAtom = a => `[${a.subject_kind || 'unknown'}:${a.subject_label || ''}] ${a.predicate}: ${a.value}`;
  const fmtChunk = c => `[${c._kind}] ${c._chunk}`;

  const sections = [];
  if (textAtoms.length)   sections.push('ATOMS MATCHING QUERY\n' + textAtoms.map(fmtAtom).join('\n'));
  if (semanticAtoms.length) {
    const atomPart  = semanticAtoms.filter(a => a.predicate).map(fmtAtom).join('\n');
    const chunkPart = semanticAtoms.filter(a => a._chunk).map(fmtChunk).join('\n');
    if (atomPart)  sections.push('SEMANTICALLY RELATED ATOMS\n' + atomPart);
    if (chunkPart) sections.push('SEMANTICALLY RELATED CONTENT\n' + chunkPart);
  }
  if (insights.length) sections.push('CROSS-ENTITY INSIGHTS\n' + insights.map(a => `[insight] ${a.subject_label}: ${a.value}`).join('\n'));

  if (!sections.length) {
    return {
      answer: 'No relevant knowledge was found for that question. Try running the knowledge synthesis job to build cross-entity insights, or ingest more source material.',
      atomsUsed: 0, semanticHits: 0, insightsUsed: 0,
    };
  }

  const evidenceText = [`Question: ${query}`, '', ...sections].join('\n\n').slice(0, 18000);

  const modelId = getSystemModelId('knowledge_query', 'system', 'anthropic/claude-haiku-4-5');
  const started = Date.now();

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_QUERY),
    body:    JSON.stringify({
      model:       modelId,
      messages: [
        { role: 'system', content: getSystemPrompt('knowledge_query', 'system', PROMPTS.knowledge_query) },
        { role: 'user',   content: evidenceText },
      ],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature: 'knowledge-query', modelKey: 'knowledge_query',
    fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.KNOWLEDGE_QUERY,
  });

  const answer = data.choices?.[0]?.message?.content || '';
  return {
    answer,
    model: modelId,
    atomsUsed: textAtoms.length,
    semanticHits: semanticAtoms.length,
    insightsUsed: insights.length,
  };
}

module.exports = { runCrossEntitySynthesis, getInsightAtoms, textSearchAtoms, answerKnowledgeQuery };
