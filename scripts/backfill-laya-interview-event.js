#!/usr/bin/env node
'use strict';

// One-off backfill + smoke test for the calendar-write path (lib/google-calendar.js).
// Creates the real Laya Healthcare interview event using the exact source_id the
// CRM engine already used to create Google Task ef890133, so any future
// reprocessing of that email correctly dedups against this event too.
// Run on the VPS (the refresh token with calendar.events scope lives there):
//   node scripts/backfill-laya-interview-event.js

require('dotenv').config();
const { createCalendarEvent } = require('../lib/google-calendar');

const SOURCE_ID = 'crm-engine:email_summary:380c88b3-5347-4ce1-9099-d75a0581af17:calendar:attend-virtual-1st-round-technical-interview-with-laya-healthcare-on-friday-24th-july-at-13-30';

async function main() {
  const result = await createCalendarEvent('douglas', {
    title: 'Attend virtual 1st round technical interview with Laya Healthcare on Friday 24th July at 13.30',
    description: [
      'Evidence: Laya Healthcare invites Douglas to a virtual 1st round technical interview for the',
      'Senior Microsoft Collaboration Engineer role on Friday 24th July at 13.30, with Olivia O’Loughlin',
      '(Applications Team Leader) and Warren Guerin (IT Transformation Lead). ~40-45 mins.',
      'Source: email_summary/380c88b3-5347-4ce1-9099-d75a0581af17',
    ].join('\n'),
    location: 'https://teams.microsoft.com/meet/368627281804725?p=fGEtI1gO4zEQj58m7l',
    startAt: '2026-07-24T13:30',
    endAt: '2026-07-24T14:15',
    source: 'crm-engine',
    sourceId: SOURCE_ID,
    contactId: 'd11b3c85-338f-462c-a4fe-3504b1fd0f92', // Carol White
  });
  console.log('createCalendarEvent result:', JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
