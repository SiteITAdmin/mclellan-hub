'use strict';

/**
 * Model-family prompt style profiles.
 *
 * Distils per-family "how to write prompts for this model" profiles from the
 * production system prompts collected in github.com/asgeirtj/system_prompts_leaks.
 * Profiles are compiled knowledge: the monthly style_profile_run job re-reads the
 * repo and re-distils, so nothing here is hand-maintained. Storage is the existing
 * crm_context KV under user 'system' — no new tables.
 */

const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const PROFILE_KEY_PREFIX = 'hub_style_profile_';
const REPO = 'asgeirtj/system_prompts_leaks';

const MODEL_FAMILIES = Object.freeze([
  { key: 'claude', label: 'Claude (Anthropic)' },
  { key: 'gpt',    label: 'GPT / ChatGPT (OpenAI)' },
  { key: 'gemini', label: 'Gemini (Google)' },
  { key: 'grok',   label: 'Grok (xAI)' },
  { key: 'open',   label: 'Open-weights / other (Llama, Mistral, Qwen, DeepSeek)' },
]);

const FAMILY_LABELS = Object.fromEntries(MODEL_FAMILIES.map(f => [f.key, f.label]));

// Evidence selection is dynamic — directories are listed at run time and files
// matched by pattern, largest first, so new model releases in the repo are
// picked up automatically without code changes.
const FAMILY_SOURCES = Object.freeze({
  claude: [
    { dir: 'Anthropic', pattern: /^claude-(fable|opus|sonnet|haiku)-[\d.]+\.md$/i, take: 3 },
    { dir: 'Anthropic/Claude Code', pattern: /^claude-code-[\d.a-z-]+\.md$/i, take: 1 },
  ],
  gpt: [
    { dir: 'OpenAI', pattern: /^(chatgpt-)?gpt-[\d.]+.*\.md$/i, take: 3 },
    { dir: 'OpenAI/Codex', pattern: /codex.*\.md$/i, take: 1 },
  ],
  gemini: [
    { dir: 'Google', pattern: /^gemini-[\d.]+.*\.md$/i, take: 3 },
    { dir: 'Google', pattern: /^gemini-cli\.md$/i, take: 1 },
  ],
  grok: [
    { dir: 'xAI', pattern: /^grok-[\d.]+.*\.md$/i, take: 3 },
  ],
  open: [
    { dir: 'Meta', pattern: /\.md$/i, take: 1 },
    { dir: 'Mistral', pattern: /\.md$/i, take: 1 },
    { dir: 'Qwen', pattern: /\.md$/i, take: 1 },
    { dir: 'Cursor', pattern: /\.md$/i, take: 1 },
  ],
});

const MIN_FILE_BYTES = 2000;
const MAX_CHARS_PER_FILE = 40000;

// Maps an OpenRouter model_id (or model key/label) to a style family.
function familyFromModelId(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (!id) return null;
  if (id.includes('claude') || id.startsWith('anthropic/')) return 'claude';
  if (id.includes('gpt') || id.startsWith('openai/') || /\bo[134][- ]/.test(id) || id.includes('codex')) return 'gpt';
  if (id.includes('gemini') || id.startsWith('google/')) return 'gemini';
  if (id.includes('grok') || id.startsWith('x-ai/')) return 'grok';
  return 'open';
}

function normalizeFamily(value) {
  const key = String(value || '').trim().toLowerCase();
  return FAMILY_LABELS[key] ? key : null;
}

function getStyleProfile(family) {
  const key = normalizeFamily(family);
  if (!key) return null;
  try {
    const row = db.hub().prepare(
      'SELECT value FROM crm_context WHERE user = ? AND key = ?'
    ).get('system', PROFILE_KEY_PREFIX + key);
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && parsed.profile ? parsed : null;
  } catch (_) { return null; }
}

function listStyleProfiles() {
  return MODEL_FAMILIES.map(f => {
    const stored = getStyleProfile(f.key);
    return { key: f.key, label: f.label, ...(stored || {}), present: !!stored };
  });
}

