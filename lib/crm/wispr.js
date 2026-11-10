'use strict';

// Wispr Flow meetings (Notetaker) through Wispr's hosted MCP server. The Hub
// holds its own sign-in per space, made with the OAuth device flow: Douglas
// opens a link, enters a code, and the VPS keeps the refresh token. Wispr
// keeps a work account's and a personal account's meetings apart, so each
// space connects on its own and nothing crosses between them.

const { setting, setSetting, now } = require('./db');

const MCP_URL = 'https://api.wisprflow.ai/connect/mcp';
const AUTH = 'https://mcp-auth.wisprflow.com/oauth2';
const SCOPE = 'openid offline_access email profile';
const PROTOCOL = '2025-06-18';

const key = (space, k) => `wispr_${space}_${k}`;
const getJson = k => { try { return JSON.parse(setting(k) || 'null'); } catch { return null; } };
const putJson = (k, v) => setSetting(k, v == null ? '' : JSON.stringify(v));

let http = (url, opts) => fetch(url, opts);
function _setHttp(fn) { http = fn; }

async function form(path, body) {
  const res = await http(`${AUTH}/${path}`, {
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
  const message = reason === 'local_expiry' ? 'No approval result was received before the code expired. Connect again.'
    : reason === 'access_denied' ? 'Wispr denied activation. Connect again to retry.'
    : reason === 'expired_token' ? 'The code ran out before sign-in finished. Connect again.'
    : 'Wispr could not finish sign-in. Connect again to retry.';
  setSetting(key(space, 'error'), `${message} (${reason}${Number.isInteger(httpStatus) ? `, HTTP ${httpStatus}` : ''})`);
  return reason === 'access_denied' ? 'denied' : ['expired_token', 'local_expiry'].includes(reason) ? 'expired' : 'error';
}

// One public client for the Hub, registered once. Device flow needs no
// redirect, but Wispr's registration requires one.
async function clientId() {
  const existing = setting('wispr_client_id');
  if (existing) return existing;
  const res = await http(`${AUTH}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'McLellan Hub',
      redirect_uris: ['https://douglas.mclellan.scot/crm/wispr/callback'],
      grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.client_id) throw new Error(`Wispr registration failed (HTTP ${res.status}, ${oauthReason(data)}).`);
  setSetting('wispr_client_id', data.client_id);
  return data.client_id;
}

function status(space) {
  const auth = getJson(key(space, 'auth'));
  const device = getJson(key(space, 'device'));
  return {
    connected: !!(auth && auth.refresh_token && auth.verified !== false),
    authorized: !!(auth && auth.refresh_token),
    connectedAt: auth?.connected_at || null,
    account: getJson(key(space, 'account')),
    device: device || null,
    error: setting(key(space, 'error')) || '',
    tools: getJson(key(space, 'tools')) || [],
  };
}

async function startConnect(space) {
  const { status: code, data } = await form('device_authorization', {
    client_id: await clientId(), scope: SCOPE, resource: MCP_URL,
  });
  if (!data.device_code) throw new Error(`Wispr would not start sign-in (${code}): ${oauthReason(data)}`.trim());
  putJson(key(space, 'device'), {
    device_code: data.device_code,
    user_code: data.user_code,
    url: data.verification_uri_complete || data.verification_uri,
    interval: Math.max(5, data.interval || 5),
    expires_at: now() + (data.expires_in || 300),
    next_poll_at: now() + Math.max(5, data.interval || 5),
  });
  setSetting(key(space, 'error'), '');
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

// Called while the connect page is open. Returns 'connected', 'waiting' or
// 'denied', 'expired' or 'error'.
async function pollConnect(space) {
  const device = getJson(key(space, 'device'));
  if (!device) return status(space).connected ? 'connected' : 'error';
  if (device.expires_at <= now()) return stopped(space, 'local_expiry');
  if (device.next_poll_at > now()) return 'waiting';
  const { status: httpStatus, data } = await form('token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: device.device_code,
    client_id: await clientId(),
    resource: MCP_URL,
  });
  if (data.access_token) {
    saveTokens(space, data);
    putJson(key(space, 'device'), null);
    try {
      await afterConnect(space);
    } catch {
      return 'error';
    }
    return 'connected';
  }
  if (data.error === 'authorization_pending' || data.error === 'slow_down') {
    const interval = device.interval + (data.error === 'slow_down' ? 5 : 0);
    putJson(key(space, 'device'), { ...device, interval, next_poll_at: now() + interval });
    return 'waiting';
  }
  return stopped(space, oauthReason(data), httpStatus);
}

function disconnect(space) {
  for (const k of ['auth', 'device', 'account', 'tools', 'error']) setSetting(key(space, k), '');
}

let refreshing = {};
async function accessToken(space) {
  const auth = getJson(key(space, 'auth'));
  if (!auth || !auth.refresh_token) throw new Error(`Wispr Flow is not connected in ${space}`);
  if (auth.access_token && auth.expires_at > now()) return auth.access_token;
  if (!refreshing[space]) {
    refreshing[space] = (async () => {
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
    })().finally(() => { refreshing[space] = null; });
  }
  return refreshing[space];
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
  const res = await http(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
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

module.exports = { status, startConnect, pollConnect, disconnect, accessToken, open, afterConnect, MCP_URL, _setHttp };
