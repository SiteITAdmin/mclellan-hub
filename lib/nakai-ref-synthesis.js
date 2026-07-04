'use strict';

/**
 * Nakai Reference Source Synthesis
 *
 * Pipeline: nakai_ref_sources → fetch → extraction prompt → synthesis prompt
 *           → knowledge_receipt → nakai_ref_atoms
 *
 * The briefing builder reads nakai_ref_atoms instead of hardcoded notes.
 * Bootstrap atoms (is_bootstrap=1) are used until this job upgrades them.
 */

const fetch = require('./fetch');
const db = require('./db');
const { PROMPTS } = require('./prompts');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { openRouterHeaders, TASK_CODES } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { uuid } = require('./id');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TIMEOUT_MS = parseInt(process.env.NAKAI_REF_SYNTHESIS_TIMEOUT_MS || '60000', 10);

// ── Page fetch (mirrors regulatory-monitor strategy) ─────────────────────────

async function fetchPageContent(url) {
  if (process.env.FIRECRAWL_API_KEY) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'] }),
      });
      if (r.ok) {
        const data = await r.json();
        const md = data?.data?.markdown || '';
        if (md.trim()) return { method: 'firecrawl', text: md.slice(0, 12000) };
      }
    } catch (_) {}
  }

  try {
    const r = await fetch(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; McLellan-Hub/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain',
      },
    });
    if (!r.ok) return { method: `http-${r.status}`, text: '' };
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 8000);
    return { method: 'fetch', text };
  } catch (err) {
    return { method: `error:${err.message}`, text: '' };
  }
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function llmCall(systemPrompt, userContent, modelId) {
  const r = await fetch(OR_URL, {
    method: 'POST',
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      ...openRouterHeaders(TASK_CODES.synthesis),
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
  const data = await r.json();
  logUsageFromResponse(data, modelId, TASK_CODES.synthesis);
  return data.choices?.[0]?.message?.content || '';
}

// ── Receipt writer ────────────────────────────────────────────────────────────

function writeReceipt(hub, { stage, sourceKey, status, summary, payload, modelId }) {
  const id = uuid();
  hub.prepare(`
    INSERT INTO knowledge_receipts (id, user, source_kind, source_id, stage, status, summary, payload, model_id)
    VALUES (?, 'nakai', 'nakai_ref_source', ?, ?, ?, ?, ?, ?)
  `).run(id, sourceKey, stage, status, summary, JSON.stringify(payload || {}), modelId || null);
  return id;
}

// ── Single source synthesis ───────────────────────────────────────────────────

async function synthesizeSource(source) {
  const hub = db.hub();
  const extractionModelId = getSystemModelId('nakai_ref_extraction', 'system', 'anthropic/claude-haiku-4-5-20251001');
  const modelId = getSystemModelId('nakai_ref_synthesis', 'system', 'anthropic/claude-haiku-4-5-20251001');
  const now = Math.floor(Date.now() / 1000);

  // 1. Fetch
  const { method, text } = await fetchPageContent(source.url);
  hub.prepare(`UPDATE nakai_ref_sources SET last_fetched_at = ? WHERE id = ?`).run(now, source.id);

  if (!text.trim()) {
    writeReceipt(hub, {
      stage: 'ref_extraction',
      sourceKey: source.source_key,
      status: 'skipped',
      summary: `No content fetched via ${method}`,
      payload: { method },
      modelId: extractionModelId,
    });
    console.log(`[nakai-ref-synthesis] ${source.source_key}: no content (${method})`);
    return null;
  }

  // 2. Extraction prompt
  let extracted = '';
  try {
    extracted = await llmCall(
      getSystemPrompt('nakai_ref_extraction', 'system', PROMPTS.nakai_ref_extraction),
      `Source intent: ${source.intent || 'regulatory reference for audit work'}\nURL: ${source.url}\n\nPage content:\n${text}`,
      extractionModelId,
    );
  } catch (err) {
    writeReceipt(hub, {
      stage: 'ref_extraction',
      sourceKey: source.source_key,
      status: 'error',
      summary: err.message,
      payload: { method },
      modelId: extractionModelId,
    });
    throw err;
  }

  writeReceipt(hub, {
    stage: 'ref_extraction',
    sourceKey: source.source_key,
    status: 'done',
    summary: `Extracted via ${method}`,
    payload: { method, length: text.length },
    modelId: extractionModelId,
  });

  // 3. Synthesis prompt
  let compiled = '';
  try {
    compiled = await llmCall(
      getSystemPrompt('nakai_ref_synthesis', 'system', PROMPTS.nakai_ref_synthesis),
      `Source: ${source.title}\nURL: ${source.url}\nIntent: ${source.intent || ''}\n\nExtracted content:\n${extracted}`,
      modelId,
    );
  } catch (err) {
    writeReceipt(hub, {
      stage: 'ref_synthesis',
      sourceKey: source.source_key,
      status: 'error',
      summary: err.message,
      payload: {},
      modelId,
    });
    throw err;
  }

  const receiptId = writeReceipt(hub, {
    stage: 'ref_synthesis',
    sourceKey: source.source_key,
    status: 'done',
    summary: `Synthesised ${source.source_key}: ${compiled.length} chars`,
    payload: { atomLength: compiled.length },
    modelId,
  });

  // 4. Store atom (replace existing for this source_key)
  const atomId = uuid();
  hub.prepare(`DELETE FROM nakai_ref_atoms WHERE source_key = ?`).run(source.source_key);
  hub.prepare(`
    INSERT INTO nakai_ref_atoms (id, source_key, content, synthesized_at, model_id, receipt_id, is_bootstrap)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(atomId, source.source_key, compiled, now, modelId, receiptId);

  hub.prepare(`UPDATE nakai_ref_sources SET last_synthesized_at = ? WHERE id = ?`).run(now, source.id);

  console.log(`[nakai-ref-synthesis] ${source.source_key}: done (${compiled.length} chars)`);
  return { sourceKey: source.source_key, atomId, chars: compiled.length };
}

// ── Public: synthesize all active sources (or a single one by source_key) ────

async function synthesizeRefSources(options = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const hub = db.hub();

  const sources = options.sourceKey
    ? hub.prepare(`SELECT * FROM nakai_ref_sources WHERE source_key = ? AND active = 1`).all(options.sourceKey)
    : hub.prepare(`SELECT * FROM nakai_ref_sources WHERE active = 1 ORDER BY source_key`).all();

  const results = [];
  for (const source of sources) {
    try {
      const r = await synthesizeSource(source);
      if (r) results.push(r);
    } catch (err) {
      console.error(`[nakai-ref-synthesis] ${source.source_key} failed:`, err.message);
      results.push({ sourceKey: source.source_key, error: err.message });
    }
  }
  return results;
}

// ── Read compiled atoms for briefing builder ──────────────────────────────────

function getRefAtoms() {
  const hub = db.hub();
  // One atom per active source, latest first within each source_key
  return hub.prepare(`
    SELECT s.source_key, s.title, s.url, s.intent, a.content, a.is_bootstrap, a.synthesized_at
    FROM nakai_ref_sources s
    LEFT JOIN nakai_ref_atoms a ON a.source_key = s.source_key
      AND a.id = (
        SELECT id FROM nakai_ref_atoms WHERE source_key = s.source_key
        ORDER BY synthesized_at DESC LIMIT 1
      )
    WHERE s.active = 1
    ORDER BY s.source_key
  `).all();
}

module.exports = { synthesizeRefSources, getRefAtoms };
