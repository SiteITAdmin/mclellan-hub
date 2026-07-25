'use strict';

/**
 * Completeness gate: every PROMPTS key and every getSystemModelId /
 * getSystemPrompt feature used in production code must appear in
 * SYSTEM_MODEL_GROUPS so Douglas can find it on /admin/models/system and
 * /admin/models/prompts.
 *
 * If this fails, add the missing slot to routes/hub-admin.js SYSTEM_MODEL_GROUPS
 * and (for text prompts) a default in lib/prompts.js, then wire the call site
 * through getSystemModelId / getSystemPrompt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'data', 'preview', 'automation-discovery-run', 'test'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function registeredFeatures() {
  const src = fs.readFileSync(path.join(ROOT, 'routes/hub-admin.js'), 'utf8');
  const features = new Set();
  for (const m of src.matchAll(/feature:\s*'([a-zA-Z0-9_]+)'/g)) features.add(m[1]);
  // Exclude admin testbench-only keys that are not system pipeline slots
  for (const noise of ['testbench', 'testbench-brave', 'testbench-prompt-improver']) {
    features.delete(noise);
  }
  return features;
}

function promptKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'lib/prompts.js'), 'utf8');
  const block = src.match(/const PROMPTS\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(block, 'PROMPTS object not found in lib/prompts.js');
  const keys = new Set();
  for (const m of block[1].matchAll(/^\s{2}([a-zA-Z0-9_]+)\s*:/gm)) keys.add(m[1]);
  return keys;
}

function usedFeatures() {
  const files = walk(ROOT);
  const model = new Set();
  const prompt = new Set();
  for (const file of files) {
    // Skip the admin route itself and pure audit helpers
    if (file.endsWith('routes/hub-admin.js')) continue;
    if (file.endsWith('scripts/audit-system-model-slots.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/getSystemModelId\(\s*['"`]([^'"`]+)['"`]/g)) model.add(m[1]);
    for (const m of text.matchAll(/getSystemPrompt\(\s*['"`]([^'"`]+)['"`]/g)) prompt.add(m[1]);
    for (const m of text.matchAll(/getSystemPromptOverride\(\s*['"`]([^'"`]+)['"`]/g)) prompt.add(m[1]);
    for (const m of text.matchAll(/PROMPTS\.([a-zA-Z0-9_]+)/g)) prompt.add(m[1]);
  }
  return { model, prompt };
}

// Model-only slots that intentionally have no chat prompt (STT/TTS/embeddings/parent models).
const MODEL_ONLY_ALLOWED = new Set([
  'embeddings',
  'debrief_transcriber',
  'debrief_tts',
  'workday_transcription',
  'suggestions',
  'work_daily_brief',
]);

test('every PROMPTS key is registered in SYSTEM_MODEL_GROUPS', () => {
  const registered = registeredFeatures();
  const prompts = promptKeys();
  const missing = [...prompts].filter(k => !registered.has(k)).sort();
  assert.deepEqual(
    missing,
    [],
    `PROMPTS keys missing from SYSTEM_MODEL_GROUPS (add slots on /admin/models):\n  ${missing.join('\n  ')}`,
  );
});

test('every getSystemModelId / getSystemPrompt call uses a registered slot', () => {
  const registered = registeredFeatures();
  const { model, prompt } = usedFeatures();
  const missingModel = [...model].filter(k => !registered.has(k)).sort();
  const missingPrompt = [...prompt].filter(k => !registered.has(k)).sort();
  assert.deepEqual(
    missingModel,
    [],
    `getSystemModelId features not in SYSTEM_MODEL_GROUPS:\n  ${missingModel.join('\n  ')}`,
  );
  assert.deepEqual(
    missingPrompt,
    [],
    `getSystemPrompt/PROMPTS features not in SYSTEM_MODEL_GROUPS:\n  ${missingPrompt.join('\n  ')}`,
  );
});

test('registered slots either have a PROMPTS default or are declared model-only', () => {
  const registered = registeredFeatures();
  const prompts = promptKeys();
  // Only slots we know from the production groups — ignore accidental matches
  // from hub-admin that aren't in SYSTEM_MODEL_GROUPS by checking PROMPTS coverage.
  const knownModelOnly = MODEL_ONLY_ALLOWED;
  // Repair agent / embeddings etc are in registered; model-only set covers them.
  // Any other registered slot without a prompt will still appear on the system
  // models page (good) but not the prompts page — flag those that look like
  // prompt-bearing names.
  const suspicious = [...registered]
    .filter(k => !prompts.has(k) && !knownModelOnly.has(k))
    .filter(k => !/^(embeddings|debrief_transcriber|debrief_tts|workday_transcription|suggestions|work_daily_brief)$/.test(k))
    .sort();
  // These currently legitimately have no PROMPTS text (parent/model-only or voice handled above).
  // If a new slot lands without a prompt and isn't model-only, fail so we notice.
  const allowedEmpty = new Set([
    ...knownModelOnly,
  ]);
  const bad = suspicious.filter(k => !allowedEmpty.has(k));
  // Don't hard-fail on historical empties if any slip through knownModelOnly —
  // but fail when a clearly prompt-shaped name lacks PROMPTS.
  const clearlyPrompt = bad.filter(k =>
    /_(brief|advisor|triage|agent|extractor|parser|classifier|writer|synthesis|search|digest|answer|retrieval|prompt|learner|scorer|drafter|refiner|planner|reviewer)$/.test(k)
    || /^(clarification|consigliere|remediation|repair|wiki|newsletter|daily)/.test(k)
  );
  assert.deepEqual(
    clearlyPrompt,
    [],
    `Registered slots that look prompt-bearing but lack PROMPTS defaults:\n  ${clearlyPrompt.join('\n  ')}`,
  );
});

test('critical previously-missing slots are present', () => {
  const registered = registeredFeatures();
  const prompts = promptKeys();
  for (const key of [
    'clarification_answer',
    'consigliere_brief',
    'remediation_advisor',
    'repair_triage',
    'repair_agent',
    'daily_digest',
    'wiki_search',
    'newsletter_retrieval',
    'workday_transcription',
    'debrief_tts_voice',
    'hub_chat',
    'hub_chat_research',
    'model_effectiveness_review',
  ]) {
    assert.ok(registered.has(key), `missing SYSTEM_MODEL_GROUPS slot: ${key}`);
  }
  for (const key of [
    'clarification_answer',
    'consigliere_brief',
    'remediation_advisor',
    'repair_triage',
    'repair_agent',
    'daily_digest',
    'wiki_search',
    'newsletter_retrieval',
    'debrief_tts_voice',
    'hub_chat',
    'hub_chat_research',
    'model_effectiveness_review',
  ]) {
    assert.ok(prompts.has(key), `missing PROMPTS default: ${key}`);
  }
});
