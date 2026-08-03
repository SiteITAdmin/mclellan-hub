'use strict';

// Grok drives scripts/last30days.py the same way a reasoning model in
// Claude Code would: resolve handles/subs, build a last30days --plan JSON,
// run the engine, then write LinkedIn angles grounded in SOCIAL evidence
// from the last 30 days — people talking, not press releases.
//
// Behavioral contract (ported from last30days SKILL.md, not invented here):
//   - engine evidence is AUTHORITATIVE
//   - citation priority: Reddit/X/HN/GitHub/TikTok/IG/YouTube >> web press
//   - web is for handle resolution + rare in-window corroboration only
//   - thin community signal → honest thin output, not analyst padding
//
// On the Mac mini the driver uses the authenticated Grok CLI subscription.
// OpenRouter remains a compatibility transport for hosts that do not have the
// local CLI. The evidence engine is always local to the selected host.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uuid } = require('./id');
const { openRouterHeaders, TASK_CODES } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { researchWindowStart } = require('./content-research-core');

const MAX_TURNS = 6;
const ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const FALLBACK_MODEL = 'x-ai/grok-4.5';
const GROK_CLI_TIMEOUT_MS = 3 * 60 * 1000;
const GROK_CLI_PATH = process.env.GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', 'grok');

// Domains that are almost never "people talking" — reject as sole source unless
// the model already marked thin-signal (we still prefer to drop pure analyst PR).
const ANALYST_PRESS_HOSTS = [
  'gartner.com',
  'mckinsey.com',
  'deloitte.com',
  'forrester.com',
  'idc.com',
  'accenture.com',
  'pwc.com',
  'ey.com',
  'kpmg.com',
  'bcg.com',
];

const SOCIAL_HOSTS = [
  'reddit.com',
  'old.reddit.com',
  'x.com',
  'twitter.com',
  'news.ycombinator.com',
  'github.com',
  'tiktok.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
];

function engineDir() {
  return process.env.LAST30DAYS_ENGINE_PATH || path.join(os.homedir(), '.claude/skills/last30days');
}

function useNativeGrokCli() {
  // A local `grok` driver means the authenticated Mac CLI when it is present.
  // Keep an explicit transport setting for diagnostics and non-standard hosts.
  return process.env.GROK_RESEARCH_TRANSPORT === 'cli' ||
    (process.env.CONTENT_RESEARCH_DRIVER === 'grok' && fs.existsSync(GROK_CLI_PATH));
}

function resolvePython() {
  const candidates = [process.env.LAST30DAYS_PYTHON, 'python3.14', 'python3.13', 'python3.12', 'python3'].filter(Boolean);
  for (const candidate of candidates) {
    const check = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)']);
    if (!check.error && check.status === 0) return candidate;
  }
  throw new Error('No Python 3.12+ interpreter found for last30days engine (checked LAST30DAYS_PYTHON, python3.14/13/12, python3)');
}

const RUN_LAST30DAYS_TOOL = {
  type: 'function',
  function: {
    name: 'run_last30days',
    description: 'PRIMARY research tool. Runs the last30days multi-source SOCIAL engine and returns ranked, engagement-scored evidence from Reddit, Hacker News, GitHub, Digg, TikTok, Instagram, and YouTube for the last ~30 days. This is the authoritative corpus for suggestions — not optional background. Use native web/X only to resolve handles/subreddits before calling this, not as a substitute story source.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short topic phrase using practitioner vocabulary, e.g. "Microsoft Intune Entra SharePoint admin" or "enterprise transformation failure adoption" — not bare corporate abstractions when a search_query hint was provided' },
        plan: {
          type: 'object',
          description: 'last30days query plan JSON: {intent, freshness_mode, cluster_mode, subqueries:[{label, search_query, ranking_query, sources, weight}]}. sources is a subset of [reddit, hackernews, github, digg, tiktok, instagram, youtube].',
        },
        x_related: { type: 'string', description: 'Comma-separated X handles to weight in ranking, no @ prefix. Optional.' },
        subreddits: { type: 'string', description: 'Comma-separated broad/category subreddits. Optional.' },
        dedicated_subreddits: { type: 'string', description: 'Comma-separated subreddits entirely dedicated to this topic (pulled in full, not relevance-floored). Optional.' },
      },
      required: ['topic', 'plan'],
    },
  },
};

