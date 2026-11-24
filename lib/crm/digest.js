'use strict';

// Delivery for the one morning email (written and joined in lib/crm/digest-narrative.js).
// The old bulleted 07:30 digest is retired: it no longer sends, even as a fallback.

const { crm, now } = require('./db');
const { uuid } = require('../id');

// A two-part (plain and HTML) message as Gmail's API wants it. Written out by
// hand because the mail library's composer is not part of its public interface.
function mime({ from, to, subject, text, html }) {
  const boundary = `hub-${uuid()}`;
  const b64 = v => Buffer.from(v, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
  return [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '', part('text/plain', text) + part('text/html', html) + `--${boundary}--`].join('\r\n');
}

// Sent through the Gmail API on the Hub's own Google connection: the VPS
// cannot reach Gmail's SMTP port, so the app-password route times out.
function transport() {
  const user = require('./config').personalAddresses()[0];
  const gmail = require('./google').gmail();
  return { user, mailer: { sendMail: async message => {
    const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(mime(message), 'utf8').toString('base64url') } }, { timeout: 30000, retry: false });
    return { messageId: data.id };
  } } };
}

// Douglas's own mailbox only: nothing from the CRM is sent into the work mail system.
async function deliver(message, { user, mailer, entity = '' }) {
  const id = uuid();
  crm().prepare("INSERT INTO effects (id, module, entity_id, operation, request, status) VALUES (?, 'crm_morning_digest', ?, 'email.send', ?, 'started')")
    .run(id, entity, JSON.stringify({ to: user, subject: message.subject }));
  try {
    const info = await mailer.sendMail({ from: `"Hub" <${user}>`, to: user, subject: message.subject, text: message.text, html: message.html });
    crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify({ messageId: info?.messageId || '' }), now(), id);
    return { messageId: info?.messageId || '' };
  } catch (err) {
    crm().prepare("UPDATE effects SET status = 'uncertain', result = ?, finished_at = ? WHERE id = ?").run(String(err.message).slice(0, 500), now(), id);
    throw new Error(`Morning email: ${err.message}`);
  }
}

module.exports = { deliver, mime, transport };
