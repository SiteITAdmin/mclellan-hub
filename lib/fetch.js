'use strict';

// Shared fetch wrapper.
// - OpenRouter hostnames are rejected before any network transmission.
// - hub-model:// URLs are handled in-process via the subscription CLI plane.

const {
  isOpenRouterUrl,
  assertNotOpenRouter,
  OpenRouterBlockedError,
} = require('./openrouter-guard');
const { isHubModelUrl, hubModelFetch } = require('./hub-model-fetch');

function fetchWithTimeout(url, options = {}) {
  // Reject as a Promise so callers using await/assert.rejects always observe failure.
  if (isOpenRouterUrl(url)) return Promise.reject(new OpenRouterBlockedError(url));
  if (isHubModelUrl(url)) {
    return hubModelFetch(url, options);
  }
  const { timeout, signal, ...fetchOptions } = options;
  if (timeout) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    fetchOptions.signal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
  } else if (signal) {
    fetchOptions.signal = signal;
  }
  return globalThis.fetch(url, fetchOptions);
}

function applyOpenRouterGate(url, options = {}) {
  assertNotOpenRouter(url);
  return options;
}

fetchWithTimeout.applyOpenRouterGate = applyOpenRouterGate;
fetchWithTimeout.isOpenRouterUrl = isOpenRouterUrl;
fetchWithTimeout.OpenRouterBlockedError = OpenRouterBlockedError;
fetchWithTimeout.assertNotOpenRouter = assertNotOpenRouter;

module.exports = fetchWithTimeout;