function runLast30DaysEngine({ topic, plan, x_related, subreddits, dedicated_subreddits }, { saveDir }) {
  return new Promise((resolve) => {
    let python;
    try {
      python = resolvePython();
    } catch (e) {
      resolve({ error: e.message });
      return;
    }

    // Grok occasionally sends `plan` as a JSON *string* instead of an object;
    // passing that through double-encoded crashes the engine's plan parser
    // and burns a whole attempt (seen 2026-07-16, AttributeError in intent_hint).
    if (typeof plan === 'string') {
      try { plan = JSON.parse(plan); } catch { /* engine will fall back to its own planner */ }
    }
    const planFile = path.join(os.tmpdir(), `grok-last30days-plan-${uuid()}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan || {}));

    const args = [
      path.join(engineDir(), 'scripts/last30days.py'),
      ...String(topic || '').split(/\s+/).filter(Boolean),
      '--emit=json',
      '--json-profile=agent',
      '--plan', planFile,
      '--search=reddit,hackernews,github,digg,tiktok,instagram,youtube',
    ];
    if (saveDir) args.push('--save-dir', saveDir);
    if (x_related) args.push('--x-related', x_related);
    if (subreddits) args.push('--subreddits', subreddits);
    if (dedicated_subreddits) args.push('--dedicated-subreddits', dedicated_subreddits);

    console.log('[grok-research] engine run:', topic);
    const child = spawn(python, args, {
      cwd: engineDir(),
      env: { ...process.env, LAST30DAYS_NATIVE_SEARCH: '1' },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ error: 'last30days engine timed out after 5 minutes' });
    }, ENGINE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.unlink(planFile, () => {});
      if (code !== 0) {
        console.error('[grok-research] engine exit', code, stderr.slice(-2000));
        resolve({ error: `last30days engine exited ${code}: ${stderr.slice(-500)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // --json-profile=agent's `candidates` key doesn't populate on real (non-mock)
        // runs as of last30days v3.14.0 - only `results`/`clusters` do. Checking both
        // keeps this correct if that gets fixed upstream. Full object still goes to
        // Grok either way, so this only affects the diagnostic count, not behavior.
        const evidenceCount = (parsed.candidates || parsed.results || []).length;
        console.log('[grok-research] engine returned', evidenceCount, 'evidence items');
        resolve(parsed);
      } catch (e) {
        resolve({ error: `failed to parse engine JSON: ${e.message}` });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: `failed to spawn engine: ${e.message}` });
    });
  });
}

