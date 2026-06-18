'use strict';

/**
 * Outbound Google Chat posting via the hermes bot service account.
 * Posting into the space where Douglas talks to hermes means replies
 * ("done 3", "snooze 3 2h") come back through /api/google-chat/hermes.
 */

const fs = require('fs');
const path = require('path');

function escapeCardText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildReminderCard(reminders) {
  const sections = reminders.map(r => {
    const n = r.short_code;
    const when = r.next_fire_at
      ? new Date(r.next_fire_at * 1000).toLocaleString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short',
          hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin',
        })
      : r.status;
    return {
      hasDivider: true,
      widgets: [
        { textParagraph: { text: `<b>#${n}</b> ${escapeCardText(r.title)}` } },
        { decoratedText: { topLabel: 'Due', text: escapeCardText(when) } },
        {
          buttonList: {
            buttons: [
              { text: '✅ Done', onClick: { action: { function: `done ${n}` } } },
              { text: '😴 Snooze 2h', onClick: { action: { function: `snooze ${n} 2h` } } },
              { text: '👍 Ok', onClick: { action: { function: `ok ${n}` } } },
              { text: '✏️ Edit', onClick: { action: { function: `edit ${n}` } } },
            ],
          },
        },
      ],
    };
  });

  return {
    cardsV2: [{
      cardId: 'reminders',
      card: {
        header: { title: 'Open Reminders', subtitle: `${reminders.length} open` },
        sections,
      },
    }],
  };
}

function buildSuggestionCard(suggestions) {
  const sections = suggestions.map(s => ({
    hasDivider: true,
    widgets: [
      { textParagraph: { text: `<b>#${s.short_code}</b> [${escapeCardText(s.domain)}] ${escapeCardText(s.title)}` } },
      { textParagraph: { text: escapeCardText(String(s.body || '').slice(0, 400)) } },
      {
        buttonList: {
          buttons: [
            { text: '✅ Accept', onClick: { action: { function: `accept ${s.short_code}` } } },
            { text: '🗑 Dismiss', onClick: { action: { function: `dismiss ${s.short_code}` } } },
            { text: 'Why?', onClick: { action: { function: `why ${s.short_code}` } } },
          ],
        },
      },
    ],
  }));

  return {
    cardsV2: [{
      cardId: 'suggestions',
      card: {
        header: { title: 'Open Suggestions', subtitle: `${suggestions.length} open` },
        sections,
      },
    }],
  };
}

// Card for a single reminder fire — replaces the plain-text fireMessage ping.
function buildFireCard(r) {
  const n = r.short_code;
  const openers = [
    `🔔 Reminder #${n}`,
    `⏰ Still open #${n}`,
    `🔴 Third nudge #${n}`,
    `⚠️ Last ping #${n}`,
  ];
  const title = openers[Math.min(r.escalation_level, openers.length - 1)];
  return {
    cardsV2: [{
      cardId: `reminder-fire-${n}`,
      card: {
        header: { title, subtitle: escapeCardText(r.title) },
        sections: [{
          widgets: [{
            buttonList: {
              buttons: [
                { text: '✅ Done', onClick: { action: { function: `done ${n}` } } },
                { text: '😴 Snooze 2h', onClick: { action: { function: `snooze ${n} 2h` } } },
                { text: '😴 Tomorrow', onClick: { action: { function: `snooze ${n} tomorrow` } } },
                { text: '👍 Ok', onClick: { action: { function: `ok ${n}` } } },
              ],
            },
          }],
        }],
      },
    }],
  };
}

// Download an image attachment from a Chat DM using service account auth.
// resourceName is either attachmentDataRef.resourceName or the attachment name.
async function downloadChatAttachment(resourceName) {
  const saPath = path.join(__dirname, '..', 'config', 'google-service-account.json');
  if (!fs.existsSync(saPath)) { console.warn('[google-chat] no service account for attachment download'); return null; }
  try {
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(fs.readFileSync(saPath, 'utf8')),
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    const token = await auth.getAccessToken();
    const fetch = require('./fetch');
    const resp = await fetch(
      `https://chat.googleapis.com/v1/media/${encodeURIComponent(resourceName)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) { console.warn('[google-chat] attachment download failed:', resp.status); return null; }
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.toString('base64');
  } catch (err) {
    console.error('[google-chat] downloadChatAttachment:', err.message);
    return null;
  }
}

async function postToGoogleChatSpace(spaceName, text, card) {
  if (!spaceName) return false;
  try {
    const saPath = path.join(__dirname, '..', 'config', 'google-service-account.json');
    if (!fs.existsSync(saPath)) { console.warn('[google-chat] no service account for async post'); return false; }
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(fs.readFileSync(saPath, 'utf8')),
      scopes: ['https://www.googleapis.com/auth/chat.bot'],
    });
    const chat = google.chat({ version: 'v1', auth });
    const requestBody = { text, ...(card || {}) };
    await chat.spaces.messages.create({ parent: spaceName, requestBody });
    console.log('[google-chat] async post sent to', spaceName);
    return true;
  } catch (err) {
    console.error('[google-chat] async post failed:', err.message);
    return false;
  }
}

module.exports = { postToGoogleChatSpace, downloadChatAttachment, buildReminderCard, buildSuggestionCard, buildFireCard };
