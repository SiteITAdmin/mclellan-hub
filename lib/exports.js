const {
  Document, Packer, Paragraph, TextRun,
  HeadingLevel, AlignmentType, LevelFormat,
  convertInchesToTwip, BorderStyle,
  Table, TableRow, TableCell, WidthType, ShadingType,
} = require('docx');
const path = require('path');

// ── Inline markdown → TextRun[] ───────────────────────────────────────────────
function parseInline(text) {
  const runs = [];
  const re = /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun(text.slice(last, m.index)));
    if (m[1]) runs.push(new TextRun({ text: m[1], bold: true, italics: true }));
    else if (m[2]) runs.push(new TextRun({ text: m[2], bold: true }));
    else if (m[3]) runs.push(new TextRun({ text: m[3], italics: true }));
    else if (m[4]) runs.push(new TextRun({ text: m[4], font: 'Courier New', size: 20 }));
    else if (m[5]) runs.push(new TextRun({ text: m[5], strike: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs.length ? runs : [new TextRun(text)];
}

// ── Markdown table → Table ────────────────────────────────────────────────────
function buildTable(tableLines) {
  const parseRow = line => line.split('|').slice(1, -1).map(c => c.trim());
  const isSeparator = line => /^\|[\s|:-]+\|$/.test(line) && line.includes('-');

  const [headerLine, ...rest] = tableLines;
  const dataLines = rest.filter(l => !isSeparator(l));
  const headerCells = parseRow(headerLine);

  const cellPara = (text, bold = false) =>
    new Paragraph({ children: parseInline(text).map(r => bold ? new TextRun({ ...r, bold: true }) : r) });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headerCells.map(cell => new TableCell({
          shading: { fill: 'F0F0F0', type: ShadingType.CLEAR, color: 'auto' },
          children: [new Paragraph({ children: [new TextRun({ text: cell, bold: true })] })],
        })),
      }),
      ...dataLines.map(line => new TableRow({
        children: parseRow(line).map(cell => new TableCell({
          children: [new Paragraph({ children: parseInline(cell) })],
        })),
      })),
    ],
  });
}

// ── DOCX ──────────────────────────────────────────────────────────────────────
async function exportDocx(content, filename) {
  const lines = content.split('\n');
  const children = [];
  let inCodeBlock = false;
  let codeLines = [];
  let tableLines = [];

  const flushCode = () => {
    for (const cl of codeLines) {
      children.push(new Paragraph({
        children: [new TextRun({ text: cl || ' ', font: 'Courier New', size: 20 })],
        spacing: { before: 0, after: 0 },
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 6 } },
      }));
    }
    codeLines = [];
  };

  const flushTable = () => {
    if (tableLines.length >= 2) children.push(buildTable(tableLines));
    tableLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith('```')) {
      flushTable();
      if (inCodeBlock) { flushCode(); inCodeBlock = false; }
      else inCodeBlock = true;
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    // Table rows — collect until the block ends
    if (line.startsWith('|')) { tableLines.push(line); continue; }
    if (tableLines.length) flushTable();

    if (/^[-*_]{3,}$/.test(line.trim())) {
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 3, color: 'CCCCCC', space: 1 } },
        spacing: { before: 200, after: 200 },
      }));
    } else if (line.startsWith('#### ')) {
      children.push(new Paragraph({ text: line.slice(5), heading: HeadingLevel.HEADING_4 }));
    } else if (line.startsWith('### ')) {
      children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith('# ')) {
      children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (line.startsWith('> ')) {
      children.push(new Paragraph({
        children: parseInline(line.slice(2)),
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 6 } },
      }));
    } else if (/^[-*+] /.test(line)) {
      children.push(new Paragraph({
        children: parseInline(line.slice(2)),
        numbering: { reference: 'bullet-list', level: 0 },
      }));
    } else if (/^\d+\. /.test(line)) {
      children.push(new Paragraph({
        children: parseInline(line.replace(/^\d+\. /, '')),
        numbering: { reference: 'number-list', level: 0 },
      }));
    } else if (line.trim() === '') {
      children.push(new Paragraph({ text: '' }));
    } else {
      children.push(new Paragraph({ children: parseInline(line) }));
    }
  }
  if (inCodeBlock) flushCode();
  flushTable();

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'bullet-list',
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } },
          }],
        },
        {
          reference: 'number-list',
          levels: [{
            level: 0,
            format: LevelFormat.DECIMAL,
            text: '%1.',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: convertInchesToTwip(0.5), hanging: convertInchesToTwip(0.25) } } },
          }],
        },
      ],
    },
    sections: [{ properties: {}, children }],
  });
  return Packer.toBuffer(doc);
}

// ── PDF (Puppeteer — renders proper HTML/CSS) ─────────────────────────────────
async function exportPdf(content, filename) {
  const { marked } = require('marked');
  const puppeteer = require('puppeteer');

  const body = marked.parse(content);
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Georgia, serif; font-size: 11pt; line-height: 1.7;
         max-width: 680px; margin: 0 auto; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 1.2em 0 0.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.25em; }
  h2 { font-size: 14pt; margin: 1em 0 0.3em; }
  h3 { font-size: 11pt; font-weight: bold; margin: 0.8em 0 0.2em; }
  h4 { font-size: 10pt; font-weight: bold; margin: 0.6em 0 0.2em; color: #444; }
  p  { margin: 0.5em 0; }
  ul, ol { padding-left: 1.6em; margin: 0.4em 0; }
  li { margin: 0.2em 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px;
         font-family: 'Courier New', monospace; font-size: 9pt; }
  pre  { background: #f4f4f4; padding: 12px 14px; border-radius: 4px;
         border-left: 3px solid #ccc; overflow-x: auto; margin: 0.8em 0; }
  pre code { background: none; padding: 0; font-size: 9pt; }
  blockquote { border-left: 3px solid #bbb; margin: 0.8em 0 0.8em 0;
               padding: 0.3em 0 0.3em 1em; color: #555; font-style: italic; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 10pt; }
  th, td { border: 1px solid #ddd; padding: 5px 10px; text-align: left; }
  th { background: #f0f0f0; font-weight: bold; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  strong { font-weight: bold; }
  em { font-style: italic; }
</style></head><body>${body}</body></html>`;

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buf = await page.pdf({
      format: 'A4',
      margin: { top: '2cm', right: '2.2cm', bottom: '2cm', left: '2.2cm' },
      printBackground: true,
    });
    return Buffer.from(buf);
  } finally {
    await browser.close();
  }
}

// ── Google Doc ────────────────────────────────────────────────────────────────
async function exportGoogleDoc(content, filename, user) {
  const { google } = require('googleapis');

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, '..', 'config', 'google-service-account.json'),
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents'],
  });

  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  const doc = await docs.documents.create({ requestBody: { title: filename } });
  const docId = doc.data.documentId;

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
  });

  const shareEmail = process.env[`${user.toUpperCase()}_GOOGLE_EMAIL`];
  if (shareEmail) {
    await drive.permissions.create({
      fileId: docId,
      requestBody: { role: 'writer', type: 'user', emailAddress: shareEmail },
    });
  }

  return `https://docs.google.com/document/d/${docId}/edit`;
}

module.exports = { exportDocx, exportPdf, exportGoogleDoc };
