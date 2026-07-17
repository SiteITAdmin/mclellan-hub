'use strict';

// Grok drives scripts/last30days.py the same way a reasoning model in
// Claude Code would: it searches to resolve entity handles/subreddits/
// context, builds a last30days --plan JSON, calls the run_last30days
// function tool to execute the engine, reads the ranked evidence, and
// writes LinkedIn-angle suggestions grounded in real quotes/stats.
//
// Routed through OpenRouter (not a direct xAI key) to stay on the single
// model gateway. OpenRouter passes xAI's native web_search + x_search
// through untouched for x-ai/* models when the `web` plugin is enabled -
// confirmed this is real live X search, not OpenRouter's generic
// Exa-backed fallback that other providers get.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uuid } = require('./id');
const { openRouterHeaders, TASK_CODES } = require('./openrouter-attribution');
const { logUsageFromResponse } = require('./openrouter-usage');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TURNS = 6;
const ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const FALLBACK_MODEL = 'x-ai/grok-4.5';

function engineDir() {
  return process.env.LAST30DAYS_ENGINE_PATH || path.join(os.homedir(), '.claude/skills/last30days');
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
    description: 'Runs the last30days multi-source research engine against a structured query plan and returns ranked, engagement-scored evidence from Reddit, Hacker News, GitHub, Digg, TikTok, Instagram, and YouTube. Do NOT use this for general web or X/Twitter search - you already have native web and X search for that; this tool is for the sources they cannot reach.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Short topic phrase, e.g. "Microsoft Intune Entra SharePoint admin"' },
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
    const r = await fetch(OPENROUTER_URL, {
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
  return list.slice(0, limit).map((s) => ({
    id: uuid(),
    plan_date: planDate,
    topic,
    tone,
    title: String(s.title || '').slice(0, 120),
    summary: String(s.summary || '').slice(0, 400),
    source_url: s.source_url || null,
    source_title: s.source_title || null,
    source_provider: 'grok+last30days',
    source_json: JSON.stringify(s),
    researched_at: Math.floor(Date.now() / 1000),
  })).filter((s) => s.title);
}

async function driveLast30DaysResearch({ user = 'system', topic, tone = 'professional', planDate, saveDir, limit = 3 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) return { ok: false, error: 'OPENROUTER_API_KEY not set', suggestions: [] };
  if (!topic) return { ok: false, error: 'no topic', suggestions: [] };

  const suggestionCount = Math.max(1, Math.min(10, Number(limit) || 3));
  const modelId = getSystemModelId('content_research_driver', user, FALLBACK_MODEL);
  const systemPrompt = getSystemPrompt('content_research_driver', user, PROMPTS.content_research_driver)
    .replace(/\[COUNT\]/g, String(suggestionCount));
  const tools = [RUN_LAST30DAYS_TOOL];
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Topic: ${topic}\nTone: ${tone}\nDate: ${planDate}` },
  ];

  const started = Date.now();
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
        const result = await runLast30DaysEngine(args, { saveDir });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 60000),
        });
      }
      continue;
    }

    const finalText = message.content;
    if (finalText) {
      const suggestions = parseSuggestionsJson(finalText, { topic, tone, planDate, limit: suggestionCount });
      return { ok: true, suggestions, rawText: finalText, turns: turn + 1, durationMs: Date.now() - started };
    }

    messages.push({ role: 'user', content: 'Respond now with only the JSON object described in your instructions.' });
  }

  return { ok: false, error: `gave up after ${MAX_TURNS} turns without a final answer`, suggestions: [] };
}

module.exports = { driveLast30DaysResearch };
