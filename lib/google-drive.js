const { google } = require('googleapis');
const db = require('./db');

async function getDriveClient(user) {
  const tokenRow = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!tokenRow) throw new Error('No Google refresh token — please sign in with Google first.');

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: tokenRow.value });
  return google.drive({ version: 'v3', auth: client });
}

// Extract Drive/Docs/Sheets file ID from any URL format or plain ID
function extractFileId(input) {
  const s = (input || '').trim();

  // https://drive.google.com/file/d/FILE_ID/...
  let m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'file' };

  // https://docs.google.com/document/d/DOC_ID/...
  m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'gdoc' };

  // https://docs.google.com/spreadsheets/d/SHEET_ID/...
  m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'gsheet' };

  // https://docs.google.com/presentation/d/PRES_ID/...
  m = s.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { id: m[1], type: 'gslides' };

  // Plain ID (25+ alphanumeric chars)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return { id: s, type: 'file' };

  throw new Error('Could not find a Drive file ID in that URL. Paste the sharing link directly from Google Drive.');
}

// Find a folder by name under a given parent ('root' for My Drive root).
async function findFolder(drive, name, parentId) {
  const q = [
    `name='${name.replace(/'/g, "\\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `'${parentId}' in parents`,
  ].join(' and ');
  const res = await drive.files.list({ q, fields: 'files(id,name)', spaces: 'drive' });
  return res.data.files?.[0] || null;
}

async function getOrCreateFolder(drive, name, parentId) {
  const existing = await findFolder(drive, name, parentId);
  if (existing) return existing.id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return created.data.id;
}

// Walk/create a chain of folder names starting at My Drive root, returning the leaf folder ID.
async function resolveFolderPath(drive, segments) {
  let parentId = 'root';
  for (const name of segments) {
    parentId = await getOrCreateFolder(drive, name, parentId);
  }
  return parentId;
}

async function downloadDriveFile(user, urlOrId) {
  const drive = await getDriveClient(user);
  const { id, type } = extractFileId(urlOrId);

  // Fetch metadata to get name + MIME type
  const meta = await drive.files.get({
    fileId: id,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  });
  const { name, mimeType } = meta.data;

  let buffer, filename;

  const isGdoc     = type === 'gdoc'   || mimeType === 'application/vnd.google-apps.document';
  const isGsheet   = type === 'gsheet' || mimeType === 'application/vnd.google-apps.spreadsheet';
  const isGslides  = type === 'gslides'|| mimeType === 'application/vnd.google-apps.presentation';

  if (isGdoc) {
    // Export as Word (then mammoth converts to markdown)
    const res = await drive.files.export(
      { fileId: id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { responseType: 'arraybuffer' }
    );
    buffer = Buffer.from(res.data);
    filename = (name || 'document').replace(/[/\\]/g, '-') + '.docx';

  } else if (isGsheet) {
    const res = await drive.files.export(
      { fileId: id, mimeType: 'text/csv' },
      { responseType: 'arraybuffer' }
    );
    buffer = Buffer.from(res.data);
    filename = (name || 'spreadsheet').replace(/[/\\]/g, '-') + '.csv';

  } else if (isGslides) {
    // Export as plain text (best we can do without a separate converter)
    const res = await drive.files.export(
      { fileId: id, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' }
    );
    buffer = Buffer.from(res.data);
    filename = (name || 'presentation').replace(/[/\\]/g, '-') + '.txt';

  } else {
    // Regular file — download as-is
    const res = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    buffer = Buffer.from(res.data);
    filename = (name || 'file').replace(/[/\\]/g, '-');
  }

  return { buffer, filename, mimeType };
}

module.exports = { downloadDriveFile, extractFileId, getDriveClient, findFolder, getOrCreateFolder, resolveFolderPath };
