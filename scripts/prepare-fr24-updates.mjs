import fs from "node:fs/promises";

const progress = JSON.parse(await fs.readFile("/private/tmp/fr24_known_progress.json", "utf8"));

const manual = [
  {
    date: "8 Feb 2025",
    route: "EDI-DUB",
    flight: "FR819",
    registration: "EI-IHR",
    duration: "0:44",
    status: "Landed 21:12",
    scheduled_dep: "20:10",
    actual_dep: "20:29",
    scheduled_arr: "21:15",
    actual_arr: "21:12",
    from: "Edinburgh (EDI)",
    to: "Dublin (DUB)",
  },
  {
    date: "6 Feb 2025",
    route: "DUB-EDI",
    flight: "FR808",
    registration: "EI-EVC",
    duration: "0:46",
    status: "Landed 06:53",
    scheduled_dep: "05:55",
    actual_dep: "06:07",
    scheduled_arr: "07:00",
    actual_arr: "06:53",
    from: "Dublin (DUB)",
    to: "Edinburgh (EDI)",
  },
];

const rows = [...progress.matches, ...manual];

function parseDisplayDate(s) {
  const [day, mon, year] = s.split(" ");
  const months = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Sept: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  return `${year}-${months[mon]}-${day.padStart(2, "0")}`;
}

function isDstIreland(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  const lastSunday = (m) => {
    const x = new Date(Date.UTC(year, m, 0));
    x.setUTCDate(x.getUTCDate() - x.getUTCDay());
    return x;
  };
  const start = lastSunday(3);
  const end = lastSunday(10);
  return d >= start && d < end;
}

function addHour(hhmm) {
  if (!/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  return `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const normalized = rows
  .map((row) => {
    const flight_date = parseDisplayDate(row.date);
    return {
      flight_date,
      route: row.route,
      flight_number: row.flight,
      airline: row.flight.startsWith("EI") ? "Aer Lingus" : "Ryanair",
      scheduled_dep: row.scheduled_dep,
      actual_dep: row.actual_dep,
      scheduled_arr: row.scheduled_arr,
      actual_arr: isDstIreland(flight_date) ? addHour(row.actual_arr) : row.actual_arr,
      fr24_landed_utc: row.actual_arr,
      registration: row.registration,
      duration: row.duration,
      source: `https://www.flightradar24.com/data/flights/${row.flight.toLowerCase()}`,
    };
  })
  .sort((a, b) => b.flight_date.localeCompare(a.flight_date) || a.flight_number.localeCompare(b.flight_number));

const headers = [
  "flight_date",
  "route",
  "flight_number",
  "airline",
  "scheduled_dep",
  "actual_dep",
  "scheduled_arr",
  "actual_arr",
  "fr24_landed_utc",
  "registration",
  "duration",
  "source",
];
const csv = [headers.join(","), ...normalized.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n") + "\n";

await fs.writeFile("fr24_historical_known_updates.csv", csv, "utf8");
await fs.writeFile("/private/tmp/fr24_historical_known_updates.json", JSON.stringify(normalized, null, 2), "utf8");
console.log(`Wrote ${normalized.length} rows`);
