'use strict';

require('dotenv').config();

const { google } = require('googleapis');
const db = require('../lib/db');
const { uuid } = require('../lib/id');

async function main() {
  const hub = db.hub();
  hub.prepare(`
    INSERT INTO email_taxonomy_rules
      (id, user, match_type, match_value, target_label, notes, priority, enabled)
    VALUES (?, 'douglas', 'sender_email', 'natesnewsletter@substack.com',
      'Resources/Newsletters', ?, 1000, 1)
    ON CONFLICT(user, match_type, match_value) DO UPDATE SET
      target_label = excluded.target_label,
      notes = excluded.notes,
      priority = excluded.priority,
      enabled = 1
  `).run(uuid(), 'Nate Substack exact-sender consistency rule');

  const token = hub.prepare(`
    SELECT value FROM crm_context
    WHERE user = 'douglas' AND key = '_google_refresh_token'
  `).get();
  if (!token) throw new Error('No Google refresh token for douglas');

  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: token.value });
  const gmail = google.gmail({ version: 'v1', auth });

  const labels = (await gmail.users.labels.list({ userId: 'me' })).data.labels || [];
  const canonicalNames = new Set(
    hub.prepare(`
      SELECT lower(name) AS name FROM email_taxonomy_labels
      WHERE user = 'douglas' AND enabled = 1
    `).all().map(row => row.name)
  );
  const target = labels.find(label =>
    String(label.name).toLowerCase() === 'resources/newsletters'
  );
  if (!target) throw new Error('Resources/Newsletters Gmail label is missing');

  const removeLabelIds = labels
    .filter(label =>
      label.id !== target.id
      && canonicalNames.has(String(label.name).toLowerCase())
    )
    .map(label => label.id);

  const messageIds = [];
  let pageToken;
  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:natesnewsletter@substack.com',
      maxResults: 500,
      pageToken,
    });
    messageIds.push(...(response.data.messages || []).map(message => message.id));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  for (let index = 0; index < messageIds.length; index += 1000) {
    await gmail.users.messages.batchModify({
      userId: 'me',
      requestBody: {
        ids: messageIds.slice(index, index + 1000),
        addLabelIds: [target.id],
        removeLabelIds,
      },
    });
  }

  console.log(JSON.stringify({
    target: target.name,
    messagesUpdated: messageIds.length,
    competingCanonicalLabels: removeLabelIds.length,
  }));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
