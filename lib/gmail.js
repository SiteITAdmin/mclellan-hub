const { google } = require('googleapis');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { uuid } = require('./id');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');
const { admitSource } = require('./source-admission');
const { resolveContactIdentity } = require('./contact-identity');

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

function decodeBodyData(data) {
  return Buffer.from(String(data || ''), 'base64url').toString('utf8');
}

function htmlToText(value) {
  return String(value || '')
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

function partMimeType(part) {
  return String(part?.mimeType || '').split(';', 1)[0].trim().toLowerCase();
}

function isTextPart(part) {
  const mimeType = partMimeType(part);
  // Gmail payloads normally have an explicit MIME type.  Keep the old direct
  // body behaviour for a provider-shaped but type-less payload, rather than
  // silently losing its text.
  return mimeType === 'text/plain' || mimeType === 'text/html'
    || (!mimeType && (part?.body?.data || part?.body?.attachmentId));
}

async function materializePartBody(gmail, messageId, part) {
  const body = part?.body || {};
  if (body.data != null && String(body.data) !== '') return decodeBodyData(body.data);
  if (body.attachmentId) {
    if (!gmail?.users?.messages?.attachments?.get) {
      throw new Error(`Gmail text part ${body.attachmentId} requires attachment materialization`);
    }
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: body.attachmentId,
    });
    const data = attachment?.data?.data;
    if (data == null) {
      throw new Error(`Gmail attachment-backed text part ${body.attachmentId} returned no body data`);
    }
    return decodeBodyData(data);
  }
  // An explicitly non-empty text part without data is incomplete provider
  // material.  Throw so callers retain/retry rather than capture a deceptively
  // complete-looking partial message.
  if (Number(body.size || 0) > 0) {
    throw new Error('Gmail text part body is unavailable');
  }
  return '';
}

function headerValue(part, name) {
  const target = String(name || '').toLowerCase();
  const header = (part?.headers || []).find(item => String(item?.name || '').toLowerCase() === target);
  return String(header?.value || '').trim();
}

function dispositionToken(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase() || null;
}

function dispositionFilename(value) {
  const match = String(value || '').match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;]+))/i);
  return String(match?.[1] || match?.[2] || match?.[3] || '').trim() || null;
}

const ATTACHMENT_MIME_EXTENSIONS = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/json': '.json',
  'application/xml': '.xml',
};

const DIRECT_TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.log', '.rtf',
]);

const EXTRACTOR_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.xls', '.pptx', '.ppt',
]);

function attachmentFilename(part, mimeType) {
  const disposition = headerValue(part, 'content-disposition');
  const value = String(part?.filename || '').trim() || dispositionFilename(disposition);
  if (value) return value;
  return `attachment${ATTACHMENT_MIME_EXTENSIONS[mimeType] || '.bin'}`;
}

async function attachmentBytesFromPart(gmail, messageId, part) {
  const body = part?.body || {};
  if (body.attachmentId) {
    if (!gmail?.users?.messages?.attachments?.get) {
      throw new Error(`Gmail attachment ${body.attachmentId} requires attachment materialization`);
    }
    const response = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: body.attachmentId,
    });
    const data = response?.data?.data;
    if (data == null) throw new Error(`Gmail attachment ${body.attachmentId} returned no body data`);
    const bytes = Buffer.from(String(data), 'base64url');
    if (Number(body.size || 0) > 0 && bytes.length === 0) {
      throw new Error(`Gmail attachment ${body.attachmentId} returned an empty body`);
    }
    return bytes;
  }
  if (body.data != null) {
    const bytes = Buffer.from(String(body.data), 'base64url');
    if (Number(body.size || 0) > 0 && bytes.length === 0) {
      throw new Error(`Gmail attachment ${attachmentFilename(part, partMimeType(part))} returned an empty body`);
    }
    return bytes;
  }
  throw new Error(`Gmail attachment ${attachmentFilename(part, partMimeType(part))} returned no body data`);
}

async function extractAttachmentText(filename, mimeType, bytes) {
  const ext = path.extname(filename || '').toLowerCase() || ATTACHMENT_MIME_EXTENSIONS[mimeType] || '';
  if (mimeType.startsWith('text/') || DIRECT_TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
    const text = bytes.toString('utf8');
    return {
      status: 'extracted',
      format: 'utf8',
      text: mimeType === 'text/html' || ext === '.html' || ext === '.htm' ? htmlToText(text) : text.trim(),
    };
  }
  if (!EXTRACTOR_ATTACHMENT_EXTENSIONS.has(ext)) {
    return { status: 'unextracted', format: null, text: '' };
  }
  try {
    // Reuse the same PDF/DOCX/office extraction path as uploaded documents.
    const { fileToMarkdown } = require('./extract');
    const result = await fileToMarkdown(filename, bytes);
    if (result?.isImage) return { status: 'unextracted', format: null, text: '' };
    const text = String(result?.markdown || '').trim();
    return text
      ? { status: 'extracted', format: ext.slice(1), text }
      : { status: 'extraction_failed', format: ext.slice(1), text: '', error: 'extractor returned no text' };
  } catch (err) {
    return {
      status: 'extraction_failed',
      format: ext.slice(1),
      text: '',
      error: String(err?.message || err || 'attachment extraction failed').slice(0, 500),
    };
  }
}

