'use strict';

/**
 * Microsoft 365 (Entra ID / Graph) integration.
 *
 * Mirrors lib/google-auth.js + lib/gmail.js: an OAuth authorization-code flow
 * that stores a refresh token in crm_context, and a thin Graph client that
 * background jobs use to read Outlook mail and calendar.
 *
 * Env:
 *   MS_OAUTH_CLIENT_ID / MS_OAUTH_CLIENT_SECRET — Entra ID app registration
 *   MS_OAUTH_TENANT_ID — tenant GUID or domain; defaults to 'organizations'
 *   <USER>_MS_EMAILS — optional comma-separated allowlist of account emails
 */

const crypto = require('crypto');
const fetch = require('./fetch');
const db = require('./db');
const { uuid } = require('./id');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Read-only mailbox/calendar scopes — the Hub ingests; it never writes back.
const SCOPES = 'openid profile email offline_access User.Read Mail.Read Calendars.Read';

const REFRESH_TOKEN_KEY = '_ms_refresh_token';
const ACCOUNT_EMAIL_KEY = '_ms_account_email';

function tenantId() {
  return String(process.env.MS_OAUTH_TENANT_ID || 'organizations').trim();
}

function loginBase() {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId())}/oauth2/v2.0`;
}

function isMsGraphConfigured() {
  return Boolean(process.env.MS_OAUTH_CLIENT_ID && process.env.MS_OAUTH_CLIENT_SECRET);
}

function contextValue(user, key) {
  const row = db.hub().prepare(
    'SELECT value FROM crm_context WHERE user = ? AND key = ?'
  ).get(user, key);
  return row ? row.value : null;
}

function setContextValue(user, key, value) {
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, key, value);
}

function hasMsToken(user) {
  return Boolean(contextValue(user, REFRESH_TOKEN_KEY));
}

function getMsAccountEmail(user) {
  return contextValue(user, ACCOUNT_EMAIL_KEY) || '';
}

function allowedMsEmails(user) {
  const prefix = String(user || '').toUpperCase();
  return String(process.env[`${prefix}_MS_EMAILS`] || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

// ── Token endpoint ────────────────────────────────────────────────────────────

async function tokenRequest(params) {
  const resp = await fetch(`${loginBase()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_OAUTH_CLIENT_ID,
      client_secret: process.env.MS_OAUTH_CLIENT_SECRET,
      scope: SCOPES,
      ...params,
    }).toString(),
    timeout: 30_000,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Microsoft token endpoint ${resp.status}: ${data.error_description || data.error || 'unknown error'}`);
  }
  return data;
}

// In-memory access-token cache: { user -> { token, expiresAt } }
const accessTokenCache = {};

async function getAccessToken(user) {
  if (!isMsGraphConfigured()) throw new Error('Microsoft OAuth is not configured');
  const cached = accessTokenCache[user];
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const refreshToken = contextValue(user, REFRESH_TOKEN_KEY);
  if (!refreshToken) throw new Error(`No Microsoft refresh token stored for user "${user}"`);

  const data = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  // Entra ID rotates refresh tokens — persist the replacement or the stored
  // one eventually expires and background sync dies silently.
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    setContextValue(user, REFRESH_TOKEN_KEY, data.refresh_token);
  }
  accessTokenCache[user] = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

// ── Graph client ──────────────────────────────────────────────────────────────

async function graphFetch(user, path, options = {}) {
  const token = await getAccessToken(user);
  const url = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    timeout: options.timeout || 30_000,
  });
  if (resp.status === 204) return null;
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Graph ${resp.status} on ${path.split('?')[0]}: ${data.error?.message || 'unknown error'}`);
  }
  return data;
}

// Follows @odata.nextLink until done or `limit` items collected.
async function graphGetAll(user, path, { limit = 500, headers } = {}) {
  const items = [];
  let next = path;
  while (next && items.length < limit) {
    const page = await graphFetch(user, next, { headers });
    items.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return items.slice(0, limit);
}

// ── OAuth route handlers (connect flow from the admin panel) ──────────────────

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function startMicrosoftAuth({ user, callbackPath, returnTo = '/admin' }) {
  return (req, res) => {
    try {
      if (!isMsGraphConfigured()) {
        return res.status(500).send('Microsoft OAuth is not configured — set MS_OAUTH_CLIENT_ID and MS_OAUTH_CLIENT_SECRET');
      }
      const state = crypto.randomBytes(24).toString('hex');
      req.session.msOAuth = { state, user, returnTo };
      const url = `${loginBase()}/authorize?${new URLSearchParams({
        client_id: process.env.MS_OAUTH_CLIENT_ID,
        response_type: 'code',
        redirect_uri: `${baseUrl(req)}${callbackPath}`,
        response_mode: 'query',
        scope: SCOPES,
        state,
        prompt: 'select_account',
      })}`;
      req.session.save(() => res.redirect(url));
    } catch (err) {
      res.status(500).send(err.message);
    }
  };
}

function finishMicrosoftAuth({ user, callbackPath, returnTo = '/admin' }) {
  return async (req, res) => {
    try {
      const saved = req.session.msOAuth;
      if (!saved || saved.state !== req.query.state || saved.user !== user) {
        return res.status(400).send('Invalid Microsoft sign-in state');
      }
      if (req.query.error) {
        return res.status(400).send(`Microsoft sign-in failed: ${req.query.error_description || req.query.error}`);
      }

      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: `${baseUrl(req)}${callbackPath}`,
      });

      const profileResp = await fetch(`${GRAPH_BASE}/me`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        timeout: 30_000,
      });
      const profile = await profileResp.json().catch(() => ({}));
      if (!profileResp.ok) {
        return res.status(500).send('Microsoft sign-in failed: could not read profile');
      }
      const accountEmail = String(profile.mail || profile.userPrincipalName || '').toLowerCase();

      const allowed = allowedMsEmails(user);
      if (allowed.length && !allowed.includes(accountEmail)) {
        return res.status(403).send('This Microsoft account is not allowed for this Hub user.');
      }

      if (!tokens.refresh_token) {
        return res.status(500).send('Microsoft did not return a refresh token — check that offline_access is granted for the app registration');
      }
      setContextValue(user, REFRESH_TOKEN_KEY, tokens.refresh_token);
      setContextValue(user, ACCOUNT_EMAIL_KEY, accountEmail);
      delete accessTokenCache[user];
      console.log(`[ms-graph] refresh token stored for ${user} (${accountEmail})`);

      req.session.msOAuth = null;
      req.session.save(() => res.redirect(saved.returnTo || returnTo));
    } catch (err) {
      console.error('[ms-graph]', err);
      res.status(500).send('Microsoft sign-in failed');
    }
  };
}

function disconnectMicrosoft(user) {
  const hub = db.hub();
  hub.prepare('DELETE FROM crm_context WHERE user = ? AND key IN (?, ?)')
     .run(user, REFRESH_TOKEN_KEY, ACCOUNT_EMAIL_KEY);
  delete accessTokenCache[user];
}

module.exports = {
  disconnectMicrosoft,
  finishMicrosoftAuth,
  getMsAccountEmail,
  graphFetch,
  graphGetAll,
  hasMsToken,
  isMsGraphConfigured,
  startMicrosoftAuth,
};
