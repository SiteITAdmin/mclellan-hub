'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SYSTEM_MAILBOXES = new Set([
  'Important', 'Starred', 'All Mail', 'Drafts', 'Sent Mail', 'Trash', 'Spam',
  'Outbox', 'Notes',
]);

const LEGACY_MAPPINGS = {
  Dad: 'People/Alister McLellan',
  'Alister McLellan': 'People/Alister McLellan',
  Iain: 'People/Alister McLellan',
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
  null: 'Resources/Research',
};

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

const MIXED_MAILBOXES = ['Kai', 'Follow-up', 'Personal', 'INBOX'];

function appleString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function runAppleScript(lines) {
  const args = lines.flatMap(line => ['-e', line]);
  return execFileSync('osascript', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trimEnd();
}

function listMailboxes() {
  const output = runAppleScript([
    'tell application "Mail"',
    'set oldDelimiters to AppleScript\'s text item delimiters',
    'set AppleScript\'s text item delimiters to linefeed',
    'set mailboxNames to name of every mailbox of account "Google"',
    'set outputText to mailboxNames as text',
    'set AppleScript\'s text item delimiters to oldDelimiters',
    'return outputText',
    'end tell',
  ]);
  return output ? output.split('\n') : [];
}

function fetchMailbox(name) {
  const output = runAppleScript([
    'tell application "Mail"',
    `set matchingMailboxes to every mailbox of account "Google" whose name is ${appleString(name)}`,
    'if (count matchingMailboxes) is 0 then return ""',
    'set sourceMailbox to item 1 of matchingMailboxes',
    'set outputText to ""',
    'repeat with aMessage in messages of sourceMailbox',
    'set outputText to outputText & (id of aMessage as text) & tab & (sender of aMessage as text) & tab & (subject of aMessage as text) & tab & (date received of aMessage as text) & linefeed',
    'end repeat',
    'return outputText',
    'end tell',
  ]);
  if (!output) return [];
  return output.split('\n').map(line => {
    const [id, sender = '', subject = '', receivedAt = ''] = line.split('\t');
    return { id: Number(id), mailbox: name, sender, subject, received_at: receivedAt };
  }).filter(record => Number.isInteger(record.id));
}

function ensureMailbox(name) {
  runAppleScript([
    'tell application "Mail"',
    'set googleAccount to account "Google"',
    `set matchingMailboxes to every mailbox of googleAccount whose name is ${appleString(name)}`,
    `if (count matchingMailboxes) is 0 then make new mailbox at googleAccount with properties {name:${appleString(name)}}`,
    'end tell',
  ]);
}

function moveIds(source, target, ids) {
  if (!ids.length) return;
  const idList = `{${ids.join(',')}}`;
  const [targetParent, targetLeaf] = target.split('/');
  if (!targetParent || !targetLeaf) throw new Error(`Canonical target must contain "/": ${target}`);
  runAppleScript([
    'tell application "Mail"',
    `set sourceMailbox to item 1 of (every mailbox of account "Google" whose name is ${appleString(source)})`,
    `set targetMailbox to mailbox ${appleString(targetLeaf)} of mailbox ${appleString(targetParent)} of account "Google"`,
    `repeat with targetId in ${idList}`,
    'set matchingMessages to messages of sourceMailbox whose id is targetId',
    'if (count matchingMessages) > 0 then move item 1 of matchingMessages to targetMailbox',
    'end repeat',
    'end tell',
  ]);
}

function countCanonical(target) {
  const [parent, leaf] = target.split('/');
  const output = runAppleScript([
    'tell application "Mail"',
    `set parentMailbox to mailbox ${appleString(parent)} of account "Google"`,
    `set targetMailbox to mailbox ${appleString(leaf)} of parentMailbox`,
    'return count of messages of targetMailbox',
    'end tell',
  ]);
  return Number(output);
}

function countInbox() {
  return Number(runAppleScript([
    'tell application "Mail"',
    'return count of messages of mailbox "INBOX" of account "Google"',
    'end tell',
  ]));
}

function classify(record) {
  const text = `${record.sender}\n${record.subject}`.toLowerCase();
  if (/kaimutenga@icloud\.com|nakai mclellan|nakai mutenga/.test(text)) return 'People/Nakai McLellan';
  if (/alister|dad|iain/.test(text)) return 'People/Alister McLellan';
  if (/skyscanner/.test(text)) return 'Travel/Price Alerts';
  if (/ryanair|dublin airport|flightradar|aviationstack/.test(text)) return 'Travel/Bookings';
  if (/bank of ireland|irish life|lottery\.ie|payments-noreply/.test(text)) return 'Finance/Banking';
  if (/amazon\.|tesco|kildare village|laundryheap|square mile coffee|warhammer/.test(text)) return 'Commerce/Orders';
  if (/security|new login|new sign|new device|verification|password|account was used/.test(text)) {
    return 'Systems/Accounts and Security';
  }
  if (/substack|newsletter|beehiiv|futurepedia|rundown|forwardfuture|fortelabs|maven|masterclass/.test(text)) {
    return 'Resources/Newsletters';
  }
  if (/beaconhospital\.ie/.test(text)) return 'Organisations/Beacon Hospital';
  if (/rholdsworthconsulting|richard holdsworth/.test(text)) return 'Projects/VIPBackups';
  if (/invoice|receipt|billing|payment/.test(text)) return 'Finance/Receipts and Billing';
  if (/calendar|ticket|event|flight|booking/.test(text)) return 'Travel/Bookings';
  return record.mailbox === 'INBOX' ? 'Action/Review' : 'Resources/Research';
}

function snapshot(mailboxes) {
  const records = [];
  for (const mailbox of mailboxes) {
    if (!SYSTEM_MAILBOXES.has(mailbox)) records.push(...fetchMailbox(mailbox));
  }
  return records;
}

function toTsv(records, includeTarget = false) {
  const columns = ['mailbox', 'id', 'sender', 'subject', 'received_at'];
  if (includeTarget) columns.push('target_mailbox', 'status', 'error');
  const clean = value => String(value ?? '').replace(/[\t\r\n]+/g, ' ');
  return [
    columns.join('\t'),
    ...records.map(record => columns.map(column => clean(record[column])).join('\t')),
  ].join('\n') + '\n';
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function main() {
  if (process.argv.includes('--verify')) {
    const canonical = Object.fromEntries(CANONICAL_LABELS.map(label => [label, countCanonical(label)]));
    const available = new Set(listMailboxes());
    const legacy = {};
    for (const source of Object.keys(LEGACY_MAPPINGS)) {
      if (available.has(source)) legacy[source] = fetchMailbox(source).length;
    }
    console.log(JSON.stringify({
      canonical,
      canonical_total: Object.values(canonical).reduce((sum, count) => sum + count, 0),
      inbox: countInbox(),
      legacy_nonempty: Object.fromEntries(Object.entries(legacy).filter(([, count]) => count > 0)),
    }, null, 2));
    return;
  }

  const outputDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'logs'));
  fs.mkdirSync(outputDir, { recursive: true });
  const runStamp = stamp();
  const beforePath = path.join(outputDir, `mail-taxonomy-before-${runStamp}.tsv`);
  const operationsPath = path.join(outputDir, `mail-taxonomy-operations-${runStamp}.tsv`);
  const afterPath = path.join(outputDir, `mail-taxonomy-after-${runStamp}.tsv`);

  const initialMailboxes = listMailboxes();
  const before = snapshot(initialMailboxes);
  fs.writeFileSync(beforePath, toTsv(before), 'utf8');

  for (const label of CANONICAL_LABELS) ensureMailbox(label);

  const operations = [];
  const available = new Set(listMailboxes());
  const sources = [...Object.keys(LEGACY_MAPPINGS), ...MIXED_MAILBOXES];
  for (const source of [...new Set(sources)]) {
    if (!available.has(source)) continue;
    const records = fetchMailbox(source);
    const grouped = new Map();
    for (const record of records) {
      const target = LEGACY_MAPPINGS[source] || classify(record);
      if (!grouped.has(target)) grouped.set(target, []);
      grouped.get(target).push(record);
    }
    for (const [target, targetRecords] of grouped) {
      try {
        moveIds(source, target, targetRecords.map(record => record.id));
        operations.push(...targetRecords.map(record => ({
          ...record, target_mailbox: target, status: 'moved', error: '',
        })));
      } catch (error) {
        operations.push(...targetRecords.map(record => ({
          ...record, target_mailbox: target, status: 'error', error: error.message,
        })));
      }
    }
  }
  fs.writeFileSync(operationsPath, toTsv(operations, true), 'utf8');

  const after = snapshot(listMailboxes());
  fs.writeFileSync(afterPath, toTsv(after), 'utf8');

  const result = {
    before: beforePath,
    operations: operationsPath,
    after: afterPath,
    before_records: before.length,
    moved: operations.filter(record => record.status === 'moved').length,
    errors: operations.filter(record => record.status === 'error').length,
    after_records: after.length,
  };
  console.log(JSON.stringify(result, null, 2));
}

main();
