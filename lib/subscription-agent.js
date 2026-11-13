'use strict';

// Subscription-backed model execution via authenticated CLIs.
// Codex / Claude / Grok authenticate through their own sessions under HOME.
// This module never receives Hub API keys, mail credentials, or DB access.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveFeatureRunner, MODELS } = require('./feature-runners');

// Legacy per-feature env overrides still honoured for the original five jobs.
const LEGACY_ENV = Object.freeze({
  nakai_daily_briefing: 'NAKAI_DAILY_BRIEFING_RUNNER',
  m365_daily_briefing: 'M365_DAILY_BRIEFING_RUNNER',
  us_block_special_briefing: 'US_BLOCK_BRIEFING_RUNNER',
  nakai_briefing_quality_review: 'NAKAI_BRIEFING_QUALITY_REVIEW_RUNNER',
  cross_entity_synthesis: 'CROSS_ENTITY_SYNTHESIS_RUNNER',
});

// Keep the old export shape for tests that enumerate RUNNERS.
const RUNNERS = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_ENV).map(([feature, env]) => {
    const cfg = resolveFeatureRunner(feature);
    return [feature, Object.freeze({ env, runner: cfg.runner, model: cfg.model, effort: cfg.effort })];
  }),
));

function cliAvailable(runner) {
  try {
    if (runner === 'claude') {
      const p = process.env.CLAUDE_CLI_PATH
        || (process.platform === 'darwin' && process.env.HOME
          ? path.join(process.env.HOME, '.local', 'bin', 'claude')
          : 'claude');
      return p === 'claude' || fs.existsSync(p);
    }
    if (runner === 'codex') {
      const p = process.env.CODEX_CLI_PATH || 'codex';
      return p === 'codex' || fs.existsSync(p);
    }
    if (runner === 'grok') {
      const p = process.env.GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', 'grok');
      return fs.existsSync(p);
    }
    if (runner === 'opencode') {
      const p = process.env.OPENCODE_CLI_PATH || 'opencode';
      return p === 'opencode' || fs.existsSync(p);
    }
  } catch (_) {}
  return false;
}

function configuredRunner(feature, { force = false } = {}) {
  const config = resolveFeatureRunner(feature);
  if (!config || config.runner === 'local') return null;

  const legacyEnv = LEGACY_ENV[feature];
  if (legacyEnv) {
    const selected = String(process.env[legacyEnv] || 'auto').trim().toLowerCase();
    if (selected === 'off' || selected === 'false') return null;
    if (!force && selected !== config.runner && !(selected === 'auto' && process.platform === 'darwin')) {
      return null;
    }
  } else if (!force && process.platform !== 'darwin' && process.env.SUBSCRIPTION_AGENT_LOCAL !== '1') {
    // On the VPS the Mac pull-worker owns CLI execution unless explicitly forced.
    return null;
  }

  return {
    feature,
    runner: config.runner,
    model: config.model,
    effort: config.effort,
    timeoutMs: config.timeoutMs,
    maxInputChars: config.maxInputChars,
    maxOutputChars: config.maxOutputChars,
    allowTools: config.allowTools,
    jsonMode: config.jsonMode,
    tier: config.tier,
    fallbackTo: config.fallbackTo || null,
  };
}

