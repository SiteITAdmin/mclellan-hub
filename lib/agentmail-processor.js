'use strict';

const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { uuid } = require('./id');
const { classifyEmail } = require('./email-processor');
const fetch = require('./fetch');
const { getAttachment, getMessage, listMessages, updateMessage } = require('./agentmail');
const { isApprovedExternalEmail, extractTopicsFromEmail } = require('./newsletter-pipeline');
const { getEnabledEmailLabels, matchEmailTaxonomy } = require('./email-taxonomy');
const { getSystemModelId, getSystemPrompt } = require('./settings');
const { PROMPTS } = require('./prompts');
const { requestModelObject } = require('./model-request');
const { TASK_CODES } = require('./openrouter-attribution');
const { appendContactVaultEntry } = require('./crm');
const { createTask } = require('./google-tasks');
const { recordProcessingFailure, resolveProcessingFailure } = require('./processing-failures');
const { legacyDirectCrmWritesEnabled } = require('./crm-pipeline-mode');
const { closedProjectSlugs } = require('./project-lifecycle');
const { admitSource } = require('./source-admission');

function normalizeActionTasks(work) {
  const raw = Array.isArray(work?.action_tasks)
    ? work.action_tasks
    : work?.action_task
      ? [{ title: work.action_task }]
      : [];
  const seen = new Set();
  return raw
    .map(item => typeof item === 'string' ? { title: item } : item)
    .filter(item => item && typeof item.title === 'string')
    .map(item => ({
      title: item.title.trim().slice(0, 240),
      evidence: String(item.evidence || '').trim().slice(0, 800),
    }))
    .filter(item => {
      const key = item.title.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function actionTaskKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'action';
}

function rootSubject(subject) {
  let cleaned = String(subject || '(no subject)').trim();
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '').trim();
  } while (cleaned && cleaned !== previous);
  return cleaned || '(no subject)';
}

function hasMailSubjectPrefix(subject) {
  return /^\s*(re|fw|fwd)\s*:/i.test(String(subject || ''));
}

