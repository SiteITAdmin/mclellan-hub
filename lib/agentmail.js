'use strict';
const fetch = require('./fetch');

const AM_BASE = 'https://api.agentmail.to';
const AM_API = `${AM_BASE}/v0`;

function key() {
  return process.env.AGENTMAIL_API_KEY;
}

function inboxId() {
  return process.env.AGENTMAIL_INBOX_ID;
}

async function amFetch(path, options = {}) {
  const k = key();
  if (!k) throw new Error('AGENTMAIL_API_KEY not set');
  const res = await fetch(`${AM_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${k}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`AgentMail ${res.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return body; }
}

async function sendEmail({ to, subject, text, html, attachments, inbox = inboxId() }) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  return amFetch(`/inboxes/${inbox}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ to, subject, text, html, attachments }),
  });
}

async function listInboxes() {
  return amFetch('/inboxes');
}

async function listMessages({ inbox = inboxId(), limit = 100, pageToken, labels, after } = {}) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  const params = new URLSearchParams({ limit: String(limit) });
  if (pageToken) params.set('page_token', pageToken);
  if (after) params.set('after', after);
  for (const label of labels || []) params.append('labels', label);
  return amFetch(`/inboxes/${encodeURIComponent(inbox)}/messages?${params}`);
}

async function getMessage(messageId, inbox = inboxId()) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  return amFetch(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}`);
}

// AgentMail returns attachment metadata (including a short-lived download URL)
// from this endpoint.  The processor deliberately downloads the bytes before
// capturing/classifying the message so an unavailable attachment cannot be
// mistaken for a terminally processed source.
async function getAttachment(messageId, attachmentId, inbox = inboxId()) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  if (!attachmentId) throw new Error('AgentMail attachment id is required');
  const k = key();
  if (!k) throw new Error('AGENTMAIL_API_KEY not set');
  const res = await fetch(
    `${AM_API}/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      headers: {
        Authorization: `Bearer ${k}`,
        'Content-Type': 'application/json',
      },
    },
  );
  const contentType = String(
    res.headers?.get?.('content-type')
      || res.headers?.['content-type']
      || res.headers?.['Content-Type']
      || ''
  ).toLowerCase();
  if (res.ok === false || Number(res.status || 0) >= 400) {
    const body = await res.text();
    throw new Error(`AgentMail ${res.status}: ${body.slice(0, 300)}`);
  }
  // The API reference documents JSON metadata with a signed download_url,
  // while the SDK guide permits the endpoint to return the raw file bytes.
  // Preserve both shapes; never turn binary bytes into UTF-8 text.
  if (contentType.includes('json')) {
    const body = await res.text();
    try { return JSON.parse(body); } catch { return body; }
  }
  const payload = Buffer.from(await res.arrayBuffer());
  if (contentType.startsWith('text/') || !contentType) {
    const text = payload.toString('utf8').trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return JSON.parse(text); } catch (_) {}
    }
  }
  return payload;
}

async function updateMessage(messageId, { addLabels = [], removeLabels = [] } = {}, inbox = inboxId()) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  return amFetch(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      add_labels: addLabels,
      remove_labels: removeLabels,
    }),
  });
}

module.exports = {
  getAttachment,
  getMessage,
  listInboxes,
  listMessages,
  sendEmail,
  updateMessage,
};