async function openRouterRequest(modelId, messages, tools) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch('hub-model://v1/chat/completions', {
      method: 'POST',
      headers: openRouterHeaders(TASK_CODES.LINKEDIN_PLANNER),
      body: JSON.stringify({
        model: modelId,
        messages,
        tools,
        plugins: [{ id: 'web' }],
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`OpenRouter error ${r.status}: ${errText.slice(0, 500)}`);
    }
    return r.json();
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isAnalystPressUrl(url) {
  const host = hostOf(url);
  return !!host && ANALYST_PRESS_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isSocialUrl(url) {
  const host = hostOf(url);
  return !!host && SOCIAL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function looksThinSignal(text) {
  return /thin community|thin signal|thin evidence|little community|no clear community|quiet (this )?window|sparse conversation/i.test(String(text || ''));
}

/**
 * Post-parse safety net: drop pure analyst-press angles that are not
 * explicitly framed as thin-signal honesty. Models still occasionally ignore
 * the prompt; this is the seatbelt, not the steering wheel.
 */
function filterSuggestions(list) {
  const kept = [];
  for (const s of list) {
    const origin = String(s.evidence_origin || '').toLowerCase();
    const url = s.source_url;
    if (isAnalystPressUrl(url) && origin !== 'engine' && !looksThinSignal(s.summary) && !looksThinSignal(s.title)) {
      console.warn('[grok-research] dropped analyst-press suggestion (not engine-grounded):', s.title, url);
      continue;
    }
    kept.push(s);
  }
  return kept;
}

function parseSuggestionsJson(text, { topic, tone, planDate, limit }) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  const mapped = list.slice(0, Math.max(limit * 2, limit)).map((s) => {
    const origin = String(s.evidence_origin || s.origin || '').toLowerCase();
    let evidenceOrigin = ['engine', 'x', 'web'].includes(origin) ? origin : '';
    if (!evidenceOrigin && isSocialUrl(s.source_url)) evidenceOrigin = 'engine';
    if (!evidenceOrigin && isAnalystPressUrl(s.source_url)) evidenceOrigin = 'web';
    const row = {
      id: uuid(),
      plan_date: planDate,
      topic,
      tone,
      title: String(s.title || '').slice(0, 120),
      summary: String(s.summary || '').slice(0, 400),
      source_url: s.source_url || null,
      source_title: s.source_title || null,
      source_provider: 'grok+last30days',
      source_json: JSON.stringify({ ...s, evidence_origin: evidenceOrigin || s.evidence_origin || null }),
      researched_at: Math.floor(Date.now() / 1000),
      evidence_origin: evidenceOrigin || null,
    };
    return row;
  }).filter((s) => s.title);

  return filterSuggestions(mapped).slice(0, limit);
}

function buildDriverUserMessage({ topic, tone, planDate, description, searchQuery }) {
  const windowStart = researchWindowStart(planDate);
  const lines = [
    `Topic: ${topic}`,
    `Tone: ${tone}`,
    `Date: ${planDate}`,
    windowStart
      ? `Window: last 30 days ending ${planDate} (window_start=${windowStart}). Cite only sources published on or after window_start.`
      : null,
    description ? `Topic description: ${description}` : null,
    searchQuery
      ? `Preferred search_query hint (use as primary subquery; people actually say these phrases, not the abstract topic label): ${searchQuery}`
      : null,
    'Contract: last30days engine = authoritative corpus of what PEOPLE said. Native web is for handle/subreddit resolution only — not for inventing angles from press releases. If community conversation is thin, say so honestly.',
  ].filter(Boolean);
  return lines.join('\n');
}

/** Injected after every engine tool result so the model cannot treat social evidence as optional. */
function postEngineReinforcement({ windowStart, planDate }) {
  return [
    'run_last30days has returned. That JSON is your PRIMARY evidence corpus.',
    'Citation priority: Reddit / X / HN / GitHub / TikTok / Instagram / YouTube from the tool result first.',
    'Web press (Gartner, McKinsey, Deloitte, Forrester, vendor PR) is NOT a substitute when community evidence is thin or noisy — write honest thin-signal angles instead.',
    windowStart
      ? `Hard window: source_url must be published on or after ${windowStart} (plan date ${planDate}).`
      : null,
    'Write the JSON suggestions now. Prefer social source_urls. Set evidence_origin to "engine" when the angle comes from the tool result.',
  ].filter(Boolean).join(' ');
}

function engineEvidenceCount(result) {
  if (!result || result.error) return 0;
  return (result.candidates || result.results || []).length;
}

function runGrokCli({ prompt, schema }) {
  return new Promise((resolve) => {
    if (!fs.existsSync(GROK_CLI_PATH)) {
      resolve({ error: `Grok CLI not found at ${GROK_CLI_PATH}` });
      return;
    }

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(schema),
      '--model', process.env.GROK_RESEARCH_CLI_MODEL || 'grok-4.5',
      // The CLI may use one internal turn to prepare its structured response.
      // Keep this bounded: research planning and synthesis must not become an
      // open-ended coding-agent session.
      '--max-turns', '3',
      '--no-memory',
      '--no-plan',
      '--no-subagents',
      '--disable-web-search',
      '--permission-mode', 'dontAsk',
    ];
    const child = spawn(GROK_CLI_PATH, args, { cwd: engineDir(), env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ error: 'Grok CLI timed out after 3 minutes' });
    }, GROK_CLI_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: `failed to start Grok CLI: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: `Grok CLI exited ${code}: ${stderr.slice(-500)}` });
        return;
      }
      try {
        const envelope = JSON.parse(stdout);
        const result = envelope.structuredOutput || JSON.parse(envelope.text || '{}');
        resolve({ result, turns: Number(envelope.num_turns || 1) });
      } catch (err) {
        resolve({ error: `failed to parse Grok CLI output: ${err.message}` });
      }
    });
  });
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'plan'],
  properties: {
    topic: { type: 'string' },
    x_related: { type: 'string' },
    subreddits: { type: 'string' },
    dedicated_subreddits: { type: 'string' },
    plan: {
      type: 'object',
      additionalProperties: true,
      required: ['intent', 'subqueries'],
      properties: {
        intent: { type: 'string' },
        freshness_mode: { type: 'string' },
        cluster_mode: { type: 'string' },
        subqueries: { type: 'array' },
      },
    },
  },
};

const SUGGESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['title', 'summary', 'source_url', 'source_title', 'evidence_origin'],
        properties: {
          title: { type: 'string' },
          summary: { type: 'string' },
          source_url: { type: 'string' },
          source_title: { type: 'string' },
          evidence_origin: { type: 'string' },
        },
      },
    },
  },
};

async function driveLast30DaysResearchViaCli({ topic, tone, planDate, saveDir, limit, description, searchQuery, topicContext }) {
  const planPrompt = [
    'Create a last30days research plan as JSON only. You are planning social listening, not writing suggestions.',
    buildDriverUserMessage({ topic, tone, planDate, description, searchQuery, topicContext }),
    'Use practitioner vocabulary. Provide a topic, a plan with intent and focused subqueries, and optional relevant handles/subreddits.',
  ].join('\n\n');
  const planned = await runGrokCli({ prompt: planPrompt, schema: PLAN_SCHEMA });
  if (planned.error) return { ok: false, error: planned.error, suggestions: [] };

  const engineResult = await runLast30DaysEngine(planned.result, { saveDir });
  if (engineResult?.error) return { ok: false, error: engineResult.error, suggestions: [] };

  const evidence = JSON.stringify(engineResult).slice(0, 60000);
  const suggestionPrompt = [
    'Write evidence-grounded LinkedIn angle suggestions as JSON only.',
    buildDriverUserMessage({ topic, tone, planDate, description, searchQuery, topicContext }),
    `Return at most ${limit} suggestions. Use only the supplied last30days evidence for claims and source URLs. If it is thin, say so honestly rather than filling gaps with press or assumptions.`,
    `LAST30DAYS EVIDENCE:\n${evidence}`,
  ].join('\n\n');
  const written = await runGrokCli({ prompt: suggestionPrompt, schema: SUGGESTIONS_SCHEMA });
  if (written.error) return { ok: false, error: written.error, suggestions: [] };

  return {
    ok: true,
    suggestions: parseSuggestionsJson(JSON.stringify(written.result), { topic, tone, planDate, limit }),
    turns: planned.turns + written.turns,
    engineEvidenceCount: engineEvidenceCount(engineResult),
  };
}

async function driveLast30DaysResearch({
  user = 'system',
  topic,
  tone = 'professional',
  planDate,
  saveDir,
  limit = 3,
  description = '',
  searchQuery = '',
  topicContext = null,
} = {}) {
  if (!topic) return { ok: false, error: 'no topic', suggestions: [] };

  const cleanDescription = String(topicContext?.description || description || '').trim().slice(0, 600);
  const cleanSearchQuery = String(topicContext?.searchQuery || searchQuery || '').trim().slice(0, 300);
  const suggestionCount = Math.max(1, Math.min(10, Number(limit) || 3));
  if (useNativeGrokCli()) {
    return driveLast30DaysResearchViaCli({
      topic,
      tone,
      planDate,
      saveDir,
      limit: suggestionCount,
      description: cleanDescription,
      searchQuery: cleanSearchQuery,
      topicContext,
    });
  }
  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1') return { ok: false, error: 'subscription model plane disabled', suggestions: [] };
  const windowStart = researchWindowStart(planDate);
  const modelId = getSystemModelId('content_research_driver', user, FALLBACK_MODEL);
  const systemPrompt = getSystemPrompt('content_research_driver', user, PROMPTS.content_research_driver)
    .replace(/\[COUNT\]/g, String(suggestionCount));
  const tools = [RUN_LAST30DAYS_TOOL];
  let messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: buildDriverUserMessage({
        topic,
        tone,
        planDate,
        description: cleanDescription,
        searchQuery: cleanSearchQuery,
      }),
    },
  ];

  const started = Date.now();
  let engineRan = false;
  let lastEngineCount = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let data;
    try {
      data = await openRouterRequest(modelId, messages, tools);
    } catch (e) {
      console.error('[grok-research] OpenRouter request failed:', e.message);
      return { ok: false, error: e.message, suggestions: [] };
    }

    logUsageFromResponse({
      user,
      feature: 'content-research-grok',
      modelKey: 'content_research_driver',
      fallbackModelId: modelId,
      data,
      taskCode: TASK_CODES.LINKEDIN_PLANNER,
    });

    const message = data.choices?.[0]?.message;
    if (!message) return { ok: false, error: 'OpenRouter returned no message', suggestions: [] };

    const toolCalls = (message.tool_calls || []).filter((c) => c.function?.name === 'run_last30days');
    if (toolCalls.length) {
      // Drop reasoning/reasoning_details - xAI's encrypted reasoning blob is
      // single-use and replaying it verbatim 400s on the next turn.
      // OpenRouter's own guidance: ignore it client-side, keep content + tool_calls.
      const { reasoning, reasoning_details, ...cleanMessage } = message;
      messages = [...messages, cleanMessage];
      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty */ }
        // Prefer taxonomy searchQuery as the engine topic when Grok still
        // passes the abstract corporate label alone.
        if (cleanSearchQuery && (!args.topic || args.topic === topic)) {
          args.topic = cleanSearchQuery;
        }
        const result = await runLast30DaysEngine(args, { saveDir });
        engineRan = true;
        lastEngineCount = engineEvidenceCount(result);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 60000),
        });
      }
      // Structural reinforcement: the system prompt alone was not enough when
      // Claude wrote the first version — restate the contract after the corpus lands.
      messages.push({
        role: 'user',
        content: postEngineReinforcement({ windowStart, planDate }),
      });
      continue;
    }

    const finalText = message.content;
    if (finalText) {
      // Force the engine path if Grok tries to answer from web alone.
      if (!engineRan) {
        messages = [
          ...messages,
          { role: 'assistant', content: finalText },
          {
            role: 'user',
            content: 'You must call run_last30days before writing suggestions. Native web search is not a substitute. Call the tool now with a plan that uses practitioner search terms.',
          },
        ];
        continue;
      }
      const suggestions = parseSuggestionsJson(finalText, {
        topic,
        tone,
        planDate,
        limit: suggestionCount,
      });
      return {
        ok: true,
        suggestions,
        rawText: finalText,
        turns: turn + 1,
        durationMs: Date.now() - started,
        engineEvidenceCount: lastEngineCount,
      };
    }

    messages.push({ role: 'user', content: 'Respond now with only the JSON object described in your instructions.' });
  }

  return { ok: false, error: `gave up after ${MAX_TURNS} turns without a final answer`, suggestions: [] };
}

module.exports = {
  driveLast30DaysResearch,
  buildDriverUserMessage,
  postEngineReinforcement,
  parseSuggestionsJson,
  filterSuggestions,
  isAnalystPressUrl,
  isSocialUrl,
  useNativeGrokCli,
  runGrokCli,
};