async function materializeAttachmentLeaf(gmail, messageId, part) {
  const mimeType = partMimeType(part) || 'application/octet-stream';
  const disposition = headerValue(part, 'content-disposition');
  const contentId = headerValue(part, 'content-id') || null;
  const filename = attachmentFilename(part, mimeType);
  const bytes = await attachmentBytesFromPart(gmail, messageId, part);
  // Inline related resources (usually cid: images referenced by an HTML body)
  // are still hashed and manifested, but are not semantic source gaps. A real
  // attachment remains review-incomplete when it cannot be text-extracted.
  const textAttachment = isTextPart(part) && Boolean(
    String(part.filename || '').trim()
    || dispositionToken(disposition) === 'attachment'
  );
  const inlineResource = !textAttachment && (dispositionToken(disposition) === 'inline'
    || Boolean(contentId && dispositionToken(disposition) !== 'attachment'));
  const extraction = inlineResource
    ? { status: 'inline_resource', format: null, text: '' }
    : await extractAttachmentText(filename, mimeType, bytes);
  const manifest = {
    filename,
    mime_type: mimeType,
    disposition: dispositionToken(disposition),
    content_id: contentId,
    inline_resource: inlineResource,
    provider_attachment_id: part?.body?.attachmentId || null,
    byte_size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    extraction_status: extraction.status,
    extraction_format: extraction.format,
    extracted_chars: extraction.text.length,
  };
  if (extraction.error) manifest.extraction_error = extraction.error;
  return { manifest, text: extraction.text };
}

function isAttachmentLeaf(part) {
  if (!part || (Array.isArray(part.parts) && part.parts.length)) return false;
  if (isTextPart(part)) {
    // A text MIME leaf with a filename or explicit attachment disposition is
    // a real attachment, not the message's ordinary body/alternative. Route
    // it through byte fetching, hashing, and attachment boundaries first.
    return Boolean(
      String(part.filename || '').trim()
      || dispositionToken(headerValue(part, 'content-disposition')) === 'attachment'
    );
  }
  const body = part.body || {};
  return Boolean(
    String(part.filename || '').trim()
    || body.attachmentId
    || body.data != null
    || Number(body.size || 0) > 0
  );
}

// Return ordered, human-readable MIME segments. `multipart/alternative` is
// the one container where sibling parts are representations of the same
// content; elsewhere siblings are distinct material (for example an HTML
// body followed by a plain-text forwarded tail) and must all be retained.
async function materializeMimePart(gmail, messageId, part) {
  if (!part) return { segments: [], hasPlain: false, hasHtml: false, attachments: [] };

  if (isAttachmentLeaf(part)) {
    const attachment = await materializeAttachmentLeaf(gmail, messageId, part);
    const boundary = `[Attachment: ${attachment.manifest.filename}]`;
    const closing = `[End attachment: ${attachment.manifest.filename}]`;
    return {
      segments: attachment.text
        ? [{ kind: 'attachment', body: `${boundary}\n${attachment.text}\n${closing}` }]
        : [],
      hasPlain: false,
      hasHtml: false,
      attachments: [attachment.manifest],
    };
  }

  if (isTextPart(part)) {
    const body = await materializePartBody(gmail, messageId, part);
    const mimeType = partMimeType(part);
    const kind = mimeType === 'text/html' ? 'html' : 'plain';
    if (!String(body).trim()) return {
      segments: [], hasPlain: kind === 'plain', hasHtml: kind === 'html', attachments: [],
    };
    return {
      segments: [{ kind, body: String(body) }],
      hasPlain: kind === 'plain',
      hasHtml: kind === 'html',
      attachments: [],
    };
  }

  const children = [];
  for (const child of part.parts || []) {
    // Materialize every branch before selecting an alternative. An
    // attachment-backed text branch which cannot be fetched is incomplete
    // provider evidence and must fail closed even when another alternative
    // happens to be available.
    children.push(await materializeMimePart(gmail, messageId, child));
  }

  const mimeType = partMimeType(part);
  const attachments = children.flatMap(child => child.attachments || []);
  if (mimeType === 'multipart/alternative') {
    // Prefer the first branch containing plain text. Gmail normally orders
    // plain before HTML, but selecting by content keeps this correct for
    // providers which reverse that order. If no plain representation exists,
    // retain the first non-empty HTML/other branch.
    const plain = children.find(child => child.hasPlain && child.segments.length);
    const fallback = children.find(child => child.segments.length);
    // …except when the plain branch is not a representation of the message at
    // all. Newsletter platforms (beehiiv, Substack) ship a plain-text
    // alternative that is only "you are reading a plain text version — view
    // this post online <link>" while the HTML branch carries the entire issue.
    // Preferring plain unconditionally threw the issue away: 8 of 17 Futurepedia
    // issues were stored as ~464 characters of link, and the briefings built on
    // them were correspondingly empty. Only override when the gap is stark, so
    // ordinary mail keeps its plain text.
    let chosen = plain || fallback;
    if (plain) {
      const richest = children
        .filter(child => child !== plain && child.segments.length)
        .map(child => ({ child, len: renderedLength(child) }))
        .sort((a, b) => b.len - a.len)[0];
      const plainLen = renderedLength(plain);
      if (richest && plainLen < 2000 && richest.len >= plainLen * 3) chosen = richest.child;
    }
    return { ...(chosen || { segments: [], hasPlain: false, hasHtml: false, attachments: [] }), attachments };
  }

  return {
    segments: children.flatMap(child => child.segments),
    hasPlain: children.some(child => child.hasPlain),
    hasHtml: children.some(child => child.hasHtml),
    attachments,
  };
}

