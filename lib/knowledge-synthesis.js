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
const { runSubscriptionText } = require('./subscription-agent');

const INSIGHT_KIND = 'insight';
const THREAD_KIND = 'thread';
const LIVE_THREAD_DERIVER = 'live_thread_synthesis';
// The evidence packet stays capped at the same total it always was, so cost is
// unchanged — but it is spent better. Only SEED_ATOMS of it is the newest
// "what changed" driver; the rest is filled by semantic retrieval across the
// WHOLE atom corpus, which is what lets a new atom be synthesised against an
// old one. Before this the packet was 80 newest atoms and nothing older than a
// day or two was ever reachable. PACKET_MAX also caps the remote reload that
// re-validates evidence ids, so the two must not drift apart.
const CROSS_ENTITY_PACKET_MAX = 80;
const CROSS_ENTITY_SEED_ATOMS = 40;
const CROSS_ENTITY_RELATED_PER_SEED = 6;
const CROSS_ENTITY_RELATED_MIN_SCORE = 0.6;
const CROSS_ENTITY_SEED_QUERY_SAMPLE = 14;
// Insights accumulate rather than being rebuilt from scratch each night: a
// discovery must survive after the new atom that surfaced it ages out of the
// seed, or a genuine old-meets-new connection would flash for one night and be
// gone before Douglas ever saw it. Growth is bounded by CROSS_ENTITY_MAX_INSIGHTS.
const CROSS_ENTITY_MAX_INSIGHTS = 120;
// The synthesis output is quality-led rather than quota-led. An 8k ceiling
// accommodates evidence-cited JSON on the larger post-import graph, while
// remaining far below an unbounded long-form reasoning response.
const CROSS_ENTITY_MAX_TOKENS = 8000;
const CROSS_ENTITY_EVIDENCE_CONTRACT = `

Output contract (mandatory): Every insight must include evidence_atom_ids with
the exact atom IDs supplied in the input. Never invent IDs. Patterns and gaps
need at least 3 cited IDs; workflows and connections need at least 2, and a
connection must cite atoms from at least two different entities. Return only
insights that materially change what Douglas should do or think. Do not fill a
quota or split one underlying conclusion into several insights. This is a
bounded synthesis result, not a prose report.`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatAtomsForSynthesis(atoms) {
  return atoms
    .map(a => `[atom:${a.id}] [${a.subject_kind}:${a.subject_label}] ${a.predicate}: ${a.value}`)
    .join('\n');
}

function parseModelJson(raw, defaults) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start < 0 || end <= start) return defaults;
  try { return { ...defaults, ...JSON.parse(text.slice(start, end + 1)) }; } catch { return defaults; }
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function normaliseCrossEntityInsights(rawInsights, atoms) {
  if (!Array.isArray(rawInsights)) return [];

  const atomById = new Map(atoms.map(atom => [String(atom.id), atom]));
  const accepted = [];

  for (const raw of rawInsights) {
    const type = String(raw?.type || '').trim().toLowerCase();
    const title = String(raw?.title || '').trim().slice(0, 200);
    const detail = String(raw?.detail || '').trim().slice(0, 1000);
    const evidenceAtomIds = [...new Set((Array.isArray(raw?.evidence_atom_ids)
      ? raw.evidence_atom_ids : []).map(id => String(id).trim()).filter(Boolean))]
      .filter(id => atomById.has(id));

    if (!['pattern', 'workflow', 'connection', 'gap'].includes(type) || !title || !detail) continue;
    if (evidenceAtomIds.length < (type === 'connection' || type === 'workflow' ? 2 : 3)) continue;

    const evidenceAtoms = evidenceAtomIds.map(id => atomById.get(id));
    const entityCount = new Set(evidenceAtoms.map(atom => `${atom.subject_kind}:${atom.subject_label}`)).size;
    if (type === 'connection' && entityCount < 2) continue;

    accepted.push({
      type,
      title,
      detail,
      entities: Array.isArray(raw.entities)
        ? [...new Set(raw.entities.map(entity => String(entity).trim()).filter(Boolean))].slice(0, 20)
        : [],
      evidenceAtomIds,
      confidence: Math.min(0.99, Math.max(0.3, Number(raw.confidence) || 0.7)),
    });
  }
  return accepted;
}

