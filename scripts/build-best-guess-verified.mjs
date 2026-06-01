import fs from "node:fs/promises";

const original = [
  ["2024-12-20","Friday","EDI-DUB","Ryanair","","","","","","","Booking ref VHQ18B (return); calendar: return Fri"],
  ["2024-12-16","Monday","DUB-EDI","Ryanair","","","","","","","Booking ref VHQ18B; calendar: Douglas to Scotland Mon-Fri"],
  ["2024-11-29","Friday","EDI-DUB","Ryanair","","","","","","","Booking ref SLRHKF (return)"],
  ["2024-11-26","Tuesday","DUB-EDI","Ryanair","19:05","","","","","","Booking ref SLRHKF; calendar: 19:05 flight"],
  ["2024-11-09","Saturday","EDI-DUB","Ryanair","","FR817","16:15","17:20","Saturday pattern checked against common return flights; FR817 verified on FR24, FR819 not found","verified","Booking ref ZNBYSC (return); calendar: return Sat"],
  ["2024-11-06","Wednesday","DUB-EDI","Ryanair","05:55","FR808","05:55","07:00","Visible 05:55 time beats Wednesday evening rule; FR808 verified on FR24","verified","Booking ref ZNBYSC; calendar: 5:55am flight"],
  ["2024-10-12","Saturday","EDI-DUB","Ryanair","","FR819","22:10","23:15","Saturday = last common EDI-DUB flight; FR819 verified on FR24","verified","Booking ref KQHJVD (return); calendar: return Sat"],
  ["2024-10-09","Wednesday","DUB-EDI","Ryanair","","FR816","17:10","18:20","Wednesday around 6pm pattern; FR816 verified on FR24","verified","Booking ref KQHJVD; calendar: Douglas in Scotland Wed-Sat"],
  ["2024-09-26","Thursday","EDI-DUB","Ryanair","","FR815","12:35","13:40","Thursday first checked against common return flights; FR815 verified on FR24","verified","Booking ref RLMYTF (return); 1-night trip"],
  ["2024-09-25","Wednesday","DUB-EDI","Ryanair","","FR816","17:10","18:20","Wednesday around 6pm pattern; FR816 verified on FR24","verified","Booking ref RLMYTF; calendar: Assessment Trip to Scotland Wed-Thu"],
  ["2024-09-19","Thursday","REU-DUB","Ryanair","","FR1115","","","Candidate from Reus return pattern; not found on FR24 for this date","unverified","Booking ref CP9UTD (return); 2 pax; Barcelona Reus"],
  ["2024-09-14","Saturday","DUB-REU","Ryanair","","FR1114","","","Candidate from Reus outbound pattern; not found on FR24 for this date","unverified","Booking ref CP9UTD; 2 pax; Barcelona Reus"],
  ["2024-08-31","Saturday","EDI-DUB","Ryanair","","FR819","22:10","23:15","Saturday = last common EDI-DUB flight; FR819 verified on FR24","verified","Booking ref KVH1XR (return); calendar: return Sat"],
  ["2024-08-28","Wednesday","DUB-EDI","Ryanair","","FR816","17:10","18:20","Wednesday around 6pm pattern; FR816 verified on FR24","verified","Booking ref KVH1XR; calendar: Douglas to Edinburgh Wed-Sat"],
  ["2024-08-03","Saturday","EDI-DUB","Ryanair","","FR819","22:10","23:15","Saturday = last common EDI-DUB flight; FR819 verified on FR24","verified","Booking ref XI676L (return); calendar: return Sat"],
  ["2024-08-01","Thursday","DUB-EDI","Ryanair","","FR814","14:05","15:15","Thursday rule checked against repeated DUB-EDI numbers; FR814 verified on FR24","verified","Booking ref XI676L; calendar: Douglas in Scotland (Jul 31-Aug 3)"],
  ["2024-07-19","Friday","EDI-DUB","Ryanair","","","","","","","Booking ref LIVM6F (return); calendar: return Fri"],
  ["2024-07-17","Wednesday","DUB-EDI","Ryanair","","FR816","17:10","18:20","Wednesday around 6pm pattern; FR816 verified on FR24","verified","Booking refs LIVM6F, INU7WW; calendar: Douglas Scotland Wed-Fri"],
  ["2024-07-09","Tuesday","EDI-DUB","Ryanair","","","","","","","Booking refs MSUV7U, SWVTTG, INU7WW; calendar: Douglas & Kai return Tue"],
  ["2024-07-06","Saturday","DUB-EDI","Ryanair","","FR814","13:25","14:35","Saturday DUB-EDI common candidates checked; FR814 verified on FR24, FR808/FR816 not found","verified","Booking refs TK1U8S, SWVTTG; calendar: Douglas & Kai to Scotland Sat-Tue"],
  ["2024-06-29","Saturday","EDI-DUB","Ryanair","","FR819","22:10","23:15","Saturday = last common EDI-DUB flight; FR819 verified on FR24","verified","Booking ref ONJQHJ (return)"],
  ["2024-06-26","Wednesday","DUB-EDI","Ryanair","","FR816","17:10","18:20","Wednesday around 6pm pattern; FR816 verified on FR24","verified","Booking ref ONJQHJ; calendar: Douglas in Scotland Wed-Sat"],
  ["2024-03-19","Tuesday","EDI-DUB","Ryanair","","","","","","","Booking ref JQ533H (return); calendar: return Tue"],
  ["2024-03-15","Friday","DUB-EDI","Ryanair","","","","","","","Booking ref JQ533H; calendar: Douglas in Scotland Fri-Tue"],
  ["2023-12-21","Thursday","EDI-DUB","Ryanair","","FR817","17:30","18:35","Thursday first common return found; FR817 verified on FR24, FR819 also operated later","verified","Booking ref HG2RXI (return); visible in Ryanair bookings, receipt unavailable"],
  ["2023-12-20","Wednesday","DUB-EDI","Ryanair","","FR812","05:45","06:50","Wednesday candidate verified on FR24; schedule was morning rather than evening","verified","Booking ref HG2RXI; visible in Ryanair bookings, receipt unavailable"],
  ["2023-10-21","Saturday","REU-DUB","Ryanair","","FR1115","10:35","12:10","Reus return candidate verified on FR24","verified","Booking ref CKVIQQ (return); 2 pax; Barcelona Reus; visible in Ryanair bookings, receipt unavailable"],
  ["2023-10-16","Monday","DUB-REU","Ryanair","","","","","","","Booking ref CKVIQQ; 2 pax; Barcelona Reus; visible in Ryanair bookings, receipt unavailable"],
  ["2023-07-21","Friday","EDI-DUB","Ryanair","","","","","","","Booking ref WL792A (return); visible in Ryanair bookings, receipt unavailable"],
  ["2023-07-19","Wednesday","DUB-EDI","Ryanair","","FR816","12:50","14:00","Wednesday candidate verified on FR24; schedule was midday rather than evening","verified","Booking ref WL792A; visible in Ryanair bookings, receipt unavailable"],
];

