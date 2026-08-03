'use strict';

/**
 * Knowledge layer — L3 retrieval.
 *
 * Embeds raw/derived sources into the `embeddings` table and answers semantic
 * queries over them. This is what lets a query like "dad's medicine" reach
 * Alister McLellan without the word "Alister" appearing anywhere in the query.
 *
 * Embeddings use a local model when configured (LOCAL_EMBED_URL / ollama).
 * OpenRouter is retired and is never a fallback. Historical vectors are
 * preserved; new sources use the local model id. Different dimensions are
 * never compared.
 */

const db = require('./db');
const { uuid } = require('./id');
const { getSystemModelId } = require('./settings');
const { TASK_CODES } = require('./openrouter-attribution');
const { logModelUsage } = require('./model-usage');
const { listSourceEvidence, resolveSourceEvidence, hash } = require('./source-evidence');

const EMBED_FALLBACK = 'local/embeddings-unavailable';
// Measured on the Mac's qwen3-embedding: 32 chunks return quickly, 48 takes
// ~32s, 96 takes ~183s. Requests that long let Ollama's model-runner subprocess
// die mid-flight ("...: EOF"), which is what crashed large-document embedding.
// More, shorter requests beat one long one.
const EMBED_BATCH = 32;
const EMBED_UNEMBEDDABLE_MODEL = 'unembeddable';
const EMBED_MAX_REQUEST_CHARS = 800_000;
// A 2M cap excluded a real 2.02MB handbook by 1%, making it permanently
// unsearchable. Chunks are truncated and batched before sending, so a larger
// source costs more passes, not a larger request.
const EMBED_MAX_SOURCE_CHARS = 4_000_000;

function embedModelId() {
  // Prefer explicit LOCAL_EMBED_MODEL so production can pin ollama/qwen3-embedding
  // without rewriting system model slots. Store with ollama/ prefix for provenance.
  if (process.env.LOCAL_EMBED_MODEL) {
    const m = String(process.env.LOCAL_EMBED_MODEL).trim();
    return m.includes('/') ? m : `ollama/${m}`;
  }
  return getSystemModelId('embeddings', 'system', EMBED_FALLBACK);
}

function localEmbedUrl() {
  return process.env.LOCAL_EMBED_URL || process.env.OLLAMA_EMBED_URL || '';
}

