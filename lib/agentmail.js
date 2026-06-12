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

async function sendEmail({ to, subject, text, html, inbox = inboxId() }) {
  if (!inbox) throw new Error('AGENTMAIL_INBOX_ID not set');
  return amFetch(`/inboxes/${inbox}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ to, subject, text, html }),
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
  getMessage,
  listInboxes,
  listMessages,
  sendEmail,
  updateMessage,
};
