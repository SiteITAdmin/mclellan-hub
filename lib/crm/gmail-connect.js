'use strict';

// Connects an extra Gmail mailbox (config.extraGmailAccounts) with a read-only
// token of its own. The token never touches the Hub's main Google token, so
// connecting this account cannot narrow or replace the main one.
//
// The Google callback is the admin sign-in callback that is already registered
// with Google (/admin/auth/google/callback); routes/admin.js hands the request
// here when the sign-in was started for this purpose.

const crypto = require('crypto');
const { google } = require('googleapis');
const { oauthClient } = require('../google-auth');
const gmail = require('./gmail');

const PURPOSE = 'crm-gmail-account';
const CALLBACK = '/admin/auth/google/callback';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'];

function start(req, res, email) {
  const account = gmail.accountFor(email);
  if (!account?.extra) return res.status(404).send('Not a mailbox the Hub can connect');
  const state = crypto.randomBytes(24).toString('hex');
  const returnTo = '/crm/personal';
  req.session.googleOAuth = { state, purpose: PURPOSE, user: 'douglas', account: account.email, returnTo };
  const url = oauthClient(req, CALLBACK).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: false,
    login_hint: account.email,
    hd: account.email.split('@')[1],
    scope: SCOPES,
    state,
  });
  req.session.save(() => res.redirect(url));
}

function isMine(req) {
  return req.session?.googleOAuth?.purpose === PURPOSE;
}

async function finish(req, res) {
  const saved = req.session.googleOAuth;
  req.session.googleOAuth = null;
  const done = (text, level) => {
    req.session.crmFlash = { text, level };
    req.session.save(() => res.redirect(saved?.returnTo || '/crm/personal'));
  };
  // Only Douglas, already signed in to the CRM, can attach a mailbox.
  if (req.session?.adminUser !== 'douglas') return res.status(403).send('Sign in to the CRM first');
  if (!saved || saved.state !== req.query.state) return res.status(400).send('Invalid sign-in state');
  if (req.query.error) return done(`Google said: ${req.query.error}. ${saved.account} is not connected.`, 'bad');
  const account = gmail.accountFor(saved.account);
  try {
    const client = oauthClient(req, CALLBACK);
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    if (!String(tokens.scope || '').includes('gmail.readonly')) {
      throw new Error('Google did not grant mail access. Tick the Gmail box on the consent screen and connect again.');
    }
    const { data: profile } = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
    gmail.saveToken(account, { profileEmail: profile.emailAddress, tokens });
    require('./jobs').scheduleBootstrap(30, 'connect');
    done(`${account.email} is connected. The Hub looks back over 3 months of sent mail now, then checks it every 15 minutes.`, 'ok');
  } catch (err) {
    console.error('[gmail-connect]', err.message);
    done(err.message, 'bad');
  }
}

module.exports = { start, finish, isMine, PURPOSE };
