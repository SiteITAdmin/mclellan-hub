#!/usr/bin/env node
'use strict';

const {
  dailyConsigliereMarkdown,
  writeDailyConsigliereReport,
} = require('../lib/daily-consigliere-report');

const userArg = process.argv.find(arg => arg.startsWith('--user='));
const user = userArg ? userArg.slice('--user='.length) : 'douglas';

try {
  const { report } = writeDailyConsigliereReport(user);
  console.log(dailyConsigliereMarkdown(report));
  if (process.argv.includes('--strict') && report.verdict === 'fail') process.exit(1);
} catch (err) {
  console.error(`Daily Consigliere report failed: ${err.message}`);
  process.exit(1);
}
