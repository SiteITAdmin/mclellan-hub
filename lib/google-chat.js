'use strict';

/**
 * Outbound Google Chat posting via the hermes bot service account.
 * Posting into the space where Douglas talks to hermes means replies
 * ("done 3", "snooze 3 2h") come back through /api/google-chat/hermes.
 */

const fs = require('fs');
const path = require('path');

async function postToGoogleChatSpace(spaceName, text) {
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
    await chat.spaces.messages.create({ parent: spaceName, requestBody: { text } });
    console.log('[google-chat] async post sent to', spaceName);
    return true;
  } catch (err) {
    console.error('[google-chat] async post failed:', err.message);
    return false;
  }
}

module.exports = { postToGoogleChatSpace };