// The stable identity of a connection is its type plus the exact set of atoms
// it cites. Two runs that rediscover the same link over the same atoms collapse
// to one row (refreshed); a link over different atoms is a different insight.
function insightIdentity(type, evidenceAtomIds) {
  return `${type}|${[...evidenceAtomIds].sort().join(',')}`;
}

function insightEvidenceAtomIds(sourceRefs) {
  try {
    const refs = JSON.parse(sourceRefs || '[]');
    return Array.isArray(refs)
      ? refs.filter(r => r && r.kind === 'knowledge_atom' && r.id).map(r => String(r.id))
      : [];
  } catch (_) { return []; }
}

// Merge newly-derived insights into the standing set instead of rebuilding it
// nightly. A prior insight is retired only when this run supersedes it (same
// identity) or when its evidence atoms are no longer active — never merely
// because a later run's seed did not happen to resurface it. Total active
// insights are bounded; the lowest-confidence, oldest ones are evicted first.
function mergeCrossEntityInsights(user, insights) {
  const hub = db.hub();
  const ts = now();
  const activeAtomIds = new Set(
    hub.prepare(`SELECT id FROM knowledge_atoms WHERE user = ? AND status = 'active'`).all(user).map(r => r.id)
  );

  const prior = hub.prepare(`
    SELECT id, subject_label AS title, predicate AS type, value AS detail,
           source_refs, confidence, first_seen
      FROM knowledge_atoms
     WHERE user = ? AND subject_kind = ? AND status = 'active'
  `).all(user, INSIGHT_KIND).map(row => ({
    ...row,
    evidenceAtomIds: insightEvidenceAtomIds(row.source_refs),
  }));

  const incoming = new Map();
  for (const insight of insights) {
    incoming.set(insightIdentity(insight.type, insight.evidenceAtomIds), insight);
  }

  const insert = hub.prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?,?)
  `);
  const del = hub.prepare(`DELETE FROM knowledge_atoms WHERE id = ? AND user = ?`);

  let written = 0;
  let retired = 0;
  let kept = 0;

  hub.transaction(() => {
    // Retire a prior insight when a fresh version supersedes it, or when its
    // evidence no longer stands. Otherwise keep it — accumulation, not churn.
    for (const row of prior) {
      const identity = insightIdentity(row.type, row.evidenceAtomIds);
      const evidenceStillActive = row.evidenceAtomIds.length > 0
        && row.evidenceAtomIds.every(id => activeAtomIds.has(id));
      if (incoming.has(identity) || !evidenceStillActive) {
        del.run(row.id, user);
        retired += 1;
      } else {
        kept += 1;
      }
    }
    for (const insight of incoming.values()) {
      insert.run(
        uuid(), user, INSIGHT_KIND,
        insight.title,
        insight.type,
        insight.detail,
        JSON.stringify(insight.evidenceAtomIds.map(id => ({ kind: 'knowledge_atom', id }))),
        insight.confidence,
        'active', 'cross_entity_synthesis', ts, ts, ts
      );
      written += 1;
    }

    // Bound total standing insights: evict lowest-confidence, then oldest.
    const total = hub.prepare(
      `SELECT count(*) AS n FROM knowledge_atoms WHERE user = ? AND subject_kind = ? AND status = 'active'`
    ).get(user, INSIGHT_KIND).n;
    if (total > CROSS_ENTITY_MAX_INSIGHTS) {
      const evict = hub.prepare(`
        DELETE FROM knowledge_atoms WHERE id IN (
          SELECT id FROM knowledge_atoms
           WHERE user = ? AND subject_kind = ? AND status = 'active'
           ORDER BY confidence ASC, first_seen ASC
           LIMIT ?
        )
      `);
      evict.run(user, INSIGHT_KIND, total - CROSS_ENTITY_MAX_INSIGHTS);
    }
  })();
  return { written, retired, kept };
}

function tableExists(hub, name) {
  return Boolean(hub.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

// ── Cross-entity synthesis ─────────────────────────────────────────────────────

const ATOM_SELECT_COLS = 'id, subject_kind, subject_label, predicate, value, confidence';

function loadAtomsByIds(user, ids) {
  if (!ids.length) return [];
  const hub = db.hub();
  const placeholders = ids.map(() => '?').join(',');
  return hub.prepare(
    `SELECT ${ATOM_SELECT_COLS} FROM knowledge_atoms
      WHERE user = ? AND status = 'active' AND subject_kind NOT IN (?, ?)
        AND id IN (${placeholders})`
  ).all(user, INSIGHT_KIND, THREAD_KIND, ...ids);
}

// Build the bounded evidence packet. The seed is the newest changed atoms —
// this stays change-driven. The rest of the same fixed budget is filled by
// semantic retrieval across the WHOLE corpus, so a new atom can be synthesised
// against an old one it resembles. Retrieval is fail-open: if embeddings are
// unavailable the packet degrades to newest-first (the prior behaviour), never
// throwing and never blocking the nightly run.
async function gatherCrossEntityEvidence(user) {
  const hub = db.hub();
  const seed = hub.prepare(`
    SELECT ${ATOM_SELECT_COLS}
      FROM knowledge_atoms
     WHERE user = ? AND status = 'active' AND subject_kind NOT IN (?, ?)
     ORDER BY last_confirmed DESC, confidence DESC
     LIMIT ?
  `).all(user, INSIGHT_KIND, THREAD_KIND, CROSS_ENTITY_SEED_ATOMS);

  const packet = new Map(seed.map(atom => [String(atom.id), atom]));

  try {
    const { semanticSearch } = require('./retrieval');
    for (const anchor of seed.slice(0, CROSS_ENTITY_SEED_QUERY_SAMPLE)) {
      if (packet.size >= CROSS_ENTITY_PACKET_MAX) break;
      const query = `${anchor.subject_label} ${anchor.predicate} ${anchor.value}`;
      const hits = await semanticSearch(user, query, CROSS_ENTITY_RELATED_PER_SEED, {
        sourceKinds: ['atom'],
        minScore: CROSS_ENTITY_RELATED_MIN_SCORE,
      });
      const relatedIds = hits.map(h => String(h.source_id)).filter(id => !packet.has(id));
      for (const atom of loadAtomsByIds(user, relatedIds)) {
        if (packet.size >= CROSS_ENTITY_PACKET_MAX) break;
        packet.set(String(atom.id), atom);
      }
    }
  } catch (err) {
    console.warn('[knowledge-synthesis] related-atom retrieval skipped:', err.message);
  }

  // Backfill any unused budget with the next-newest atoms so the packet is
  // never smaller than it was before, even when retrieval found little.
  if (packet.size < CROSS_ENTITY_PACKET_MAX) {
    const more = hub.prepare(`
      SELECT ${ATOM_SELECT_COLS}
        FROM knowledge_atoms
       WHERE user = ? AND status = 'active' AND subject_kind NOT IN (?, ?)
       ORDER BY last_confirmed DESC, confidence DESC
       LIMIT ?
    `).all(user, INSIGHT_KIND, THREAD_KIND, CROSS_ENTITY_PACKET_MAX);
    for (const atom of more) {
      if (packet.size >= CROSS_ENTITY_PACKET_MAX) break;
      packet.set(String(atom.id), atom);
    }
  }

  return [...packet.values()];
}

async function runCrossEntitySynthesis(user) {
  const hub = db.hub();

  const atoms = await gatherCrossEntityEvidence(user);

  if (atoms.length < 5) {
    console.log('[knowledge-synthesis] skipped — fewer than 5 atoms');
    return { atomsRead: atoms.length, insights: 0, reason: 'insufficient_atoms' };
  }

  // Change-driven, retrieval-bounded: a fixed budget spent on newest atoms plus
  // their whole-corpus semantic neighbours — never a full-table dump.
  const atomText = formatAtomsForSynthesis(atoms);
  const systemPrompt = `${getSystemPrompt('cross_entity_synthesis', 'system', PROMPTS.cross_entity_synthesis)}${CROSS_ENTITY_EVIDENCE_CONTRACT}`;
  const started  = Date.now();

  // Production VPS: prepare bounded evidence; Mac worker runs Claude Sonnet.
  // Never Luna atomisation and never a full-table dump (cap is LIMIT 80 above).
  if (require('./subscription-agent-jobs').enabled()) {
    const evidenceCount = atoms.length;
    const inputChars = systemPrompt.length + atomText.length;
    const queued = require('./subscription-agent-jobs').enqueue({
      feature: 'cross_entity_synthesis',
      dedupeKey: `${user}:${require('crypto').createHash('sha256').update(atomText).digest('hex').slice(0, 16)}`,
      payload: {
        user,
        // Ids only for apply-side re-load; packet text is the bounded evidence.
        atomIds: atoms.map(a => a.id),
        systemPrompt,
        userPrompt: atomText,
        mode: 'apply',
        runner: 'claude',
        model: 'sonnet',
        effort: 'high',
        tier: 'sonnet',
        maxEvidenceRecords: evidenceCount,
        evidenceCount,
        inputChars,
        maxInputChars: 100000,
      },
    });
    return {
      atomsRead: evidenceCount,
      insights: 0,
      execution: 'subscription_remote',
      runner: 'claude',
      model: 'sonnet',
      effort: 'high',
      evidenceCount,
      inputChars,
      ...queued,
    };
  }

  try {
    const local = await runSubscriptionText({
      feature: 'cross_entity_synthesis',
      systemPrompt,
      userPrompt: atomText,
      timeoutMs: 300000,
      force: true,
    });
    if (!local) throw new Error('no local Sonnet/CLI runner available for cross_entity_synthesis');
    const parsed = parseJsonObject(local.text);
    if (!parsed || !Array.isArray(parsed.insights)) {
      console.warn('[knowledge-synthesis] retained prior insights — invalid subscription JSON');
      return { atomsRead: atoms.length, insights: 0, retained: true, reason: 'invalid_model_output', durationMs: Date.now() - started };
    }
    const insights = normaliseCrossEntityInsights(parsed.insights, atoms);
    if (!insights.length) {
      console.warn('[knowledge-synthesis] retained prior insights — no sufficiently evidenced insights');
      return { atomsRead: atoms.length, insights: 0, retained: true, reason: 'no_valid_insights' };
    }
    const result = mergeCrossEntityInsights(user, insights);
    console.log(`[knowledge-synthesis] ${atoms.length} atoms -> ${result.written} new / ${result.kept} kept / ${result.retired} retired insights (${local.runner}/${local.model}/${local.effort})`);
    return { atomsRead: atoms.length, insights: result.written, kept: result.kept, retired: result.retired, execution: 'subscription', runner: local.runner, model: local.model, effort: local.effort };
  } catch (err) {
    // Fail closed — never fall back to OpenRouter or empty out prior good synthesis.
    console.warn(`[knowledge-synthesis] subscription runner failed; retaining prior insights: ${err.message}`);
    return { atomsRead: atoms.length, insights: 0, retained: true, reason: 'runner_failed', error: err.message };
  }
}

function completeRemoteCrossEntitySynthesis(payload, output) {
  const user = String(payload?.user || '');
  let atoms = Array.isArray(payload?.atoms) ? payload.atoms : [];
  if (!atoms.length && Array.isArray(payload?.atomIds) && payload.atomIds.length) {
    const hub = db.hub();
    const placeholders = payload.atomIds.map(() => '?').join(',');
    atoms = hub.prepare(
      `SELECT id, subject_kind, subject_label, predicate, value, confidence FROM knowledge_atoms WHERE user = ? AND id IN (${placeholders})`,
    ).all(user, ...payload.atomIds.slice(0, CROSS_ENTITY_PACKET_MAX));
  }
  const parsed = parseJsonObject(output);
  if (!user || !parsed || !Array.isArray(parsed.insights)) throw new Error('remote Sonnet response was not valid insight JSON');
  const insights = normaliseCrossEntityInsights(parsed.insights, atoms);
  if (!insights.length) {
    // The prompt deliberately permits zero insights. Keep the last compiled
    // set rather than treating an evidence-disciplined empty answer as failure.
    return { atomsRead: atoms.length, insights: 0, retained: true, reason: 'no_valid_insights', execution: 'subscription_remote', runner: 'claude', model: 'sonnet', effort: 'high' };
  }
  const result = mergeCrossEntityInsights(user, insights);
  return { atomsRead: atoms.length, insights: result.written, kept: result.kept, retired: result.retired, execution: 'subscription_remote', runner: 'claude', model: 'sonnet', effort: 'high' };
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

// ── Live-thread synthesis ─────────────────────────────────────────────────────

function gatherLiveThreadSignals(user, { daysBack = 45, limit = 450 } = {}) {
  const hub = db.hub();
  const since = now() - daysBack * 86400;
  const signals = [];

  const push = (kind, sourceId, title, text, extra = {}) => {
    const cleanTitle = String(title || '').trim();
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!sourceId || (!cleanTitle && !cleanText)) return;
    signals.push({
      id: `${kind}:${sourceId}`,
      kind,
      source_id: String(sourceId),
      title: cleanTitle || cleanText.slice(0, 80),
      text: cleanText.slice(0, 700),
      ...extra,
    });
  };

  if (tableExists(hub, 'knowledge_atoms')) {
    const rows = hub.prepare(`
      SELECT id, subject_kind, subject_label, predicate, value, confidence, updated_at
      FROM knowledge_atoms
      WHERE user = ?
        AND status = 'active'
        AND subject_kind NOT IN (?, ?)
      ORDER BY COALESCE(updated_at, last_confirmed, first_seen, 0) DESC, confidence DESC
      LIMIT 180
    `).all(user, INSIGHT_KIND, THREAD_KIND);
    for (const row of rows) {
      push(
        'atom',
        row.id,
        `${row.subject_label} / ${row.predicate}`,
        `[${row.subject_kind}:${row.subject_label}] ${row.predicate}: ${row.value}`,
        { occurred_at: row.updated_at || null, confidence: row.confidence }
      );
    }
  }

  if (tableExists(hub, 'email_summaries')) {
    const rows = hub.prepare(`
      SELECT id, subject, from_name, from_email, summary, project_slug, received_at
      FROM email_summaries
      WHERE user = ?
        AND received_at >= ?
        AND (project_slug IS NULL OR project_slug NOT IN ('__system','__skip'))
      ORDER BY received_at DESC
      LIMIT 80
    `).all(user, since);
    for (const row of rows) {
      push(
        'email_summary',
        row.id,
        row.subject,
        `${row.from_name || row.from_email || 'Email'}: ${row.subject || ''}. ${row.summary || ''}${row.project_slug ? ` Project: ${row.project_slug}.` : ''}`,
        { occurred_at: row.received_at || null, source_label: row.from_name || row.from_email || '' }
      );
    }
  }

  if (tableExists(hub, 'meeting_intakes')) {
    const rows = hub.prepare(`
      SELECT id, title, summary, project_slug, created_at
      FROM meeting_intakes
      WHERE user = ? AND status = 'processed' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 60
    `).all(user, since);
    for (const row of rows) {
      push(
        'meeting_intake',
        row.id,
        row.title,
        `${row.title || 'Meeting'}${row.project_slug ? ` (${row.project_slug})` : ''}: ${row.summary || ''}`,
        { occurred_at: row.created_at || null, source_label: row.project_slug || '' }
      );
    }
  }

  if (tableExists(hub, 'intel_items')) {
    const rows = hub.prepare(`
      SELECT id, title, summary, category, source_url, published_at
      FROM intel_items
      WHERE user = ? AND selected = 1 AND COALESCE(published_at, created_at, 0) >= ?
      ORDER BY COALESCE(published_at, created_at, 0) DESC
      LIMIT 80
    `).all(user, since);
    for (const row of rows) {
      push(
        'intel_item',
        row.id,
        row.title,
        `${row.category || 'Intelligence'}: ${row.title || ''}. ${row.summary || ''}`,
        { occurred_at: row.published_at || null, source_label: row.category || '', url: row.source_url || '' }
      );
    }
  }

  if (tableExists(hub, 'rss_articles')) {
    const rows = hub.prepare(`
      SELECT id, title, url, creator_slug, published_at
      FROM rss_articles
      WHERE user = ? AND COALESCE(published_at, 0) >= ?
      ORDER BY published_at DESC
      LIMIT 60
    `).all(user, since);
    for (const row of rows) {
      push(
        'rss_article',
        row.id,
        row.title,
        `${row.creator_slug || 'RSS'}: ${row.title || ''}`,
        { occurred_at: row.published_at || null, source_label: row.creator_slug || '', url: row.url || '' }
      );
    }
  }

  if (tableExists(hub, 'opportunity_signals')) {
    const rows = hub.prepare(`
      SELECT id, signal_type, title, summary, actor, geography, currency, valid_until, observed_at
      FROM opportunity_signals
      WHERE user = ? AND status = 'active'
      ORDER BY observed_at DESC
      LIMIT 40
    `).all(user);
    for (const row of rows) {
      push(
        'opportunity_signal',
        row.id,
        row.title,
        `${row.signal_type || 'opportunity'}: ${row.title || ''}. ${row.summary || ''}${row.actor ? ` Actor: ${row.actor}.` : ''}${row.geography ? ` Geography: ${row.geography}.` : ''}${row.currency ? ` Currency: ${row.currency}.` : ''}${row.valid_until ? ` Valid until: ${row.valid_until}.` : ''}`,
        { occurred_at: row.observed_at || null }
      );
    }
  }

  signals.sort((a, b) => (b.occurred_at || 0) - (a.occurred_at || 0));
  return signals.slice(0, limit);
}

function formatLiveThreadSignals(signals) {
  return signals.map(signal => [
    `[${signal.id}] ${signal.kind}${signal.source_label ? ` / ${signal.source_label}` : ''}`,
    `Title: ${signal.title}`,
    `Text: ${signal.text}`,
  ].join('\n')).join('\n\n');
}

function normaliseLiveThreads(rawThreads, signalById) {
  const raw = Array.isArray(rawThreads) ? rawThreads : [];
  const threads = [];
  for (const thread of raw) {
    const evidenceIds = Array.isArray(thread.evidence_ids)
      ? [...new Set(thread.evidence_ids.map(id => String(id || '').trim()).filter(id => signalById.has(id)))]
      : [];
    const sourceKinds = new Set(evidenceIds.map(id => signalById.get(id).kind));
    const confidence = Number(thread.confidence);
    if (evidenceIds.length < 2 || sourceKinds.size < 2) continue;
    if (!Number.isFinite(confidence) || confidence < 0.55) continue;
    const title = String(thread.title || '').trim();
    const detail = String(thread.detail || '').trim();
    if (!title || !detail) continue;
    threads.push({
      type: String(thread.type || 'theme').trim().slice(0, 80) || 'theme',
      title: title.slice(0, 200),
      detail: detail.slice(0, 1200),
      evidence_ids: evidenceIds.slice(0, 8),
      why_now: String(thread.why_now || '').trim().slice(0, 500),
      suggested_surface: String(thread.suggested_surface || '').trim().slice(0, 120),
      confidence,
    });
  }
  return threads.slice(0, 12);
}

function sourceRefsForEvidenceIds(evidenceIds, signalById) {
  const refs = [];
  const seen = new Set();
  for (const evidenceId of evidenceIds || []) {
    const signal = signalById.get(evidenceId);
    if (!signal) continue;
    const key = `${signal.kind}:${signal.source_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: signal.kind, id: signal.source_id });
  }
  return refs;
}

