#!/usr/bin/env node
'use strict';

// Repair the /crm/questions flood from the first attribution-reconciliation
// corpus pass: auto-apply quote-backed organisational fact unlinks, keep only
// person-decidable reviews, drop the rest. No new model calls.
//
//   node scripts/repair-attribution-review-queue.js            # dry run
//   node scripts/repair-attribution-review-queue.js --apply    # write receipts
//   HUB_DB_PATH=<snapshot> node scripts/repair-attribution-review-queue.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: false });

const { settleOpenAttributionReviews } = require('../lib/attribution-reconciliation');

async function main() {
  const apply = process.argv.includes('--apply');
  const user = process.env.HUB_USER || 'douglas';
  const result = await settleOpenAttributionReviews(user, { apply });
  process.stdout.write(`${apply ? 'APPLY' : 'DRY RUN'} ${JSON.stringify(result, null, 2)}\n`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
