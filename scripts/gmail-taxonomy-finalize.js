'use strict';

require('/app/node_modules/dotenv').config({ path: '/app/.env' });

const fs = require('fs');
const { google } = require('/app/node_modules/googleapis');
const db = require('/app/lib/db');

const USER = 'douglas';
const LOG_PATH = process.argv[2] || '/tmp/gmail-taxonomy-finalize.jsonl';

const CANONICAL_LABELS = [
  'Action/Reply', 'Action/Waiting', 'Action/Review',
  'People/Alister McLellan', 'People/Nakai McLellan',
  'Organisations/Beacon Hospital', 'Organisations/Wicklow Dementia Support',
  'Projects/CV', 'Projects/Knowledge Base', 'Projects/Second Brain', 'Projects/VIPBackups',
  'Travel/Bookings', 'Travel/Price Alerts',
  'Finance/Banking', 'Finance/Receipts and Billing',
  'Commerce/Orders', 'Commerce/Offers',
  'Systems/Accounts and Security', 'Systems/Agents', 'Systems/Services',
  'Resources/Learning', 'Resources/Newsletters', 'Resources/Research',
];

const CANONICAL_ROOTS = new Set(CANONICAL_LABELS.map(name => name.split('/')[0]));

const LEGACY_TARGETS = {
  Dad: 'People/Alister McLellan',
  'Alister McLellan': 'People/Alister McLellan',
  Iain: 'People/Alister McLellan',
  Kai: 'People/Nakai McLellan',
  Beacon: 'Organisations/Beacon Hospital',
  'Wicklow Dementia': 'Organisations/Wicklow Dementia Support',
  WDS: 'Organisations/Wicklow Dementia Support',
  CV: 'Projects/CV',
  'Knowledge Base': 'Projects/Knowledge Base',
  'Second Brain': 'Projects/Second Brain',
  VIPBackups: 'Projects/VIPBackups',
  Ryanair: 'Travel/Bookings',
  'Dublin Airport': 'Travel/Bookings',
  SkyScanner: 'Travel/Price Alerts',
  'Bank of Ireland': 'Finance/Banking',
  Shopping: 'Commerce/Orders',
  'Kildare Village': 'Commerce/Offers',
  _agent: 'Systems/Agents',
  agent: 'Systems/Agents',
  Agents: 'Systems/Agents',
  Elementor: 'Systems/Services',
  'M365 Learning': 'Resources/Learning',
  MoreMins: 'Systems/Services',
  Ollama: 'Systems/Services',
  OpenRouter: 'Systems/Services',
  Proton: 'Systems/Services',
  Slack: 'Systems/Services',
  Supabase: 'Systems/Services',
  Workspace: 'Systems/Services',
  'All Other Substacks': 'Resources/Newsletters',
  'Edwina Voice of AI': 'Resources/Newsletters',
  'Forte Labs Newsletter': 'Resources/Newsletters',
  'Forward Future': 'Resources/Newsletters',
  Futurepedia: 'Resources/Newsletters',
  'Grace Leung': 'Resources/Newsletters',
  'Jeff Su': 'Resources/Newsletters',
  'Simple AI': 'Resources/Newsletters',
  'The Rundown AI': 'Resources/Newsletters',
  'AI News': 'Resources/Newsletters',
  MasterClass: 'Resources/Newsletters',
  'Matthew Berman': 'Resources/Newsletters',
  Nate: 'Resources/Newsletters',
  'Peter Simmons': 'Resources/Newsletters',
  'Team Maven': 'Resources/Newsletters',
  Feedly: 'Resources/Research',
  LinkedIn: 'Resources/Research',
  'AI Research': 'Resources/Research',
  null: 'Resources/Research',
};

function chunks(items, size = 500) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function header(message, name) {
  return (message.payload?.headers || []).find(item => item.name.toLowerCase() === name)?.value || '';
}

