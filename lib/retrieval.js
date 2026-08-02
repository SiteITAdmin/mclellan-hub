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
const { listSourceEvidence, resolveSourceEvidence, hash } = require('./source-evidence');

const EMBED_FALLBACK = 'openai/text-embedding-3-small';
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

// Indexed = has chunks AND (when a model is given) they were made with that model.
// Passing the current model means a model change is treated as not-indexed, so
// backfill re-embeds the source (indexSource replaces its chunks). The corpus
// migrates to the new model over successive passes; semanticSearch's same-dim
// filter keeps results clean during the migration.
function isIndexed(sourceKind, sourceId, model = null, sourceRevision = null) {
  const row = db.hub().prepare(
    'SELECT model, source_revision FROM embeddings WHERE source_kind = ? AND source_id = ? LIMIT 1'
  ).get(sourceKind, sourceId);
  if (!row) return false;
  if (model && row.model && row.model !== model) return false;
  if (sourceRevision && row.source_revision !== sourceRevision) return false;
  return true;
}

function removeSource(sourceKind, sourceId) {
  db.hub().prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
}

// Embed + (re)store all chunks for one source. Idempotent: replaces prior chunks.
async function indexSource(user, sourceKind, sourceId, text = null) {
  const hub = db.hub();
  // Raw source kinds are always resolved through the canonical evidence
  // boundary.  A caller-provided string remains supported for compiled atoms
  // and maintenance callers, but never replaces a faithfully stored email.
  const evidence = text && typeof text === 'object' && Array.isArray(text.chunks)
    ? text
    : sourceKind !== 'atom'
      ? resolveSourceEvidence(user, sourceKind, sourceId)
      : null;
  const chunks = evidence?.chunks || chunkText(text);
  const sourceRevision = evidence?.revision_hash || hash(`${sourceKind}:${sourceId}:${String(text || '')}`);
  hub.prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
  if (!chunks.length) return 0;

  const model = embedModelId();
  const vectors = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const vs = await embed(chunks.slice(i, i + EMBED_BATCH)
      .map(chunk => typeof chunk === 'string' ? chunk : chunk.text));
    vectors.push(...vs);
  }

  const insert = hub.prepare(`
    INSERT INTO embeddings (id, user, source_kind, source_id, chunk_index, chunk_text, vector, model, dim, source_revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
  `);
  const tx = hub.transaction(() => {
    chunks.forEach((chunk, idx) => {
      const v = vectors[idx];
      if (!v) return;
      const chunkTextValue = typeof chunk === 'string' ? chunk : chunk.text;
      const chunkIndex = typeof chunk === 'string' ? idx : chunk.index;
      insert.run(uuid(), user, sourceKind, sourceId, chunkIndex, chunkTextValue, JSON.stringify(v), model, v.length, sourceRevision);
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

const BACKFILL_COMPILED_SOURCES = [
  { kind: 'atom', sql: "SELECT id, (subject_label || ' ' || predicate || ' ' || value) AS text FROM knowledge_atoms WHERE user = ? AND status = 'active' ORDER BY first_seen ASC, id ASC" },
];

// Index sources that have no embeddings yet, up to `limit` sources per call.
// Returns { processed, indexedChunks, remaining }; remaining>0 means call again.
async function backfillEmbeddings(user, { limit = 50 } = {}) {
  const hub = db.hub();
  const model = embedModelId();
  let processed = 0, indexedChunks = 0, remaining = 0;
  // Canonical source evidence is oldest-first and contains the full stored
  // body/transcript/document.  There is no fixed newest-N window and no email
  // summary fallback here.
  for (const evidence of listSourceEvidence(user)) {
    if (!evidence.complete || !evidence.chunks.length) {
      remaining++;
      continue;
    }
    if (isIndexed(evidence.source_kind, evidence.source_id, model, evidence.revision_hash)) continue;
    if (processed >= limit) { remaining++; continue; }
    try {
      indexedChunks += await indexSource(user, evidence.source_kind, evidence.source_id, evidence);
      processed++;
    } catch (err) {
      console.warn(`[retrieval] backfill ${evidence.source_kind} ${evidence.source_id}:`, err.message);
    }
  }
  for (const src of BACKFILL_COMPILED_SOURCES) {
    const rows = hub.prepare(src.sql).all(user);
    for (const row of rows) {
      if (!row.text || !row.text.trim()) continue;
      if (isIndexed(src.kind, row.id, model)) continue;
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
