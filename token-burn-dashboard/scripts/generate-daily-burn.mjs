import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const home = process.env.HOME || "/Users/dm_mini";
const timezone = process.env.TOKEN_BURN_TIMEZONE || "Europe/Dublin";

const outputPath = join(projectRoot, "data", "daily-burn.sample.json");
const openRouterSummaryPath = join(projectRoot, "data", "openrouter-activity.summary.json");
const openRouterLiveDailyPath = join(projectRoot, "data", "openrouter-live.daily.json");
const deployDataDir = join(projectRoot, "deploy-data");
const deployOutputPath = join(deployDataDir, "daily-burn.sample.json");
const deployOpenRouterSummaryPath = join(deployDataDir, "openrouter-activity.summary.json");
const hubRoot = join(home, "Documents", "mclellan hub");
const openRouterSummary = {
  rows: 0,
  exported_generations: 0,
  zero_token_generations: 0,
  tokens: 0,
  cost_usd: 0,
  cost_web_search_usd: 0,
  cost_file_processing_usd: 0,
  byok_usage_inference_usd: 0,
  export_first_at: null,
  export_last_at: null,
  by_model: {},
  by_provider: {},
  by_app: {},
};

const sources = {
  codex: join(home, ".codex", "sessions"),
  claudeCode: join(home, ".claude", "projects"),
  antigravity: join(home, ".agy-usage", "statusline-events.jsonl"),
  // Grok Build / Grok CLI: native unified log (shell.turn.inference_done carries per-turn tokens).
  // Same role as Codex sessions / Claude projects — scrape measured usage, do not invent estimates.
  grokBuild: join(home, ".grok", "logs", "unified.jsonl"),
  downloads: join(home, "Downloads"),
  hubImportDb: join(hubRoot, "data", "dchat-import", "db", "hub.db"),
  hubCurrentDb: join(hubRoot, "data", "hub.db"),
  synthadocKnowledgeDb: join(
    hubRoot,
    "data",
    "synthadoc",
    "mclellan-hub-knowledge",
    ".synthadoc",
    "audit.db",
  ),
  synthadocHistoryDb: join(
    hubRoot,
    "data",
    "synthadoc",
    "history-of-computing",
    ".synthadoc",
    "audit.db",
  ),
};

const rows = new Map();
const manualBackfills = [
  {
    date: "2026-06-20",
    antigravity_tokens: 3_000_000,
    antigravity_estimated: true,
    evidence: "Antigravity rough estimate from local watchlist build transcripts, generation metadata, and step count",
  },
];

collectCodex();
collectClaudeCode();
collectAntigravity();
collectGrokBuild();
const openRouterExportRows = collectOpenRouterExports();
collectOpenRouterManagementDaily();
if (openRouterExportRows === 0) collectHubApi();
collectSynthadocApi();
applyManualBackfills();

const normalized = Array.from(rows.values())
  .map((row) => ({
    date: row.date,
    codex_tokens: row.codex_tokens,
    claude_code_tokens: row.claude_code_tokens,
    claude_code_calls: row.claude_code_calls,
    antigravity_tokens: row.antigravity_tokens,
    antigravity_events: row.antigravity_events,
    antigravity_estimated: row.antigravity_estimated,
    grok_build_tokens: row.grok_build_tokens,
    grok_build_events: row.grok_build_events,
    api_tokens: row.api_tokens,
    chatgpt_conversations: 0,
    chatgpt_messages: 0,
    chatgpt_files: 0,
    claude_chat_conversations: 0,
    claude_chat_messages: 0,
    chat_tokens_low: 0,
    chat_tokens_high: 0,
    confidence: row.antigravity_estimated ? "rough" : "measured",
    driver: inferDriver(row),
    evidence: buildEvidence(row),
  }))
  .filter((row) => row.codex_tokens + row.claude_code_tokens + row.antigravity_tokens + row.grok_build_tokens + row.api_tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date));

const dailyJson = `${JSON.stringify(normalized, null, 2)}\n`;
const openRouterJson = `${JSON.stringify(finalizeOpenRouterSummary(), null, 2)}\n`;
mkdirSync(deployDataDir, { recursive: true });
writeFileSync(outputPath, dailyJson);
writeFileSync(openRouterSummaryPath, openRouterJson);
writeFileSync(deployOutputPath, dailyJson);
writeFileSync(deployOpenRouterSummaryPath, openRouterJson);

