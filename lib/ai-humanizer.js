'use strict';
// AI text humanizer.
// Redrafts AI-generated prose so it reads as naturally human by editing the six
// recurring "tells" of machine writing: the rule of three, low burstiness,
// predictable transitions, flat/absolute tone, thesaurus vocabulary, and
// surface-level generality. Manual method after Andy Stapleton
// (https://www.youtube.com/watch?v=ikSVh2X1qec), applied by the model.
//
// This is an editing tool, not a fabrication tool: it never invents statistics,
// citations, or facts. Where specific data would strengthen the text it inserts
// an [ADD SPECIFIC FIGURE: ...] marker for the author instead of making one up.

const fetch = require('./fetch');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES, openRouterHeaders } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { parseModelObject } = require('./model-response');
const { scanDiscourse } = require('./humanizer-discourse');

const HUMANIZER_FALLBACK = 'anthropic/claude-sonnet-4-5';
const MAX_INPUT_CHARS = 24000;

const INTENSITY = { light: 'light', balanced: 'balanced', heavy: 'heavy' };

// Six SURFACE tells the humaniser has always edited, plus six DISCOURSE tells
// (StoryScope, arXiv:2604.03136) that persist after surface edits. Each change
// the model reports is tagged with its layer so the UI can show whether a
// rewrite touched narrative structure or only polished words.
const SURFACE_PATTERNS = ['rule_of_three', 'burstiness', 'transitions', 'nuance', 'vocabulary', 'surface_depth'];
const DISCOURSE_PATTERNS = ['over_explanation', 'moralising', 'emotion_naming', 'sensory_density', 'presentation_order', 'audience_address'];
const CHANGE_PATTERNS = new Set([...SURFACE_PATTERNS, ...DISCOURSE_PATTERNS]);
const PATTERN_LAYER = Object.fromEntries([
  ...SURFACE_PATTERNS.map(p => [p, 'surface']),
  ...DISCOURSE_PATTERNS.map(p => [p, 'discourse']),
]);

// Cheap, deterministic pre-scan so the UI can show which tells are present even
// before the model runs, and so we never claim a clean bill of health silently.
function scanTells(text) {
  const t = String(text || '');
  const sentences = t.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  const words = t.trim().split(/\s+/).filter(Boolean);

  // Burstiness: coefficient of variation of sentence word-counts. Low = machine-like.
  const lengths = sentences.map(s => s.split(/\s+/).filter(Boolean).length);
  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const variance = lengths.length
    ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length
    : 0;
  const stdev = Math.sqrt(variance);
  const burstiness = mean > 0 ? +(stdev / mean).toFixed(2) : 0;

  const transitionWords = ['however', 'moreover', 'furthermore', 'therefore', 'additionally',
    'consequently', 'nevertheless', 'in conclusion', 'in summary', 'ultimately', 'notably'];
  const transitionOpeners = sentences.filter(s =>
    transitionWords.some(w => s.trim().toLowerCase().startsWith(w))).length;

  // Rule-of-three: "a, b, and c" style triads. Items may be multi-word — the
  // old \w+-only pattern missed real professional triads like "endpoint
  // management, software deployment, and security" (only caught single words),
  // so it scored 0 on exactly the triads worth flagging. Segments are anything
  // up to the next comma/sentence break; two+ segments then "and/or <segment>".
  const ruleOfThree = (t.match(/(?:[^,.;:!?\n]+,\s+){2,}(?:and|or)\s+[^,.;:!?\n]+/gi) || []).length;

  const wordyTerms = ['utilise', 'utilize', 'leverage', 'delve', 'myriad', 'pivotal',
    'underscore', 'underscores', 'plethora', 'realm', 'tapestry', 'facilitate',
    'endeavour', 'endeavor', 'paramount', 'multifaceted', 'holistic', 'robust',
    'seamless', 'commendable', 'noteworthy'];
  const lower = t.toLowerCase();
  const wordyHits = wordyTerms.filter(w => new RegExp(`\\b${w}\\b`).test(lower));

  return {
    word_count: words.length,
    sentence_count: sentences.length,
    burstiness,                       // lower is more machine-like; humans often > 0.5
    low_burstiness: sentences.length >= 4 && burstiness < 0.4,
    transition_openers: transitionOpeners,
    rule_of_three_count: ruleOfThree,
    wordy_terms: wordyHits,
  };
}