function writeLiveThreadAtoms(user, threads, signals) {
  const hub = db.hub();
  const signalById = new Map((signals || []).map(signal => [signal.id, signal]));
  const normalised = normaliseLiveThreads(threads, signalById);
  const ts = now();
  hub.prepare(`
    DELETE FROM knowledge_atoms
    WHERE user = ? AND subject_kind = ? AND derived_by = ?
  `).run(user, THREAD_KIND, LIVE_THREAD_DERIVER);

  const insert = hub.prepare(`
    INSERT INTO knowledge_atoms
      (id, user, subject_kind, subject_id, subject_label, predicate, value,
       source_refs, confidence, status, derived_by, first_seen, last_confirmed, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let written = 0;
  for (const thread of normalised) {
    const refs = sourceRefsForEvidenceIds(thread.evidence_ids, signalById);
    if (refs.length < 2) continue;
    const value = [
      thread.detail,
      thread.why_now ? `Why now: ${thread.why_now}` : '',
      thread.suggested_surface ? `Surface: ${thread.suggested_surface}` : '',
    ].filter(Boolean).join('\n');
    insert.run(
      uuid(),
      user,
      THREAD_KIND,
      null,
      thread.title,
      thread.type || 'theme',
      value,
      JSON.stringify(refs),
      Math.min(0.99, Math.max(0.3, thread.confidence)),
      'active',
      LIVE_THREAD_DERIVER,
      ts,
      ts,
      ts
    );
    written++;
  }
  return { written, accepted: normalised.length };
}

async function runLiveThreadSynthesis(user) {
  const signals = gatherLiveThreadSignals(user);
  if (signals.length < 6) {
    console.log('[live-thread-synthesis] skipped — fewer than 6 signals');
    return { signalsRead: signals.length, threads: 0, reason: 'insufficient_signals' };
  }

  const modelId = getSystemModelId('live_thread_synthesis', 'system', 'anthropic/claude-haiku-4-5');
  const started = Date.now();
  const resp = await fetch('hub-model://v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.KNOWLEDGE_SYNTHESIS),
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: getSystemPrompt('live_thread_synthesis', 'system', PROMPTS.live_thread_synthesis) },
        { role: 'user', content: formatLiveThreadSignals(signals).slice(0, 22000) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.25,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}`);
  const data = await resp.json();
  logUsageFromResponse({
    user, feature: 'live-thread-synthesis', modelKey: 'live_thread_synthesis',
    fallbackModelId: modelId, data, durationMs: Date.now() - started, taskCode: TASK_CODES.KNOWLEDGE_SYNTHESIS,
  });

  const parsed = parseModelJson(data.choices?.[0]?.message?.content, { threads: [] });
  const result = writeLiveThreadAtoms(user, parsed.threads || [], signals);
  console.log(`[live-thread-synthesis] ${signals.length} signals → ${result.written} threads`);
  return { signalsRead: signals.length, threads: result.written };
}

