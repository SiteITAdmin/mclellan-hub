'use strict';

// Google clients on the Hub's stored refresh token (douglas@mclellan.scot).
// Run capture on the VPS only: Google rotates the token if it is used from
// the Mac against production.

const { google } = require('googleapis');
const hubDb = require('../db');

function auth(user = 'douglas') {
  const row = hubDb.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!row) throw new Error(`No Google refresh token stored for user "${user}"`);
  const client = new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET);
  client.setCredentials({ refresh_token: row.value });
  return client;
}

module.exports = {
  gmail: user => google.gmail({ version: 'v1', auth: auth(user) }),
  drive: user => google.drive({ version: 'v3', auth: auth(user) }),
};