async function humanizeText({ text, field = 'general professional writing', aggressiveness = 'balanced', user = 'system' }) {
  const source = String(text || '').trim();
  if (!source) throw new Error('No text supplied to humanize.');
  if (source.length > MAX_INPUT_CHARS) {
    throw new Error(`Text is too long (${source.length} chars). Limit is ${MAX_INPUT_CHARS}.`);
  }

  const intensity = INTENSITY[aggressiveness] || INTENSITY.balanced;
  const preScan = scanTells(source);

  const modelId = getSystemModelId('ai_humanizer', 'system', HUMANIZER_FALLBACK);
  const prompt = getSystemPrompt('ai_humanizer', 'system', PROMPTS.ai_humanizer)
    .replaceAll('[FIELD]', field || 'general professional writing')
    .replaceAll('[AGGRESSIVENESS]', intensity)
    .replaceAll('[SOURCE_TEXT]', source);

  const started = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: openRouterHeaders(TASK_CODES.HUMANIZER),
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: source },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`AI humanizer OpenRouter ${resp.status}: ${body.slice(0, 300)}`);
  }
  const data = await resp.json();
  logUsageFromResponse({
    user,
    feature: 'ai-humanizer',
    modelKey: 'ai_humanizer',
    fallbackModelId: modelId,
    data,
    durationMs: Date.now() - started,
    taskCode: TASK_CODES.HUMANIZER,
  });

  const parsed = parseModelObject(data.choices?.[0]?.message?.content, {
    humanized_text: '',
    estimated_detector_risk_before: 'unknown',
    estimated_detector_risk_after: 'unknown',
    risk_note: 'AI-detector scores are unreliable; this is an estimate, not a guarantee.',
    changes: [],
    added_data_markers: [],
    added_source_markers: [],
  }, 'AI humanizer response');

  if (!parsed.humanized_text || typeof parsed.humanized_text !== 'string') {
    throw new Error('AI humanizer returned no rewritten text.');
  }
  parsed.changes = (Array.isArray(parsed.changes) ? parsed.changes : [])
    .filter(c => c && CHANGE_PATTERNS.has(c.pattern))
    // Trust the model's layer only if valid; otherwise derive it from the pattern.
    .map(c => ({ ...c, layer: c.layer === 'surface' || c.layer === 'discourse' ? c.layer : PATTERN_LAYER[c.pattern] }));
  parsed.added_data_markers = Array.isArray(parsed.added_data_markers) ? parsed.added_data_markers : [];
  parsed.added_source_markers = Array.isArray(parsed.added_source_markers) ? parsed.added_source_markers : [];

  // If the model didn't self-report markers, still surface any it left inline.
  const inlineFigures = parsed.humanized_text.match(/\[ADD SPECIFIC FIGURE:[^\]]*\]/gi) || [];
  for (const m of inlineFigures) {
    if (!parsed.added_data_markers.includes(m)) parsed.added_data_markers.push(m);
  }
  const inlineSources = parsed.humanized_text.match(/\[ADD SPECIFIC SOURCE:[^\]]*\]/gi) || [];
  for (const m of inlineSources) {
    if (!parsed.added_source_markers.includes(m)) parsed.added_source_markers.push(m);
  }

  return {
    modelId,
    field,
    aggressiveness: intensity,
    original: source,
    scan_before: preScan,
    scan_after: scanTells(parsed.humanized_text),
    scan_discourse_before: scanDiscourse(source),
    scan_discourse_after: scanDiscourse(parsed.humanized_text),
    ...parsed,
  };
}

module.exports = {
  humanizeText, scanTells, HUMANIZER_FALLBACK, MAX_INPUT_CHARS,
  SURFACE_PATTERNS, DISCOURSE_PATTERNS, PATTERN_LAYER,
};