const exactTotal = normalized.reduce(
  (sum, row) => sum + row.codex_tokens + row.claude_code_tokens + row.antigravity_tokens + row.grok_build_tokens + row.api_tokens,
  0,
);

console.log(`Wrote ${normalized.length} rows to ${outputPath}`);
console.log(`Wrote OpenRouter summary to ${openRouterSummaryPath}`);
console.log(`Wrote deploy-safe scrubbed copies to ${deployDataDir}`);
console.log(`Imported burn tokens: ${exactTotal}`);
console.log("Chat activity and estimate lanes are intentionally empty until exports/interview answers are added.");

function collectCodex() {
  if (!existsSync(sources.codex)) return;

  for (const file of walkJsonl(sources.codex)) {
    const lastByDate = new Map();

    for (const event of readJsonLines(file)) {
      if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") continue;

      const total = Number(
        event?.payload?.info?.total_token_usage?.total_tokens ||
          event?.payload?.info?.last_token_usage?.total_tokens ||
          0,
      );
      if (total <= 0) continue;

      const date = toLocalDate(event.timestamp);
      if (!date) continue;

      const existing = lastByDate.get(date) || 0;
      if (total > existing) lastByDate.set(date, total);
    }

    for (const [date, total] of lastByDate) {
      const row = rowFor(date);
      row.codex_tokens += total;
      row.codex_sessions += 1;
    }
  }
}

function applyManualBackfills() {
  for (const backfill of manualBackfills) {
    const row = rowFor(backfill.date);
    row.antigravity_tokens += Number(backfill.antigravity_tokens || 0);
    row.antigravity_estimated = Boolean(backfill.antigravity_estimated);
    if (backfill.evidence) row.manual_evidence.push(backfill.evidence);
  }
}

function collectClaudeCode() {
  if (!existsSync(sources.claudeCode)) return;

  const messages = new Map();

  for (const file of walkJsonl(sources.claudeCode)) {
    for (const event of readJsonLines(file)) {
      const usage = event?.message?.usage;
      const id = event?.message?.id;
      const timestamp = event?.timestamp;
      if (!usage || !id || !timestamp) continue;

      const total =
        Number(usage.input_tokens || 0) +
        Number(usage.output_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0) +
        Number(usage.cache_read_input_tokens || 0);
      if (total <= 0) continue;

      const date = toLocalDate(timestamp);
      if (!date) continue;

      const current = messages.get(id);
      if (!current || total > current.total) {
        messages.set(id, { date, total });
      }
    }
  }

  for (const { date, total } of messages.values()) {
    const row = rowFor(date);
    row.claude_code_tokens += total;
    row.claude_code_calls += 1;
  }
}

function collectAntigravity() {
  if (!existsSync(sources.antigravity)) return;

  const events = new Map();

  for (const event of readJsonLines(sources.antigravity)) {
    const date = toLocalDate(findTimestamp(event));
    if (!date) continue;

    const total = extractAntigravityTokens(event);
    if (total <= 0) continue;

    const key = `${date}:${findEventKey(event) || events.size}`;
    const current = events.get(key);
    if (!current || total > current.total) {
      events.set(key, { date, total });
    }
  }

  for (const { date, total } of events.values()) {
    const row = rowFor(date);
    row.antigravity_tokens += total;
    row.antigravity_events += 1;
  }
}

/**
 * Grok Build / Grok CLI coding sessions.
 * Each shell.turn.inference_done event reports the full prompt size for that
 * turn (including cache hits). Counting full prompt_tokens would massively
 * double-count a growing context window. Billable work is the uncached prompt
 * delta plus new completion tokens — the same spirit as Claude Code's
 * per-message usage sums, not Codex's max-session counter.
 */
function collectGrokBuild() {
  if (!existsSync(sources.grokBuild)) return;

  const seen = new Set();

  for (const event of readJsonLines(sources.grokBuild)) {
    if (event?.msg !== "shell.turn.inference_done") continue;

    const ctx = event.ctx && typeof event.ctx === "object" ? event.ctx : {};
    const prompt = Number(ctx.prompt_tokens || 0);
    const cached = Number(ctx.cached_prompt_tokens || 0);
    const completion = Number(ctx.completion_tokens || 0);
    // reasoning_tokens is usually a subset of completion; do not add it again.
    const uncachedPrompt = Math.max(0, prompt - cached);
    const total = uncachedPrompt + completion;
    if (total <= 0) continue;

    const date = toLocalDate(event.ts || event.timestamp || "");
    if (!date) continue;

    // Dedup if the unified log is re-appended or we re-process the same turn.
    const key = [
      event.sid || "",
      event.pid || "",
      event.ts || "",
      ctx.loop_index ?? "",
      prompt,
      completion,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);

    const row = rowFor(date);
    row.grok_build_tokens += total;
    row.grok_build_events += 1;
  }
}