// Injection block appended to the adapter/optimizer/improver system prompt when
// a target family is selected. Empty string when no profile has been distilled yet.
function styleProfileBlock(family) {
  const stored = getStyleProfile(family);
  if (!stored) return '';
  const when = stored.distilled_at
    ? new Date(stored.distilled_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'unknown date';
  return [
    '',
    `TARGET MODEL STYLE PROFILE — ${FAMILY_LABELS[normalizeFamily(family)]}`,
    `(distilled ${when} from production system prompts; follow it when shaping the prompt)`,
    'The prompt you produce will be run on this model family. Match its structure conventions, rule phrasing, formatting idiom, and output-contract style as described below, while keeping every content rule above:',
    '',
    stored.profile,
  ].join('\n');
}

function saveStyleProfile(family, payload) {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, 'system', ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), PROFILE_KEY_PREFIX + normalizeFamily(family), JSON.stringify(payload));
}

async function githubJson(path) {
  const url = `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'mclellan-hub', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub API ${r.status} for ${path}`);
  return r.json();
}

async function selectEvidenceFiles(family) {
  const picked = [];
  for (const source of FAMILY_SOURCES[family] || []) {
    let entries;
    try {
      entries = await githubJson(source.dir);
    } catch (err) {
      console.error(`[style-profiles] listing failed for ${source.dir}: ${err.message}`);
      continue;
    }
    const matches = (Array.isArray(entries) ? entries : [])
      .filter(e => e.type === 'file' && (e.size || 0) >= MIN_FILE_BYTES && source.pattern.test(e.name))
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .slice(0, source.take);
    for (const m of matches) {
      if (!picked.some(p => p.path === `${source.dir}/${m.name}`)) {
        picked.push({ path: `${source.dir}/${m.name}`, size: m.size, download_url: m.download_url });
      }
    }
  }
  return picked;
}

async function fetchEvidence(files) {
  const out = [];
  for (const f of files) {
    try {
      const r = await fetch(f.download_url, { headers: { 'User-Agent': 'mclellan-hub' } });
      if (!r.ok) { console.error(`[style-profiles] fetch ${f.path} → ${r.status}`); continue; }
      const text = (await r.text()).slice(0, MAX_CHARS_PER_FILE);
      if (text.trim().length >= 500) out.push({ ...f, text });
    } catch (err) {
      console.error(`[style-profiles] fetch ${f.path} failed: ${err.message}`);
    }
  }
  return out;
}

function writeReceipt({ family, status, summary, payload, modelId }) {
  try {
    db.hub().prepare(`
      INSERT INTO knowledge_receipts (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id)
      VALUES (?, 'system', 'style_profile', ?, 'distil', ?, ?, ?, 'style_distiller', ?)
    `).run(uuid(), family, status, summary, JSON.stringify(payload || {}), modelId || null);
  } catch (err) {
    console.error(`[style-profiles] receipt write failed: ${err.message}`);
  }
}