function classify({ from, subject, labelNames, unread }) {
  const existingCanonical = CANONICAL_LABELS.filter(name => labelNames.includes(name));
  if (existingCanonical.length === 1) return existingCanonical[0];

  const text = `${from}\n${subject}`.toLowerCase();
  if (/kaimutenga@icloud\.com|nakai mclellan|nakai mutenga/.test(text)) return 'People/Nakai McLellan';
  if (/alister|dad|iain/.test(text)) return 'People/Alister McLellan';
  if (/skyscanner/.test(text)) return 'Travel/Price Alerts';
  if (/ryanair|dublin airport|flightradar|aviationstack/.test(text)) return 'Travel/Bookings';
  if (/beaconhospital\.ie/.test(text)) return 'Organisations/Beacon Hospital';
  if (/wicklow dementia|\bwds\b/.test(text)) return 'Organisations/Wicklow Dementia Support';
  if (/rholdsworthconsulting|richard holdsworth/.test(text)) return 'Projects/VIPBackups';
  if (/bank of ireland|irish life|lottery\.ie|payments-noreply/.test(text)) return 'Finance/Banking';
  if (/amazon\.|tesco|kildare village|laundryheap|square mile coffee|warhammer/.test(text)) return 'Commerce/Orders';
  if (/security|new login|new sign|new device|verification|password|account was used/.test(text)) {
    return 'Systems/Accounts and Security';
  }
  if (/m365|microsoft 365|learning|course|masterclass/.test(text)) return 'Resources/Learning';
  if (/agentmail|heypresto|agent\b/.test(text)) return 'Systems/Agents';
  if (/ollama|openrouter|supabase|slack|proton|elementor|workspace|moremins/.test(text)) {
    return 'Systems/Services';
  }
  if (/substack|newsletter|beehiiv|futurepedia|rundown|forwardfuture|fortelabs|maven|digest|myft/.test(text)) {
    return 'Resources/Newsletters';
  }
  if (/invoice|receipt|billing|payment/.test(subject.toLowerCase())) return 'Finance/Receipts and Billing';
  if (/calendar|ticket|event|flight|booking/.test(subject.toLowerCase())) return 'Travel/Bookings';

  for (const [legacy, target] of Object.entries(LEGACY_TARGETS)) {
    if (labelNames.includes(legacy)) return target;
  }
  return unread ? 'Action/Review' : 'Resources/Research';
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

  const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
  const labels = labelsResponse.data.labels || [];
  const byName = new Map(labels.map(label => [label.name, label]));
  const byId = new Map(labels.map(label => [label.id, label]));

  for (const name of CANONICAL_LABELS) {
    if (byName.has(name)) continue;
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    byName.set(name, created.data);
    byId.set(created.data.id, created.data);
  }

  const messages = [];
  let pageToken;
  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: '-from:me -in:trash -in:spam',
      maxResults: 500,
      pageToken,
    });
    messages.push(...(response.data.messages || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  const groups = new Map(CANONICAL_LABELS.map(name => [name, []]));
  const log = fs.createWriteStream(LOG_PATH, { flags: 'w' });

  for (const item of messages) {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: item.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const message = response.data;
    const labelIds = message.labelIds || [];
    const labelNames = labelIds.map(id => byId.get(id)?.name || id);
    const from = header(message, 'from');
    const subject = header(message, 'subject');
    const target = classify({
      from,
      subject,
      labelNames,
      unread: labelIds.includes('UNREAD'),
    });
    groups.get(target).push(item.id);
    log.write(JSON.stringify({
      id: item.id,
      thread_id: item.threadId,
      from,
      subject,
      original_labels: labelNames,
      target_label: target,
    }) + '\n');
  }
  log.end();

  const keepNames = new Set([...CANONICAL_LABELS, ...CANONICAL_ROOTS]);
  const obsoleteLabels = labels.filter(label =>
    label.type === 'user' && !keepNames.has(label.name)
  );
  const baseRemoveLabelIds = obsoleteLabels.map(label => label.id);
  if (byName.has('INBOX')) baseRemoveLabelIds.push(byName.get('INBOX').id);
  else baseRemoveLabelIds.push('INBOX');

  const counts = {};
  for (const [target, ids] of groups) {
    counts[target] = ids.length;
    const targetId = byName.get(target).id;
    const removeLabelIds = [
      ...baseRemoveLabelIds,
      ...CANONICAL_LABELS
        .filter(name => name !== target)
        .map(name => byName.get(name).id),
    ];
    for (const batch of chunks(ids)) {
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: batch,
          addLabelIds: [targetId],
          removeLabelIds,
        },
      });
    }
  }

  for (const label of obsoleteLabels) {
    await gmail.users.labels.delete({ userId: 'me', id: label.id });
  }

  const inbox = await gmail.users.messages.list({
    userId: 'me',
    labelIds: ['INBOX'],
    maxResults: 1,
  });

  console.log(JSON.stringify({
    processed: messages.length,
    counts,
    obsolete_labels_deleted: obsoleteLabels.map(label => label.name),
    inbox_remaining: Number(inbox.data.resultSizeEstimate || 0),
    log: LOG_PATH,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