function collectHubApi() {
  for (const dbPath of [sources.hubImportDb, sources.hubCurrentDb]) {
    if (!existsSync(dbPath)) continue;

    const sql = `
      SELECT date(ts, 'unixepoch', 'localtime') AS day,
             COALESCE(SUM(tokens_in), 0) + COALESCE(SUM(tokens_out), 0) AS tokens
      FROM request_logs
      GROUP BY day
      HAVING tokens > 0
      ORDER BY day;
    `;

    for (const line of sqliteLines(dbPath, sql)) {
      const [date, tokens] = line.split("|");
      if (!date) continue;
      const row = rowFor(date);
      row.api_tokens += Number(tokens || 0);
      row.hub_api_days += 1;
    }
  }
}

function collectOpenRouterExports() {
  if (!existsSync(sources.downloads)) return 0;

  const files = readdirSync(sources.downloads)
    .filter((name) => /^openrouter_activity_.*\.csv$/i.test(name))
    .map((name) => join(sources.downloads, name));
  const seen = new Set();
  let imported = 0;

  for (const file of files) {
    const records = parseCsv(readFileSync(file, "utf8"));
    for (const record of records) {
      const id = record.generation_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const date = toLocalDate(record.created_at);
      if (!date) continue;

      const prompt = Number(record.tokens_prompt || 0);
      const completion = Number(record.tokens_completion || 0);
      const reasoning = Number(record.tokens_reasoning || 0);
      const cached = Number(record.tokens_cached || 0);
      const tokens = prompt + completion + reasoning + cached;
      const cost = Number(record.cost_total || 0);
      const webSearchCost = Number(record.cost_web_search || 0);
      const fileProcessingCost = Number(record.cost_file_processing || 0);
      const byokUsage = Number(record.byok_usage_inference || 0);

      const row = rowFor(date);
      if (tokens > 0) row.api_tokens += tokens;
      row.openrouter_export_rows += 1;
      row.openrouter_cost_usd += cost;
      addOpenRouterSummary("by_model", record.model_permaslug || "unknown", tokens, cost);
      addOpenRouterSummary("by_provider", record.provider_name || "unknown", tokens, cost);
      addOpenRouterSummary("by_app", normalizeOpenRouterApp(record.app_name), tokens, cost);
      trackOpenRouterExportWindow(record.created_at);
      openRouterSummary.exported_generations += 1;
      if (tokens <= 0) openRouterSummary.zero_token_generations += 1;
      openRouterSummary.rows += 1;
      openRouterSummary.tokens += tokens;
      openRouterSummary.cost_usd += cost;
      openRouterSummary.cost_web_search_usd += webSearchCost;
      openRouterSummary.cost_file_processing_usd += fileProcessingCost;
      openRouterSummary.byok_usage_inference_usd += byokUsage;
      imported += 1;
    }
  }

  return imported;
}

function collectOpenRouterManagementDaily() {
  if (!existsSync(openRouterLiveDailyPath)) return 0;
  let payload;
  try {
    payload = JSON.parse(readFileSync(openRouterLiveDailyPath, "utf8"));
  } catch {
    return 0;
  }
  if (payload?.source !== "openrouter_management_api" || !Array.isArray(payload.days)) return 0;

  const exportLastDate = String(openRouterSummary.export_last_at || "").slice(0, 10);
  let imported = 0;
  for (const item of payload.days) {
    const date = String(item?.date || "").slice(0, 10);
    const tokens = Number(item?.tokens || 0);
    // The downloaded CSV remains the historical baseline. Management data owns
    // each later daily bucket, so the two sources never double-count.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || tokens <= 0 || (exportLastDate && date <= exportLastDate)) continue;
    const row = rowFor(date);
    row.api_tokens += tokens;
    row.openrouter_management_days += 1;
    imported += 1;
  }
  return imported;
}

function addOpenRouterSummary(bucket, key, tokens, cost) {
  const safeKey = String(key || "unknown").slice(0, 120);
  openRouterSummary[bucket][safeKey] ||= { label: safeKey, tokens: 0, cost_usd: 0, calls: 0 };
  openRouterSummary[bucket][safeKey].tokens += tokens;
  openRouterSummary[bucket][safeKey].cost_usd += cost;
  openRouterSummary[bucket][safeKey].calls += 1;
}

