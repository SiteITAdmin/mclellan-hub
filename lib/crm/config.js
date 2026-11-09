'use strict';

// Fixed facts about Douglas's own accounts. Env overrides exist for tests and
// for when the Outlook flow moves to its own Drive subfolder.

function list(envName, fallback) {
  return String(process.env[envName] || fallback).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

module.exports = {
  // Outlook 365 (Work) arrives through Douglas's own flow into this Drive folder.
  outlookFolderId: () => process.env.CRM_OUTLOOK_FOLDER_ID || '1ESZYr16slcoGFYQFO8Gdj0PrTnhyMWGn',
  workAddresses: () => list('CRM_WORK_ADDRESSES', 'douglas.mclellan@beaconhospital.ie'),
  personalAddresses: () => list('CRM_PERSONAL_ADDRESSES', 'douglas@mclellan.scot,aio.mclellan@gmail.com,douglas@wicklowdementiasupport.ie'),
  // Further Gmail mailboxes Douglas connects himself from the CRM. Read-only, Personal.
  extraGmailAccounts: () => list('CRM_EXTRA_GMAIL', 'douglas@wicklowdementiasupport.ie'),
  selfNames: () => list('CRM_SELF_NAMES', 'douglas,douglas mclellan,dougie'),
  // Douglas's standing word that a channel belongs to a project.
  wdsProject: { space: 'personal', name: 'Wicklow Dementia Support' },
  // Chats Douglas has already said to capture, approved the moment they first appear.
  whatsappPreapproved: [{ name: 'WDS Board 2026', isGroup: true, space: 'personal', project: 'Wicklow Dementia Support' }],
  // Calendars the planner reads, each with a fixed space. Task blocks are written to the first.
  calendars: [{ id: 'primary', space: 'personal' }],
  hubUser: 'douglas',
  captureWindowDays: 7,
  bootstrapDays: 90,
  bootstrapMinEmails: 2,
};
