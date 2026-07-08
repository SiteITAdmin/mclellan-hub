#!/usr/bin/env node
'use strict';

const { writeTokenBurnAudit } = require('../lib/token-burn-auditor');

const userArg = process.argv.find(arg => arg.startsWith('--user='));
const user = userArg ? userArg.slice('--user='.length) : 'douglas';

try {
  const { audit } = writeTokenBurnAudit(user);
  console.log(`Token Burn Auditor: ${audit.verdict.toUpperCase()}`);
  for (const item of audit.checks) {
    const mark = item.verdict === 'pass' ? 'PASS' : item.verdict === 'warn' ? 'WARN' : 'FAIL';
    console.log(`[${mark}] ${item.name}: ${item.evidence}`);
  }
  if (process.argv.includes('--strict') && audit.verdict === 'fail') process.exit(1);
} catch (err) {
  console.error(`Token Burn Auditor failed to run: ${err.message}`);
  process.exit(1);
}

