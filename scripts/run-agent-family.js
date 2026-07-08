#!/usr/bin/env node
'use strict';

const { runFamilyAudit } = require('../lib/hub-family-agents');
const { writeConsigliereAudit } = require('../lib/hub-consigliere-agent');

const userArg = process.argv.find(arg => arg.startsWith('--user='));
const user = userArg ? userArg.slice('--user='.length) : 'douglas';

try {
  const family = runFamilyAudit(user);
  const { audit } = writeConsigliereAudit(user);
  console.log(`Capos reported: ${family.capoReceipts.length}`);
  for (const receipt of family.capoReceipts) {
    console.log(`[${receipt.verdict.toUpperCase()}] ${receipt.title}`);
  }
  console.log(`Underbosses reported: ${family.underbossReceipts.length}`);
  for (const receipt of family.underbossReceipts) {
    console.log(`[${receipt.verdict.toUpperCase()}] ${receipt.title}`);
  }
  console.log(`Hub Consigliere: ${audit.verdict.toUpperCase()}`);
  if (process.argv.includes('--strict') && audit.verdict === 'fail') process.exit(1);
} catch (err) {
  console.error(`Agent family audit failed: ${err.message}`);
  process.exit(1);
}

