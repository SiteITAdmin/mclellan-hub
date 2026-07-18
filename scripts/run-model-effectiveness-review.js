#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { runModelEffectivenessReview } = require('../lib/model-effectiveness-review');

runModelEffectivenessReview({ reason: process.argv[2] || 'manual-cli' })
  .then(report => {
    console.log(JSON.stringify({ ok: true, month: report.month, summary: report.summary, email: report.email }, null, 2));
  })
  .catch(err => {
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  });
