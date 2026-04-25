const crypto = require('crypto');
const { google } = require('googleapis');

function envList(...names) {
  return names
    .flatMap(name => String(process.env[name] || '').split(','))
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function oauthClient(req, callbackPath) {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Google OAuth is not configured');
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    `${baseUrl(req)}${callbackPath}`
  );
}

function allowedEmailsFor(user) {
  const prefix = String(user || '').toUpperCase();
  return envList(`${prefix}_GOOGLE_EMAILS`, `${prefix}_GOOGLE_EMAIL`);
}

function isAllowedProfile(profile, user) {
  const email = String(profile.email || '').toLowerCase();
  if (!email || !profile.verified_email) return false;

  const allowedEmails = allowedEmailsFor(user);
  if (allowedEmails.length) return allowedEmails.includes(email);

  const workspaceDomain = String(process.env.GOOGLE_WORKSPACE_DOMAIN || '').trim().toLowerCase();
  if (!workspaceDomain) return false;
  return email.endsWith(`@${workspaceDomain}`);
}

function startGoogleAuth({ purpose, user, callbackPath, returnTo = '/', extraScopes = [] }) {
  return (req, res) => {
    try {
      const state = crypto.randomBytes(24).toString('hex');
      req.session.googleOAuth = { state, purpose, user, returnTo };
      const client = oauthClient(req, callbackPath);
      const hd = process.env.GOOGLE_WORKSPACE_DOMAIN || undefined;
      const url = client.generateAuthUrl({
        access_type: 'offline',
        hd,
        prompt: 'consent',
        scope: ['openid', 'email', 'profile', ...extraScopes],
        state,
      });
      req.session.save(() => res.redirect(url));
    } catch (err) {
      res.status(500).send(err.message);
    }
  };
}

function finishGoogleAuth({ purpose, user, callbackPath, sessionKey, returnTo = '/' }) {
  return async (req, res) => {
    try {
      const saved = req.session.googleOAuth;
      if (!saved || saved.state !== req.query.state || saved.purpose !== purpose || saved.user !== user) {
        return res.status(400).send('Invalid sign-in state');
      }

      const client = oauthClient(req, callbackPath);
      const { tokens } = await client.getToken(req.query.code);
      client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data: profile } = await oauth2.userinfo.get();

      if (!isAllowedProfile(profile, user)) {
        return res.status(403).send('This Google account is not allowed for this site.');
      }

      req.session[sessionKey] = user;
      req.session.googleProfile = {
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      };
      // Store refresh token for background calendar access if provided
      if (tokens.refresh_token) {
        const db = require('./db');
        db.hub().prepare(`
          INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
          ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
        `).run(require('./id').uuid(), user, '_google_refresh_token', tokens.refresh_token);
      }
      req.session.googleOAuth = null;
      req.session.save(() => res.redirect(saved.returnTo || returnTo));
    } catch (err) {
      console.error('[google-auth]', err);
      res.status(500).send('Google sign-in failed');
    }
  };
}

module.exports = {
  finishGoogleAuth,
  startGoogleAuth,
};
