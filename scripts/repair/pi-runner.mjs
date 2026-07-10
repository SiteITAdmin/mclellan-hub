// Pi coding-agent runner for the self-repair venue. Spawned as a child
// process by lib/repair-venue.js — never imported by the Hub (the SDK is
// ESM-only and the Hub is CommonJS, and a separate process is what makes the
// 5-minute timeout enforceable with a kill).
//
// Sandbox properties enforced here:
//   - cwd is the throwaway git worktree; Pi gets file tools only (no bash),
//     so it cannot run shell, hit the network, or leave the worktree via
//     commands. Path escapes are caught by the orchestrator's post-fix diff
//     check (only worktree files can appear in it).
//   - The OpenRouter key arrives via environment and is interpolated by pi's
//     models.json loader — it is never written to disk and the agent has no
//     tool that could read the environment.
//   - All model calls go to OpenRouter under the AT-RepairAgent task code
//     headers, so spend shows up in the token-burn dashboard like every
//     other Hub agent.
//   - The cost cap is a real-time brake: usage is summed from the event
//     stream after every turn and the session is aborted the moment the cap
//     is crossed.
//
// Usage: node pi-runner.mjs --job <path-to-job.json>
// Job file: { worktree, modelId, prompt, systemPrompt, costCapUsd, pricing }
// Emits JSONL progress on stdout; final line is {type:"result", ...}.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const jobPath = argValue('--job');
if (!jobPath) {
  emit({ type: 'result', status: 'error', error: 'missing --job' });
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));

if (!process.env.OPENROUTER_API_KEY) {
  emit({ type: 'result', status: 'error', error: 'OPENROUTER_API_KEY not set' });
  process.exit(2);
}

// Scratch agent dir so nothing from the user's ~/.pi (settings, extensions,
// skills, sessions) leaks into the repair session, and nothing persists.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-repair-pi-'));

// A dedicated provider entry pointed at OpenRouter with the Hub's
// attribution headers. `$OPENROUTER_API_KEY` is interpolated by pi at
// request time from this process's environment — the key is not in the file.
const providerId = 'hub-openrouter';
const modelsJson = {
  providers: {
    [providerId]: {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKey: '$OPENROUTER_API_KEY',
      headers: job.headers || {},
      models: [
        {
          id: job.modelId,
          name: `Hub repair agent (${job.modelId})`,
          reasoning: false,
          input: ['text'],
          contextWindow: job.contextWindow || 200000,
          maxTokens: job.maxTokens || 32000,
          // USD per million tokens; missing pricing falls back to a
          // deliberately expensive estimate so the brake errs on the side
          // of stopping early rather than never.
          cost: {
            input: job.pricing?.input ?? 5,
            output: job.pricing?.output ?? 15,
            cacheRead: job.pricing?.cacheRead ?? job.pricing?.input ?? 5,
            cacheWrite: job.pricing?.cacheWrite ?? 0,
          },
        },
      ],
    },
  },
};
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify(modelsJson, null, 2));

const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
const modelRegistry = ModelRegistry.create(authStorage, path.join(agentDir, 'models.json'));
const model = modelRegistry.find(providerId, job.modelId);
if (!model) {
  emit({ type: 'result', status: 'error', error: `model ${job.modelId} not registered` });
  process.exit(2);
}

const loader = new DefaultResourceLoader({
  cwd: job.worktree,
  agentDir,
  systemPromptOverride: () => job.systemPrompt,
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: job.worktree,
  agentDir,
  authStorage,
  modelRegistry,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  model,
  // File tools only: no bash. The orchestrator runs the tests; the agent
  // writes code.
  tools: ['read', 'edit', 'write', 'grep', 'find', 'ls'],
});

const costCap = Number(job.costCapUsd || 2);
let costSoFar = 0;
let turns = 0;
let abortedForCost = false;
let assistantText = '';

session.subscribe((event) => {
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    assistantText = (assistantText + event.assistantMessageEvent.delta).slice(-4000);
  }
  if (event.type === 'turn_end') {
    turns += 1;
    const usage = event.message?.usage;
    if (usage?.cost?.total) costSoFar += usage.cost.total;
    emit({ type: 'turn', turns, costUsd: Number(costSoFar.toFixed(4)) });
    if (costSoFar >= costCap && !abortedForCost) {
      abortedForCost = true;
      emit({ type: 'cost_cap', costUsd: costSoFar, capUsd: costCap });
      session.abort().catch(() => {});
    }
  }
  if (event.type === 'tool_execution_end') {
    emit({ type: 'tool', tool: event.toolName, isError: !!event.isError });
  }
});

let runError = null;
try {
  await session.prompt(job.prompt);
} catch (err) {
  runError = String(err?.message || err);
}

const errorMessage = session.agent?.state?.errorMessage || null;
emit({
  type: 'result',
  status: abortedForCost ? 'aborted_cost' : (runError ? 'error' : 'done'),
  costUsd: Number(costSoFar.toFixed(4)),
  turns,
  error: runError || errorMessage,
  // Tail of the agent's prose — the only way to diagnose a session that
  // talked instead of acting.
  assistantText: assistantText.slice(-2000),
});

session.dispose();
try { fs.rmSync(agentDir, { recursive: true, force: true }); } catch { /* scratch */ }
process.exit(0);