function commandFor(config, systemPrompt) {
  if (config.runner === 'claude') {
    // The Mac worker runs from the repo checkout, so a plain `claude --print`
    // loaded the developer workspace into every Hub call: repo CLAUDE.md,
    // auto-memory, plugins, skills and MCP connectors (~61K tokens around a
    // ~3K classifier prompt, measured 12 Oct 2026), plus the personal
    // project permission list. Confine each call to its own prompt.
    // (--bare would also do this but skips the keychain subscription login.)
    const args = [
      '--print',
      '--model', config.model,
      '--effort', config.effort || 'high',
      '--setting-sources', 'user',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--exclude-dynamic-system-prompt-sections',
      '--no-session-persistence',
    ];
    if (config.allowTools) {
      args.push('--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch');
    } else {
      args.push('--tools', '');
    }
    args.push(
      '--permission-mode', 'dontAsk',
      '--system-prompt', systemPrompt,
      '--output-format', 'json',
    );
    return {
      command: process.env.CLAUDE_CLI_PATH
        || (process.platform === 'darwin' && process.env.HOME
          ? path.join(process.env.HOME, '.local', 'bin', 'claude')
          : 'claude'),
      args,
    };
  }
  if (config.runner === 'codex') {
    return {
      command: process.env.CODEX_CLI_PATH || 'codex',
      args: [
        'exec',
        '--model', config.model,
        '--config', `model_reasoning_effort=${config.effort || 'medium'}`,
        // Same reason as the Claude confinement above: the repo AGENTS.md is
        // developer guidance, not part of any Hub prompt.
        '--config', 'project_doc_max_bytes=0',
        '--sandbox', 'read-only',
        '--ephemeral',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '-',
      ],
    };
  }
  if (config.runner === 'grok') {
    // Grok CLI headless mode is `-p/--single <PROMPT>` (not --print).
    // Prompt text is filled in by runSubscriptionText via args — not stdin.
    //
    // Grok always narrates its intent before answering ("I'll classify this
    // against the Hub taxonomy…") and that narration consumes turns, so a cap
    // of 2 failed every structured call with "Max turns reached" once Luna and
    // Terra moved here. Measured on real classifier and triage prompts: 2 and 4
    // fail, 8 succeeds in 8-18s. --no-plan does not suppress the narration and
    // --json-schema hits the same cap, so the cap is the thing to raise;
    // extractJsonCandidate already slices the object out of the preamble.
    const args = [
      '--single', '__PROMPT__',
      '--model', config.model,
      '--sandbox', 'off',
      '--output-format', 'json',
      '--tools', config.allowTools ? 'web_search,web_fetch' : '',
      '--no-subagents',
      '--permission-mode', 'dontAsk',
      '--max-turns', config.allowTools ? '12' : '8',
    ];
    // Research features may use controlled web search; everything else is tool-disabled.
    if (!config.allowTools) {
      args.push('--disable-web-search', '--disallowed-tools', 'Shell,Bash,Edit,Write,MultiEdit,CallMcpTool,GetMcpTools,FetchMcpResource,ListMcpResources');
    } else {
      args.push('--disallowed-tools', 'Shell,Bash,Edit,Write,MultiEdit,CallMcpTool,GetMcpTools,FetchMcpResource,ListMcpResources');
    }
    return {
      command: process.env.GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', 'grok'),
      args,
      promptArg: true,
    };
  }
  if (config.runner === 'opencode') {
    // OpenCode free-tier lane (opencode/deepseek-v4-flash-free). Same binary
    // that serves the T3/opencode session plane. `--format json` emits NDJSON
    // events to stdout; textFromOutput extracts the assistant text parts.
    // The prompt travels as a single positional message, so no shell leakage.
    const args = ['run', '-m', `opencode/${config.model}`, '--format', 'json', '__PROMPT__'];
    return {
      command: process.env.OPENCODE_CLI_PATH || 'opencode',
      args,
      promptArg: true,
    };
  }
  throw new Error(`Unsupported local subscription runner: ${config.runner}`);
}

function textFromOutput(config, stdout) {
  const text = String(stdout || '').trim();
  if (!text) return text;
  if (config.runner === 'claude') {
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      parsed = text.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(row => row?.type === 'result').at(-1);
    }
    if (parsed?.is_error) throw new Error(String(parsed.result || parsed.errors?.join('; ') || 'Claude could not read the input'));
    return parsed ? String(parsed.result || parsed.text || '').trim() : text;
  }
  if (config.runner === 'grok') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return text; }
    if (typeof parsed === 'string') return parsed;
    if (parsed.is_error || (parsed.stopReason && parsed.stopReason !== 'end_turn')) {
      throw new Error(`Grok did not finish: ${parsed.stopReason || parsed.error || 'error'}`);
    }
    return String(parsed.result || parsed.text || parsed.content || '').trim();
  }
  if (config.runner === 'opencode') {
    // `--format json` streams one JSON object per line. Collect the assistant
    // text parts (step-start/config events and the final step-finish envelope
    // are dropped). Keeps the answer even when the free tier narrates first.
    const parts = [];
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.part?.type === 'text' && typeof event.part.text === 'string') {
          parts.push(event.part.text);
        }
      } catch (_) { /* not an event line */ }
    }
    if (parts.length) return parts.join('\n').trim();
    return text;
  }
  return text;
}

function sanitisedEnv() {
  // Never hand the Hub's API keys, worker tokens, or mail credentials to a model CLI.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: process.env.TERM || 'dumb',
  };
}