async function distilFamily(family) {
  const files = await selectEvidenceFiles(family);
  if (!files.length) throw new Error(`no evidence files matched for ${family}`);
  const evidence = await fetchEvidence(files);
  if (!evidence.length) throw new Error(`no evidence content fetched for ${family}`);

  const modelId = getSystemModelId('style_distiller', 'system', 'anthropic/claude-sonnet-4-6');
  const userPrompt = [
    `MODEL FAMILY: ${FAMILY_LABELS[family]}`,
    '',
    'PRODUCTION SYSTEM PROMPTS (evidence):',
    ...evidence.map((e, i) => `\n=== FILE ${i + 1}: ${e.path} ===\n${e.text}`),
  ].join('\n');

  const started = Date.now();
  const r = await fetch('hub-model://v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.STYLE_DISTILLER),
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: getSystemPrompt('style_distiller', 'system', PROMPTS.style_distiller) },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
    }),
  });
  const data = await r.json();
  logUsageFromResponse({
    user: 'system',
    feature: 'style-distiller',
    modelKey: 'style_distiller',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.STYLE_DISTILLER,
  });
  if (!r.ok) throw new Error(data.error?.message || `OpenRouter error ${r.status}`);
  const profile = data.choices?.[0]?.message?.content?.trim();
  if (!profile || profile.length < 400) throw new Error(`distiller returned implausibly short profile for ${family}`);

  const payload = {
    family,
    label: FAMILY_LABELS[family],
    profile,
    sources: evidence.map(e => ({ path: e.path, size: e.size })),
    model_id: data.model || modelId,
    distilled_at: Math.floor(Date.now() / 1000),
  };
  saveStyleProfile(family, payload);
  writeReceipt({
    family,
    status: 'done',
    summary: `Distilled ${FAMILY_LABELS[family]} style profile from ${evidence.length} production prompts (${profile.length} chars)`,
    payload: { sources: payload.sources, profile_chars: profile.length },
    modelId: payload.model_id,
  });
  return payload;
}

// Rewrites an existing system prompt to match the style conventions of the model
// family it is assigned to run on. Returns a proposal only — the caller decides
// whether to save it. Placeholders like [DATE] must survive verbatim.
async function shapePromptForFamily({ user, promptText, family, featureLabel = '' }) {
  const fam = normalizeFamily(family);
  if (!fam) throw new Error('Unknown model family');
  const text = String(promptText || '').trim();
  if (!text) throw new Error('No prompt text to shape');
  const styleBlock = styleProfileBlock(fam);
  if (!styleBlock) throw new Error(`No style profile distilled for ${FAMILY_LABELS[fam]} yet — run the style profile job first`);

  const modelId = getSystemModelId('prompt_shaper', 'system', 'anthropic/claude-sonnet-4-6');
  const system = [
    getSystemPrompt('prompt_shaper', 'system', PROMPTS.prompt_shaper),
    styleBlock,
  ].join('\n');

  const started = Date.now();
  const r = await fetch('hub-model://v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.PROMPT_QUICK_IMPROVER),
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `SYSTEM PROMPT TO RESHAPE${featureLabel ? ` (pipeline slot: ${featureLabel})` : ''}:\n\n${text}` },
      ],
      stream: false,
    }),
  });
  const data = await r.json();
  logUsageFromResponse({
    user: user || 'system',
    feature: 'prompt-shaper',
    modelKey: 'prompt_shaper',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.PROMPT_QUICK_IMPROVER,
  });
  if (!r.ok) throw new Error(data.error?.message || `OpenRouter error ${r.status}`);
  let proposal = data.choices?.[0]?.message?.content?.trim();
  if (!proposal) throw new Error('Model returned no reshaped prompt');
  proposal = proposal.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '').trim();
  return { proposal, family: fam, familyLabel: FAMILY_LABELS[fam], modelId: data.model || modelId };
}

// Runs the full synthesis across all families. Existing profiles are kept when a
// family fails (stale beats absent); failures get a receipt so they are visible.
async function runStyleProfileSynthesis() {
  const results = { done: [], failed: [] };
  for (const f of MODEL_FAMILIES) {
    try {
      const p = await distilFamily(f.key);
      results.done.push({ family: f.key, sources: p.sources.length });
    } catch (err) {
      console.error(`[style-profiles] ${f.key} failed: ${err.message}`);
      writeReceipt({ family: f.key, status: 'error', summary: err.message, payload: {} });
      results.failed.push({ family: f.key, error: err.message });
    }
  }
  return results;
}

module.exports = {
  MODEL_FAMILIES,
  FAMILY_LABELS,
  familyFromModelId,
  normalizeFamily,
  getStyleProfile,
  listStyleProfiles,
  styleProfileBlock,
  shapePromptForFamily,
  runStyleProfileSynthesis,
};
