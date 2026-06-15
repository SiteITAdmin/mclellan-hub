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
const deployDataDir = join(projectRoot, "deploy-data");
const deployOutputPath = join(deployDataDir, "daily-burn.sample.json");
const deployOpenRouterSummaryPath = join(deployDataDir, "openrouter-activity.summary.json");
const hubRoot = join(home, "Documents", "mclellan hub");
const openRouterSummary = {
  rows: 0,
  tokens: 0,
  cost_usd: 0,
  by_model: {},
  by_provider: {},
  by_app: {},
};

const sources = {
  codex: join(home, ".codex", "sessions"),
  claudeCode: join(home, ".claude", "projects"),
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

collectCodex();
collectClaudeCode();
const openRouterExportRows = collectOpenRouterExports();
if (openRouterExportRows === 0) collectHubApi();
collectSynthadocApi();

const normalized = Array.from(rows.values())
  .map((row) => ({
    date: row.date,
    codex_tokens: row.codex_tokens,
    claude_code_tokens: row.claude_code_tokens,
    claude_code_calls: row.claude_code_calls,
    api_tokens: row.api_tokens,
    chatgpt_conversations: 0,
    chatgpt_messages: 0,
    chatgpt_files: 0,
    claude_chat_conversations: 0,
    claude_chat_messages: 0,
    chat_tokens_low: 0,
    chat_tokens_high: 0,
    confidence: "measured",
    driver: inferDriver(row),
    evidence: buildEvidence(row),
  }))
  .filter((row) => row.codex_tokens + row.claude_code_tokens + row.api_tokens > 0)
  .sort((a, b) => a.date.localeCompare(b.date));

const dailyJson = `${JSON.stringify(normalized, null, 2)}\n`;
const openRouterJson = `${JSON.stringify(finalizeOpenRouterSummary(), null, 2)}\n`;
mkdirSync(deployDataDir, { recursive: true });
writeFileSync(outputPath, dailyJson);
writeFileSync(openRouterSummaryPath, openRouterJson);
writeFileSync(deployOutputPath, dailyJson);
writeFileSync(deployOpenRouterSummaryPath, openRouterJson);

const exactTotal = normalized.reduce(
  (sum, row) => sum + row.codex_tokens + row.claude_code_tokens + row.api_tokens,
  0,
);

console.log(`Wrote ${normalized.length} rows to ${outputPath}`);
console.log(`Wrote OpenRouter summary to ${openRouterSummaryPath}`);
console.log(`Wrote deploy-safe scrubbed copies to ${deployDataDir}`);
console.log(`Exact measured tokens: ${exactTotal}`);
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
      if (tokens <= 0) continue;
      const cost = Number(record.cost_total || 0);

      const row = rowFor(date);
      row.api_tokens += tokens;
      row.openrouter_export_rows += 1;
      row.openrouter_cost_usd += cost;
      addOpenRouterSummary("by_model", record.model_permaslug || "unknown", tokens, cost);
      addOpenRouterSummary("by_provider", record.provider_name || "unknown", tokens, cost);
      addOpenRouterSummary("by_app", normalizeOpenRouterApp(record.app_name), tokens, cost);
      openRouterSummary.rows += 1;
      openRouterSummary.tokens += tokens;
      openRouterSummary.cost_usd += cost;
      imported += 1;
    }
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

function finalizeOpenRouterSummary() {
  const sortBucket = (bucket) =>
    Object.values(bucket)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 20);

  return {
    rows: openRouterSummary.rows,
    tokens: openRouterSummary.tokens,
    cost_usd: openRouterSummary.cost_usd,
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
      api_tokens: 0,
      hub_api_days: 0,
      openrouter_export_rows: 0,
      openrouter_cost_usd: 0,
      synthadoc_days: 0,
    });
  }
  return rows.get(date);
}

function inferDriver(row) {
  const total = row.codex_tokens + row.claude_code_tokens + row.api_tokens;
  if (row.api_tokens > row.codex_tokens + row.claude_code_tokens) return "hub ingestion";
  if (row.codex_tokens >= row.claude_code_tokens && row.codex_tokens > 0) return "shipping";
  if (row.claude_code_tokens > 0 && total >= 100_000) return "Hub Development";
  if (row.claude_code_tokens > 0) return "review";
  return "admin";
}

function buildEvidence(row) {
  const parts = [];
  if (row.codex_tokens > 0) parts.push("Codex session token counters");
  if (row.claude_code_tokens > 0) parts.push("Claude Code message usage");
  if (row.hub_api_days > 0) parts.push("McLellan hub request logs");
  if (row.openrouter_export_rows > 0) parts.push("OpenRouter activity export");
  if (row.synthadoc_days > 0) parts.push("Synthadoc audit logs");
  return parts.join("; ");
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
