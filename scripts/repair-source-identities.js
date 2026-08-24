#!/usr/bin/env node
'use strict';

const db = require('../lib/db');
const {
  loadContactIdentities,
  resolveContactIdentityFromContacts,
} = require('../lib/contact-identity');
const { messageIdentityHints, routingMetadata } = require('../lib/messaging-capture');

function parseArgs(argv) {
  const args = { apply: false, user: 'douglas', contactIds: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--user' && argv[i + 1]) args.user = argv[++i];
    else if (argv[i] === '--contact-id' && argv[i + 1]) args.contactIds.add(argv[++i]);
    else if (argv[i] === '--help') {
      console.log('Usage: node scripts/repair-source-identities.js [--user douglas] [--contact-id ID] [--apply]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function parsedEnvelope(row) {
  try { return JSON.parse(row.raw_json || '{}'); }
  catch (_) { return {}; }
}

function identityPayload(identity) {
  return {
    status: identity.status,
    contact_id: identity.contact?.id || null,
    contact_name: identity.contact?.name || null,
    matched_by: identity.matchedBy || [],
    candidate_ids: identity.status === 'ambiguous' ? identity.candidateIds : [],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hub = db.hub();
  const contacts = loadContactIdentities(args.user, { hub });
  const allowed = identity => identity.contact
    && (!args.contactIds.size || args.contactIds.has(identity.contact.id));
  const emails = [];
  const messages = [];
  let ambiguousEmails = 0;
  let ambiguousMessages = 0;

  for (const row of hub.prepare(`
    SELECT id, from_name, from_email
    FROM email_summaries
    WHERE user = ? AND contact_id IS NULL
    ORDER BY received_at, id
  `).all(args.user)) {
    const identity = resolveContactIdentityFromContacts(contacts, {
      names: [row.from_name],
      addresses: [row.from_email],
    });
    if (identity.status === 'ambiguous') ambiguousEmails += 1;
    if (allowed(identity)) emails.push({ row, identity });
  }

  for (const row of hub.prepare(`
    SELECT * FROM messaging_messages
    WHERE user = ?
    ORDER BY received_at, id
  `).all(args.user)) {
    if (routingMetadata(row).contact_id) continue;
    const envelope = parsedEnvelope(row);
    const payload = {
      ...envelope,
      platform: row.platform,
      chat_id: row.chat_id,
      chat_name: row.chat_name,
      is_group: Boolean(row.is_group),
      sender_id: row.sender_id,
      sender_name: row.sender_name,
    };
    const identity = resolveContactIdentityFromContacts(contacts, messageIdentityHints(payload));
    if (identity.status === 'ambiguous') ambiguousMessages += 1;
    if (allowed(identity)) messages.push({ row, envelope, identity });
  }

  if (args.apply) {
    hub.transaction(() => {
      const updateEmail = hub.prepare(`
        UPDATE email_summaries SET contact_id = ?
        WHERE user = ? AND id = ? AND contact_id IS NULL
      `);
      for (const item of emails) updateEmail.run(item.identity.contact.id, args.user, item.row.id);

      const updateMessage = hub.prepare(`
        UPDATE messaging_messages SET raw_json = ?
        WHERE user = ? AND id = ?
      `);
      for (const item of messages) {
        const next = {
          ...item.envelope,
          contact_id: item.identity.contact.id,
          contact_name: item.identity.contact.name,
          identity_resolution: identityPayload(item.identity),
        };
        updateMessage.run(JSON.stringify(next), args.user, item.row.id);
      }
    })();
  }

  const grouped = items => Object.values(items.reduce((out, item) => {
    const id = item.identity.contact.id;
    out[id] ||= { contact_id: id, contact_name: item.identity.contact.name, sources: 0 };
    out[id].sources += 1;
    return out;
  }, {})).sort((a, b) => b.sources - a.sources || a.contact_name.localeCompare(b.contact_name));
  console.log(JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    user: args.user,
    contact_filter: [...args.contactIds],
    email_matches: emails.length,
    message_matches: messages.length,
    ambiguous_emails: ambiguousEmails,
    ambiguous_messages: ambiguousMessages,
    contacts: grouped([...emails, ...messages]),
  }, null, 2));
}

main();
