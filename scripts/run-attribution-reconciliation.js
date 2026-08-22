#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: false });

const { runAttributionReconciliation } = require('../lib/attribution-reconciliation');

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const user = argValue('--user') || 'douglas';
  const sourceId = argValue('--source-id') || null;
  const limit = Math.max(1, Number(argValue('--limit') || (sourceId ? 1 : 32)) || 1);
  const force = process.argv.includes('--force');
  const result = await runAttributionReconciliation(user, { limit, sourceId, force });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors) process.exitCode = 1;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
