'use strict';

// Subscription-backed model execution via authenticated CLIs.
// Codex / Claude / Grok authenticate through their own sessions under HOME.
// This module never receives Hub API keys, mail credentials, or DB access.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { resolveFeatureRunner } = require('./feature-runners');

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
  };
}

function commandFor(config, systemPrompt) {
  if (config.runner === 'claude') {
    const args = [
      '--print',
      '--model', config.model,
      '--effort', config.effort || 'high',
    ];
    if (!config.allowTools) args.push('--tools', '');
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
        '--sandbox', 'read-only',
        '--ephemeral',
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
      '--sandbox', 'off',
      '--output-format', 'plain',
      '--max-turns', config.allowTools ? '12' : '8',
    ];
    // Research features may use controlled web search; everything else is tool-disabled.
    if (!config.allowTools) {
      args.push('--disable-web-search', '--disallowed-tools', 'Shell,Bash,Edit,Write,MultiEdit');
    } else {
      args.push('--disallowed-tools', 'Shell,Bash,Edit,Write,MultiEdit');
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
    try {
      const parsed = JSON.parse(text);
      return String(parsed.result || parsed.text || '').trim();
    } catch (_) { return text; }
  }
  if (config.runner === 'grok') {
    // Grok --print may wrap in JSON; prefer raw text body.
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') return parsed;
      return String(parsed.result || parsed.text || parsed.content || text).trim();
    } catch (_) { return text; }
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

function runProcess({ command, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      if (code !== 0) return reject(new Error(`local subscription runner exited ${code}: ${stderr.slice(-800)}`));
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

async function runSubscriptionText({
  feature,
  systemPrompt,
  userPrompt,
  timeoutMs,
  force = false,
  config: configOverride = null,
} = {}) {
  const config = configOverride || configuredRunner(feature, { force });
  if (!config) return null;

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
  const started = Date.now();
  const limit = timeoutMs || config.timeoutMs || 180000;
  const stdout = await runProcess({ command: command.command, args, input, timeoutMs: limit });
  const text = textFromOutput(config, stdout);
  if (!text) throw new Error('local subscription runner returned no text');
  const maxOut = config.maxOutputChars || 32000;
  return {
    text: text.length > maxOut ? text.slice(0, maxOut) : text,
    runner: config.runner,
    model: config.model,
    effort: config.effort,
    tier: config.tier,
    feature,
    durationMs: Date.now() - started,
  };
}

module.exports = {
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
