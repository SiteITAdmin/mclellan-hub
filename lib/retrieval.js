'use strict';

/**
 * Knowledge layer — L3 retrieval.
 *
 * Embeds raw/derived sources into the `embeddings` table and answers semantic
 * queries over them. This is what lets a query like "dad's medicine" reach
 * Alister McLellan without the word "Alister" appearing anywhere in the query.
 *
 * All model calls go through OpenRouter; the embedding model is a system slot
 * ('embeddings') controllable in the admin models tool. Query and corpus must
 * share one model — vectors of different dimension are never compared.
 */

const db = require('./db');
const { uuid } = require('./id');
const { getSystemModelId } = require('./settings');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');

const EMBED_FALLBACK = 'openai/text-embedding-3-small';
const MAX_CHUNKS_PER_SOURCE = 30;
const EMBED_BATCH = 96;

function embedModelId() {
  return getSystemModelId('embeddings', 'system', EMBED_FALLBACK);
}

// ── Embedding calls (OpenRouter, OpenAI-compatible) ─────────────────────────────

async function embed(texts, { taskCode = TASK_CODES.EMBEDDINGS } = {}) {
  if (!texts || !texts.length) return [];
  const model = embedModelId();
  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: openRouterHeaders(taskCode),
    body: JSON.stringify({ model, input: texts }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenRouter embeddings ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  logUsageFromResponse({
    user: 'system', feature: 'embeddings', modelKey: 'embeddings',
    fallbackModelId: model, data, durationMs: Date.now() - started, taskCode,
  });
  return (data.data || [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(d => d.embedding);
}

async function embedOne(text) {
  const [v] = await embed([text]);
  return v || null;
}

// ── Chunking ────────────────────────────────────────────────────────────────

function chunkText(text, { maxChars = 1200, overlap = 150 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + maxChars, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const brk = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      if (brk > maxChars * 0.6) end = i + brk + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks.filter(Boolean);
}

// ── Index management ──────────────────────────────────────────────────────────

function isIndexed(sourceKind, sourceId) {
  return !!db.hub().prepare(
    'SELECT 1 FROM embeddings WHERE source_kind = ? AND source_id = ? LIMIT 1'
  ).get(sourceKind, sourceId);
}

function removeSource(sourceKind, sourceId) {
  db.hub().prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
}

// Embed + (re)store all chunks for one source. Idempotent: replaces prior chunks.
async function indexSource(user, sourceKind, sourceId, text) {
  const hub = db.hub();
  const chunks = chunkText(text).slice(0, MAX_CHUNKS_PER_SOURCE);
  hub.prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
  if (!chunks.length) return 0;

  const model = embedModelId();
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const vs = await embed(chunks.slice(i, i + EMBED_BATCH));
    vectors.push(...vs);
  }

  const insert = hub.prepare(`
    INSERT INTO embeddings (id, user, source_kind, source_id, chunk_index, chunk_text, vector, model, dim, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `);
  const tx = hub.transaction(() => {
    chunks.forEach((c, idx) => {
      const v = vectors[idx];
      if (!v) return;
      insert.run(uuid(), user, sourceKind, sourceId, idx, c, JSON.stringify(v), model, v.length);
    });
  });
  tx();
  return chunks.length;
}

// ── Search ────────────────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Returns top-k chunks by cosine similarity. Only compares vectors of the same
// dimension as the query, so a model change never contaminates results.
async function semanticSearch(user, query, k = 8, { sourceKinds = null, minScore = 0 } = {}) {
  const qv = await embedOne(query);
  if (!qv) return [];
  const hub = db.hub();
  let sql = 'SELECT source_kind, source_id, chunk_index, chunk_text, vector FROM embeddings WHERE user = ? AND dim = ?';
  const args = [user, qv.length];
  if (sourceKinds && sourceKinds.length) {
    sql += ` AND source_kind IN (${sourceKinds.map(() => '?').join(',')})`;
    args.push(...sourceKinds);
  }
  const rows = hub.prepare(sql).all(...args);
  const scored = [];
  for (const r of rows) {
    let v;
    try { v = JSON.parse(r.vector); } catch { continue; }
    const score = cosine(qv, v);
    if (score >= minScore) {
      scored.push({ source_kind: r.source_kind, source_id: r.source_id, chunk_index: r.chunk_index, chunk_text: r.chunk_text, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── Backfill ────────────────────────────────────────────────────────────────

// Each entry: a source kind + the SQL that yields { id, text } rows for a user.
const BACKFILL_SOURCES = [
  { kind: 'document',       sql: 'SELECT id, markdown AS text FROM documents WHERE user = ?' },
  { kind: 'email_summary',  sql: "SELECT id, (COALESCE(subject,'') || '. ' || COALESCE(summary,'')) AS text FROM email_summaries WHERE user = ?" },
  { kind: 'crm_fact',       sql: 'SELECT id, fact AS text FROM crm_facts WHERE user = ?' },
  { kind: 'meeting_intake', sql: "SELECT id, (COALESCE(title,'') || '. ' || COALESCE(summary,'') || ' ' || COALESCE(transcript,'')) AS text FROM meeting_intakes WHERE user = ?" },
  { kind: 'atom',           sql: "SELECT id, (subject_label || ' ' || predicate || ' ' || value) AS text FROM knowledge_atoms WHERE user = ? AND status = 'active'" },
];

// Index sources that have no embeddings yet, up to `limit` sources per call.
// Returns { processed, indexedChunks, remaining }; remaining>0 means call again.
async function backfillEmbeddings(user, { limit = 50 } = {}) {
  const hub = db.hub();
  let processed = 0, indexedChunks = 0, remaining = 0;
  for (const src of BACKFILL_SOURCES) {
    const rows = hub.prepare(src.sql).all(user);
    for (const row of rows) {
      if (!row.text || !row.text.trim()) continue;
      if (isIndexed(src.kind, row.id)) continue;
      if (processed >= limit) { remaining++; continue; }
      try {
        indexedChunks += await indexSource(user, src.kind, row.id, row.text);
        processed++;
      } catch (err) {
        console.warn(`[retrieval] backfill ${src.kind} ${row.id}:`, err.message);
      }
    }
  }
  return { processed, indexedChunks, remaining };
}

module.exports = {
  embed, embedOne, chunkText, cosine,
  indexSource, removeSource, isIndexed,
  semanticSearch, backfillEmbeddings,
  embedModelId, EMBED_FALLBACK,
};
