#!/usr/bin/env node
'use strict';

// Purge CRM products of an unintelligible meeting transcript and leave the
// raw capture as a monumental intake error. Default target is the 25 Aug 2026
// Krisp mobile recording that became /crm/questions cards about black teeth.
//
//   node scripts/repair-unintelligible-meeting-intake.js            # dry run
//   node scripts/repair-unintelligible-meeting-intake.js --apply
//   HUB_DB_PATH=<snapshot> node scripts/repair-unintelligible-meeting-intake.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: false });

const { assessTranscriptIntelligibility } = require('../lib/transcript-quality');
const { failUnintelligibleMeetingIntake, intakeDeleteInventory } = require('../lib/meeting-intake');
const db = require('../lib/db');

const DEFAULT_INTAKE_ID = '9d66f1d8-1289-45b9-a341-3b5d66875d09';

async function main() {
  const apply = process.argv.includes('--apply');
  const user = process.env.HUB_USER || 'douglas';
  const intakeId = process.argv.slice(2).find(arg => arg !== '--apply' && !arg.startsWith('-'))
    || DEFAULT_INTAKE_ID;
  const intake = db.hub().prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?').get(intakeId, user);
  if (!intake) {
    process.stdout.write(`No intake ${intakeId}\n`);
    process.exitCode = 1;
    return;
  }
  const assessment = assessTranscriptIntelligibility(intake.transcript);
  const inventory = intakeDeleteInventory(user, intakeId);
  const preview = {
    apply,
    intakeId,
    title: intake.title,
    status: intake.status,
    assessment,
    inventory,
  };
  if (!apply) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }
  const result = await failUnintelligibleMeetingIntake(user, intakeId, { assessment });
  process.stdout.write(`${JSON.stringify({ ...preview, result }, null, 2)}\n`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
