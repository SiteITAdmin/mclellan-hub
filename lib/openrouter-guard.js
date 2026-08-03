'use strict';

// Process-level network guard: no request to OpenRouter may leave the process.
// Applied at boot (server.js) and by lib/fetch.js. Fail closed — never soft-log.

const OPENROUTER_HOSTS = new Set([
  'openrouter.ai',
  'www.openrouter.ai',
  'api.openrouter.ai',
]);

function hostnameOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isOpenRouterHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (OPENROUTER_HOSTS.has(host)) return true;
  return host.endsWith('.openrouter.ai');
}

function isOpenRouterUrl(url) {
  return isOpenRouterHost(hostnameOf(url));
}

class OpenRouterBlockedError extends Error {
  constructor(url) {
    super(`OpenRouter is retired: blocked request to ${String(url || 'openrouter.ai')}`);
    this.name = 'OpenRouterBlockedError';
    this.code = 'OPENROUTER_BLOCKED';
    this.url = String(url || '');
  }
}

function assertNotOpenRouter(url) {
  if (isOpenRouterUrl(url)) throw new OpenRouterBlockedError(url);
  return true;
}

let installed = false;
let originalFetch = null;

function installOpenRouterNetworkGuard({ fetchImpl } = {}) {
  if (installed) return { already: true };
  const root = fetchImpl || globalThis;
  originalFetch = root.fetch.bind(root);
  root.fetch = function guardedFetch(input, init) {
    const url = typeof input === 'string' ? input
      : (input && typeof input.url === 'string' ? input.url : String(input));
    if (isOpenRouterUrl(url)) return Promise.reject(new OpenRouterBlockedError(url));
    return originalFetch(input, init);
  };
  installed = true;
  return { already: false };
}

function uninstallOpenRouterNetworkGuard({ fetchImpl } = {}) {
  if (!installed || !originalFetch) return false;
  const root = fetchImpl || globalThis;
  root.fetch = originalFetch;
  installed = false;
  originalFetch = null;
  return true;
}

function isGuardInstalled() {
  return installed;
}

module.exports = {
  OPENROUTER_HOSTS,
  isOpenRouterHost,
  isOpenRouterUrl,
  OpenRouterBlockedError,
  assertNotOpenRouter,
  installOpenRouterNetworkGuard,
  uninstallOpenRouterNetworkGuard,
  isGuardInstalled,
};
