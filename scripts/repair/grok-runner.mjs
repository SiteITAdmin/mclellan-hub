// Grok CLI runner for the self-repair venue. It is spawned by
// lib/repair-venue.js, never imported by the Hub. The worktree and the
// orchestrator's diff/gate checks remain the authority on what it can change.
//
// The CLI runs through the locally authenticated subscription, so it has no
// OpenRouter key or API billing path. It receives only the home directory
// needed for that authentication plus the worktree cwd; web, memory,
// subagents, planning, and shell tools are disabled.

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

const grokCli = process.env.GROK_CLI_PATH || path.join(os.homedir(), '.grok', 'bin', 'grok');
if (!fs.existsSync(grokCli)) {
  emit({ type: 'result', status: 'error', error: `Grok CLI not found at ${grokCli}` });
  process.exit(2);
}

const args = [
  '--single', job.prompt,
  '--cwd', job.worktree,
  '--model', job.modelId,
  '--system-prompt-override', job.systemPrompt,
  '--max-turns', String(job.maxTurns || 12),
  '--output-format', 'json',
  '--tools', 'Read,Edit,Write,Glob,Grep',
  '--no-memory',
  '--no-plan',
  '--no-subagents',
  '--disable-web-search',
  '--permission-mode', 'auto',
];

const child = spawn(grokCli, args, {
  cwd: job.worktree,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GROK_CLI_PATH: grokCli,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.on('error', (error) => {
  emit({ type: 'result', status: 'error', turns: 0, error: `failed to start Grok CLI: ${error.message}` });
});
child.on('close', (code) => {
  if (code !== 0) {
    emit({ type: 'result', status: 'error', turns: 0, error: `Grok CLI exited ${code}: ${stderr.slice(-1000)}` });
    return;
  }
  try {
    const result = JSON.parse(stdout);
    emit({
      type: 'result',
      status: 'done',
      costUsd: Number(result.total_cost_usd || 0),
      turns: Number(result.num_turns || result.numTurns || 0),
      assistantText: String(result.text || '').slice(-2000),
    });
  } catch (error) {
    emit({ type: 'result', status: 'error', turns: 0, error: `failed to parse Grok CLI output: ${error.message}` });
  }
});