const verifiedFiles = [
  "/private/tmp/best_guess_fr24_verified.json",
  "/private/tmp/best_guess_fr24_alts.json",
  "/private/tmp/best_guess_fr24_reus.json",
  "/private/tmp/best_guess_fr24_extra.json",
  "/private/tmp/best_guess_fr24_extra2.json",
];

const fr24 = [];
for (const file of verifiedFiles) {
  try {
    fr24.push(...JSON.parse(await fs.readFile(file, "utf8")));
  } catch {}
}

const preferred = new Map([
  ["2024-11-09|EDI-DUB", "FR817"],
  ["2024-11-06|DUB-EDI", "FR808"],
  ["2024-10-12|EDI-DUB", "FR819"],
  ["2024-10-09|DUB-EDI", "FR816"],
  ["2024-09-26|EDI-DUB", "FR815"],
  ["2024-09-25|DUB-EDI", "FR816"],
  ["2024-09-19|REU-DUB", "FR1115"],
  ["2024-09-14|DUB-REU", "FR1114"],
  ["2024-08-31|EDI-DUB", "FR819"],
  ["2024-08-28|DUB-EDI", "FR816"],
  ["2024-08-03|EDI-DUB", "FR819"],
  ["2024-08-01|DUB-EDI", "FR814"],
  ["2024-07-17|DUB-EDI", "FR816"],
  ["2024-07-06|DUB-EDI", "FR814"],
  ["2024-06-29|EDI-DUB", "FR819"],
  ["2024-06-26|DUB-EDI", "FR816"],
  ["2023-12-21|EDI-DUB", "FR817"],
  ["2023-12-20|DUB-EDI", "FR812"],
  ["2023-10-21|REU-DUB", "FR1115"],
  ["2023-07-19|DUB-EDI", "FR816"],
]);

function csvEscape(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const headers = [
  "flight_date","weekday","route","airline","visible_scheduled_dep",
  "best_guess_flight_number","best_guess_scheduled_dep","best_guess_scheduled_arr",
  "fr24_verified","fr24_actual_dep","fr24_actual_arr","fr24_registration","fr24_duration",
  "fr24_source","evidence","notes"
];

const output = original.map((row) => {
  const [flight_date, weekday, route, airline, visible_scheduled_dep, guess, dep, arr, evidence, verification, notes] = row;
  const key = `${flight_date}|${route}`;
  const candidate = preferred.get(key) || guess;
  const hit = fr24.find((r) => r.flight_date === flight_date && r.route === route && r.candidate === candidate && r.verified);
  const miss = fr24.find((r) => r.flight_date === flight_date && r.route === route && r.candidate === candidate && !r.verified);
  return {
    flight_date, weekday, route, airline, visible_scheduled_dep,
    best_guess_flight_number: candidate || "",
    best_guess_scheduled_dep: hit?.scheduled_dep || dep,
    best_guess_scheduled_arr: hit?.scheduled_arr || arr,
    fr24_verified: hit ? "yes" : (miss ? "no" : ""),
    fr24_actual_dep: hit?.actual_dep || "",
    fr24_actual_arr: hit?.actual_arr || "",
    fr24_registration: hit?.registration || "",
    fr24_duration: hit?.duration || "",
    fr24_source: hit?.source || miss?.source || "",
    evidence,
    notes,
  };
});

const csv = [headers.join(","), ...output.map((row) => headers.map((h) => csvEscape(row[h])).join(","))].join("\n") + "\n";
await fs.writeFile("best_guess.csv", csv);
console.log(`Wrote ${output.length} rows; verified ${output.filter(r => r.fr24_verified === "yes").length}`);
