#!/usr/bin/env node
// One-off: create a Drive folder under Onyx/NoteMax/Notebooks for each CRM project.
// Idempotent — skips folders that already exist.
//
// Usage: node scripts/create-notebook-folders.js [--user=douglas]

'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const db = require('../lib/db');
const { getDriveClient, getOrCreateFolder, resolveFolderPath } = require('../lib/google-drive');

const user = (process.argv.find(a => a.startsWith('--user=')) || '--user=douglas').split('=')[1];

(async () => {
  const drive = await getDriveClient(user);
  const notebooksId = await resolveFolderPath(drive, ['Onyx', 'NoteMax', 'Notebooks']);

  const projects = db.hub().prepare('SELECT name FROM projects WHERE user = ? ORDER BY name').all(user);
  if (!projects.length) {
    console.log(`No projects found for user "${user}".`);
    return;
  }

  for (const p of projects) {
    const id = await getOrCreateFolder(drive, p.name, notebooksId);
    console.log(`${p.name} -> ${id}`);
  }
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
