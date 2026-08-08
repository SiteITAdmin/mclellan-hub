// Claude Code CLI runner for the self-repair venue. It is spawned by
// lib/repair-venue.js, never imported by the Hub. The worktree and the
// orchestrator's diff/gate checks remain the authority on what it can change.
//
// The CLI runs through the locally authenticated Claude subscription, so it has
// no OpenRouter key or API billing path. It receives only the home directory
// needed for that authentication plus the worktree cwd; the tool allowlist is
// restricted to read/edit operations — no Bash, web, or subagents — so it can
// only touch files inside the worktree.
//
// Job protocol and result envelope are identical to grok-runner.mjs so the
// orchestrator (runRepairSession) is runner-agnostic: it reads a single
// { type: 'result', status, costUsd, turns, assistantText } JSON line.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const jobPath = argValue('--job');
if (!jobPath) {
  emit({ type: 'result', status: 'error', error: 'missing --job' });
  process.exit(2);
}

let job;
try {
  job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
} catch (error) {
  emit({ type: 'result', status: 'error', error: `invalid job: ${error.message}` });
  process.exit(2);
}

const claudeCli = process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), '.local', 'bin', 'claude');
if (!fs.existsSync(claudeCli)) {
  emit({ type: 'result', status: 'error', error: `Claude Code CLI not found at ${claudeCli}` });
  process.exit(2);
}

// Claude Code has no --max-turns; the venue's outer SIGKILL is the hard bound.
// The tool allowlist is exclusive, so only file read/edit tools are available;
// acceptEdits auto-applies them non-interactively (there is no TTY under -p).
const args = [
  '--print',
  '--model', job.modelId,
  '--system-prompt', job.systemPrompt,
  '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
  '--permission-mode', 'acceptEdits',
  '--output-format', 'json',
  job.prompt,
];

const child = spawn(claudeCli, args, {
  cwd: job.worktree,
  // Mirror lib/subscription-agent.js sanitisedEnv(): the CLI needs USER/LOGNAME/
  // LANG/TERM to authenticate and run non-degraded, but never the Hub's API keys
  // or mail credentials. A minimal PATH+HOME env makes it exit degraded.
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: process.env.TERM || 'dumb',
    CLAUDE_CLI_PATH: claudeCli,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('error', (error) => {
  emit({ type: 'result', status: 'error', turns: 0, error: `failed to start Claude Code CLI: ${error.message}` });
});
child.on('close', (code) => {
  if (code !== 0) {
    emit({ type: 'result', status: 'error', turns: 0, error: `Claude Code CLI exited ${code}: ${stderr.slice(-1000)}` });
    return;
  }
  try {
    const result = JSON.parse(stdout);
    if (result.is_error) {
      emit({ type: 'result', status: 'error', turns: Number(result.num_turns || 0), error: String(result.result || result.subtype || 'reported error').slice(-1000) });
      return;
    }
    emit({
      type: 'result',
      status: 'done',
      costUsd: Number(result.total_cost_usd || 0),
      turns: Number(result.num_turns || 0),
      assistantText: String(result.result || '').slice(-2000),
    });
  } catch (error) {
    emit({ type: 'result', status: 'error', turns: 0, error: `failed to parse Claude Code CLI output: ${error.message}` });
  }
});
