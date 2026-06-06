'use strict';

require('/app/node_modules/dotenv').config({ path: '/app/.env' });

const { google } = require('/app/node_modules/googleapis');
const db = require('/app/lib/db');

const APPLY = process.argv.includes('--apply');
const USER = 'douglas';
const TODAY_START = Date.parse('2026-06-06T00:00:00Z');

function header(message, name) {
  return (message.payload?.headers || []).find(item => item.name.toLowerCase() === name)?.value || '';
}

async function listAll(gmail, query) {
  const messages = [];
  let pageToken;
  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500,
      pageToken,
    });
    messages.push(...(response.data.messages || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return messages;
}

function shouldRestore(message, labels) {
  const received = Number(message.internalDate || 0);
  const today = received >= TODAY_START;
  return {
    restore: today,
    reasons: today ? ['received-today'] : [],
  };
}

async function main() {
  const token = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(USER);
  if (!token) throw new Error('Google refresh token not found');

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: token.value });
  const gmail = google.gmail({ version: 'v1', auth });

  const candidates = await listAll(
    gmail,
    '-in:inbox -in:trash -in:spam newer_than:2d'
  );
  const restore = [];
  for (const item of candidates) {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: item.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const message = response.data;
    const labels = message.labelIds || [];
    const decision = shouldRestore(message, labels);
    if (!decision.restore) continue;
    restore.push({
      id: item.id,
      from: header(message, 'from'),
      subject: header(message, 'subject'),
      date: header(message, 'date'),
      reasons: decision.reasons,
    });
  }

  if (APPLY && restore.length) {
    for (let index = 0; index < restore.length; index += 500) {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: restore.slice(index, index + 500).map(item => item.id),
          addLabelIds: ['INBOX'],
        },
      });
    }
  }

  const inbox = await listAll(gmail, 'in:inbox');
  console.log(JSON.stringify({
    apply: APPLY,
    candidate_count: candidates.length,
    restore_count: restore.length,
    inbox_count: inbox.length,
    messages: restore,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
