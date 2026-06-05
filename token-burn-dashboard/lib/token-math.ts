import type { BurnRow } from "./burn-data";
import { toUtcDate } from "./date-windows";

export function formatTokens(value: number, showDecimals = true) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(showDecimals ? 1 : 0)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatBand(low: number, high: number) {
  return `${formatTokens(low)}-${formatTokens(high)}`;
}

export function sumExactTotal(rows: BurnRow[]) {
  return rows.reduce((sum, row) => sum + row.exact_total, 0);
}

export function logHeatLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  const level = Math.ceil((Math.log10(value + 1) / Math.log10(max + 1)) * 5);
  return Math.max(0, Math.min(5, level));
}

export function movingAverage7(rows: BurnRow[], index: number) {
  const start = Math.max(0, index - 6);
  const windowRows = rows.slice(start, index + 1);
  if (windowRows.length === 0) return 0;
  return sumExactTotal(windowRows) / windowRows.length;
}

export function weeklyTotals(rows: BurnRow[]) {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const week = startOfIsoWeek(row.date);
    totals.set(week, (totals.get(week) || 0) + row.exact_total);
  }

  return Array.from(totals, ([week, total]) => ({ week, total })).sort((a, b) =>
    a.week.localeCompare(b.week),
  );
}

export function topNDays(rows: BurnRow[], n = 10) {
  return [...rows]
    .sort((a, b) => b.exact_total - a.exact_total)
    .slice(0, n)
    .map((row) => ({
      date: row.date,
      total: row.exact_total,
      driver: row.driver,
      evidence: row.evidence,
    }));
}

export function sameDayActivity(rows: BurnRow[], targetDate: string) {
  const today = rows.find((row) => row.date === targetDate);
  if (!today) return null;
  return {
    date: today.date,
    exact: today.exact_total,
    driver: today.driver,
    codex: today.codex_tokens,
    claudeCode: today.claude_code_tokens,
    api: today.api_tokens,
    convos: today.chatgpt_conversations + today.claude_chat_conversations,
    messages: today.chatgpt_messages + today.claude_chat_messages,
  };
}

function startOfIsoWeek(date: string) {
  const value = toUtcDate(date);
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day);
  return value.toISOString().slice(0, 10);
}