function ollamaModelName() {
  const raw = process.env.LOCAL_EMBED_MODEL || 'qwen3-embedding';
  return String(raw).replace(/^ollama\//, '').trim() || 'qwen3-embedding';
}

function vectorsFromOllamaResponse(data) {
  // Modern: { embeddings: [[...], ...] }  Legacy: { embedding: [...] }
  // OpenAI-compat: { data: [{ embedding: [...] }] }
  if (Array.isArray(data?.embeddings) && data.embeddings.length) {
    return data.embeddings.map(v => Array.isArray(v) ? v : null).filter(Boolean);
  }
  if (Array.isArray(data?.embedding)) return [data.embedding];
  if (Array.isArray(data?.data)) {
    return data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(d => d.embedding)
      .filter(Array.isArray);
  }
  return [];
}

// ── Embedding calls (local Ollama only — no OpenRouter) ───────────────────────

async function embed(texts, { taskCode = TASK_CODES.EMBEDDINGS } = {}) {
  if (!texts || !texts.length) return [];
  const modelId = embedModelId();
  const model = ollamaModelName();
  const base = localEmbedUrl().replace(/\/$/, '');
  if (!base) {
    const err = new Error('Local embeddings unavailable: set LOCAL_EMBED_URL (or OLLAMA_EMBED_URL). OpenRouter is retired.');
    err.code = 'EMBEDDINGS_UNAVAILABLE';
    throw err;
  }
  const started = Date.now();
  const inputs = texts.map(t => String(t || '').slice(0, 8000));

  // Prefer modern batch /api/embed; fall back to legacy /api/embeddings one-by-one.
  let vectors = [];
  try {
    const resp = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs.length === 1 ? inputs[0] : inputs }),
    });
    if (resp.ok) {
      vectors = vectorsFromOllamaResponse(await resp.json());
    } else if (resp.status !== 404) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Local embeddings ${resp.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    if (err.code === 'EMBEDDINGS_UNAVAILABLE') throw err;
    if (!String(err.message || '').startsWith('Local embeddings')) {
      // Network / parse — try legacy path below.
    } else {
      throw err;
    }
  }

  if (vectors.length !== inputs.length) {
    vectors = [];
    for (const text of inputs) {
      const resp = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Local embeddings ${resp.status}: ${body.slice(0, 200)}`);
      }
      const batch = vectorsFromOllamaResponse(await resp.json());
      if (!batch[0]) throw new Error('Local embeddings response missing vector');
      vectors.push(batch[0]);
    }
  }

  logModelUsage({
    user: 'system', feature: 'embeddings', modelKey: 'embeddings',
    modelId, endpoint: 'local', durationMs: Date.now() - started, taskCode,
    tokensIn: inputs.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
  });
  return vectors;
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
  // Permanent skip marker — never re-queue for backfill.
  if (row.model === EMBED_UNEMBEDDABLE_MODEL) {
    if (sourceRevision && row.source_revision && row.source_revision !== sourceRevision) return false;
    return true;
  }
  if (model && row.model && row.model !== model) return false;
  if (sourceRevision && row.source_revision !== sourceRevision) return false;
  return true;
}

function removeSource(sourceKind, sourceId) {
  db.hub().prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
}

function markUnembeddable(user, sourceKind, sourceId, sourceRevision, reason) {
  const hub = db.hub();
  hub.prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
  hub.prepare(`
    INSERT INTO embeddings (id, user, source_kind, source_id, chunk_index, chunk_text, vector, model, dim, source_revision, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, '[]', ?, 0, ?, unixepoch())
  `).run(
    uuid(), user, sourceKind, sourceId,
    `[unembeddable] ${String(reason || 'oversized').slice(0, 200)}`,
    EMBED_UNEMBEDDABLE_MODEL,
    sourceRevision || null,
  );
}

// Permanence must be a property of the content, never of the engine's mood.
// Ollama wraps transient runner crashes ("EOF", broken pipe, refused socket) in
// an HTTP 400, so matching the status alone tombstoned twelve healthy sources in
// five hours on 3 Aug 2026 — and a tombstone is never retried, so each one was
// silent permanent loss from semantic search. Match the size wording only, and
// treat anything that smells like transport as retryable.
function isPermanentEmbedFailure(err) {
  const msg = String(err?.message || err || '');
  if (/\bEOF\b|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|fetch failed|network|timed? ?out|connection/i.test(msg)) {
    return false;
  }
  return /maximum request size/i.test(msg)
    || /too large/i.test(msg)
    || /exceeds \S+ (?:context|token|size)/i.test(msg);
}

function chunkRequestBatches(chunks, { maxChars = EMBED_MAX_REQUEST_CHARS, maxItems = EMBED_BATCH } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : chunk.text;
    const len = String(text || '').length;
    if (current.length && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    // A single oversized chunk still travels alone so the permanent-failure
    // path can mark the source unembeddable instead of hanging the batcher.
    current.push(chunk);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
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
  const totalChars = chunks.reduce((sum, chunk) => {
    const value = typeof chunk === 'string' ? chunk : chunk.text;
    return sum + String(value || '').length;
  }, 0);
  if (totalChars > EMBED_MAX_SOURCE_CHARS) {
    markUnembeddable(user, sourceKind, sourceId, sourceRevision, `source exceeds ${EMBED_MAX_SOURCE_CHARS} chars`);
    return 0;
  }
  hub.prepare('DELETE FROM embeddings WHERE source_kind = ? AND source_id = ?')
    .run(sourceKind, sourceId);
  if (!chunks.length) return 0;

  const model = embedModelId();
  const vectors = [];
  try {
    for (const batch of chunkRequestBatches(chunks)) {
      const vs = await embed(batch.map(chunk => typeof chunk === 'string' ? chunk : chunk.text));
      vectors.push(...vs);
    }
  } catch (err) {
    if (isPermanentEmbedFailure(err)) {
      markUnembeddable(user, sourceKind, sourceId, sourceRevision, err.message);
      return 0;
    }
    throw err;
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
  indexSource, removeSource, isIndexed, markUnembeddable,
  semanticSearch, backfillEmbeddings,
  embedModelId, EMBED_FALLBACK, EMBED_UNEMBEDDABLE_MODEL,
};