// How much readable text a materialized branch actually yields, so a
// multipart/alternative can be chosen on substance rather than on MIME order.
function renderedLength(branch) {
  return (branch?.segments || [])
    .map(segment => segment.kind === 'html' ? htmlToText(segment.body) : String(segment.body || ''))
    .join('\n\n')
    .trim()
    .length;
}

// Materialize attachment-backed text before returning an email to ingestion.
// HTML is converted only after structure-aware selection, preserving order and
// retaining distinct sibling/forwarded content without duplicating an
// alternative's plain+HTML representations.
async function materializeMimeBody(gmail, messageId, payload) {
  const materialized = await materializeMimePart(gmail, messageId, payload);
  return materialized.segments
    .map(segment => segment.kind === 'html' ? htmlToText(segment.body) : String(segment.body || ''))
    .filter(segment => Boolean(segment && String(segment).trim()))
    .join('\n\n');
}

async function materializeMimePayload(gmail, messageId, payload) {
  const materialized = await materializeMimePart(gmail, messageId, payload);
  const bodyText = materialized.segments
    .map(segment => segment.kind === 'html' ? htmlToText(segment.body) : String(segment.body || ''))
    .filter(segment => Boolean(segment && String(segment).trim()))
    .join('\n\n');
  return { bodyText, attachments: materialized.attachments || [] };
}