function followUpSummary(fact, fallbackSubject) {
  const sentence = String(fact || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim()
    .replace(/[.!?]+$/g, '');
  const base = sentence || rootSubject(fallbackSubject);
  return base.length > 92 ? `${base.slice(0, 89).trim()}...` : base;
}

function followUpTaskTitle(person, subject) {
  const name = String(person?.name || '').trim() || 'owner';
  return `Follow up with ${name}: ${followUpSummary(person?.fact, subject)}`;
}

function followUpTaskSourceId(email, person) {
  const threadPart = email.threadId && !hasMailSubjectPrefix(email.subject)
    ? `thread:${actionTaskKey(email.threadId)}`
    : `subject:${actionTaskKey(rootSubject(email.subject))}`;
  return `agentmail:owner:${threadPart}:${actionTaskKey(person?.name)}`;
}

function agentmailFactLinks() {
  // Names sharing a digest or forwarded thread are not necessarily related.
  return '[]';
}

// The email's CONTENT decides which project it belongs to. The sender's domain only
// tells us whose world it is (e.g. any Beacon address is Beacon work); it must never
// pick the specific project, and a project the user has ended is never a valid target.
// Priority: what the model read in the body, then the classifier, then — only as a last
// resort when content is silent — the sender's company mapping, then a live work default.
function resolveProjectSlug({ workSlug, classificationSlug, companySlug, isWork, liveSlugs, workDefaultSlug = 'beacon' }) {
  const live = slug => (slug && liveSlugs.has(slug)) ? slug : null;
  return live(workSlug)
    || live(classificationSlug)
    || live(companySlug)
    || (isWork ? live(workDefaultSlug) : null);
}

function parseSender(from) {
  const raw = String(from || '').trim();
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  return {
    fromName: (match?.[1] || raw).trim().replace(/^["']|["']$/g, ''),
    fromEmail: (match?.[2] || raw).trim().toLowerCase(),
  };
}

function stripHtml(html) {
  return String(html || '')
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

function messageBody(message) {
  const full = String(message.text || '').trim()
    || stripHtml(message.extracted_html || message.html || '').trim();
  const extracted = String(message.extracted_text || '').trim();
  // Prefer full text — it includes forwarded chains that AgentMail's extractor strips out
  const body = full || extracted || message.preview || '';
  // Raw evidence is never acquisition-capped here.  Prompt-specific limits
  // live at the model boundary; otherwise late forwarded asks disappear.
  return String(body);
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

function firstAttachmentValue(attachment, names) {
  for (const name of names) {
    if (attachment && attachment[name] !== undefined && attachment[name] !== null
      && String(attachment[name]).trim() !== '') return attachment[name];
  }
  return null;
}

function attachmentDisposition(attachment) {
  return String(firstAttachmentValue(attachment, [
    'disposition', 'content_disposition', 'contentDisposition',
  ]) || '').split(';', 1)[0].trim().toLowerCase() || null;
}

function attachmentContentId(attachment) {
  const value = firstAttachmentValue(attachment, ['content_id', 'contentId', 'cid']);
  return value == null ? null : String(value).trim() || null;
}

function attachmentIsInline(attachment) {
  const disposition = attachmentDisposition(attachment);
  return Boolean(
    attachment?.inline === true
    || attachment?.is_inline === true
    || attachment?.inline_resource === true
    || disposition === 'inline'
    // AgentMail marks CID-related resources with a content ID.  Treat one as
    // inline unless an explicit attachment disposition says otherwise.
    || (attachmentContentId(attachment) && disposition !== 'attachment')
  );
}

function attachmentId(attachment) {
  const value = firstAttachmentValue(attachment, [
    'provider_attachment_id', 'attachment_id', 'attachmentId', 'id',
  ]);
  return value == null ? null : String(value);
}

function attachmentMimeType(attachment) {
  return String(firstAttachmentValue(attachment, [
    'mime_type', 'mimeType', 'content_type', 'contentType', 'type',
  ]) || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
}

function attachmentFilename(attachment, mimeType) {
  const value = firstAttachmentValue(attachment, ['filename', 'file_name', 'name']);
  if (value) return String(value).trim();
  return `attachment${ATTACHMENT_MIME_EXTENSIONS[mimeType] || '.bin'}`;
}

function decodeAttachmentValue(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value === 'object') {
    for (const key of ['data', 'content', 'bytes', 'buffer', 'body']) {
      if (value[key] !== undefined && value[key] !== null) return decodeAttachmentValue(value[key]);
    }
    return null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return Buffer.alloc(0);
  const dataUrl = text.match(/^data:[^;,]+;base64,(.*)$/is);
  const encoded = dataUrl ? dataUrl[1] : text;
  // AgentMail's send/retrieve contract uses base64 content.  Reject values
  // which cannot be a complete base64 payload instead of silently hashing a
  // provider error message as attachment bytes.
  if (!/^[a-z0-9+/\s]+={0,2}$/i.test(encoded) || encoded.replace(/\s+/g, '').length % 4 === 1) {
    return null;
  }
  return Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
}

function attachmentBytesFromObject(attachment) {
  for (const key of ['bytes', 'content_bytes', 'buffer', 'content', 'data', 'body']) {
    if (!attachment || attachment[key] === undefined || attachment[key] === null) continue;
    const bytes = decodeAttachmentValue(attachment[key]);
    if (bytes) return bytes;
  }
  return null;
}

async function fetchAttachmentDownload(url) {
  const response = await fetch(url, { timeout: 30_000 });
  if (response?.ok === false || Number(response?.status || 0) >= 400) {
    throw new Error(`AgentMail attachment download failed (${response?.status || 'unknown'})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadAgentMailAttachment(externalId, attachment, full, downloader) {
  const local = attachmentBytesFromObject(attachment);
  if (local) return { descriptor: attachment, bytes: local };

  if (typeof downloader === 'function') {
    const result = await downloader(attachment, full, externalId);
    const bytes = decodeAttachmentValue(result?.bytes ?? result?.data ?? result?.content ?? result);
    if (bytes) {
      return {
        descriptor: result && typeof result === 'object' && !Buffer.isBuffer(result)
          ? { ...attachment, ...(result.metadata || {}) }
          : attachment,
        bytes,
      };
    }
  }

  const id = attachmentId(attachment);
  if (id) {
    const remote = await getAttachment(externalId, id);
    if (Buffer.isBuffer(remote) || remote instanceof Uint8Array) {
      return { descriptor: attachment, bytes: Buffer.from(remote) };
    }
    const merged = { ...attachment, ...(remote && typeof remote === 'object' ? remote : {}) };
    const remoteBytes = attachmentBytesFromObject(merged);
    if (remoteBytes) return { descriptor: merged, bytes: remoteBytes };
    const url = firstAttachmentValue(merged, ['download_url', 'downloadUrl', 'url']);
    if (url) return { descriptor: merged, bytes: await fetchAttachmentDownload(String(url)) };
  }

  const url = firstAttachmentValue(attachment, ['download_url', 'downloadUrl', 'url']);
  if (url) return { descriptor: attachment, bytes: await fetchAttachmentDownload(String(url)) };
  return { descriptor: attachment, bytes: null };
}

async function extractAgentMailAttachmentText(filename, mimeType, bytes) {
  const ext = path.extname(filename || '').toLowerCase() || ATTACHMENT_MIME_EXTENSIONS[mimeType] || '';
  if (mimeType.startsWith('text/') || DIRECT_TEXT_ATTACHMENT_EXTENSIONS.has(ext)) {
    const text = bytes.toString('utf8');
    return {
      status: 'extracted',
      format: 'utf8',
      text: mimeType === 'text/html' || ext === '.html' || ext === '.htm' ? stripHtml(text) : text.trim(),
    };
  }
  if (!EXTRACTOR_ATTACHMENT_EXTENSIONS.has(ext)) {
    return {
      status: 'unextracted',
      format: null,
      text: '',
      error: `Unsupported attachment type: ${mimeType || ext || 'unknown'}`,
    };
  }
  try {
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

function attachmentManifestForMetadata(attachment) {
  const allowed = [
    'filename', 'mime_type', 'disposition', 'content_id', 'inline_resource',
    'provider_attachment_id', 'byte_size', 'sha256', 'extraction_status',
    'extraction_format', 'extracted_chars', 'extraction_error',
  ];
  const result = {};
  for (const key of allowed) {
    if (attachment?.[key] !== undefined && attachment?.[key] !== null) result[key] = attachment[key];
  }
  // Legacy provider responses use content_type/attachment_id.  Normalize
  // those names without retaining the raw object (which may contain base64).
  if (!result.mime_type) result.mime_type = attachmentMimeType(attachment);
  if (!result.filename) result.filename = attachmentFilename(attachment, result.mime_type);
  if (!result.disposition && attachmentDisposition(attachment)) result.disposition = attachmentDisposition(attachment);
  if (!result.content_id && attachmentContentId(attachment)) result.content_id = attachmentContentId(attachment);
  if (!result.provider_attachment_id && attachmentId(attachment)) result.provider_attachment_id = attachmentId(attachment);
  if (result.inline_resource === undefined && attachmentIsInline(attachment)) result.inline_resource = true;
  if (!result.extraction_status) result.extraction_status = 'unmaterialized';
  return result;
}

function attachmentMetadataList(full, email) {
  const source = Array.isArray(email?.attachments) && email.attachments.length
    ? email.attachments
    : Array.isArray(full?.attachments) ? full.attachments : [];
  return source.map(attachmentManifestForMetadata);
}

function agentmailRawMetadata(full, email) {
  return JSON.stringify({
    provider: 'agentmail',
    headers: full?.headers || [],
    labels: full?.labels || [],
    to: full?.to || [],
    cc: full?.cc || [],
    attachments: attachmentMetadataList(full, email),
    thread_id: full?.thread_id || null,
  });
}

function metadataAttachments(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return Array.isArray(parsed?.attachments) ? parsed.attachments : [];
  } catch (_) {
    return [];
  }
}

function attachmentMetadataNeedsReview(value) {
  return metadataAttachments(value).some(attachment => {
    const status = String(attachment?.extraction_status || '').toLowerCase();
    return !['extracted', 'inline_resource'].includes(status);
  });
}

function hasPersistedAttachmentManifest(value) {
  const attachments = metadataAttachments(value);
  return attachments.length > 0 && attachments.every(attachment =>
    attachment?.inline_resource === true || Boolean(attachment?.sha256)
  );
}

function preserveAgentMailAttachmentManifest(hub, messageId, metadata) {
  const incoming = metadataAttachments(metadata);
  const existing = hub.prepare('SELECT raw_metadata FROM email_summaries WHERE gmail_message_id = ?').get(`agentmail:${messageId}`);
  const current = metadataAttachments(existing?.raw_metadata);
  if (!current.length) return metadata;
  const incomingMaterialized = incoming.length && incoming.every(attachment =>
    attachment?.inline_resource === true || Boolean(attachment?.sha256)
  );
  if (incomingMaterialized) return metadata;
  const next = JSON.parse(metadata);
  next.attachments = current;
  return JSON.stringify(next);
}

// Persist provider material before any classifier/model call.  Both the
// AgentMail receipt and the canonical email row carry the same faithful body
// so an interrupted run is retryable by either intake surface.
function captureRawAgentMail(hub, user, externalId, full, email) {
  const metadata = preserveAgentMailAttachmentManifest(
    hub,
    externalId,
    agentmailRawMetadata(full, email),
  );
  const captureStatus = email?.attachmentReview ? 'attachment_unextracted' : 'captured';
  hub.prepare(`
    INSERT INTO inbound_email_records
      (id, user, source, external_message_id, thread_id, from_name, from_email,
       subject, received_at, summary, classification, project_slug, status, raw_metadata, body_text)
    VALUES (?, ?, 'agentmail', ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?, ?)
    ON CONFLICT(user, source, external_message_id) DO UPDATE SET
      thread_id = COALESCE(excluded.thread_id, inbound_email_records.thread_id),
      from_name = COALESCE(excluded.from_name, inbound_email_records.from_name),
      from_email = COALESCE(excluded.from_email, inbound_email_records.from_email),
      subject = COALESCE(excluded.subject, inbound_email_records.subject),
      received_at = COALESCE(excluded.received_at, inbound_email_records.received_at),
      body_text = CASE
        WHEN TRIM(COALESCE(excluded.body_text, '')) != '' THEN excluded.body_text
        ELSE inbound_email_records.body_text
      END,
      raw_metadata = CASE
        WHEN excluded.raw_metadata IS NOT NULL AND excluded.raw_metadata != '{}' THEN excluded.raw_metadata
        ELSE inbound_email_records.raw_metadata
      END,
      status = CASE
        WHEN excluded.status = 'attachment_unextracted' THEN 'attachment_unextracted'
        WHEN inbound_email_records.status = 'processed' THEN 'processed'
        ELSE excluded.status
      END
  `).run(
    uuid(), user, externalId, full?.thread_id || null, email.fromName || '', email.fromEmail || '',
    email.subject || '(no subject)', email.receivedAt || null, captureStatus, metadata,
    email.bodyText == null ? null : String(email.bodyText),
  );
  hub.prepare(`
    INSERT INTO email_summaries
      (id, user, gmail_message_id, subject, from_name, from_email, received_at,
       summary, direction, body_text, raw_metadata, ingestion_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 'received', ?, ?, ?)
    ON CONFLICT(gmail_message_id) DO UPDATE SET
      subject = COALESCE(excluded.subject, email_summaries.subject),
      from_name = COALESCE(excluded.from_name, email_summaries.from_name),
      from_email = COALESCE(excluded.from_email, email_summaries.from_email),
      received_at = COALESCE(excluded.received_at, email_summaries.received_at),
      body_text = CASE
        WHEN TRIM(COALESCE(excluded.body_text, '')) != '' THEN excluded.body_text
        ELSE email_summaries.body_text
      END,
      raw_metadata = CASE
        WHEN excluded.raw_metadata IS NOT NULL AND excluded.raw_metadata != '{}' THEN excluded.raw_metadata
        ELSE email_summaries.raw_metadata
      END,
      ingestion_status = CASE
        WHEN excluded.ingestion_status = 'attachment_unextracted' THEN 'attachment_unextracted'
        WHEN COALESCE(email_summaries.ingestion_status, 'processed') = 'processed' THEN 'processed'
        ELSE excluded.ingestion_status
      END
  `).run(
    uuid(), user, `agentmail:${externalId}`, email.subject || '(no subject)', email.fromName || '',
    email.fromEmail || '', email.receivedAt || null,
    email.bodyText == null ? null : String(email.bodyText), metadata, captureStatus,
  );
  return admitCapturedEmail(hub, user, `agentmail:${externalId}`, 'agentmail');
}

// The ingest door: judge what was actually captured while we still know which
// ingester captured it.  Without this the only place that ever asks whether an
// email is readable is the CRM engine, hours later, by which point a body that
// never arrived looks identical to an email with nothing in it.
function admitCapturedEmail(hub, user, gmailMessageId, ingester) {
  try {
    const row = hub.prepare(
      'SELECT id FROM email_summaries WHERE user = ? AND gmail_message_id = ?'
    ).get(user, gmailMessageId);
    if (!row?.id) return null;
    return admitSource(user, 'email_summary', row.id, { ingester });
  } catch (error) {
    // Admission is an observation, never a gate on capture itself: losing the
    // receipt must not lose the email.
    console.error(`[${ingester}] source admission failed for ${gmailMessageId}:`, error.message);
    return null;
  }
}

function markRawAgentMail(hub, user, externalId, status) {
  hub.prepare(`
    UPDATE inbound_email_records
       SET status = ?, processed_at = unixepoch()
     WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
  `).run(status, user, externalId);
  hub.prepare(`
    UPDATE email_summaries
       SET ingestion_status = ?, processed_at = unixepoch()
     WHERE user = ? AND gmail_message_id = ?
  `).run(status, user, `agentmail:${externalId}`);
}

// AgentMail's model/domain routing is compatibility metadata, not canonical
// source identity.  In normal knowledge-first mode it stays off the canonical
// email row entirely; raw evidence is later triaged/synthesised like Gmail.
function recordAgentMailSemanticCompatibility(hub, user, externalId, {
  summary = '',
  projectSlug = null,
  contactId = null,
} = {}) {
  if (!legacyDirectCrmWritesEnabled()) return;
  hub.prepare(`
    UPDATE email_summaries
       SET summary = ?, project_slug = ?, contact_id = ?
     WHERE user = ? AND gmail_message_id = ?
  `).run(summary || '', projectSlug, contactId, user, `agentmail:${externalId}`);
}

function agentmailEmailFromFull(externalId, full) {
  const sender = parseSender(full?.from);
  const parsedTimestamp = new Date(full?.timestamp || full?.created_at).getTime();
  const email = {
    id: `agentmail:${externalId}`,
    ...sender,
    subject: full?.subject || '(no subject)',
    threadId: full?.thread_id || null,
    receivedAt: Number.isFinite(parsedTimestamp)
      ? Math.floor(parsedTimestamp / 1000)
      : Math.floor(Date.now() / 1000),
    bodyText: messageBody(full),
  };
  if (Array.isArray(full?.attachments) && full.attachments.length) {
    email.attachments = full.attachments;
  }
  return email;
}

// Materialise AgentMail's attachment descriptors before any semantic work.
// The provider normally returns attachment_id + a short-lived download_url
// metadata object; tests and older responses may instead include base64
// content inline, so both forms are accepted.  The returned `full` is a safe
// provider-shaped copy containing manifests only — never attachment bytes.
async function materializeAgentMailMessage(externalId, full, { downloadAttachment } = {}) {
  const sourceAttachments = Array.isArray(full?.attachments) ? full.attachments : [];
  if (!sourceAttachments.length) {
    const email = agentmailEmailFromFull(externalId, full);
    return { full, email, attachments: [], attachmentReview: false };
  }

  const manifests = [];
  const attachmentSegments = [];
  let attachmentReview = false;

  for (const original of sourceAttachments) {
    const initial = original && typeof original === 'object' ? original : {};
    const initialInline = attachmentIsInline(initial);
    let inlineResource = initialInline;
    let descriptor = initial;
    let bytes = null;
    try {
      const downloaded = await downloadAgentMailAttachment(externalId, initial, full, downloadAttachment);
      descriptor = downloaded.descriptor || initial;
      bytes = downloaded.bytes;
      inlineResource = initialInline || attachmentIsInline(descriptor);
    } catch (err) {
      // Inline/CID resources are provider-declared presentation material, not
      // semantic source attachments.  Keep a manifest without downgrading a
      // complete HTML body when their optional byte fetch is unavailable.
      if (!inlineResource) throw err;
    }

    const mimeType = attachmentMimeType(descriptor);
    const filename = attachmentFilename(descriptor, mimeType);
    const disposition = attachmentDisposition(descriptor);
    const contentId = attachmentContentId(descriptor);
    let extraction = { status: 'inline_resource', format: null, text: '' };
    if (!inlineResource) {
      if (!bytes) {
        throw new Error(`AgentMail attachment ${filename} bytes unavailable`);
      }
      extraction = await extractAgentMailAttachmentText(filename, mimeType, bytes);
      if (!['extracted', 'inline_resource'].includes(extraction.status)) attachmentReview = true;
    }

    const manifest = {
      filename,
      mime_type: mimeType,
      disposition,
      content_id: contentId,
      inline_resource: inlineResource,
      provider_attachment_id: attachmentId(descriptor),
      byte_size: bytes ? bytes.length : Number.isFinite(Number(descriptor?.size)) ? Number(descriptor.size) : null,
      sha256: bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null,
      extraction_status: extraction.status,
      extraction_format: extraction.format,
      extracted_chars: extraction.text.length,
    };
    if (extraction.error) manifest.extraction_error = String(extraction.error).slice(0, 500);
    manifests.push(manifest);

    const boundary = `[Attachment: ${filename}]`;
    const closing = `[End attachment: ${filename}]`;
    const attachmentText = String(extraction.text || '').trim();
    attachmentSegments.push(
      attachmentText
        ? `${boundary}\n${attachmentText}\n${closing}`
        : `${boundary}\n[Attachment text unavailable; see attachment manifest]\n${closing}`
    );
  }

  const body = messageBody(full);
  const bodyText = [body, ...attachmentSegments].filter(value => String(value || '').trim()).join('\n\n');
  const materializedFull = { ...full, attachments: manifests };
  const email = agentmailEmailFromFull(externalId, materializedFull);
  email.bodyText = bodyText;
  email.attachments = manifests;
  email.attachmentReview = attachmentReview;
  return {
    full: materializedFull,
    email,
    attachments: manifests,
    attachmentReview,
  };
}

async function extractWorkIntelligence(email, contacts, projects, companyProjects = [], wrongFacts = []) {
  const { formatLearnedTaskRules } = require('./task-learning');
  const contactNames = contacts
    .map(contact => `${contact.name}${contact.email ? ` <${contact.email}>` : ''}`)
    .join(', ') || '(none)';
  const projectRows = projects.map(project => `${project.slug}: ${project.name}`).join('\n') || '(none)';
  const companyRows = companyProjects.length
    ? companyProjects.map(cp => `${cp.company_name} → ${cp.project_slug}`).join('\n')
    : '(none)';
  const prompt = `${getSystemPrompt('agentmail_extractor', 'system', PROMPTS.agentmail_extractor)}

From: ${email.fromName} <${email.fromEmail}>
Subject: ${email.subject}
Body:
${email.bodyText.slice(0, 8000)}

Known people: ${contactNames}
Known projects:
${projectRows}
Companies linked to projects (context only — the email's CONTENT decides project_slug, never the sender's company):
${companyRows}${wrongFacts.length ? `

The following past extractions were marked WRONG by the user — do not repeat similar errors:
${wrongFacts.map(w => `- "${w.fact}" (about ${w.contact_name})`).join('\n')}` : ''}${formatLearnedTaskRules('douglas', 'agentmail')}`;

  const modelId = getSystemModelId('agentmail_extractor', 'system', 'google/gemini-3.1-pro-preview');
  const parsed = await requestModelObject({
    modelId,
    messages: [{ role: 'user', content: prompt }],
    feature: 'agentmail_extractor',
    modelKey: 'agentmail_extractor',
    taskCode: TASK_CODES.AGENTMAIL,
    timeout: 60_000,
    defaults: {
      is_work_content: false,
      summary: '',
      project_slug: null,
      fact_type: 'fact',
      action_tasks: [],
      people: [],
    },
    label: 'AgentMail work-extractor response',
  });
  parsed.people = Array.isArray(parsed.people) ? parsed.people : [];
  parsed.action_tasks = normalizeActionTasks(parsed);
  return parsed;
}

function resolveContact(hub, user, name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) return null;
  const contacts = hub.prepare('SELECT * FROM contacts WHERE user = ?').all(user);
  let contact = contacts.find(item => item.name.toLowerCase() === normalized);
  if (!contact) {
    contact = contacts.find(item => {
      try {
        return JSON.parse(item.aliases || '[]').some(alias => alias.toLowerCase() === normalized);
      } catch (_) {
        return false;
      }
    });
  }
  if (contact) return contact;
  const id = uuid();
  hub.prepare('INSERT INTO contacts (id, user, name) VALUES (?, ?, ?)').run(id, user, String(name).trim());
  return hub.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function storePeopleFacts(hub, user, email, people, source = 'agentmail', factType = 'fact', projectSlug = null) {
  const sourceLabel = source === 'gmail' ? 'Gmail' : 'AgentMail';
  const validTypes = new Set(['fact', 'decision', 'action', 'note']);
  const resolved = (people || [])
    .filter(item => item?.name && item?.fact)
    .map(item => ({ item, contact: resolveContact(hub, user, item.name) }))
    .filter(row => row.contact);

  for (const { item, contact } of resolved) {
    const itemType = item.role === 'action_owner'
      ? 'action'
      : validTypes.has(factType) ? factType : 'fact';
    const duplicate = hub.prepare(`
      SELECT 1 FROM crm_facts
      WHERE user = ? AND contact_id = ? AND fact = ? AND source = ?
    `).get(user, contact.id, item.fact, source);
    if (duplicate) continue;
    const factId = uuid();
    hub.prepare(`
      INSERT INTO crm_facts
        (id, user, contact_id, fact, status, source, linked_contacts, fact_type, project_slug)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(factId, user, contact.id, item.fact, source, agentmailFactLinks(), itemType, projectSlug);
    appendContactVaultEntry(
      contact.name,
      `[${sourceLabel}] ${email.subject} — ${item.fact}`,
      { factId, date: new Date(email.receivedAt * 1000) }
    );
  }
  return resolved.map(r => r.contact.id);
}

function linkContactsToProject(hub, user, contactIds, projectSlug) {
  if (!contactIds.length || !projectSlug) return;
  const project = hub.prepare('SELECT id FROM projects WHERE user = ? AND slug = ?').get(user, projectSlug);
  if (!project) return;
  const stmt = hub.prepare('INSERT OR IGNORE INTO contact_projects (contact_id, project_id) VALUES (?, ?)');
  for (const id of contactIds) stmt.run(id, project.id);
}

async function fetchReceivedMessages() {
  const messages = [];
  let pageToken;
  do {
    const page = await listMessages({ limit: 100, pageToken });
    messages.push(...(page.messages || []).filter(message =>
      (message.labels || []).includes('received')
      && !(message.labels || []).includes('hub-processed')
    ));
    pageToken = page.next_page_token;
  } while (pageToken);
  return messages;
}

function domainMatchesCompany(fromEmail, companyName) {
  const domain = (fromEmail.split('@')[1] || '').replace(/\.[^.]+$/, '').toLowerCase();
  const words = companyName.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2);
  return domain.length > 0 && words.some(word => domain.includes(word));
}

// Domains whose emails always bypass newsletter detection and always get work extraction.
// Set AGENTMAIL_WORK_DOMAINS=beaconhospital.ie,h3odigital.co.uk in .env to configure.
function isWorkSenderDomain(fromEmail) {
  const raw = (process.env.AGENTMAIL_WORK_DOMAINS || '').trim();
  if (!raw) return false;
  const host = (fromEmail || '').split('@')[1] || '';
  return raw.split(',').map(d => d.trim().toLowerCase()).some(d => host.toLowerCase().endsWith(d));
}

function isForcedWorkSender(fromEmail) {
  return String(fromEmail || '').trim().toLowerCase() === 'douglas.mclellan@beaconhospital.ie';
}

async function processAgentMail(user = 'douglas') {
  const hub = db.hub();
  const listed = await fetchReceivedMessages();
  if (!listed.length) return { processed: 0, newsletters: 0, peopleFacts: 0, pending: 0 };

  const contacts = hub.prepare('SELECT id, name, email FROM contacts WHERE user = ? ORDER BY name').all(user);
  const projects = hub.prepare('SELECT slug, name FROM projects WHERE user = ? ORDER BY name').all(user);
  // Slugs of projects still alive — mail is only ever filed into these. Ended projects
  // (closed/completed/etc.) are excluded so live content can never be buried in a dead one.
  const closedSlugs = closedProjectSlugs(hub, user);
  const liveSlugs = new Set(projects.map(p => p.slug).filter(slug => !closedSlugs.has(slug)));
  const emailLabels = getEnabledEmailLabels(user);
  const wrongFacts = hub.prepare(`
    SELECT f.fact, c.name AS contact_name
    FROM crm_facts f JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND f.status = 'wrong'
    ORDER BY f.updated_at DESC LIMIT 10
  `).all(user);

  // Companies linked to projects — used for deterministic domain matching and LLM context
  const companyProjects = hub.prepare(`
    SELECT co.name AS company_name, co.id AS company_id, p.slug AS project_slug
    FROM company_projects cp
    JOIN companies co ON co.id = cp.company_id
    JOIN projects p ON p.id = cp.project_id
    WHERE p.user = ?
  `).all(user);
  let processed = 0;
  let newsletters = 0;
  let peopleFacts = 0;
  let pending = 0;

  for (const listedMessage of listed) {
    const externalId = listedMessage.message_id;
    const exists = hub.prepare(`
      SELECT id, body_text, raw_metadata, status FROM inbound_email_records
      WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
    `).get(user, externalId);
    // Unsupported/failed extraction is a durable local review state.  Keep it
    // visible and pending without repeatedly downloading the same bytes on
    // every poll; an operator or a later materialisation/backfill retry can
    // move the row back to `retry` when extraction support changes.
    if (exists?.status === 'attachment_unextracted' && hasPersistedAttachmentManifest(exists.raw_metadata)) {
      pending++;
      continue;
    }
    if (exists?.status === 'processed') {
      // Backfill legacy processed rows once, but only a terminal row earns the
      // remote processed label.  In particular, captured/retry rows below are
      // deliberately re-entered rather than being mistaken for completion.
      const needsBackfill = !String(exists.body_text || '').trim()
        || !String(exists.raw_metadata || '').trim()
        || exists.raw_metadata === '{}'
        || attachmentMetadataNeedsReview(exists.raw_metadata)
        || (Array.isArray(listedMessage.attachments)
          && listedMessage.attachments.length > 0
          && metadataAttachments(exists.raw_metadata).length === 0);
      if (needsBackfill) {
        try {
          const full = await getMessage(externalId);
          const materialized = await materializeAgentMailMessage(externalId, full);
          captureRawAgentMail(hub, user, externalId, materialized.full, materialized.email);
          if (materialized.attachmentReview) {
            markRawAgentMail(hub, user, externalId, 'attachment_unextracted');
            recordProcessingFailure(
              'agentmail',
              externalId,
              new Error('AgentMail attachment extraction requires review'),
            );
            pending++;
            continue;
          }
          console.log(`[agentmail] backfilled faithful provider material for ${externalId}`);
        } catch (err) {
          try { markRawAgentMail(hub, user, externalId, 'retry'); } catch (_) {}
          recordProcessingFailure('agentmail', externalId, err);
          console.warn(`[agentmail] raw backfill failed for ${externalId}:`, err.message);
          continue;
        }
      }
      try {
        await updateMessage(externalId, { addLabels: ['hub-processed'] });
      } catch (err) {
        try { markRawAgentMail(hub, user, externalId, 'retry'); } catch (_) {}
        recordProcessingFailure('agentmail', externalId, err);
        console.warn(`[agentmail] processed-label update failed for ${externalId}:`, err.message);
      }
      continue;
    }

    try {
      const full = await getMessage(externalId);
      // Byte acquisition and extraction are deliberately before raw capture:
      // an attachment that cannot be materialised must remain retryable rather
      // than becoming a captured-looking, terminal source.
      const materialized = await materializeAgentMailMessage(externalId, full);
      const email = materialized.email;
      captureRawAgentMail(hub, user, externalId, materialized.full, email);
      if (materialized.attachmentReview) {
        markRawAgentMail(hub, user, externalId, 'attachment_unextracted');
        recordProcessingFailure(
          'agentmail',
          externalId,
          new Error('AgentMail attachment extraction requires review'),
        );
        pending++;
        continue;
      }
      const senderContact = contacts.find(contact =>
        contact.email
        && contact.email.trim().toLowerCase() === String(email.fromEmail || '').trim().toLowerCase()
      );
      const taxonomyMatch = matchEmailTaxonomy(user, email);
      const trustedWork = isForcedWorkSender(email.fromEmail) || isWorkSenderDomain(email.fromEmail);
      const newsletter = !trustedWork && isApprovedExternalEmail(user, email, taxonomyMatch?.label || '');
      const hasContent = email.bodyText.trim().length >= 5;
      const classification = (hasContent
        ? await classifyEmail(email, contacts, projects, emailLabels, user, 'agentmail')
        : null) ?? { summary: '', project_slug: null, move_label: null };
      const work = (hasContent && (trustedWork || !newsletter)
        ? await extractWorkIntelligence(email, contacts, projects, companyProjects, wrongFacts)
        : null) ?? { is_work_content: false, summary: '', project_slug: null, people: [] };

      // Sender domain → company mapping is a last-resort fallback only, never a decider.
      const companyDomainMatch = companyProjects.find(cp => domainMatchesCompany(email.fromEmail, cp.company_name));
      const companyProjectSlug = companyDomainMatch?.project_slug || null;

      // Content decides the project; the domain map only breaks ties when content is silent.
      const validProject = resolveProjectSlug({
        workSlug: work.project_slug,
        classificationSlug: classification.project_slug,
        companySlug: companyProjectSlug,
        isWork: work.is_work_content || trustedWork,
        liveSlugs,
      });
      if (companyProjectSlug && companyProjectSlug !== validProject) {
        console.log(`[agentmail] content override: ${email.fromEmail} content→${validProject || 'none'}, ignored domain map→${companyProjectSlug}${closedSlugs.has(companyProjectSlug) ? ' (ended project)' : ''}`);
      }
      const canonicalLabel = taxonomyMatch?.label
        || (emailLabels.includes(classification.move_label) ? classification.move_label : null);

      const beforeFacts = legacyDirectCrmWritesEnabled()
        ? hub.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'agentmail'").get(user).n
        : 0;
      // For trusted work senders, extract facts even if the model said is_work_content: false.
      // Forwarded daily summaries from work domains are genuine work intelligence.
      const hasPeople = (work.people || []).length > 0;
      const shouldExtract = work.is_work_content || (trustedWork && hasPeople);
      const resolvedContactIds = legacyDirectCrmWritesEnabled() && shouldExtract
        ? storePeopleFacts(hub, user, email, work.people, 'agentmail', work.fact_type, validProject)
        : [];
      if (legacyDirectCrmWritesEnabled() && resolvedContactIds.length && validProject) {
        linkContactsToProject(hub, user, resolvedContactIds, validProject);
      }

      // Legacy direct task path. Default is off; crm_action_projection now owns
      // source-backed task creation after source triage and duplicate review.
      if (legacyDirectCrmWritesEnabled() && shouldExtract) {
        // Primary: explicit actions Douglas needs to take personally.
        for (const action of normalizeActionTasks(work)) {
          await createTask(user, {
            title: action.title,
            notes: [
              `From: ${email.fromName || email.fromEmail} — ${email.subject}`,
              action.evidence,
              work.summary || '',
            ].filter(Boolean).join('\n'),
            source: 'agentmail',
            sourceId: `agentmail:action:${externalId}:${actionTaskKey(action.title)}`,
            projectSlug: validProject || null,
          });
        }

        // Secondary: one task per named action owner (someone else has an action Douglas needs to track)
        const actionOwners = (work.people || []).filter(p => p.role === 'action_owner');
        for (const person of actionOwners) {
          const personContact = resolvedContactIds.length
            ? hub.prepare('SELECT id FROM contacts WHERE user = ? AND name = ?').get(user, person.name)
            : null;
          await createTask(user, {
            title: followUpTaskTitle(person, email.subject),
            notes: `${person.fact}\n\nFrom: ${email.fromName || email.fromEmail} — ${email.subject}`,
            source: 'agentmail',
            sourceId: followUpTaskSourceId(email, person),
            contactId: personContact?.id || null,
            projectSlug: validProject || null,
          });
        }
      }

      const afterFacts = legacyDirectCrmWritesEnabled()
        ? hub.prepare("SELECT COUNT(*) AS n FROM crm_facts WHERE user = ? AND source = 'agentmail'").get(user).n
        : 0;
      peopleFacts += afterFacts - beforeFacts;

      // Compatibility summary fields are only updated after all model work has
      // completed.  The preceding captured row remains complete and retryable
      // even if this projection or a downstream label call fails.
      hub.prepare(`
        UPDATE inbound_email_records
           SET summary = ?, classification = ?, project_slug = ?
         WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
      `).run(
        work.summary || classification.summary || '', canonicalLabel, validProject,
        user, externalId,
      );
      recordAgentMailSemanticCompatibility(hub, user, externalId, {
        summary: work.summary || classification.summary || '',
        projectSlug: validProject,
        contactId: senderContact?.id || null,
      });

      if (newsletter) {
        const topicIds = await extractTopicsFromEmail(email, user, { sourceLabel: email.fromEmail });
        if (topicIds.length) newsletters++;
      }
      if (!canonicalLabel && !newsletter && !shouldExtract) pending++;

      const agentLabels = [
        'hub-processed',
        validProject ? `project:${validProject}` : null,
        newsletter ? 'hub:newsletter' : null,
        shouldExtract ? 'hub:work' : null,
        !canonicalLabel && !newsletter && !shouldExtract ? 'hub:review' : null,
      ].filter(Boolean);
      await updateMessage(externalId, { addLabels: agentLabels });
      markRawAgentMail(hub, user, externalId, 'processed');
      processed++;
      resolveProcessingFailure('agentmail', externalId);
    } catch (err) {
      try { markRawAgentMail(hub, user, externalId, 'retry'); } catch (_) {}
      recordProcessingFailure('agentmail', externalId, err);
      console.error(`[agentmail] failed ${externalId}:`, err.message);
    }
  }

  return { processed, newsletters, peopleFacts, pending };
}

module.exports = {
  actionTaskKey,
  agentmailFactLinks,
  extractWorkIntelligence,
  followUpTaskSourceId,
  followUpTaskTitle,
  hasMailSubjectPrefix,
  isForcedWorkSender,
  normalizeActionTasks,
  processAgentMail,
  resolveProjectSlug,
  rootSubject,
  storePeopleFacts,
  _test: {
    messageBody,
    agentmailRawMetadata,
    agentmailEmailFromFull,
    extractAgentMailAttachmentText,
    materializeAgentMailMessage,
    attachmentMetadataNeedsReview,
    hasPersistedAttachmentManifest,
    captureRawAgentMail,
    markRawAgentMail,
    recordAgentMailSemanticCompatibility,
  },
};