function runProcess({ command, args, input, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: sanitisedEnv(),
    });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdin.on('error', err => { stderr += `stdin: ${err.message}\n`; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      // Bound memory on runaway outputs.
      if (stdout.length > 2_000_000) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`local subscription runner timed out or overflowed after ${timeoutMs}ms`));
      if (code !== 0) {
        // Some CLIs print failures like "model at capacity" to stdout, leaving
        // stderr empty — include a stdout tail so stored job errors are diagnosable.
        const result = String(stdout).split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(r => r?.type === 'result' || r?.is_error).at(-1);
        const detail = (result ? [result.api_error, result.result, ...(result.errors || [])].filter(Boolean).join(': ').slice(0, 600) : stderr.trim() || stdout.slice(-800)).trim();
        return reject(new Error(`local subscription runner exited ${code}: ${detail}`));
      }
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function boundInput(text, maxChars) {
  const s = String(text || '');
  if (!maxChars || s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n[truncated: input exceeded ${maxChars} characters]`;
}

function fallbackConfig(config) {
  if (!config?.fallbackTo) return null;
  const next = MODELS[config.fallbackTo];
  if (!next) return null;
  if (next.runner === config.runner && next.model === config.model) return null;
  return {
    ...config,
    runner: next.runner,
    model: next.model,
    effort: next.effort || config.effort,
    tier: config.fallbackTo,
    fallbackTo: next.fallbackTo || null,
  };
}

async function runWithConfig(config, { feature, systemPrompt, userPrompt, timeoutMs, documents }) {
  const maxIn = config.maxInputChars || 120000;
  const sys = boundInput(systemPrompt, Math.floor(maxIn * 0.35));
  const user = boundInput(userPrompt, Math.floor(maxIn * 0.65));
  const command = commandFor(config, sys);
  const combined = `${sys}\n\n--- Task input ---\n${user}`;
  let { args } = command;
  let input = user;
  if (config.runner === 'codex') {
    input = combined;
  } else if (config.runner === 'grok' || command.promptArg) {
    // Replace placeholder with the full prompt; feed empty stdin.
    args = args.map(a => (a === '__PROMPT__' ? combined : a));
    input = '';
  }
  let scratch;
  const started = Date.now();
  try {
    if (documents?.length) {
      documentInput(user, documents);
      if (config.runner === 'claude') {
        args = [...args];
        args[args.indexOf('--output-format') + 1] = 'stream-json';
        args.push('--input-format', 'stream-json', '--verbose');
        input = documentInput(user, documents);
      } else if (['codex', 'grok'].includes(config.runner)) {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-notebook-'));
        const pdf = path.join(scratch, 'page.pdf');
        const prefix = path.join(scratch, 'page');
        fs.writeFileSync(pdf, Buffer.from(documents[0].data, 'base64'), { mode: 0o600 });
        await runProcess({ command: process.env.PDFTOPPM_PATH || 'pdftoppm',
          args: ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '3000', '-png', pdf, prefix], input: '', timeoutMs: 30000, cwd: scratch });
        const png = `${prefix}.png`;
        if (!fs.existsSync(png) || fs.statSync(png).size > 12 * 1024 * 1024) throw new Error('Notebook page rendering failed or exceeded 12 MB');
        if (config.runner === 'codex') {
          args = [...args.slice(0, -1), '--image', png, '-'];
        } else {
          const prompt = path.join(scratch, 'prompt.json');
          fs.writeFileSync(prompt, JSON.stringify({ type: 'acp', content: [
            { type: 'text', text: combined },
            { type: 'image', mimeType: 'image/png', data: fs.readFileSync(png).toString('base64') },
          ] }), { mode: 0o600 });
          args = [...args];
          args.splice(args.indexOf('--single'), 2, '--prompt-file', prompt);
        }
      } else throw new Error(`Notebook images are unsupported by ${config.runner}`);
    }
    const limit = timeoutMs || config.timeoutMs || 180000;
    const stdout = await runProcess({ command: command.command, args, input, timeoutMs: limit, cwd: scratch });
    const text = textFromOutput(config, stdout);
    if (!text) throw new Error('local subscription runner returned no text');
    if (feature === 'crm_boox_read') {
      let parsed;
      try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
      if (typeof parsed?.text !== 'string' || typeof parsed?.uncertain !== 'boolean' || parsed.text.length > 30000) {
        throw new Error(`${config.runner} returned an invalid notebook transcription`);
      }
    }
    const maxOut = config.maxOutputChars || 32000;
    return { text: text.length > maxOut ? text.slice(0, maxOut) : text,
      runner: config.runner, model: config.model, effort: config.effort, tier: config.tier,
      feature, durationMs: Date.now() - started };
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function runSubscriptionText({
  feature,
  systemPrompt,
  userPrompt,
  timeoutMs,
  force = false,
  config: configOverride = null,
  documents = null,
} = {}) {
  const config = configOverride || configuredRunner(feature, { force });
  if (!config) return null;

  if (documents) documentInput('', documents);
  const tried = new Set(), failures = [], chain = [];
  let lane = config;
  while (lane && !tried.has(lane.runner)) {
    tried.add(lane.runner);
    const name = `${lane.runner}/${lane.model}`;
    chain.push(name);
    try {
      const result = await runWithConfig(lane, { feature, systemPrompt, userPrompt, timeoutMs, documents });
      return failures.length ? { ...result, fallbackFrom: chain[0], fallbackChain: chain } : result;
    } catch (err) {
      failures.push(`${name}: ${String(err.message).slice(0, 300)}`);
      const next = fallbackConfig(lane);
      if (next && !tried.has(next.runner)) console.warn(`[subscription-agent] ${feature}: ${name} failed; trying ${next.runner}/${next.model}`);
      lane = next;
    }
  }
  throw new Error(failures.join('; then '));
}

function documentInput(text, documents) {
  if (!Array.isArray(documents) || documents.length !== 1) throw new Error('Read one notebook page at a time');
  const data = documents[0]?.data;
  if (typeof data !== 'string' || data.length > 1200000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      || !Buffer.from(data, 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid or oversized notebook PDF');
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'text', text }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
  ] }, parent_tool_use_id: null }) + '\n';
}

module.exports = {
  documentInput,
  fallbackConfig,
  RUNNERS,
  LEGACY_ENV,
  configuredRunner,
  commandFor,
  textFromOutput,
  runSubscriptionText,
  cliAvailable,
  sanitisedEnv,
  boundInput,
};
