const { google } = require('googleapis');
const db = require('./db');
const { uuid } = require('./id');

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getGmailClient(user) {
  const tokenRow = db.hub().prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_google_refresh_token'"
  ).get(user);
  if (!tokenRow) throw new Error(`No Google refresh token stored for user "${user}"`);

  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: tokenRow.value });
  return google.gmail({ version: 'v1', auth: client });
}

// ── MIME body extraction ──────────────────────────────────────────────────────

function decodeBodyPart(part) {
  if (!part) return '';
  if (part.body && part.body.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  if (part.parts) {
    const plain = part.parts.find(p => p.mimeType === 'text/plain');
    if (plain) return decodeBodyPart(plain);
    const html = part.parts.find(p => p.mimeType === 'text/html');
    if (html) {
      return decodeBodyPart(html)
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    for (const p of part.parts) {
      const text = decodeBodyPart(p);
      if (text) return text;
    }
  }
  return '';
}

// ── Label management ──────────────────────────────────────────────────────────

// In-memory cache per process: { user -> { labelName -> labelId } }
const labelCache = {};

async function getOrCreateLabel(gmail, user, name) {
  if (!labelCache[user]) labelCache[user] = {};

  // Return from cache if we have it
  if (labelCache[user][name]) return labelCache[user][name];

  // Fetch all labels and match case-insensitively against existing ones
  const listRes = await gmail.users.labels.list({ userId: 'me' });
  const existing = (listRes.data.labels || []).find(
    l => l.name.toLowerCase() === name.toLowerCase()
  );

  if (existing) {
    labelCache[user][name] = existing.id;
    return existing.id;
  }

  // Create it
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  labelCache[user][name] = created.data.id;
  console.log(`[gmail] created label "${name}" for ${user}`);
  return created.data.id;
}

// Set one canonical Hub label while leaving Gmail system state (Inbox, unread,
// starred, important, categories) untouched.
async function moveToLabel(gmail, user, messageId, labelName, canonicalLabelNames = []) {
  const labelId = await getOrCreateLabel(gmail, user, labelName);
  const canonicalNames = new Set(canonicalLabelNames.map(name => name.toLowerCase()));
  const labels = await gmail.users.labels.list({ userId: 'me' });
  const removeLabelIds = (labels.data.labels || [])
    .filter(label =>
      label.id !== labelId
      && canonicalNames.has(String(label.name || '').toLowerCase())
    )
    .map(label => label.id);

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds,
    },
  });
  console.log(`[gmail] labelled message ${messageId} → "${labelName}"`);
}

// ── Fetch new emails ──────────────────────────────────────────────────────────

