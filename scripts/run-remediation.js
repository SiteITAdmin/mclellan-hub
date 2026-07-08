#!/usr/bin/env node
'use strict';

const { runFamilyAudit } = require('../lib/hub-family-agents');
const { remediateFamily } = require('../lib/hub-remediation');

const userArg = process.argv.find(arg => arg.startsWith('--user='));
const user = userArg ? userArg.slice('--user='.length) : 'douglas';
const useModel = !process.argv.includes('--no-model');

(async () => {
  try {
    // Self-heal first (reads live checks), then audit once so capo receipts
    // reflect the post-fix state.
    const result = await remediateFamily(user, { useModel });
    console.log(`Remediation: ${result.counts.resolved} fixed, ${result.counts.dispatched} dispatched, ${result.counts.escalated} escalated`);
    for (const o of result.resolved) console.log(`[FIXED]      ${o.capoKey}:${o.check.name} via ${o.action}`);
    for (const o of result.dispatched) console.log(`[DISPATCHED] ${o.capoKey}:${o.check.name} via ${o.action}`);
    for (const o of result.escalated) console.log(`[ESCALATE]   ${o.capoKey}:${o.check.name} — ${o.evidence}`);
    runFamilyAudit(user);
    if (process.argv.includes('--strict') && result.counts.escalated > 0) process.exit(1);
  } catch (err) {
    console.error(`Remediation run failed: ${err.message}`);
    process.exit(1);
  }
})();
