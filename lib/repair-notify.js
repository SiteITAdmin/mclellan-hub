'use strict';

// Notification channel for the self-repair venue. The venue runs on the Mac
// mini against a snapshot DB, so it cannot surface results through the
// Consigliere brief (those receipts live in prod) — email + GitHub PR is its
// own independent channel. Gmail SMTP first (the Mac mini has the app
// password), AgentMail as fallback where its key is configured.

const REPAIR_NOTIFY_TO = process.env.REPAIR_NOTIFY_EMAIL || 'douglas@mclellan.scot';

let nodemailer;

function getGmailTransport() {
  const user = process.env.GMAIL_SMTP_USER;
  const pass = String(process.env.GMAIL_SMTP_APP_PASSWORD || '').replace(/\s+/g, '');
  if (!user || !pass) return null;
  try {
    if (!nodemailer) nodemailer = require('nodemailer');
  } catch (_) {
    return null;
  }
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

async function sendRepairEmail({ subject, text }) {
  const transport = getGmailTransport();
  if (transport) {
    await transport.sendMail({
      from: `"Hub Self-Repair" <${process.env.GMAIL_SMTP_USER}>`,
      to: REPAIR_NOTIFY_TO,
      subject,
      text,
    });
    return { sent: true, via: 'gmail-smtp' };
  }
  if (process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID) {
    const { sendEmail } = require('./agentmail');
    await sendEmail({ to: REPAIR_NOTIFY_TO, subject, text });
    return { sent: true, via: 'agentmail' };
  }
  // No channel configured — the receipt file still records everything; say
  // so loudly rather than failing the whole run over a missing mailer.
  console.error(`[repair-notify] NO EMAIL CHANNEL — would have sent: ${subject}`);
  return { sent: false, via: null };
}

module.exports = { sendRepairEmail, REPAIR_NOTIFY_TO };
