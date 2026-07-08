#!/usr/bin/env node
'use strict';

const { writeConsigliereAudit } = require('../lib/hub-consigliere-agent');

const userArg = process.argv.find(arg => arg.startsWith('--user='));
const user = userArg ? userArg.slice('--user='.length) : 'douglas';

try {
  const { audit } = writeConsigliereAudit(user);
  console.log(`Hub Consigliere: ${audit.verdict.toUpperCase()}`);
  for (const family of audit.families) {
    console.log(`[${family.verdict.toUpperCase()}] ${family.label}: ${family.evidence}`);
    if (family.superseded_stale_versions.length) {
      console.log(`  superseded stale: ${family.superseded_stale_versions.join(', ')}`);
    }
  }
  console.log(`[${audit.subordinate.verdict.toUpperCase()}] ${audit.subordinate.label}: ${audit.subordinate.evidence}`);
  if (process.argv.includes('--strict') && audit.verdict === 'fail') process.exit(1);
} catch (err) {
  console.error(`Hub Consigliere failed to run: ${err.message}`);
  process.exit(1);
}

