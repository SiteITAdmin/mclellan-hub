const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const path = require('path');

// ── DOCX ──────────────────────────────────────────────────────────────────────
async function exportDocx(content, filename) {
  const lines = content.split('\n');
  const children = lines.map(line => {
    if (line.startsWith('# ')) {
      return new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 });
    }
    if (line.startsWith('## ')) {
      return new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 });
    }
    if (line.startsWith('### ')) {
      return new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 });
    }
    return new Paragraph({ children: [new TextRun(line)] });
  });

  const doc = new Document({ sections: [{ properties: {}, children }] });
  return Packer.toBuffer(doc);
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function exportPdf(content, filename) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').text(filename, { underline: false });
    doc.moveDown();
    doc.fontSize(11).font('Helvetica');

    const lines = content.split('\n');
    for (const line of lines) {
      if (line.startsWith('# ')) {
        doc.moveDown(0.5).fontSize(16).font('Helvetica-Bold').text(line.slice(2));
        doc.font('Helvetica').fontSize(11);
      } else if (line.startsWith('## ')) {
        doc.moveDown(0.5).fontSize(13).font('Helvetica-Bold').text(line.slice(3));
        doc.font('Helvetica').fontSize(11);
      } else if (line.startsWith('### ')) {
        doc.moveDown(0.3).fontSize(11).font('Helvetica-Bold').text(line.slice(4));
        doc.font('Helvetica').fontSize(11);
      } else if (line.trim() === '') {
        doc.moveDown(0.4);
      } else {
        doc.text(line.replace(/\*\*(.*?)\*\*/g, '$1'), { lineGap: 2 });
      }
    }
    doc.end();
  });
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
    requestBody: {
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    },
  });

  // Share with the user's Google account (optional — set GOOGLE_SHARE_EMAIL in .env)
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
