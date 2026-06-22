'use strict';

const fs = require('fs');
const path = require('path');
const { openRouterHeaders } = require('./openrouter-attribution');

function isOpenRouterUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.hostname === 'openrouter.ai' && parsed.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
}

function headerEntries(headers) {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  return Object.entries(headers);
}

function headerValue(headers, name) {
  const needle = name.toLowerCase();
  for (const [key, value] of headerEntries(headers)) {
    if (String(key).toLowerCase() === needle) return String(value || '');
  }
  return '';
}

function withOpenRouterFallbackHeaders(headers) {
  const fallback = openRouterHeaders('AT-Unclassified');
  const merged = Object.fromEntries(headerEntries(headers));
  if (!headerValue(merged, 'Authorization') && headerValue(headers, 'authorization')) {
    merged.Authorization = headerValue(headers, 'authorization');
  }
  if (!headerValue(merged, 'Content-Type') && headerValue(headers, 'content-type')) {
    merged['Content-Type'] = headerValue(headers, 'content-type');
  }
  if (!headerValue(merged, 'HTTP-Referer')) {
    merged['HTTP-Referer'] = fallback['HTTP-Referer'];
  }
  if (!headerValue(merged, 'X-OpenRouter-Title')) {
    merged['X-OpenRouter-Title'] = 'McLellan Auto: Unclassified OpenRouter Call';
  }
  if (!headerValue(merged, 'X-Title')) {
    merged['X-Title'] = merged['X-OpenRouter-Title'];
  }
  return merged;
}

function bodyModel(body) {
  if (!body || typeof body !== 'string') return '';
  try {
    return JSON.parse(body)?.model || '';
  } catch {
    return '';
  }
}

function openRouterGateLogPath() {
  return process.env.OPENROUTER_GATE_LOG
    || path.join(__dirname, '..', 'data', 'openrouter-gate.jsonl');
}

function logOpenRouterGate(entry) {
  try {
    const filePath = openRouterGateLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n');
  } catch (err) {
    console.warn('[openrouter-gate] log failed:', err.message);
  }
}

function applyOpenRouterGate(url, options = {}) {
  if (!isOpenRouterUrl(url)) return options;
  const headers = options.headers || {};
  const referer = headerValue(headers, 'HTTP-Referer');
  const title = headerValue(headers, 'X-OpenRouter-Title') || headerValue(headers, 'X-Title');
  const hasAttribution = Boolean(referer && title);
  const gatedOptions = hasAttribution
    ? options
    : { ...options, headers: withOpenRouterFallbackHeaders(headers) };

  logOpenRouterGate({
    ok: hasAttribution,
    violation: hasAttribution ? null : 'missing_openrouter_attribution',
    url: String(url),
    method: String(options.method || 'GET').toUpperCase(),
    model: bodyModel(options.body),
    http_referer: referer || null,
    title: title || null,
  });

  if (!hasAttribution) {
    console.warn(`[openrouter-gate] missing attribution for ${String(url)} model=${bodyModel(options.body) || '(unknown)'}`);
  }
  return gatedOptions;
}

function fetchWithTimeout(url, options = {}) {
  const { timeout, signal, ...fetchOptions } = options;
  const gatedOptions = applyOpenRouterGate(url, fetchOptions);
  if (timeout) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    gatedOptions.signal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
  } else if (signal) {
    gatedOptions.signal = signal;
  }
  return globalThis.fetch(url, gatedOptions);
}

fetchWithTimeout.applyOpenRouterGate = applyOpenRouterGate;
fetchWithTimeout.isOpenRouterUrl = isOpenRouterUrl;

module.exports = fetchWithTimeout;