async function receivedEmailFromFull(gmail, full, messageId) {
  const data = full?.data || full || {};
  const headers = data.payload?.headers || [];
  const get = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';
  const from = get('from');
  const fromMatch = from.match(/^(.*?)\s*<([^>]+)>$/) || [];
  const materialized = await materializeMimePayload(gmail, messageId, data.payload);
  return {
    id: messageId,
    subject: get('subject') || '(no subject)',
    fromName: (fromMatch[1] || from).trim().replace(/^["']|["']$/g, ''),
    fromEmail: (fromMatch[2] || from).trim().toLowerCase(),
    receivedAt: data.internalDate
      ? Math.floor(parseInt(data.internalDate, 10) / 1000)
      : Math.floor(Date.now() / 1000),
    // Keep the entire provider-returned message body.  Downstream ingestion
    // owns any model-context limits; the raw evidence store must not silently
    // discard an ask which happened to occur late in a long thread.
    bodyText: materialized.bodyText,
    rawHeaders: headers.map(header => ({ name: header.name, value: header.value })),
    threadId: data.threadId || null,
    labelIds: data.labelIds || [],
    ...(materialized.attachments.length ? { attachments: materialized.attachments } : {}),
  };
}

async function sentEmailFromFull(gmail, full, messageId) {
  const data = full?.data || full || {};
  const headers = data.payload?.headers || [];
  const get = name => headers.find(h => h.name.toLowerCase() === name)?.value || '';
  const to = get('to');
  const toMatch = to.match(/^(.*?)\s*<([^>]+)>$/) || [];
  const materialized = await materializeMimePayload(gmail, messageId, data.payload);
  return {
    id: messageId,
    subject: get('subject') || '(no subject)',
    toName: (toMatch[1] || to).trim().replace(/^["']|["']$/g, ''),
    toEmail: (toMatch[2] || to).trim().toLowerCase(),
    sentAt: data.internalDate
      ? Math.floor(parseInt(data.internalDate, 10) / 1000)
      : Math.floor(Date.now() / 1000),
    bodyText: materialized.bodyText,
    rawHeaders: headers.map(header => ({ name: header.name, value: header.value })),
    threadId: data.threadId || null,
    labelIds: data.labelIds || [],
    ...(materialized.attachments.length ? { attachments: materialized.attachments } : {}),
  };
}

function gmailRawMetadata(email, direction = 'received') {
  const headers = Array.isArray(email?.rawHeaders)
    ? email.rawHeaders.map(header => ({
      name: String(header?.name || ''),
      value: String(header?.value || ''),
    }))
    : [];
  const metadata = {
    provider: 'gmail',
    direction,
    thread_id: email?.threadId || null,
    label_ids: Array.isArray(email?.labelIds) ? email.labelIds : [],
    headers,
  };
  if (Array.isArray(email?.attachments) && email.attachments.length) metadata.attachments = email.attachments;
  return JSON.stringify(metadata);
}

function preserveGmailAttachmentManifest(hub, messageId, metadata) {
  if (metadata.includes('"attachments"')) return metadata;
  const existing = hub.prepare('SELECT raw_metadata FROM email_summaries WHERE gmail_message_id = ?').get(messageId);
  if (!existing?.raw_metadata) return metadata;
  try {
    const current = JSON.parse(existing.raw_metadata);
    if (!Array.isArray(current.attachments) || !current.attachments.length) return metadata;
    const next = JSON.parse(metadata);
    next.attachments = current.attachments;
    return JSON.stringify(next);
  } catch (_) {
    return metadata;
  }
}

// The Gmail fetchers have their own raw boundary so a cursor can never move
// past provider material which has only been held in memory.  The processor
// captures again before semantic work; this UPSERT is deliberately idempotent.
function captureFetchedRawGmailEmail(user, email, { direction = 'received' } = {}) {
  const hub = db.hub();
  const sent = direction === 'sent';
  const name = sent ? email.toName : email.fromName;
  const address = sent ? email.toEmail : email.fromEmail;
  const timestamp = sent ? email.sentAt : email.receivedAt;
  const identity = resolveContactIdentity(user, { names: [name], addresses: [address] }, { hub });
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at,
       summary, direction, body_text, raw_metadata, ingestion_status, contact_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'captured', ?)
    ON CONFLICT(gmail_message_id) DO UPDATE SET
      subject = COALESCE(excluded.subject, email_summaries.subject),
      from_name = COALESCE(excluded.from_name, email_summaries.from_name),
      from_email = COALESCE(excluded.from_email, email_summaries.from_email),
      received_at = COALESCE(excluded.received_at, email_summaries.received_at),
      direction = excluded.direction,
      body_text = CASE
        WHEN TRIM(COALESCE(excluded.body_text, '')) != '' THEN excluded.body_text
        ELSE email_summaries.body_text
      END,
      raw_metadata = CASE
        WHEN excluded.raw_metadata IS NOT NULL AND excluded.raw_metadata != '{}' THEN excluded.raw_metadata
        ELSE email_summaries.raw_metadata
      END,
      contact_id = COALESCE(excluded.contact_id, email_summaries.contact_id),
      ingestion_status = CASE
        WHEN COALESCE(email_summaries.ingestion_status, 'processed') = 'processed' THEN 'processed'
        ELSE 'captured'
      END
  `).run(
    uuid(), user, email.id, email.subject || '(no subject)', name || '', address || '', timestamp || null,
    direction, email.bodyText == null ? null : String(email.bodyText),
    preserveGmailAttachmentManifest(hub, email.id, gmailRawMetadata(email, direction)),
    identity.contact?.id || null,
  );
  // The ingest door.  Judging completeness here, while we still know Gmail
  // captured it, is what makes "Gmail stopped returning bodies" a reportable
  // fact instead of something inferred weeks later from missing tasks.
  try {
    const row = hub.prepare(
      'SELECT id FROM email_summaries WHERE user = ? AND gmail_message_id = ?'
    ).get(user, email.id);
    if (row?.id) admitSource(user, 'email_summary', row.id, { ingester: `gmail:${direction}` });
  } catch (error) {
    // Admission is an observation, never a gate: losing the receipt must not
    // lose the email.
    console.error(`[gmail] source admission failed for ${email.id}:`, error.message);
  }
}

// A Gmail message can be trashed/deleted by Douglas between the moment we list
// or capture its id and the moment we come back to fetch its MIME or set its
// label. The provider then answers 404. That is an expected terminal state, not
// a processing failure to retry against forever — every refetch/label lane must
// detect it, skip the message, and clear (not re-record) its retry receipt, or
// the daily report keeps warning about "unresolved failures" that can never
// recover because the message is simply gone.
function isGmailNotFound(err) {
  return err?.code === 404 || err?.response?.status === 404;
}

// Terminal-mark a raw row whose Gmail message no longer exists so it leaves the
// ('captured','retry') refetch set and the pending-label set. Provenance is
// preserved; only the retry lifecycle ends.
function markGmailMessageGone(user, messageId) {
  if (!user || !messageId) return;
  try {
    db.hub().prepare(`
      UPDATE email_summaries
         SET ingestion_status = 'gone', gmail_label_checked_at = unixepoch(), processed_at = unixepoch()
       WHERE user = ? AND gmail_message_id = ?
    `).run(user, messageId);
  } catch (_) { /* best-effort cleanup; a missing row is already "gone" */ }
}

async function fetchReceivedMessages(gmail, messages, {
  skipIds = new Set(),
  logPrefix = 'gmail',
  onFetchError = null,
  onRawCapture = null,
  rawUser = null,
  returnErrors = false,
} = {}) {
  // Any cursor-driven received lane must leave a retry receipt if full MIME
  // materialization fails.  Callers may route promotions separately, but a
  // missing callback never silently drops a message after the cursor advances.
  const recordFetchError = typeof onFetchError === 'function'
    ? onFetchError
    : (messageId, err) => recordProcessingFailure('gmail', messageId, err);
  const emails = [];
  const errors = [];
  for (const msg of messages || []) {
    const messageId = msg?.id;
    if (!messageId) {
      const err = new Error('Gmail list item did not include a message id');
      errors.push({ messageId: null, error: err });
      try { recordFetchError(null, err); } catch (_) {}
      console.error(`[${logPrefix}] error fetching message without an id:`, err.message);
      continue;
    }
    if (skipIds.has(messageId)) continue;
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const email = await receivedEmailFromFull(gmail, full, messageId);
      if (typeof onRawCapture === 'function') {
        await onRawCapture(email);
      } else if (rawUser) {
        captureFetchedRawGmailEmail(rawUser, email);
      }
      emails.push(email);
    } catch (err) {
      if (isGmailNotFound(err)) {
        resolveProcessingFailure('gmail', messageId);
        if (rawUser) markGmailMessageGone(rawUser, messageId);
        console.warn(`[${logPrefix}] message ${messageId} no longer exists (deleted) — skipping`);
        continue;
      }
      errors.push({ messageId, error: err });
      try { recordFetchError(messageId, err); } catch (_) {}
      console.error(`[${logPrefix}] error fetching message ${messageId}:`, err.message);
    }
  }
  return returnErrors ? { emails, errors } : emails;
}

// Gmail list endpoints are page-based even when maxResults is 50/100.  Keep
// traversal in one primitive so received, promotion, sent, and label lanes all
// have the same >50-message behaviour and never silently stop at page one.
async function listAllMessages(gmail, options, { maxPages = 10000 } = {}) {
  const messages = [];
  let pageToken;
  const seenPageTokens = new Set();
  for (let page = 0; page < maxPages; page++) {
    const request = { ...options };
    if (pageToken) request.pageToken = pageToken;
    const response = await gmail.users.messages.list(request);
    const data = response?.data || {};
    messages.push(...(Array.isArray(data.messages) ? data.messages : []));
    const next = data.nextPageToken;
    if (!next) return messages;
    if (seenPageTokens.has(next) || next === pageToken) {
      throw new Error('Gmail list pagination returned a repeated page token');
    }
    seenPageTokens.add(next);
    pageToken = next;
  }
  throw new Error(`Gmail list pagination exceeded ${maxPages} pages`);
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

  // Gmail modify is idempotent at the mailbox level, but avoid issuing the
  // provider side effect at all when a retry already reached the desired
  // state. Older test/dry-run clients may not expose messages.get; in that
  // case retain the historical modify path and let its failure remain visible
  // to the caller.
  if (gmail?.users?.messages?.get) {
    const current = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'minimal' });
    const currentIds = Array.isArray(current?.data?.labelIds) ? current.data.labelIds : null;
    if (currentIds) {
      const hasDesired = currentIds.includes(labelId);
      const needsRemoval = removeLabelIds.some(id => currentIds.includes(id));
      if (hasDesired && !needsRemoval) {
        return { changed: false, labelId, labelName };
      }
    }
  }

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [labelId],
      removeLabelIds,
    },
  });
  console.log(`[gmail] labelled message ${messageId} → "${labelName}"`);
  return { changed: true, labelId, labelName };
}

// ── Fetch new emails ──────────────────────────────────────────────────────────

async function fetchNewEmails(user, { onRawCapture = null, gmailClient = null } = {}) {
  const hub = db.hub();

  // Last-check timestamp — default to 24h ago on first run
  const lastCheckRow = hub.prepare(
    "SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'"
  ).get(user);
  const lastCheckTs = lastCheckRow
    ? parseInt(lastCheckRow.value, 10)
    : Math.floor(Date.now() / 1000) - 24 * 3600;

  const gmail = gmailClient || await getGmailClient(user);
  // Snapshot the boundary before listing. Messages arriving while this run is
  // in flight are intentionally left for the next poll rather than being
  // folded into a cursor which has not yet been durably committed.
  const checkpointTs = Math.max(0, Math.floor(Date.now() / 1000) - 1);

  // Gmail `after:` operator uses Unix seconds. Promotions and Social are kept
  // out of the main lane to hold marketing volume down; known/curated promotions
  // (senders with a taxonomy rule, or already filed by a Gmail filter under a
  // canonical label other than the Newsletters bulk archive) are re-admitted to
  // the classifier separately — see processNewEmails.
  const messages = await listAllMessages(gmail, {
    userId: 'me',
    q: `after:${lastCheckTs} -in:sent -category:promotions -category:social`,
    maxResults: 50,
  });

  // Skip already-processed message IDs
  const processedIds = new Set(
    hub.prepare("SELECT gmail_message_id FROM email_summaries WHERE user = ? AND COALESCE(ingestion_status, 'processed') = 'processed' AND body_text IS NOT NULL")
      .all(user)
      .map(r => r.gmail_message_id)
  );

  const fetched = await fetchReceivedMessages(gmail, messages, {
    skipIds: processedIds,
    logPrefix: 'gmail',
    onFetchError: (messageId, err) => recordProcessingFailure('gmail', messageId, err),
    onRawCapture,
    rawUser: user,
    returnErrors: true,
  });

  // A cursor is a durable checkpoint, not a fetch-start timestamp. If any
  // listed message failed acquisition or raw capture, leave the old cursor in
  // place; successful rows are already durable and will be skipped on replay.
  const checkpointAdvanced = fetched.errors.length === 0;
  if (checkpointAdvanced) {
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, String(checkpointTs));
  }

  // Return the original window for callers that need diagnostics; sent mail
  // maintains its own persisted cursor and does not rely on this value.
  return { emails: fetched.emails, gmail, lastCheckTs, checkpointTs, checkpointAdvanced };
}

async function fetchEmailByIdWithClient(gmail, messageId) {
  const full = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return receivedEmailFromFull(gmail, full, messageId);
}

async function fetchEmailById(user, messageId) {
  const gmail = await getGmailClient(user);
  return fetchEmailByIdWithClient(gmail, messageId);
}

// Promotions are excluded from the main classification lane to keep marketing
// noise down. This independent cursor admits them to the lightweight opportunity
// appraisal path; processNewEmails additionally routes the known/curated subset
// (taxonomy-rule senders, or Gmail-filter-labelled non-newsletter mail) through
// full classification so senders like MasterClass/Maven are picked up.
async function fetchNewPromotionEmails(user, existingGmailClient = null, { onRawCapture = null } = {}) {
  const hub = db.hub();
  const key = '_gmail_promotions_last_check_ts';
  const row = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, key);
  const lastCheckTs = row
    ? parseInt(row.value, 10)
    : Math.floor(Date.now() / 1000) - 24 * 3600;
  const gmail = existingGmailClient || await getGmailClient(user);
  const checkpointTs = Math.max(0, Math.floor(Date.now() / 1000) - 1);
  const messages = await listAllMessages(gmail, {
    userId: 'me',
    q: `after:${lastCheckTs} -in:sent category:promotions`,
    maxResults: 50,
  });

  const existingIds = new Set(
    hub.prepare("SELECT source_id FROM opportunity_signals WHERE user = ? AND source_kind = 'gmail'")
      .all(user)
      .map(item => item.source_id)
  );
  const fetched = await fetchReceivedMessages(gmail, messages, {
    skipIds: existingIds,
    logPrefix: 'gmail-promotions',
    onFetchError: (messageId, err) => recordProcessingFailure('gmail_promotion', messageId, err),
    onRawCapture,
    rawUser: user,
    returnErrors: true,
  });
  const checkpointAdvanced = fetched.errors.length === 0;
  if (checkpointAdvanced) {
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, key, String(checkpointTs));
  }

  // A crash can occur after capture/checkpoint but before appraisal. Replay
  // captured promotion rows by their provider category, not only by the
  // timestamp cursor. This keeps the lane resumable without admitting normal
  // received mail into the commerce appraiser.
  const capturedPromotionRows = hub.prepare(`
    SELECT gmail_message_id
    FROM email_summaries
    WHERE user = ?
      AND direction = 'received'
      AND COALESCE(ingestion_status, 'processed') IN ('captured', 'retry')
      AND raw_metadata LIKE '%CATEGORY_PROMOTIONS%'
      AND gmail_message_id NOT LIKE 'agentmail:%'
    ORDER BY COALESCE(processed_at, received_at, 0) ASC
  `).all(user);
  const seenIds = new Set(fetched.emails.map(email => email.id));
  for (const row of capturedPromotionRows) {
    if (!row.gmail_message_id || seenIds.has(row.gmail_message_id)) continue;
    try {
      const email = await fetchEmailByIdWithClient(gmail, row.gmail_message_id);
      fetched.emails.push(email);
      seenIds.add(email.id);
    } catch (err) {
      if (isGmailNotFound(err)) {
        resolveProcessingFailure('gmail_promotion', row.gmail_message_id);
        markGmailMessageGone(user, row.gmail_message_id);
        console.warn(`[gmail-promotions] captured message ${row.gmail_message_id} no longer exists (deleted) — skipping`);
        continue;
      }
      recordProcessingFailure('gmail_promotion', row.gmail_message_id, err);
      console.warn(`[gmail-promotions] error retrying captured message ${row.gmail_message_id}:`, err.message);
    }
  }
  return { emails: fetched.emails, gmail, lastCheckTs, checkpointTs, checkpointAdvanced, errors: fetched.errors };
}

// ── Send email ────────────────────────────────────────────────────────────────

function encodeMimeSubject(subject) {
  return /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
    : subject;
}

function foldBase64(value) {
  return String(value || '').replace(/(.{76})/g, '$1\r\n');
}

function buildMimeMessage({ to, subject, text, html, attachments = [] }) {
  const encodedSubject = encodeMimeSubject(subject);
  const headers = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
  ];
  const bodyText = text || '';

  if (!html && !attachments.length) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      '',
      bodyText,
    ].join('\r\n');
  }

  const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    html ? `Content-Type: multipart/alternative; boundary="${altBoundary}"` : 'Content-Type: text/plain; charset=utf-8',
    '',
  ];

  if (html) {
    parts.push(
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      bodyText,
      `--${altBoundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      html,
      `--${altBoundary}--`,
      ''
    );
  } else {
    parts.push(bodyText, '');
  }

  for (const attachment of attachments) {
    const filename = String(attachment.filename || 'attachment').replace(/"/g, "'");
    const contentType = attachment.content_type || attachment.contentType || 'application/octet-stream';
    const content = Buffer.isBuffer(attachment.content)
      ? attachment.content.toString('base64')
      : String(attachment.content || '');
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename}"`,
      '',
      foldBase64(content),
      ''
    );
  }

  parts.push(`--${mixedBoundary}--`, '');
  return parts.join('\r\n');
}

async function sendEmail(fromUser, to, subject, body) {
  const gmail  = await getGmailClient(fromUser);
  const options = body && typeof body === 'object'
    ? { to, subject, ...body }
    : { to, subject, text: body };
  const mime = buildMimeMessage(options);
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
  const messages = await listAllMessages(gmail, {
    userId: 'me',
    labelIds: [label.id],
    q,
    maxResults: 100,
  });
  const emails = [];

  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      emails.push(await receivedEmailFromFull(gmail, full, msg.id));
    } catch (err) {
      if (isGmailNotFound(err)) {
        resolveProcessingFailure('gmail', msg.id);
        console.warn(`[gmail] message ${msg.id} no longer exists (deleted) — skipping`);
        continue;
      }
      recordProcessingFailure('gmail', msg.id, err);
      console.error(`[gmail] fetchEmailsByLabel error for ${msg.id}:`, err.message);
    }
  }

  return emails;
}

