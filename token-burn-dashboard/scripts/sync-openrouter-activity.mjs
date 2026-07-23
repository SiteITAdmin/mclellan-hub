import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const hubRoot = join(projectRoot, "..");
const outputPath = join(projectRoot, "data", "openrouter-live.summary.json");
const dailyOutputPath = join(projectRoot, "data", "openrouter-live.daily.json");
const deployDataDir = join(projectRoot, "deploy-data");
const deployOutputPath = join(deployDataDir, "openrouter-live.summary.json");
const deployDailyOutputPath = join(deployDataDir, "openrouter-live.daily.json");

loadDotEnv(join(hubRoot, ".env"));

const apiKey = process.env.OPENROUTER_MANAGEMENT_KEY;
if (!apiKey) {
  console.error("OPENROUTER_MANAGEMENT_KEY is not set; skipping live OpenRouter activity sync.");
  process.exit(2);
}

const end = new Date();
const start = new Date(process.env.OPENROUTER_ACTIVITY_START || "2026-04-10T00:00:00.000Z");
const metrics = [
  "total_usage",
  "tokens_total",
  "tokens_prompt",
  "tokens_completion",
  "reasoning_tokens",
  "request_count",
  "cache_hit_rate",
];

const total = await queryAnalytics({ metrics });
const byApp = await queryAnalytics({ dimensions: ["app"], metrics, limit: 5000 });
const byModel = await queryAnalytics({ dimensions: ["model"], metrics, limit: 5000 });
const byProvider = await queryAnalytics({ dimensions: ["provider"], metrics, limit: 5000, optional: true });
const dailyStart = new Date(end.getTime() - 30 * 86400000);
const daily = await queryAnalytics({
  start: dailyStart,
  end,
  granularity: "day",
  metrics,
  limit: 100,
});

const row = total[0] || {};
const summary = {
  source: "openrouter_management_api",
  fetched_at: new Date().toISOString(),
  time_range: {
    label: "Since 10 Apr 2026",
    start: start.toISOString(),
    end: end.toISOString(),
  },
  requests: Number(row.request_count || 0),
  tokens: Number(row.tokens_total || 0),
  cost_usd: Number(row.total_usage || 0),
  cache_hit_rate: Number(row.cache_hit_rate || 0),
  by_app: normalizeRows(byApp, "app"),
  by_model: normalizeRows(byModel, "model"),
  by_provider: normalizeRows(byProvider, "provider"),
};
const dailySummary = {
  source: "openrouter_management_api",
  fetched_at: summary.fetched_at,
  time_range: {
    label: "Latest 31 days",
    start: dailyStart.toISOString(),
    end: end.toISOString(),
  },
  days: daily
    .map((row) => ({
      date: String(row.date__day || row.date || "").slice(0, 10),
      tokens: Number(row.tokens_total || 0),
      tokens_in: Number(row.tokens_prompt || 0),
      tokens_out: Number(row.tokens_completion || 0),
      tokens_reasoning: Number(row.reasoning_tokens || 0),
      calls: Number(row.request_count || 0),
      cost_usd: Number(row.total_usage || 0),
      cache_hit_rate: Number(row.cache_hit_rate || 0),
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .sort((a, b) => a.date.localeCompare(b.date)),
};

mkdirSync(join(projectRoot, "data"), { recursive: true });
mkdirSync(deployDataDir, { recursive: true });
const json = `${JSON.stringify(summary, null, 2)}\n`;
const dailyJson = `${JSON.stringify(dailySummary, null, 2)}\n`;
writeFileSync(outputPath, json);
writeFileSync(deployOutputPath, json);
writeFileSync(dailyOutputPath, dailyJson);
writeFileSync(deployDailyOutputPath, dailyJson);

console.log(`Wrote live OpenRouter summary to ${outputPath}`);
console.log(`Wrote ${dailySummary.days.length} daily OpenRouter rows to ${dailyOutputPath}`);
console.log(`Live OpenRouter: ${summary.requests} requests, ${summary.tokens} tokens, $${summary.cost_usd.toFixed(4)}`);

async function queryAnalytics({ dimensions, metrics, orderBy, limit = 1000, optional = false, start: queryStart = start, end: queryEnd = end, granularity }) {
  const body = {
    time_range: {
      start: queryStart.toISOString(),
      end: queryEnd.toISOString(),
    },
    metrics,
    limit,
  };
  if (dimensions) {
    body.dimensions = dimensions;
  }
  if (granularity || dimensions) body.granularity = granularity || "day";
  if (orderBy) body.order_by = { field: orderBy, direction: "desc" };

  const response = await fetch("https://openrouter.ai/api/v1/analytics/query", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (optional) {
      console.warn(`Optional OpenRouter analytics query skipped: ${data?.error?.message || response.status}`);
      return [];
    }
    throw new Error(data?.error?.message || `OpenRouter analytics ${response.status}`);
  }
  return data?.data?.data || data?.data || [];
}

function normalizeRows(rows, labelKey) {
  const grouped = new Map();
  for (const row of rows) {
    const label = String(row[labelKey] || "Unknown");
    const current = grouped.get(label) || {
      label,
      tokens: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_reasoning: 0,
      cost_usd: 0,
      calls: 0,
      cache_hit_rate_weighted: 0,
    };
    const calls = Number(row.request_count || 0);
    current.tokens += Number(row.tokens_total || 0);
    current.tokens_in += Number(row.tokens_prompt || 0);
    current.tokens_out += Number(row.tokens_completion || 0);
    current.tokens_reasoning += Number(row.reasoning_tokens || 0);
    current.cost_usd += Number(row.total_usage || 0);
    current.calls += calls;
    current.cache_hit_rate_weighted += Number(row.cache_hit_rate || 0) * calls;
    grouped.set(label, current);
  }
  return Array.from(grouped.values())
    .map((row) => ({
      label: row.label,
      tokens: row.tokens,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      tokens_reasoning: row.tokens_reasoning,
      cost_usd: row.cost_usd,
      calls: row.calls,
      cache_hit_rate: row.calls > 0 ? row.cache_hit_rate_weighted / row.calls : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens)
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}