function normalizeOpenRouterApp(appName) {
  const value = String(appName || "").trim();
  return value || "Legacy-Unattributed";
}

function trackOpenRouterExportWindow(createdAt) {
  const value = String(createdAt || "").trim();
  if (!value) return;
  if (!openRouterSummary.export_first_at || value < openRouterSummary.export_first_at) {
    openRouterSummary.export_first_at = value;
  }
  if (!openRouterSummary.export_last_at || value > openRouterSummary.export_last_at) {
    openRouterSummary.export_last_at = value;
  }
}

function finalizeOpenRouterSummary() {
  const sortBucket = (bucket) =>
    Object.values(bucket)
      .sort((a, b) => b.tokens - a.tokens);

  return {
    rows: openRouterSummary.rows,
    exported_generations: openRouterSummary.exported_generations,
    zero_token_generations: openRouterSummary.zero_token_generations,
    tokens: openRouterSummary.tokens,
    cost_usd: openRouterSummary.cost_usd,
    cost_web_search_usd: openRouterSummary.cost_web_search_usd,
    cost_file_processing_usd: openRouterSummary.cost_file_processing_usd,
    byok_usage_inference_usd: openRouterSummary.byok_usage_inference_usd,
    export_first_at: openRouterSummary.export_first_at,
    export_last_at: openRouterSummary.export_last_at,
    by_model: sortBucket(openRouterSummary.by_model),
    by_provider: sortBucket(openRouterSummary.by_provider),
    by_app: sortBucket(openRouterSummary.by_app),
  };
}

function collectSynthadocApi() {
  for (const dbPath of [sources.synthadocKnowledgeDb, sources.synthadocHistoryDb]) {
    if (!existsSync(dbPath)) continue;

    const ingestSql = `
      SELECT substr(ingested_at, 1, 10) AS day,
             COALESCE(SUM(tokens), 0) AS tokens
      FROM ingests
      GROUP BY day
      HAVING tokens > 0
      ORDER BY day;
    `;
    const querySql = `
      SELECT substr(queried_at, 1, 10) AS day,
             COALESCE(SUM(tokens), 0) AS tokens
      FROM queries
      GROUP BY day
      HAVING tokens > 0
      ORDER BY day;
    `;

    for (const sql of [ingestSql, querySql]) {
      for (const line of sqliteLines(dbPath, sql)) {
        const [date, tokens] = line.split("|");
        if (!date) continue;
        const row = rowFor(date);
        row.api_tokens += Number(tokens || 0);
        row.synthadoc_days += 1;
      }
    }
  }
}

function rowFor(date) {
  if (!rows.has(date)) {
    rows.set(date, {
      date,
      codex_tokens: 0,
      codex_sessions: 0,
      claude_code_tokens: 0,
      claude_code_calls: 0,
      antigravity_tokens: 0,
      antigravity_events: 0,
      antigravity_estimated: false,
      grok_build_tokens: 0,
      grok_build_events: 0,
      api_tokens: 0,
      hub_api_days: 0,
      openrouter_export_rows: 0,
      openrouter_management_days: 0,
      openrouter_cost_usd: 0,
      synthadoc_days: 0,
      manual_evidence: [],
    });
  }
  return rows.get(date);
}

function inferDriver(row) {
  const codeAgentTokens = row.codex_tokens + row.claude_code_tokens + row.antigravity_tokens + row.grok_build_tokens;
  const total = codeAgentTokens + row.api_tokens;
  if (row.api_tokens > codeAgentTokens) return "hub ingestion";
  if (
    row.grok_build_tokens >= row.codex_tokens &&
    row.grok_build_tokens >= row.claude_code_tokens &&
    row.grok_build_tokens >= row.antigravity_tokens &&
    row.grok_build_tokens > 0
  ) return "Grok Build development";
  if (row.antigravity_tokens >= row.codex_tokens && row.antigravity_tokens >= row.claude_code_tokens && row.antigravity_tokens > 0) return "Antigravity development";
  if (row.codex_tokens >= row.claude_code_tokens && row.codex_tokens > 0) return "shipping";
  if (row.claude_code_tokens > 0 && total >= 100_000) return "Hub Development";
  if (row.claude_code_tokens > 0) return "review";
  return "admin";
}