function getLiveThreadAtoms(user, { limit = 12 } = {}) {
  return db.hub().prepare(`
    SELECT * FROM knowledge_atoms
    WHERE user = ? AND subject_kind = ? AND status = 'active'
    ORDER BY confidence DESC, updated_at DESC
    LIMIT ?
  `).all(user, THREAD_KIND, limit);
}

// SQL LIKE search — always works even when the embeddings index is empty.
// Stale atoms stay findable here (knowledge never disappears from queries);
// they just rank below anything still active.
function textSearchAtoms(user, query, limit = 40) {
  const hub   = db.hub();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(t => t.length > 2).slice(0, 6);
  if (!terms.length) return [];
  const cond   = terms.map(() => `(lower(subject_label) LIKE ? OR lower(predicate) LIKE ? OR lower(value) LIKE ?)`).join(' OR ');
  const params = [user, ...terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`])];
  return hub.prepare(
    `SELECT * FROM knowledge_atoms WHERE user = ? AND status IN ('active','stale') AND (${cond})
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, confidence DESC LIMIT ${limit}`
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
        const a = hub.prepare(`SELECT * FROM knowledge_atoms WHERE id = ? AND status IN ('active','stale')`).get(h.source_id);
        if (a && !seenAtomIds.has(a.id)) { semanticAtoms.push({ ...a, _score: h.score }); seenAtomIds.add(a.id); }
      } else {
        semanticAtoms.push({ _chunk: h.chunk_text, _kind: h.source_kind, _score: h.score });
      }
    }
  } catch (_) {}

  // 3. Insight atoms (always included — these are cross-entity patterns)
  const insights = getInsightAtoms(user);
  const liveThreads = getLiveThreadAtoms(user, { limit: 12 });

  // 4. Build evidence text
  const fmtAtom = a => `[${a.subject_kind || 'unknown'}:${a.subject_label || ''}] ${a.predicate}: ${a.value}${a.status === 'stale' ? ' (stale — not confirmed by any source in over a year; may be outdated)' : ''}`;
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
  if (liveThreads.length) sections.push('LIVE THREADS\n' + liveThreads.map(a => `[thread] ${a.subject_label} (${a.predicate}): ${a.value}`).join('\n'));

  if (!sections.length) {
    return {
      answer: 'No relevant knowledge was found for that question. Try running the knowledge synthesis job to build cross-entity insights, or ingest more source material.',
      atomsUsed: 0, semanticHits: 0, insightsUsed: 0,
    };
  }

  const evidenceText = [`Question: ${query}`, '', ...sections].join('\n\n').slice(0, 18000);

  const modelId = getSystemModelId('knowledge_query', 'system', 'anthropic/claude-haiku-4-5');
  const started = Date.now();

  const resp = await fetch('hub-model://v1/chat/completions', {
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
    liveThreadsUsed: liveThreads.length,
  };
}

module.exports = {
  CROSS_ENTITY_MAX_TOKENS,
  CROSS_ENTITY_PACKET_MAX,
  CROSS_ENTITY_SEED_ATOMS,
  CROSS_ENTITY_MAX_INSIGHTS,
  runCrossEntitySynthesis,
  completeRemoteCrossEntitySynthesis,
  normaliseCrossEntityInsights,
  mergeCrossEntityInsights,
  gatherCrossEntityEvidence,
  runLiveThreadSynthesis,
  gatherLiveThreadSignals,
  writeLiveThreadAtoms,
  getInsightAtoms,
  getLiveThreadAtoms,
  textSearchAtoms,
  answerKnowledgeQuery,
};
