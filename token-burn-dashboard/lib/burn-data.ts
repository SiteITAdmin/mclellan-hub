import { formatTokens } from "./token-math";

// Three-lane data model.
// EXACT = measured token logs only (Codex, Claude Code, API).
// ACTIVITY = measured counts from chat exports (NOT tokens).
// ESTIMATE = an optional token band, never a point value.
export const exactColumns = [
  { key: "codex_tokens", label: "Codex", source: "codex" },
  { key: "claude_code_tokens", label: "Claude Code", source: "claude_code" },
  { key: "api_tokens", label: "API usage", source: "api" },
] as const;

export const activityColumns = [
  { key: "chatgpt_conversations", label: "ChatGPT convos", source: "chatgpt" },
  { key: "chatgpt_messages", label: "ChatGPT messages", source: "chatgpt" },
  { key: "chatgpt_files", label: "ChatGPT files", source: "chatgpt" },
  { key: "claude_chat_conversations", label: "Claude convos", source: "claude_chat" },
  { key: "claude_chat_messages", label: "Claude messages", source: "claude_chat" },
] as const;

export const estimateColumns = [
  { key: "chat_tokens_low", label: "Chat est. low", source: "chat_est" },
  { key: "chat_tokens_high", label: "Chat est. high", source: "chat_est" },
] as const;

export type ExactKey = (typeof exactColumns)[number]["key"];
export type ActivityKey = (typeof activityColumns)[number]["key"];
export type EstimateKey = (typeof estimateColumns)[number]["key"];
export type Confidence = "measured" | "floor" | "rough";

export type RawBurnRow = {
  date: string;
  // EXACT lane (measured logs only)
  codex_tokens?: number;
  claude_code_tokens?: number;
  claude_code_calls?: number;
  api_tokens?: number;
  // ACTIVITY lane (measured from exports, NOT tokens)
  chatgpt_conversations?: number;
  chatgpt_messages?: number;
  chatgpt_files?: number;
  claude_chat_conversations?: number;
  claude_chat_messages?: number;
  // ESTIMATE lane (always a BAND)
  chat_tokens_low?: number;
  chat_tokens_high?: number;
  confidence?: string; // narrowed to Confidence on ingest
  // Metadata
  driver: string;
  evidence?: string;
  // Deprecated fields, migrated on ingest. Do not write these in new data.
  total?: number;
  claude_chat_est?: number;
  chatgpt_est?: number;
};

export type BurnRow = {
  date: string;
  // EXACT lane
  codex_tokens: number;
  claude_code_tokens: number;
  claude_code_calls: number;
  api_tokens: number;
  exact_total: number; // sum of measured columns ONLY, never estimates
  // ACTIVITY lane
  chatgpt_conversations: number;
  chatgpt_messages: number;
  chatgpt_files: number;
  claude_chat_conversations: number;
  claude_chat_messages: number;
  // ESTIMATE lane
  chat_tokens_low: number;
  chat_tokens_high: number;
  confidence: Confidence;
  // Metadata
  driver: string;
  evidence: string;
};

export function normalizeRows(rows: RawBurnRow[]): BurnRow[] {
  return rows
    .map((row) => {
      const codex = asNumber(row.codex_tokens);
      const claudeCode = asNumber(row.claude_code_tokens);
      const api = asNumber(row.api_tokens);
      const exact_total = codex + claudeCode + api;

      // Backward compat: migrate deprecated point estimates into a band.
      const legacyEst = asNumber(row.claude_chat_est) + asNumber(row.chatgpt_est);
      const chat_low = asNumber(row.chat_tokens_low) || legacyEst;
      const chat_high = asNumber(row.chat_tokens_high) || Math.round(chat_low * 1.5);

      const activityCount =
        asNumber(row.chatgpt_conversations) +
        asNumber(row.chatgpt_messages) +
        asNumber(row.claude_chat_conversations) +
        asNumber(row.claude_chat_messages);
      const defaultConfidence: Confidence =
        exact_total > 0 ? "measured" : activityCount > 0 ? "floor" : "rough";
      const confidence: Confidence = isConfidence(row.confidence)
        ? row.confidence
        : defaultConfidence;

      return {
        date: row.date,
        codex_tokens: codex,
        claude_code_tokens: claudeCode,
        claude_code_calls: asNumber(row.claude_code_calls),
        api_tokens: api,
        exact_total,
        chatgpt_conversations: asNumber(row.chatgpt_conversations),
        chatgpt_messages: asNumber(row.chatgpt_messages),
        chatgpt_files: asNumber(row.chatgpt_files),
        claude_chat_conversations: asNumber(row.claude_chat_conversations),
        claude_chat_messages: asNumber(row.claude_chat_messages),
        chat_tokens_low: chat_low,
        chat_tokens_high: chat_high,
        confidence,
        driver: row.driver || "unlabeled",
        evidence: row.evidence || "",
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function sumExact(rows: BurnRow[], key: ExactKey) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

export function sumActivity(rows: BurnRow[], key: ActivityKey) {
  return rows.reduce((sum, row) => sum + row[key], 0);
}

export function estimateBand(rows: BurnRow[]): { low: number; high: number } {
  return rows.reduce(
    (band, row) => ({
      low: band.low + row.chat_tokens_low,
      high: band.high + row.chat_tokens_high,
    }),
    { low: 0, high: 0 },
  );
}

export type AdaptiveHeadline = {
  type: "exact" | "activity" | "estimate";
  primary: { label: string; value: string };
  secondary?: { label: string; value: string };
};

// Lead with whatever is actually measured. Exact-dominant days lead with
// exact tokens. Chat-only days lead with measured activity and demote the
// token figure to a labeled band. Never present a mixed total as exact.
export function getAdaptiveHeadline(rows: BurnRow[]): AdaptiveHeadline {
  const exactTotal = rows.reduce((sum, row) => sum + row.exact_total, 0);
  const convos = rows.reduce(
    (sum, row) => sum + row.chatgpt_conversations + row.claude_chat_conversations,
    0,
  );
  const messages = rows.reduce(
    (sum, row) => sum + row.chatgpt_messages + row.claude_chat_messages,
    0,
  );
  const { low, high } = estimateBand(rows);
  const band = `~${formatTokens(low)}-${formatTokens(high)}`;

  if (exactTotal > low) {
    return {
      type: "exact",
      primary: { label: "Exact tokens", value: formatTokens(exactTotal) },
      secondary: low > 0 ? { label: "Est. chat", value: `${band} est.` } : undefined,
    };
  }

  if (convos > 0 || messages > 0) {
    return {
      type: "activity",
      primary: { label: "Conversations", value: `${convos}` },
      secondary: { label: "Est. tokens", value: `${band}, rough` },
    };
  }

  return {
    type: "estimate",
    primary: { label: "Est. tokens", value: band },
    secondary: { label: "Confidence", value: "rough estimate" },
  };
}

function asNumber(value: number | undefined) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function isConfidence(value: string | undefined): value is Confidence {
  return value === "measured" || value === "floor" || value === "rough";
}