function buildEvidence(row) {
  const parts = [];
  if (row.codex_tokens > 0) parts.push("Codex session token counters");
  if (row.claude_code_tokens > 0) parts.push("Claude Code message usage");
  if (row.antigravity_events > 0) parts.push("Antigravity status line telemetry");
  if (row.grok_build_events > 0) parts.push("Grok Build unified log inference turns");
  if (row.manual_evidence.length) parts.push(...row.manual_evidence);
  if (row.hub_api_days > 0) parts.push("McLellan hub request logs");
  if (row.openrouter_export_rows > 0) parts.push("OpenRouter activity export");
  if (row.openrouter_management_days > 0) parts.push("OpenRouter management API daily activity");
  if (row.synthadoc_days > 0) parts.push("Synthadoc audit logs");
  return parts.join("; ");
}

function extractAntigravityTokens(event) {
  const usage = findUsageObject(event);
  if (!usage) return 0;

  const directTotal = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    usage.tokens_total,
    usage.tokensTotal,
    usage.total,
    usage.cumulative_total_tokens,
    usage.cumulativeTotalTokens,
  );
  if (directTotal > 0) return directTotal;

  const contextTotal =
    firstNumber(usage.total_input_tokens, usage.totalInputTokens) +
    firstNumber(usage.total_output_tokens, usage.totalOutputTokens);
  if (contextTotal > 0) return contextTotal;

  return (
    firstNumber(usage.prompt_tokens, usage.input_tokens, usage.inputTokens, usage.tokens_prompt) +
    firstNumber(usage.completion_tokens, usage.output_tokens, usage.outputTokens, usage.candidate_tokens, usage.tokens_completion) +
    firstNumber(usage.reasoning_tokens, usage.thinking_tokens, usage.thinkingTokens, usage.tokens_reasoning) +
    firstNumber(usage.cached_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.tokens_cached)
  );
}

function findUsageObject(event) {
  return (
    firstObject(event?.token_usage) ||
    firstObject(event?.usage) ||
    firstObject(event?.usage_metadata) ||
    firstObject(event?.usageMetadata) ||
    firstObject(event?.model?.usage) ||
    firstObject(event?.agent?.usage) ||
    firstObject(event?.session?.usage) ||
    firstObject(event?.turn?.usage) ||
    firstObject(event?.metadata?.token_usage) ||
    firstObject(event?.metadata?.usage) ||
    firstObject(event?.payload?.token_usage) ||
    firstObject(event?.payload?.usage) ||
    firstObject(event?.payload?.usage_metadata) ||
    firstObject(event?.context_window) ||
    firstObject(event?.contextWindow) ||
    firstObject(event?.payload?.context_window) ||
    firstObject(event?.payload?.contextWindow)
  );
}

function findTimestamp(event) {
  return (
    event?.timestamp ||
    event?.logged_at ||
    event?.loggedAt ||
    event?.created_at ||
    event?.createdAt ||
    event?.time ||
    event?.ts ||
    event?.payload?.timestamp ||
    event?.payload?.logged_at ||
    event?.payload?.loggedAt ||
    event?.metadata?.timestamp ||
    ""
  );
}

function findEventKey(event) {
  return (
    event?.turn_id ||
    event?.turnId ||
    event?.message_id ||
    event?.messageId ||
    event?.generation_id ||
    event?.generationId ||
    event?.session_id ||
    event?.sessionId ||
    event?.conversation_id ||
    event?.conversationId ||
    event?.id ||
    event?.payload?.turn_id ||
    event?.payload?.turnId ||
    event?.payload?.message_id ||
    event?.payload?.messageId ||
    event?.payload?.generation_id ||
    event?.payload?.generationId ||
    event?.payload?.session_id ||
    event?.payload?.sessionId ||
    event?.payload?.conversation_id ||
    event?.payload?.conversationId ||
    event?.payload?.id ||
    ""
  );
}

function firstObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function parseCsv(text) {
  const rows = [];
  const parsed = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      parsed.push(row);
      field = "";
      row = [];
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    parsed.push(row);
  }

  const headers = parsed.shift() || [];
  for (const values of parsed) {
    if (!values.length || values.every((value) => !value)) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  }

  return rows;
}

function walkJsonl(root) {
  const files = [];
  const entries = readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    const next = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonl(next));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(next);
    }
  }

  return files;
}

function readJsonLines(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function sqliteLines(dbPath, sql) {
  try {
    return execFileSync("sqlite3", ["-separator", "|", dbPath, sql], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    console.warn(`Skipped sqlite source: ${dbPath}`);
    console.warn(error.message);
    return [];
  }
}

function toLocalDate(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