async function fetchNewEmails(user) {
  const hub = db.hub();

  // Last-check timestamp — default to 24h ago on first run
  const lastCheckRow = hub.prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'"
  ).get(user);
  const lastCheckTs = lastCheckRow
    ? parseInt(lastCheckRow.value, 10)
    : Math.floor(Date.now() / 1000) - 24 * 3600;

  const gmail = await getGmailClient(user);

  // Gmail `after:` operator uses Unix seconds
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${lastCheckTs} -from:me -category:promotions -category:social`,
    maxResults: 50,
  });

  // Always update the last-check timestamp
  hub.prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, String(Math.floor(Date.now() / 1000)));

  const messages = listRes.data.messages || [];
  if (!messages.length) return { emails: [], gmail };

  // Skip already-processed message IDs
  const processedIds = new Set(
    hub.prepare('SELECT gmail_message_id FROM email_summaries WHERE user = ?')
      .all(user)
      .map(r => r.gmail_message_id)
  );

  const emails = [];
  for (const msg of messages) {
    if (processedIds.has(msg.id)) continue;

    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = full.data.payload.headers || [];
      const get = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';

      const subject = get('subject') || '(no subject)';
      const from = get('from');
      const internalDate = full.data.internalDate
        ? Math.floor(parseInt(full.data.internalDate, 10) / 1000)
        : Math.floor(Date.now() / 1000);

      // Parse "Name <email>" or plain email
      const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/) || [];
      const fromName = (fromMatch[1] || from).trim().replace(/^["']|["']$/g, '');
      const fromEmail = (fromMatch[2] || from).trim().toLowerCase();

      // Extract body text — strip HTML if needed, then cap for the model call
      let bodyText = decodeBodyPart(full.data.payload);
      if (bodyText.trimStart().startsWith('<')) {
        bodyText = bodyText
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
      }
      bodyText = bodyText.slice(0, 500000);

      emails.push({ id: msg.id, subject, fromName, fromEmail, receivedAt: internalDate, bodyText });
    } catch (err) {
      console.error(`[gmail] error fetching message ${msg.id}:`, err.message);
    }
  }

  // Return both emails and the authenticated gmail client so the processor
  // can reuse it for label operations without re-authenticating
  return { emails, gmail };
}

async function fetchEmailById(user, messageId) {
  const gmail = await getGmailClient(user);
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const headers = full.data.payload.headers || [];
  const get = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';
  const from = get('from');
  const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/) || [];
  let bodyText = decodeBodyPart(full.data.payload);
  if (bodyText.trimStart().startsWith('<')) {
    bodyText = bodyText
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return {
    id: messageId,
    subject: get('subject') || '(no subject)',
    fromName: (fromMatch[1] || from).trim().replace(/^["']|["']$/g, ''),
    fromEmail: (fromMatch[2] || from).trim().toLowerCase(),
    receivedAt: full.data.internalDate
      ? Math.floor(parseInt(full.data.internalDate, 10) / 1000)
      : Math.floor(Date.now() / 1000),
    bodyText: bodyText.slice(0, 500000),
  };
}

// ── Send email ────────────────────────────────────────────────────────────────

async function sendEmail(fromUser, to, subject, body) {
  const gmail  = await getGmailClient(fromUser);
  // RFC 2047 encode subject if it contains non-ASCII to prevent Mojibake
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
    : subject;
  const mime   = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(mime, 'utf8').toString('base64url') },
  });
}

// ── Fetch emails by Gmail label (for newsletter backfill) ─────────────────────

async function fetchEmailsByLabel(user, labelName, sinceTs) {
  const gmail = await getGmailClient(user);

  const labelsRes = await gmail.users.labels.list({ userId: 'me' });
  const label = (labelsRes.data.labels || []).find(
    l => l.name.toLowerCase() === labelName.toLowerCase()
  );
  if (!label) throw new Error(`Gmail label "${labelName}" not found`);

  const q = sinceTs ? `after:${sinceTs}` : '';
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    labelIds: [label.id],
    q,
    maxResults: 100,
  });

  const messages = listRes.data.messages || [];
  const emails = [];

  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers || [];
      const get = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';

      const subject = get('subject') || '(no subject)';
      const from = get('from');
      const internalDate = full.data.internalDate
        ? Math.floor(parseInt(full.data.internalDate, 10) / 1000)
        : Math.floor(Date.now() / 1000);

      const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/) || [];
      const fromName = (fromMatch[1] || from).trim().replace(/^["']|["']$/g, '');
      const fromEmail = (fromMatch[2] || from).trim().toLowerCase();

      let bodyText = decodeBodyPart(full.data.payload);
      if (bodyText.trimStart().startsWith('<')) {
        bodyText = bodyText
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
      }
      bodyText = bodyText.slice(0, 500000);

      emails.push({ id: msg.id, subject, fromName, fromEmail, receivedAt: internalDate, bodyText });
    } catch (err) {
      console.error(`[gmail] fetchEmailsByLabel error for ${msg.id}:`, err.message);
    }
  }

  return emails;
}

async function listUserLabels(user) {
  const gmail = await getGmailClient(user);
  const res = await gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels || [])
    .filter(l => l.type === 'user')
    .map(l => l.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

module.exports = {
  fetchEmailById,
  fetchEmailsByLabel,
  fetchNewEmails,
  getOrCreateLabel,
  listUserLabels,
  moveToLabel,
  sendEmail,
};