// Category-blind fetch of messages carrying a given label id, reusing an already
// authenticated client (Google rotates refresh tokens per client creation, so we
// must NOT call getGmailClient again per label). This is the primitive behind the
// label-driven ingestion poll: what the user filed is the signal, regardless of
// which Gmail category tab the message landed in.
async function fetchMessagesByLabelId(gmail, labelId, sinceTs, skipIds = new Set(), { onFetchError = null, returnErrors = false } = {}) {
  const q = sinceTs ? `after:${sinceTs} -in:sent` : '-in:sent';
  const messages = await listAllMessages(gmail, {
    userId: 'me',
    labelIds: [labelId],
    q,
    maxResults: 100,
  });
  return fetchReceivedMessages(gmail, messages, { skipIds, logPrefix: 'label-poll', onFetchError, returnErrors });
}

async function listUserLabels(user) {
  const gmail = await getGmailClient(user);
  const res = await gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels || [])
    .filter(l => l.type === 'user')
    .map(l => l.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ── Fetch sent emails (Douglas is the sender) ──────────────────────────────────

// existingGmailClient: reuse the authenticated client from fetchNewEmails to
// avoid a second token refresh (Google rotates refresh tokens on each use, so
// creating a fresh client with the stored token after fetchNewEmails has
// already refreshed it causes an invalid_request error).
async function fetchSentEmails(user, existingGmailClient, sinceTs, { onRawCapture = null } = {}) {
  const hub = db.hub();

  // Sent mail owns an independent cursor. Reusing the received cursor means a
  // received-only success can skip a sent message permanently when the sent
  // lane is unavailable. The explicit sinceTs remains a first-run fallback for
  // callers that used the historical API.
  const sentKey = '_gmail_sent_last_check_ts';
  const sentRow = hub.prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, sentKey);
  const lastCheckTs = sentRow
    ? parseInt(sentRow.value, 10)
    : (sinceTs || Math.floor(Date.now() / 1000) - 24 * 3600);
  const checkpointTs = Math.max(0, Math.floor(Date.now() / 1000) - 1);

  const gmail = existingGmailClient || await getGmailClient(user);

  const messages = await listAllMessages(gmail, {
    userId: 'me',
    labelIds: ['SENT'],
    q: `after:${lastCheckTs}`,
    maxResults: 50,
  });
  console.log(`[gmail-sent] query after:${lastCheckTs} (${new Date(lastCheckTs*1000).toISOString()}) → ${messages.length} message(s)`);

  const processedIds = new Set(
    hub.prepare("SELECT gmail_message_id FROM email_summaries WHERE user = ? AND direction = 'sent' AND COALESCE(ingestion_status, 'processed') = 'processed' AND body_text IS NOT NULL")
      .all(user)
      .map(r => r.gmail_message_id)
  );

  const emails = [];
  const errors = [];
  for (const msg of messages) {
    const messageId = msg?.id;
    if (!messageId) {
      const err = new Error('Gmail sent list item did not include a message id');
      errors.push({ messageId: null, error: err });
      // A malformed provider list item must hold the cursor back without
      // turning failure logging itself into the fatal error.
      try { recordProcessingFailure('gmail_sent', null, err); } catch (_) {}
      console.error('[gmail-sent] error fetching message without an id:', err.message);
      continue;
    }
    if (processedIds.has(messageId)) continue;

    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      const email = await sentEmailFromFull(gmail, full, messageId);
      if (typeof onRawCapture === 'function') {
        await onRawCapture(email);
      } else {
        captureFetchedRawGmailEmail(user, email, { direction: 'sent' });
      }
      emails.push(email);
    } catch (err) {
      errors.push({ messageId, error: err });
      recordProcessingFailure('gmail_sent', messageId, err);
      console.error(`[gmail-sent] error fetching message ${messageId}:`, err.message);
    }
  }

  // The Gmail cursor is not a retry queue.  Include raw rows captured by a
  // prior run which never reached a terminal processing state, even when they
  // are now older than the current `after:` window.
  const seenIds = new Set(emails.map(email => email.id));
  const captured = hub.prepare(`
    SELECT gmail_message_id
    FROM email_summaries
    WHERE user = ? AND direction = 'sent'
      AND COALESCE(ingestion_status, 'processed') IN ('captured', 'retry')
      AND gmail_message_id NOT LIKE 'agentmail:%'
    ORDER BY COALESCE(processed_at, received_at, 0) ASC
  `).all(user);
  const failed = hub.prepare(`
    SELECT external_id AS gmail_message_id
    FROM processing_failures
    WHERE source = 'gmail_sent' AND resolved_at IS NULL AND COALESCE(external_id, '') != ''
    ORDER BY last_failed_at ASC
  `).all();
  for (const row of [...captured, ...failed]) {
    if (!row.gmail_message_id || seenIds.has(row.gmail_message_id)) continue;
    try {
      const full = await gmail.users.messages.get({ userId: 'me', id: row.gmail_message_id, format: 'full' });
      const email = await sentEmailFromFull(gmail, full, row.gmail_message_id);
      if (typeof onRawCapture === 'function') {
        await onRawCapture(email);
      } else {
        captureFetchedRawGmailEmail(user, email, { direction: 'sent' });
      }
      emails.push(email);
      seenIds.add(row.gmail_message_id);
    } catch (err) {
      if (isGmailNotFound(err)) {
        resolveProcessingFailure('gmail_sent', row.gmail_message_id);
        markGmailMessageGone(user, row.gmail_message_id);
        console.warn(`[gmail-sent] message ${row.gmail_message_id} no longer exists (deleted) — skipping`);
        continue;
      }
      errors.push({ messageId: row.gmail_message_id, error: err });
      recordProcessingFailure('gmail_sent', row.gmail_message_id, err);
      console.error(`[gmail-sent] error retrying message ${row.gmail_message_id}:`, err.message);
    }
  }

  const checkpointAdvanced = errors.length === 0;
  if (checkpointAdvanced) {
    hub.prepare(`
      INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
    `).run(uuid(), user, sentKey, String(checkpointTs));
  }

  return { emails, gmail, lastCheckTs, checkpointTs, checkpointAdvanced, errors };
}

module.exports = {
  getGmailClient,
  fetchEmailById,
  fetchEmailByIdWithClient,
  fetchEmailsByLabel,
  fetchMessagesByLabelId,
  fetchNewEmails,
  fetchNewPromotionEmails,
  fetchSentEmails,
  getOrCreateLabel,
  isGmailNotFound,
  listUserLabels,
  markGmailMessageGone,
  moveToLabel,
  sendEmail,
  _test: {
    decodeBodyData,
    htmlToText,
    materializePartBody,
    materializeMimeBody,
    materializeMimePayload,
    materializeAttachmentLeaf,
    receivedEmailFromFull,
    sentEmailFromFull,
    captureFetchedRawGmailEmail,
    listAllMessages,
    fetchReceivedMessages,
  },
};
