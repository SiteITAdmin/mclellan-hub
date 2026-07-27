'use strict';

// Local subscription-backed model execution for the Mac mini. This deliberately
// does not know an API key: Codex and Claude authenticate through their own CLIs.

const { spawn } = require('child_process');

const RUNNERS = Object.freeze({
  nakai_daily_briefing: Object.freeze({ env: 'NAKAI_DAILY_BRIEFING_RUNNER', runner: 'claude', model: 'opus', effort: 'high' }),
  cross_entity_synthesis: Object.freeze({ env: 'CROSS_ENTITY_SYNTHESIS_RUNNER', runner: 'codex', model: 'gpt-5.6-luna', effort: 'medium' }),
});

function configuredRunner(feature) {
  const config = RUNNERS[feature];
  if (!config) return null;
  const selected = String(process.env[config.env] || 'auto').trim().toLowerCase();
  // `auto` makes a Mac-hosted Hub subscription-first without accidentally
  // trying a local CLI on the VPS. Set `off` to force the API path.
  if (selected === 'off' || selected === 'false') return null;
  if (selected !== config.runner && !(selected === 'auto' && process.platform === 'darwin')) return null;
  return config;
}

function commandFor(config, systemPrompt) {
  if (config.runner === 'claude') return {
    command: process.env.CLAUDE_CLI_PATH || 'claude',
    args: ['--print', '--model', config.model, '--effort', config.effort, '--tools', '', '--permission-mode', 'dontAsk', '--system-prompt', systemPrompt, '--output-format', 'json'],
  };
  if (config.runner === 'codex') return {
    command: process.env.CODEX_CLI_PATH || 'codex',
    args: ['exec', '--model', config.model, '--config', `model_reasoning_effort=${config.effort}`, '--sandbox', 'read-only', '--ephemeral', '-'],
  };
  throw new Error(`Unsupported local subscription runner: ${config.runner}`);
}

function textFromOutput(config, stdout) {
  const text = String(stdout || '').trim();
  if (!text || config.runner !== 'claude') return text;
  try {
    const parsed = JSON.parse(text);
    return String(parsed.result || parsed.text || '').trim();
  } catch (_) { return text; }
}

function runProcess({ command, args, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Never hand the Hub's API keys, worker tokens, or mail credentials to a
    // model CLI. Its own subscription session is discovered under HOME.
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || 'en_US.UTF-8' },
    });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`local subscription runner timed out after ${timeoutMs}ms`));
      if (code !== 0) return reject(new Error(`local subscription runner exited ${code}: ${stderr.slice(-800)}`));
      resolve(stdout);
    });
    child.stdin.end(input);
  });
}

async function runSubscriptionText({ feature, systemPrompt, userPrompt, timeoutMs = 300000 } = {}) {
  const config = configuredRunner(feature);
  if (!config) return null;
  const command = commandFor(config, systemPrompt);
  const input = config.runner === 'codex' ? `${systemPrompt}\n\n--- Task input ---\n${userPrompt}` : userPrompt;
  const started = Date.now();
  const stdout = await runProcess({ ...command, input, timeoutMs });
  const text = textFromOutput(config, stdout);
  if (!text) throw new Error('local subscription runner returned no text');
  return { text, runner: config.runner, model: config.model, effort: config.effort, durationMs: Date.now() - started };
}

module.exports = { RUNNERS, configuredRunner, commandFor, textFromOutput, runSubscriptionText };
