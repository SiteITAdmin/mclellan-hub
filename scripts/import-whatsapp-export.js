#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseWhatsAppExport,
  buildImportRecords,
} = require('../lib/whatsapp-export');

function args(argv) {
  const out = { user: 'douglas', timeZone: 'Europe/Dublin', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--dry-run') out.dryRun = true;
    else if (key.startsWith('--')) out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} required`);
  return options[key];
}

function main() {
  const options = args(process.argv.slice(2));
  const file = required(options, 'file');
  const routeConfigFile = required(options, 'routeConfig');
  const routeId = required(options, 'routeId');
  const config = JSON.parse(fs.readFileSync(routeConfigFile, 'utf8'));
  const route = (config.routes || []).find(item => item.id === routeId);
  if (!route) throw new Error(`route not found: ${routeId}`);
  if (route.match?.chat_type !== 'group') throw new Error(`route is not a group route: ${routeId}`);
  const chatName = options.chatName || route.match?.chat_names?.[0];
  if (!chatName) throw new Error('chat name unavailable');

  const parsed = parseWhatsAppExport(fs.readFileSync(file, 'utf8'), { timeZone: options.timeZone });
  const built = buildImportRecords(parsed, {
    route,
    chatName,
    user: options.user,
    sourceName: options.sourceName || path.basename(file),
  });
  const participantCounts = {};
  for (const record of built.records) {
    participantCounts[record.sender_name] = (participantCounts[record.sender_name] || 0) + 1;
  }
  const report = {
    dry_run: options.dryRun,
    parsed: parsed.length,
    importable: built.records.length,
    skipped: built.skipped,
    first_message_local: built.records[0]?.raw?.export_timestamp_local || null,
    last_message_local: built.records.at(-1)?.raw?.export_timestamp_local || null,
    participants: participantCounts,
  };

  if (!options.dryRun) {
    const db = require('../lib/db');
    const { captureMessagingMessage, routingMetadata } = require('../lib/messaging-capture');
    let created = 0;
    let duplicates = 0;
    let routingRefreshed = 0;
    db.hub().transaction(() => {
      for (const record of built.records) {
        const result = captureMessagingMessage(options.user, record);
        if (result.created) created += 1;
        else {
          duplicates += 1;
          const currentRoute = routingMetadata(result.row);
          if (
            currentRoute.project_slug !== String(record.project_slug || '')
            || currentRoute.project_name !== String(record.project_name || '')
            || currentRoute.contact_name !== String(record.contact_name || '')
            || !currentRoute.historical_backfill
          ) {
            db.hub().prepare('UPDATE messaging_messages SET raw_json = ? WHERE id = ?')
              .run(JSON.stringify(record).slice(0, 50000), result.id);
            routingRefreshed += 1;
          }
        }
      }
    })();
    report.created = created;
    report.duplicates = duplicates;
    report.routing_refreshed = routingRefreshed;
  }

  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
