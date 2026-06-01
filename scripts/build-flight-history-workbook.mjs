import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const detailCsv = await fs.readFile(path.join(root, "flight_history.csv"), "utf8");
const olderCsv = await fs.readFile(path.join(root, "pre_6_feb_visible_flights.csv"), "utf8");

const workbook = await Workbook.fromCSV(detailCsv, { sheetName: "Receipt details" });
await workbook.fromCSV(olderCsv, { sheetName: "Pre-6-Feb visible flights" });

for (const sheetName of ["Receipt details", "Pre-6-Feb visible flights"]) {
  const sheet = workbook.worksheets.getItem(sheetName);
  sheet.showGridLines = false;
  sheet.freezePanes.freezeRows(1);
  const used = sheet.getUsedRange();
  used.format.font.name = "Aptos";
  used.format.font.size = 11;
  const header = used.getRow(0);
  header.format.fill.color = "#1F4E78";
  header.format.font.color = "#FFFFFF";
  header.format.font.bold = true;
  header.format.wrapText = true;
  used.format.autofitColumns();
  used.format.autofitRows();
}

workbook.worksheets.getItem("Receipt details").tables.add("A1:T53", true, "ReceiptDetails");
workbook.worksheets.getItem("Pre-6-Feb visible flights").tables.add("A1:F23", true, "PreCutoffVisibleFlights");

await fs.mkdir(path.join(root, "exports"), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(root, "exports", "ryanair_flight_history.xlsx"));

const summary = await workbook.inspect({
  kind: "sheet,table",
  maxChars: 3000,
  tableMaxRows: 4,
  tableMaxCols: 8,
});
console.log(summary.ndjson);
