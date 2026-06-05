import type { BurnRow } from "./burn-data";

export type WindowKey = "90" | "180" | "365" | "all";

export const windows: { key: WindowKey; label: string }[] = [
  { key: "90", label: "90d" },
  { key: "180", label: "180d" },
  { key: "365", label: "1y" },
  { key: "all", label: "all" },
];

export function getWindowRows(rows: BurnRow[], windowKey: WindowKey) {
  if (windowKey === "all" || rows.length === 0) return rows;

  const lastDate = toUtcDate(rows[rows.length - 1].date);
  const firstDate = new Date(lastDate);
  firstDate.setUTCDate(firstDate.getUTCDate() - Number(windowKey) + 1);

  return rows.filter((row) => toUtcDate(row.date) >= firstDate);
}

export function toUtcDate(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}
