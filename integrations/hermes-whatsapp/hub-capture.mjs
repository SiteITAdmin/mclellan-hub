import { readFileSync, statSync } from 'node:fs';

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function values(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function matches(value, candidates) {
  const wanted = normalize(value);
  return !!wanted && values(candidates).some(candidate => normalize(candidate) === wanted);
}

function routeMatches(route, event) {
  const match = route?.match || {};
  const direction = normalize(event.direction || (event.from_me ? 'outbound' : 'inbound'));
  if (match.chat_type && normalize(match.chat_type) !== normalize(event.chat_type)) return false;
  if (match.direction && normalize(match.direction) !== direction) return false;
  if (values(match.chat_ids).length && !matches(event.chat_id, match.chat_ids)) return false;
  if (values(match.chat_names).length && !matches(event.chat_name, match.chat_names)) return false;
  if (values(match.sender_ids).length && !matches(event.sender_id, match.sender_ids)) return false;
  if (values(match.sender_names).length && !matches(event.sender_name, match.sender_names)) return false;
  return values(match.chat_ids).length
    || values(match.chat_names).length
    || values(match.sender_ids).length
    || values(match.sender_names).length
    || !!match.direction;
}

function participantContact(route, event) {
  return values(route?.participant_contacts).find(participant => {
    const idMatch = values(participant.sender_ids).length && matches(event.sender_id, participant.sender_ids);
    const nameMatch = values(participant.sender_names).length && matches(event.sender_name, participant.sender_names);
    return idMatch || nameMatch;
  })?.contact_name || '';
}

export function resolveRoute(config, event) {
  const route = values(config?.routes).find(candidate => routeMatches(candidate, event));
  if (!route) return null;
  return {
    id: String(route.id || '').trim(),
    project_slug: String(route.project_slug || '').trim(),
    project_name: String(route.project_name || '').trim(),
    contact_name: String(route.contact_name || participantContact(route, event) || '').trim(),
    note: String(route.note || '').trim(),
  };
}

export function buildCapturePayload(event, route, user = 'douglas') {
  const timestamp = Number(event.timestamp || 0);
  return {
    user,
    platform: 'whatsapp',
    external_message_id: String(event.message_id || '').slice(0, 240),
    chat_id: String(event.chat_id || '').slice(0, 240),
    chat_name: String(event.chat_name || '').slice(0, 240),
    is_group: event.chat_type === 'group',
    sender_id: String(event.sender_id || '').slice(0, 240),
    sender_name: String(event.sender_name || '').slice(0, 240),
    body: String(event.body || '').slice(0, 20000),
    received_at: Number.isFinite(timestamp) && timestamp > 1_000_000_000 ? timestamp : undefined,
    project_slug: route.project_slug || undefined,
    project_name: route.project_name || undefined,
    contact_name: route.contact_name || undefined,
    route,
    raw: {
      source: 'hermes_whatsapp_bridge_passive_capture',
      direction: event.from_me ? 'outbound' : 'inbound',
      message_type: event.message_type || 'text',
    },
  };
}

export function createHubCapture({
  routesFile,
  url,
  secret,
  user = 'douglas',
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  let cachedConfig = null;
  let cachedMtime = -1;

  function config() {
    if (!routesFile) return null;
    try {
      const mtime = statSync(routesFile).mtimeMs;
      if (!cachedConfig || mtime !== cachedMtime) {
        cachedConfig = JSON.parse(readFileSync(routesFile, 'utf8'));
        cachedMtime = mtime;
      }
      return cachedConfig;
    } catch (error) {
      logger.warn?.(`[hub-whatsapp-capture] routes unavailable: ${error.message}`);
      return null;
    }
  }

  return async function capture(event) {
    if (!url || !secret || !fetchImpl || !event?.body || !event?.message_id) return false;
    const route = resolveRoute(config(), event);
    if (!route) return false;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'User-Agent': 'hermes-whatsapp-passive-capture/1.0',
        },
        body: JSON.stringify(buildCapturePayload(event, route, user)),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        logger.warn?.(`[hub-whatsapp-capture] Hub returned HTTP ${response.status}`);
        return false;
      }
      logger.log?.(`[hub-whatsapp-capture] captured route=${route.id || 'unnamed'} message=${event.message_id}`);
      return true;
    } catch (error) {
      logger.warn?.(`[hub-whatsapp-capture] failed: ${error.message}`);
      return false;
    }
  };
}
