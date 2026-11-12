'use strict';

// One Wispr account is shared by Work and Personal; meeting capture is separate.

const crypto = require('node:crypto');
const { crm, setting, setSetting: writeSetting, now } = require('./db');

const MCP_URL = 'https://api.wisprflow.ai/connect/mcp';
const AUTH = 'https://mcp-auth.wisprflow.com/oauth2';
const SCOPE = 'openid offline_access email profile';
const PROTOCOL = '2025-06-18';
const ISSUER = 'https://mcp-auth.wisprflow.com';
const REDIRECT = process.env.WISPR_REDIRECT_URI || 'https://douglas.mclellan.scot/crm/wispr/callback';
const SIGN_IN_SECONDS = 600;

const { AsyncLocalStorage } = require('node:async_hooks');
const operation = new AsyncLocalStorage();
let generation = 0;
let queue = Promise.resolve();
let activeController;
function assertCurrent() {
  const active = operation.getStore();
  if (active && active.generation !== generation) throw new Error('Wispr connection changed. Try again.');
  active?.signal.throwIfAborted();
}
function setSetting(k, v) { assertCurrent(); writeSetting(k, v); }
function serialized(fn) {
  return (...args) => {
    if (operation.getStore()) { assertCurrent(); return fn(...args); }
    const epoch = generation;
    const result = queue.then(async () => {
      if (epoch !== generation) throw new Error('Wispr connection changed. Try again.');
      const controller = new AbortController();
      activeController = controller;
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      const timer = setTimeout(() => controller.abort(new Error('Wispr request timed out. Try again.')), 20000);
      try {
        return await Promise.race([cancelled, operation.run({ generation: epoch, signal: controller.signal }, () => fn(...args))]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        if (activeController === controller) activeController = null;
      }
    });
    queue = result.catch(() => {});
    return result;
  };
}
const fields = ['auth', 'device', 'account', 'tools', 'error'];
function migrate() {
  if (setting('wispr_shared_migration')) return;
  crm().transaction(() => {
    const candidates = ['work', 'personal'].map(space => ({
      space, auth: getJson(`wispr_${space}_auth`),
    })).filter(c => c.auth?.refresh_token);
    candidates.sort((a, b) => Number(b.auth.verified !== false) - Number(a.auth.verified !== false)
      || (b.auth.connected_at || 0) - (a.auth.connected_at || 0));
    const chosen = candidates[0];
    if (chosen) for (const field of fields.filter(f => f !== 'device')) {
      writeSetting(`wispr_shared_${field}`, setting(`wispr_${chosen.space}_${field}`) || '');
    }
    const pendingInvalidated = ['work', 'personal'].filter(s => getJson(`wispr_${s}_device`));
    if (!chosen) {
      const priorError = setting('wispr_work_error') || setting('wispr_personal_error');
      writeSetting('wispr_shared_error', priorError || (pendingInvalidated.length
        ? 'Previous Work/Personal sign-in codes were retired. Connect again once for both spaces.' : ''));
    }
    // Keep provenance, never retired credentials or device codes.
    writeSetting('wispr_shared_migration', JSON.stringify({ at: now(), selected: chosen?.space || null,
      pendingInvalidated }));
    for (const space of ['work', 'personal']) for (const field of fields) writeSetting(`wispr_${space}_${field}`, '');
  })();
}
const key = (_space, k) => { migrate(); return `wispr_shared_${k}`; };
const getJson = k => { try { return JSON.parse(setting(k) || 'null'); } catch { return null; } };
const putJson = (k, v) => setSetting(k, v == null ? '' : JSON.stringify(v));

let http = (url, opts) => fetch(url, opts);
function request(url, opts) {
  assertCurrent();
  // A call made after open() has no operation; it still must not hang the job queue.
  return http(url, { ...opts, signal: operation.getStore()?.signal || AbortSignal.timeout(30000) });
}
function _setHttp(fn) { http = fn; }

async function form(path, body) {
  const res = await request(`${AUTH}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Only protocol identifiers are displayed: provider descriptions can echo credentials.
function oauthReason(data) {
  return ['access_denied', 'expired_token', 'invalid_client', 'invalid_grant', 'invalid_request',
    'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'server_error',
    'temporarily_unavailable'].includes(data.error) ? data.error : 'unknown_error';
}

function stopped(space, reason, httpStatus) {
  putJson(key(space, 'device'), null);
  const message = reason === 'local_expiry' ? 'Sign-in was not finished in time. Connect again.'
    : reason === 'access_denied' ? 'Wispr sign-in was cancelled or refused. Connect again to retry.'
    : 'Wispr could not finish sign-in. Connect again to retry.';
  setSetting(key(space, 'error'), `${message} (${reason}${Number.isInteger(httpStatus) ? `, HTTP ${httpStatus}` : ''})`);
  return reason === 'access_denied' ? 'denied' : reason === 'local_expiry' ? 'expired' : 'error';
}

// One public client for the Hub, registered once. Wispr refuses its device
// page ("Activation denied", seen 10 Nov 2026 with a fresh client and no
// clicks), so sign-in is the browser redirect its named clients use. The
// client registered for the device grant is left behind under its old key.
async function clientId() {
  const existing = setting('wispr_browser_client_id');
  if (existing) return existing;
  const res = await request(`${AUTH}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'McLellan Hub',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.client_id) throw new Error(`Wispr registration failed (HTTP ${res.status}, ${oauthReason(data)}).`);
  writeSetting('wispr_browser_client_id', data.client_id);
  return data.client_id;
}

function pendingSignIn(space) {
  const pending = getJson(key(space, 'device'));
  return pending?.state ? pending : null;
}

function status(space) {
  const auth = getJson(key(space, 'auth'));
  const pending = pendingSignIn(space);
  return {
    connected: !!(auth && auth.refresh_token && auth.verified !== false),
    authorized: !!(auth && auth.refresh_token),
    connectedAt: auth?.connected_at || null,
    account: getJson(key(space, 'account')),
    pending: !!pending && pending.expires_at > now(),
    error: setting(key(space, 'error')) || '',
    tools: getJson(key(space, 'tools')) || [],
  };
}

const b64url = buf => buf.toString('base64url');

// Returns Wispr's sign-in address for the browser, or null when already
// connected. Each start replaces any earlier unfinished attempt.
async function startConnect(space) {
  if (status(space).connected) return null;
  const client = await clientId();
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  putJson(key(space, 'device'), { state, verifier, space, expires_at: now() + SIGN_IN_SECONDS });
  setSetting(key(space, 'error'), '');
  return `${AUTH}/authorize?${new URLSearchParams({
    response_type: 'code', client_id: client, redirect_uri: REDIRECT, scope: SCOPE, state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256', resource: MCP_URL,
  })}`;
}

function saveTokens(space, data, previous = {}) {
  putJson(key(space, 'auth'), {
    access_token: data.access_token,
    // Wispr may rotate the refresh token; keep the old one only if it didn't.
    refresh_token: data.refresh_token || previous.refresh_token,
    expires_at: now() + (data.expires_in || 3600) - 60,
    connected_at: previous.connected_at || now(),
    verified: previous.verified ?? !!previous.refresh_token,
  });
}

// Wispr sends the browser back here. Returns { result, space } where result is
// 'connected', 'denied', 'expired', 'error' or 'stale' (a reply that does not
// belong to the current attempt, which is left untouched).
async function finishConnect({ state, code, error, iss } = {}) {
  const pending = pendingSignIn('work');
  const space = pending?.space === 'personal' ? 'personal' : 'work';
  const given = Buffer.from(String(state || ''));
  const expected = Buffer.from(String(pending?.state || ''));
  if (!pending || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { result: 'stale', space };
  if (iss && iss !== ISSUER) return { result: 'stale', space };
  if (pending.expires_at <= now()) return { result: stopped(space, 'local_expiry'), space };
  if (error) return { result: stopped(space, oauthReason({ error })), space };
  if (!code) return { result: stopped(space, 'invalid_request'), space };
  const { status: httpStatus, data } = await form('token', {
    grant_type: 'authorization_code', code: String(code), redirect_uri: REDIRECT,
    client_id: await clientId(), code_verifier: pending.verifier, resource: MCP_URL,
  });
  if (!data.access_token || !data.refresh_token) return { result: stopped(space, data.access_token ? 'unknown_error' : oauthReason(data), httpStatus), space };
  saveTokens(space, data);
  putJson(key(space, 'device'), null);
  try {
    await afterConnect(space);
  } catch {
    return { result: 'error', space };
  }
  return { result: 'connected', space };
}

function disconnect(space) {
  migrate();
  generation++;
  activeController?.abort(new Error('Wispr connection changed. Try again.'));
  for (const k of ['auth', 'device', 'account', 'tools', 'error']) setSetting(key(space, k), '');
}

async function accessToken(space) {
  const auth = getJson(key(space, 'auth'));
  if (!auth || !auth.refresh_token) throw new Error(`Wispr Flow is not connected`);
  if (auth.access_token && auth.expires_at > now()) return auth.access_token;

  const { status: code, data } = await form('token', {
    grant_type: 'refresh_token', refresh_token: auth.refresh_token, client_id: await clientId(), resource: MCP_URL,
  });
  if (!data.access_token) {
    const msg = `Wispr sign-in expired (${code} ${oauthReason(data)}). Connect again on the Meetings page.`;
    if (code === 400 || code === 401) setSetting(key(space, 'error'), msg);
    throw new Error(msg);
  }
  saveTokens(space, data, auth);
  return data.access_token;

}

// Streamable HTTP: a reply is either JSON or an event stream carrying the
// JSON-RPC message.
async function rpc(space, session, method, params, id) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${await accessToken(space)}`,
    'MCP-Protocol-Version': PROTOCOL,
  };
  if (session.id) headers['Mcp-Session-Id'] = session.id;
  const body = id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
  const res = await request(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session.id = sid;
  if (id == null) return null;
  const text = await res.text();
  if (res.status === 429) throw Object.assign(new Error('Wispr: too many requests'), { transient: true });
  if (!res.ok) throw Object.assign(new Error(`Wispr ${method} failed (HTTP ${res.status})`), { transient: res.status >= 500 });
  const type = res.headers.get('content-type') || '';
  const messages = type.includes('text/event-stream')
    ? text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean)
    : [JSON.parse(text)];
  const reply = messages.find(m => m.id === id);
  if (!reply) throw new Error(`Wispr ${method}: no reply`);
  if (reply.error) throw new Error(`Wispr ${method}: request failed (JSON-RPC ${Number.isInteger(reply.error.code) ? reply.error.code : 'unknown'})`);
  return reply.result;
}

async function open(space) {
  const session = { id: null, n: 1 };
  await rpc(space, session, 'initialize', {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'mclellan-hub', version: '1' },
  }, session.n++);
  await rpc(space, session, 'notifications/initialized', {}, null);
  return {
    listTools: async () => (await rpc(space, session, 'tools/list', {}, session.n++)).tools || [],
    call: async (name, args = {}) => {
      const result = await rpc(space, session, 'tools/call', { name, arguments: args }, session.n++);
      if (result.isError) throw new Error(`Wispr ${name}: tool reported an error`);
      if (result.structuredContent) return result.structuredContent;
      const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      try { return JSON.parse(text); } catch { return text; }
    },
  };
}

// Record what the server offers and who signed in, so the capture can be
// built against the real tool shapes and the page can show the account.
async function afterConnect(space) {
  try {
    const s = await open(space);
    const tools = await s.listTools();
    putJson(key(space, 'tools'), tools.map(t => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || {}, outputSchema: t.outputSchema || null })));
    if (tools.some(t => t.name === 'get_account_info')) putJson(key(space, 'account'), await s.call('get_account_info'));
    const auth = getJson(key(space, 'auth'));
    putJson(key(space, 'auth'), { ...auth, verified: true });
    setSetting(key(space, 'error'), '');
  } catch (err) {
    const auth = getJson(key(space, 'auth'));
    if (auth) putJson(key(space, 'auth'), { ...auth, verified: false });
    putJson(key(space, 'account'), null);
    putJson(key(space, 'tools'), null);
    // Network exceptions and remote bodies may contain tokens or request details.
    const reason = /^Wispr (initialize|tools\/list|tools\/call) failed \(HTTP \d{3}\)$/.test(err.message) ? ` ${err.message}.` : '';
    const message = `Wispr connection check failed.${reason} Check the connection again or reconnect.`;
    setSetting(key(space, 'error'), message);
    throw new Error(message);
  }
}

startConnect = serialized(startConnect);
finishConnect = serialized(finishConnect);
accessToken = serialized(accessToken);
afterConnect = serialized(afterConnect);
open = serialized(open);

module.exports = { status, startConnect, finishConnect, disconnect, accessToken, open, afterConnect, MCP_URL, _setHttp };
