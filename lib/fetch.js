'use strict';

function fetchWithTimeout(url, options = {}) {
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

module.exports = fetchWithTimeout;
