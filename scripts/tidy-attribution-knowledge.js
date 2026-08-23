#!/usr/bin/env node
'use strict';

// Finish the attribution corpus pass from stored evidence. No Terra calls.
//
//   node scripts/tidy-attribution-knowledge.js            # dry run
//   node scripts/tidy-attribution-knowledge.js --apply    # write
//   HUB_DB_PATH=<snapshot> node scripts/tidy-attribution-knowledge.js --apply

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: false });

const db = require('../lib/db');
const { tidyAttributionKnowledge } = require('../lib/attribution-tidy');
const { groupedClarifications } = require('../lib/crm-clarifications');

async function snapshotUpdateTask(user, taskId, fields) {
  if (!fields || fields.notes == null) return;
  db.hub().prepare('UPDATE google_tasks SET notes = ?, synced_at = unixepoch() WHERE id = ? AND user = ?')
    .run(fields.notes, taskId, user);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const user = process.env.HUB_USER || 'douglas';
  const snapshot = Boolean(process.env.HUB_DB_PATH);
  const result = await tidyAttributionKnowledge(user, {
    apply,
    updateTaskFn: snapshot ? snapshotUpdateTask : undefined,
  });
  const groups = groupedClarifications(user);
  process.stdout.write(`${apply ? 'APPLY' : 'DRY RUN'} ${JSON.stringify({ result, questions: { total: groups.total, counts: groups.counts } }, null, 2)}\n`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
