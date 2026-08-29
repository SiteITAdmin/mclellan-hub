#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..');
const DEFAULT_VAULT = path.join(ROOT, 'data', 'synthadoc', 'mclellan-hub-knowledge');
const DEFAULT_FOLDER_PATH = 'onyx/NoteMax/Notebooks';
// The Hub's own nightly planner PDFs live in the folder the tablet syncs, so if
// the notes ingest is pointed at that same folder it would re-import the Hub's
// own output as if it were handwriting. Skip anything named with the planner
// prefix — it is generated, not captured. (Must match BOOX_PLANNER_NAME_PREFIX
// in lib/boox-planner.js, which names those files.)
const PLANNER_NAME_PREFIX = String(process.env.BOOX_PLANNER_NAME_PREFIX || 'Hub Planner').trim();
const DEFAULT_HUB_DB = path.join(ROOT, 'data', 'hub.db');
const IMPORTED_HUB_DB = path.join(ROOT, 'data', 'dchat-import', 'db', 'hub.db');

const SUPPORTED_MIME_PREFIXES = [
  'application/pdf',
  'text/',
  'image/',
  'application/vnd.google-apps.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];

function usage() {
  console.log(`Usage: node scripts/ingest-boox-drive-notes.js [--user=douglas] [--folder-id=ID] [--folder-path="onyx/NoteMax/Notebooks"] [--force]

Environment:
  BOOX_DRIVE_USER          Google-authenticated Hub user. Default: douglas
  BOOX_DRIVE_FOLDER_ID     Preferred: exact Drive folder ID for the Notebooks folder
  BOOX_DRIVE_FOLDER_PATH   Fallback folder path. Default: ${DEFAULT_FOLDER_PATH}
  BOOX_DRIVE_VAULT_ROOT    Synthadoc vault root. Default: ${DEFAULT_VAULT}
  BOOX_DRIVE_QUEUE         Set to 0 to import only and skip Synthadoc queueing
  HUB_DB_PATH              Hub database containing the Google refresh token
`);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(v => v.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function escapeDriveString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeName(name) {
  return String(name || 'untitled')
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'untitled';
}

function statePath(vaultRoot) {
  return path.join(vaultRoot, 'raw_sources', 'boox-notes', '.boox-drive-state.json');
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { files: {} };
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function hubDbPath() {
  if (process.env.HUB_DB_PATH) return process.env.HUB_DB_PATH;
  try {
    const tables = execFileSync('/usr/bin/sqlite3', [DEFAULT_HUB_DB, '.tables'], { encoding: 'utf8' });
    if (tables.includes('crm_context')) return DEFAULT_HUB_DB;
  } catch (_) {}
  return IMPORTED_HUB_DB;
}

async function getDriveClient(user) {
  const sqlUser = String(user).replace(/'/g, "''");
  const dbPath = hubDbPath();
  const refreshToken = execFileSync('/usr/bin/sqlite3', [
    dbPath,
    `SELECT value FROM crm_context WHERE user = '${sqlUser}' AND key = '_google_refresh_token' LIMIT 1;`,
  ], { encoding: 'utf8' }).trim();
  if (!refreshToken) throw new Error(`No Google refresh token for ${user} in ${dbPath}. Sign in with Google from Hub first.`);

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth: client });
}

async function downloadDriveFile(drive, id) {
  const meta = await drive.files.get({
    fileId: id,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  });
  const { name, mimeType } = meta.data;

  let res;
  let filename;
  if (mimeType === 'application/vnd.google-apps.document') {
    res = await drive.files.export(
      { fileId: id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { responseType: 'arraybuffer' }
    );
    filename = `${safeName(name || 'document')}.docx`;
  } else {
    res = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    filename = safeName(name || 'file');
  }

  return { buffer: Buffer.from(res.data), filename, mimeType };
}

async function listAllFiles(drive, params) {
  const out = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      ...params,
      pageToken,
      pageSize: 1000,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size, parents, trashed)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    out.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function findChildFolder(drive, parentId, name) {
  const files = await listAllFiles(drive, {
    q: [
      `'${escapeDriveString(parentId)}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      `name = '${escapeDriveString(name)}'`,
      'trashed = false',
    ].join(' and '),
  });
  if (!files.length) throw new Error(`Drive folder not found below ${parentId}: ${name}`);
  if (files.length > 1) {
    console.warn(`[boox-drive] multiple folders named "${name}" below ${parentId}; using ${files[0].id}`);
  }
  return files[0].id;
}

async function resolveFolderId(drive, folderId, folderPath) {
  if (folderId) return folderId;
  let current = 'root';
  for (const part of String(folderPath || '').split('/').map(s => s.trim()).filter(Boolean)) {
    current = await findChildFolder(drive, current, part);
  }
  return current;
}

async function walkFolder(drive, folderId, rel = '') {
  const children = await listAllFiles(drive, {
    q: `'${escapeDriveString(folderId)}' in parents and trashed = false`,
    orderBy: 'folder,name',
  });
  const out = [];
  for (const item of children) {
    const relPath = path.posix.join(rel, safeName(item.name));
    if (item.mimeType === 'application/vnd.google-apps.folder') {
      out.push(...await walkFolder(drive, item.id, relPath));
    } else {
      out.push({ ...item, relPath });
    }
  }
  return out;
}

function isSupported(file) {
  return SUPPORTED_MIME_PREFIXES.some(prefix => String(file.mimeType || '').startsWith(prefix));
}

/** True for the Hub's own generated planner PDFs, which are output, not input. */
function isHubGeneratedPlanner(file) {
  if (!PLANNER_NAME_PREFIX) return false;
  return String(file.name || '').trim().toLowerCase()
    .startsWith(PLANNER_NAME_PREFIX.toLowerCase());
}

function queuePath(vaultRoot, sourcePath, fileId) {
  const queueDir = path.join(vaultRoot, 'raw_sources', 'ingest-queue');
  fs.mkdirSync(queueDir, { recursive: true });
  const queueFile = path.join(queueDir, `boox-${fileId}.path`);
  const rel = path.relative(vaultRoot, sourcePath);
  fs.writeFileSync(queueFile, rel + '\n');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const user = argValue('user') || process.env.BOOX_DRIVE_USER || 'douglas';
  const folderId = argValue('folder-id') || process.env.BOOX_DRIVE_FOLDER_ID || '';
  const folderPath = argValue('folder-path') || process.env.BOOX_DRIVE_FOLDER_PATH || DEFAULT_FOLDER_PATH;
  const vaultRoot = process.env.BOOX_DRIVE_VAULT_ROOT || process.env.WORKDAY_SYNC_LOCAL_DIR || DEFAULT_VAULT;
  const force = process.argv.includes('--force');
  const queueEnabled = process.env.BOOX_DRIVE_QUEUE !== '0';

  const rawDir = path.join(vaultRoot, 'raw_sources', 'boox-notes');
  fs.mkdirSync(rawDir, { recursive: true });

  const drive = await getDriveClient(user);
  const notebooksId = await resolveFolderId(drive, folderId, folderPath);
  const files = await walkFolder(drive, notebooksId);
  const stateFile = statePath(vaultRoot);
  const state = readState(stateFile);

  let downloaded = 0;
  let skipped = 0;
  let unsupported = 0;
  let generated = 0;

  for (const file of files) {
    if (isHubGeneratedPlanner(file)) {
      generated += 1;
      continue;
    }
    if (!isSupported(file)) {
      unsupported += 1;
      continue;
    }

    const previous = state.files[file.id];
    if (!force && previous?.modifiedTime === file.modifiedTime && previous?.size === (file.size || null)) {
      skipped += 1;
      continue;
    }

    const { buffer, filename, mimeType } = await downloadDriveFile(drive, file.id);
    const relDir = path.dirname(file.relPath) === '.' ? '' : path.dirname(file.relPath);
    const targetDir = path.join(rawDir, relDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${file.id}-${safeName(filename || file.name)}`);
    fs.writeFileSync(target, buffer);

    state.files[file.id] = {
      name: file.name,
      relPath: file.relPath,
      modifiedTime: file.modifiedTime,
      size: file.size || null,
      mimeType: mimeType || file.mimeType || '',
      sourcePath: path.relative(vaultRoot, target),
      syncedAt: new Date().toISOString(),
      // Import-only mode holds a page for a human read before it can reach the
      // knowledge base: weak handwriting and untitled pages must not become
      // facts on their own. Queueing mode hands it straight to Synthadoc.
      reviewStatus: queueEnabled ? 'queued' : 'pending',
    };
    if (queueEnabled) queuePath(vaultRoot, target, file.id);
    downloaded += 1;
    console.log(`[boox-drive] ${queueEnabled ? 'queued' : 'imported'} ${file.relPath}`);
  }

  state.lastRunAt = new Date().toISOString();
  state.folderId = notebooksId;
  state.folderPath = folderId ? null : folderPath;
  writeState(stateFile, state);

  const pending = writeReviewIndex(vaultRoot, rawDir, state);
  console.log(
    `[boox-drive] done: downloaded=${downloaded} skipped=${skipped} `
    + `unsupported=${unsupported} hub-generated-skipped=${generated} awaiting-review=${pending}`,
  );
}

/**
 * Rewrite the review inbox index. It is derived from the sync state every run —
 * never a second store — so a page that has been reviewed (its entry marked
 * anything other than `pending`) simply drops off the list. This is the visible
 * surface for "captured but not yet trusted": without it, import-only mode is a
 * silent archive.
 */
function writeReviewIndex(vaultRoot, rawDir, state) {
  const pending = Object.entries(state.files || {})
    .filter(([, meta]) => meta && meta.reviewStatus === 'pending')
    .sort((a, b) => String(b[1].syncedAt || '').localeCompare(String(a[1].syncedAt || '')));

  const lines = [
    '# Boox notes awaiting review',
    '',
    'Handwritten pages imported from Drive but deliberately NOT yet in the',
    'knowledge base. Read each one, give it a real title, correct the OCR, then',
    'queue it for Synthadoc ingest. Regenerated on every ingest run.',
    '',
    `Last updated: ${new Date().toISOString()}`,
    `Awaiting review: ${pending.length}`,
    '',
  ];
  for (const [id, meta] of pending) {
    lines.push(`- **${meta.name || id}** — imported ${String(meta.syncedAt || '').slice(0, 10)}`);
    lines.push(`  - file: \`${meta.sourcePath}\``);
  }
  if (!pending.length) lines.push('_Nothing awaiting review._');
  fs.writeFileSync(path.join(rawDir, 'REVIEW-QUEUE.md'), lines.join('\n') + '\n');
  return pending.length;
}

main().catch(err => {
  console.error(`[boox-drive] ${err.message}`);
  process.exit(1);
});
