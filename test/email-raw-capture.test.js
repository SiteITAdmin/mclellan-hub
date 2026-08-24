'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-email-raw-capture-'));
const tmpDb = path.join(tmpDir, 'hub.db');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'hub.db'), tmpDb);
process.env.HUB_DB_PATH = tmpDb;
delete process.env.CRM_LEGACY_DIRECT_WRITES;

const db = require('../lib/db');
const gmailModule = require('../lib/gmail');
const { _test: gmailProvider } = gmailModule;
const { _test: gmailCapture } = require('../lib/email-processor');
const { _test: agentmailCapture } = require('../lib/agentmail-processor');
const { resolveSourceEvidence } = require('../lib/source-evidence');
const { _test: knowledgeEngine } = require('../lib/crm-knowledge-engine');

const user = 'email-raw-capture-test';
const rawBody = `${'x'.repeat(500_123)}\nTAIL: preserve this final explicit ask.`;

function emailRow(messageId) {
  return db.hub().prepare(`
    SELECT id, gmail_message_id, direction, body_text, raw_metadata, ingestion_status,
           summary, project_slug, contact_id
    FROM email_summaries WHERE user = ? AND gmail_message_id = ?
  `).get(user, messageId);
}

function providerAttachmentGmail(attachments, calls) {
  return {
    users: {
      messages: {
        attachments: {
          get: async ({ userId, messageId, id }) => {
            calls.push({ userId, messageId, id });
            if (!(id in attachments)) throw new Error(`missing attachment ${id}`);
            return { data: { data: attachments[id] } };
          },
        },
      },
    },
  };
}

function makePdfBuffer(text) {
  const content = `BT /F1 18 Tf 30 80 Td (${String(text).replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output);
}

test.after(() => {
  try { db.hub().close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Gmail received and sent capture full provider material before classification', () => {
  const hub = db.hub();
  const received = {
    id: 'raw-gmail-received',
    subject: 'Received raw evidence',
    fromName: 'Alex Example',
    fromEmail: 'alex@example.test',
    receivedAt: 1771000000,
    bodyText: rawBody,
    rawHeaders: [{ name: 'Message-ID', value: '<received@example.test>' }, { name: 'X-Provider', value: 'gmail' }],
    threadId: 'thread-received',
    labelIds: ['INBOX', 'UNREAD'],
  };
  const sent = {
    id: 'raw-gmail-sent',
    subject: 'Sent raw evidence',
    toName: 'Taylor Example',
    toEmail: 'taylor@example.test',
    sentAt: 1771000001,
    bodyText: rawBody.replace(/^x+/, 'y'.repeat(500_123)),
    rawHeaders: [{ name: 'Message-ID', value: '<sent@example.test>' }, { name: 'To', value: 'Taylor <taylor@example.test>' }],
    threadId: 'thread-sent',
    labelIds: ['SENT'],
  };

  gmailCapture.captureRawGmailEmail(hub, user, received);
  gmailCapture.captureRawGmailEmail(hub, user, sent, { direction: 'sent' });

  const receivedRow = emailRow(received.id);
  const sentRow = emailRow(sent.id);
  assert.equal(receivedRow.ingestion_status, 'captured');
  assert.equal(sentRow.ingestion_status, 'captured');
  assert.equal(receivedRow.direction, 'received');
  assert.equal(sentRow.direction, 'sent');
  assert.equal(receivedRow.body_text, received.bodyText);
  assert.equal(sentRow.body_text, sent.bodyText);
  assert.ok(receivedRow.body_text.length > 500_000);
  assert.ok(sentRow.body_text.length > 500_000);
  assert.deepEqual(JSON.parse(receivedRow.raw_metadata), {
    provider: 'gmail', direction: 'received', thread_id: 'thread-received', label_ids: ['INBOX', 'UNREAD'],
    headers: received.rawHeaders,
  });
  assert.deepEqual(JSON.parse(sentRow.raw_metadata), {
    provider: 'gmail', direction: 'sent', thread_id: 'thread-sent', label_ids: ['SENT'],
    headers: sent.rawHeaders,
  });
});

test('raw Gmail capture resolves aliases before classification and preserves the contact anchor', () => {
  const hub = db.hub();
  hub.prepare(`
    INSERT OR IGNORE INTO contacts (id, user, name, email, phone, aliases)
    VALUES (?, ?, ?, '', '', ?)
  `).run('raw-contact-nakai', user, 'Nakai McLellan', '["Nakai Mutenga","Kai"]');
  const email = {
    id: 'raw-gmail-kai',
    subject: 'Identity before model',
    fromName: 'Kai Mutenga',
    fromEmail: 'kaimutenga@icloud.com',
    receivedAt: 1771000002,
    bodyText: 'Please send the final document.',
    rawHeaders: [],
    labelIds: ['INBOX'],
  };

  const identity = gmailCapture.captureRawGmailEmail(hub, user, email);
  assert.equal(identity.status, 'matched');
  assert.equal(identity.contact.id, 'raw-contact-nakai');
  assert.equal(emailRow(email.id).contact_id, 'raw-contact-nakai');

  const providerEmail = { ...email, id: 'provider-raw-gmail-kai' };
  gmailProvider.captureFetchedRawGmailEmail(user, providerEmail);
  assert.equal(emailRow(providerEmail.id).contact_id, 'raw-contact-nakai');

  const sent = {
    id: 'raw-gmail-sent-kai',
    subject: 'Sent identity before model',
    toName: 'Kai Mutenga',
    toEmail: 'kaimutenga@icloud.com',
    sentAt: 1771000003,
    bodyText: 'Here is the final document.',
    rawHeaders: [],
    labelIds: ['SENT'],
  };
  gmailCapture.captureRawGmailEmail(hub, user, sent, { direction: 'sent' });
  assert.equal(emailRow(sent.id).contact_id, 'raw-contact-nakai');
});

test('raw AgentMail capture resolves the sender before its classifiers', () => {
  const hub = db.hub();
  const externalId = 'raw-agentmail-kai';
  const email = {
    fromName: 'Kai Mutenga',
    fromEmail: 'kaimutenga@icloud.com',
    subject: 'AgentMail identity before model',
    receivedAt: 1771000004,
    bodyText: 'Please review this.',
  };
  agentmailCapture.captureRawAgentMail(hub, user, externalId, { thread_id: 'thread-kai' }, email);
  assert.equal(emailRow(`agentmail:${externalId}`).contact_id, 'raw-contact-nakai');
});

test('Gmail attachment-backed MIME text is materialized before received and sent raw capture', async () => {
  const hub = db.hub();
  const receivedBody = `${'r'.repeat(500_321)}\nTAIL RECEIVED ATTACHMENT ASK`;
  const sentBody = `${'s'.repeat(500_654)}\nTAIL SENT ATTACHMENT ASK`;
  const calls = [];
  const gmail = providerAttachmentGmail({
    'received-text': Buffer.from(receivedBody, 'utf8').toString('base64url'),
    'sent-text': Buffer.from(sentBody, 'utf8').toString('base64url'),
  }, calls);
  const receivedFull = {
    data: {
      internalDate: '1771000005000', threadId: 'attachment-received-thread', labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'From', value: 'Provider Person <provider@example.test>' }, { name: 'Subject', value: 'Attachment-backed received' }],
        parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { attachmentId: 'received-text', size: receivedBody.length } }] }],
      },
    },
  };
  const sentFull = {
    data: {
      internalDate: '1771000006000', threadId: 'attachment-sent-thread', labelIds: ['SENT'],
      payload: {
        mimeType: 'multipart/mixed',
        headers: [{ name: 'To', value: 'Recipient Person <recipient@example.test>' }, { name: 'Subject', value: 'Attachment-backed sent' }],
        parts: [{ mimeType: 'multipart/related', parts: [{ mimeType: 'text/plain', body: { attachmentId: 'sent-text', size: sentBody.length } }] }],
      },
    },
  };

  const received = await gmailProvider.receivedEmailFromFull(gmail, receivedFull, 'provider-received-id');
  const sent = await gmailProvider.sentEmailFromFull(gmail, sentFull, 'provider-sent-id');
  assert.equal(received.bodyText, receivedBody);
  assert.equal(sent.bodyText, sentBody);
  assert.match(received.bodyText, /TAIL RECEIVED ATTACHMENT ASK$/);
  assert.match(sent.bodyText, /TAIL SENT ATTACHMENT ASK$/);
  assert.ok(received.bodyText.length > 500_000);
  assert.ok(sent.bodyText.length > 500_000);
  assert.deepEqual(calls, [
    { userId: 'me', messageId: 'provider-received-id', id: 'received-text' },
    { userId: 'me', messageId: 'provider-sent-id', id: 'sent-text' },
  ]);

  gmailCapture.captureRawGmailEmail(hub, user, received);
  gmailCapture.captureRawGmailEmail(hub, user, sent, { direction: 'sent' });
  assert.equal(emailRow('provider-received-id').body_text, receivedBody);
  assert.equal(emailRow('provider-sent-id').body_text, sentBody);
});

test('non-text PDF attachment is fetched, hashed, manifested, and represented in evidence', async () => {
  const pdf = makePdfBuffer('PDF attachment evidence body');
  const attachmentId = 'pdf-provider-attachment';
  const gmail = providerAttachmentGmail({
    [attachmentId]: pdf.toString('base64url'),
  }, []);
  const full = {
    data: {
      internalDate: '1771000007000', threadId: 'pdf-attachment-thread', labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Cover note').toString('base64url') } },
          {
            mimeType: 'application/pdf', filename: 'evidence.pdf',
            headers: [
              { name: 'Content-Disposition', value: 'attachment; filename="evidence.pdf"' },
              { name: 'Content-ID', value: '<pdf-evidence>' },
            ],
            body: { attachmentId, size: pdf.length },
          },
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull(gmail, full, 'pdf-attachment-message');
  assert.match(email.bodyText, /Cover note/);
  assert.match(email.bodyText, /PDF attachment evidence body/);
  assert.deepEqual(email.attachments, [{
    filename: 'evidence.pdf', mime_type: 'application/pdf', disposition: 'attachment',
    content_id: '<pdf-evidence>', inline_resource: false,
    provider_attachment_id: attachmentId, byte_size: pdf.length,
    sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
    extraction_status: 'extracted', extraction_format: 'pdf',
    extracted_chars: 'PDF attachment evidence body'.length,
  }]);

  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  const row = emailRow('pdf-attachment-message');
  const metadata = JSON.parse(row.raw_metadata);
  assert.equal(metadata.attachments[0].sha256, crypto.createHash('sha256').update(pdf).digest('hex'));
  const evidence = resolveSourceEvidence(user, 'email_summary', row.id);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.completeness, 'complete');
  assert.match(evidence.text, /PDF attachment evidence body/);
});

test('direct text attachment is hashed and included with explicit boundaries', async () => {
  const bytes = Buffer.from('Attached plain-text evidence and ask', 'utf8');
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Cover body').toString('base64url') } },
          {
            mimeType: 'text/plain', filename: 'notes.txt',
            headers: [{ name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' }],
            body: { data: bytes.toString('base64url'), size: bytes.length },
          },
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull({}, full, 'direct-text-attachment');
  assert.match(email.bodyText, /Cover body/);
  assert.match(email.bodyText, /\[Attachment: notes\.txt\]/);
  assert.match(email.bodyText, /Attached plain-text evidence and ask/);
  assert.match(email.bodyText, /\[End attachment: notes\.txt\]/);
  assert.equal(email.attachments[0].extraction_status, 'extracted');
  assert.equal(email.attachments[0].provider_attachment_id, null);
  assert.equal(email.attachments[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  assert.equal(JSON.parse(emailRow('direct-text-attachment').raw_metadata).attachments[0].filename, 'notes.txt');
});

test('attachmentId-backed HTML text attachment is fetched, hashed, and represented', async () => {
  const bytes = Buffer.from('<p>HTML attachment tail</p>', 'utf8');
  const attachmentId = 'html-text-provider-attachment';
  const calls = [];
  const gmail = providerAttachmentGmail({ [attachmentId]: bytes.toString('base64url') }, calls);
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [{
          mimeType: 'text/html', filename: 'tail.html',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          body: { attachmentId, size: bytes.length },
        }],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull(gmail, full, 'id-backed-html-attachment');
  assert.deepEqual(calls, [{ userId: 'me', messageId: 'id-backed-html-attachment', id: attachmentId }]);
  assert.equal(email.bodyText, '[Attachment: tail.html]\nHTML attachment tail\n[End attachment: tail.html]');
  assert.equal(email.attachments[0].provider_attachment_id, attachmentId);
  assert.equal(email.attachments[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(email.attachments[0].extraction_status, 'extracted');
});

test('unavailable non-text attachment fails closed and holds the received cursor', async () => {
  const messageId = 'unavailable-pdf-message';
  const oldCursor = '300';
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(`cursor-unavailable-${user}`, user, oldCursor);
  const gmail = {
    users: { messages: {
      list: async () => ({ data: { messages: [{ id: messageId }] } }),
      get: async () => ({ data: {
        payload: { mimeType: 'multipart/mixed', headers: [], parts: [{
          mimeType: 'application/pdf', filename: 'missing.pdf',
          body: { attachmentId: 'missing-pdf', size: 123 },
        }] },
      } }),
      attachments: { get: async () => { throw new Error('PDF bytes temporarily unavailable'); } },
    } },
  };
  const result = await gmailModule.fetchNewEmails(user, { gmailClient: gmail });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(result.emails.length, 0);
  assert.equal(db.hub().prepare("SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'").get(user).value, oldCursor);
  assert.equal(emailRow(messageId), undefined);
});

test('unavailable text attachment also fails closed before cursor advancement', async () => {
  const messageId = 'unavailable-text-attachment-message';
  const oldCursor = '350';
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(`cursor-unavailable-text-${user}`, user, oldCursor);
  const gmail = {
    users: { messages: {
      list: async () => ({ data: { messages: [{ id: messageId }] } }),
      get: async () => ({ data: {
        payload: { mimeType: 'multipart/mixed', headers: [], parts: [{
          mimeType: 'text/plain', filename: 'missing.txt',
          headers: [{ name: 'Content-Disposition', value: 'attachment' }],
          body: { attachmentId: 'missing-text-attachment', size: 20 },
        }] },
      } }),
      attachments: { get: async () => { throw new Error('text attachment bytes unavailable'); } },
    } },
  };
  const result = await gmailModule.fetchNewEmails(user, { gmailClient: gmail });
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(db.hub().prepare("SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'").get(user).value, oldCursor);
  assert.equal(emailRow(messageId), undefined);
});

test('unsupported attachment is manifested but source evidence stays review-incomplete', async () => {
  const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
  const attachmentId = 'zip-provider-attachment';
  const gmail = providerAttachmentGmail({ [attachmentId]: bytes.toString('base64url') }, []);
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Body only').toString('base64url') } }, {
          mimeType: 'application/zip', filename: 'archive.zip',
          body: { attachmentId, size: bytes.length },
        }],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull(gmail, full, 'unsupported-attachment-message');
  assert.equal(email.bodyText, 'Body only');
  assert.equal(email.attachments[0].extraction_status, 'unextracted');
  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  const row = emailRow('unsupported-attachment-message');
  const evidence = resolveSourceEvidence(user, 'email_summary', row.id);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.completeness, 'attachment_unextracted');
  assert.equal(evidence.provenance.attachment_manifest[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('inline related resources are manifested without making ordinary HTML evidence incomplete', async () => {
  const bytes = Buffer.from('fake image bytes');
  const attachmentId = 'inline-image-attachment';
  const gmail = providerAttachmentGmail({ [attachmentId]: bytes.toString('base64url') }, []);
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/related', headers: [],
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML message</p>').toString('base64url') } },
          {
            mimeType: 'image/png', filename: 'logo.png',
            headers: [
              { name: 'Content-Disposition', value: 'inline; filename="logo.png"' },
              { name: 'Content-ID', value: '<logo>' },
            ],
            body: { attachmentId, size: bytes.length },
          },
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull(gmail, full, 'inline-image-message');
  assert.equal(email.bodyText, 'HTML message');
  assert.equal(email.attachments[0].extraction_status, 'inline_resource');
  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  const row = emailRow('inline-image-message');
  const evidence = resolveSourceEvidence(user, 'email_summary', row.id);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.completeness, 'complete');
});

test('attachment manifest revision remains stable when mutable Gmail labels move', async () => {
  const bytes = Buffer.from('stable attachment bytes');
  const attachmentId = 'stable-attachment';
  const gmail = providerAttachmentGmail({ [attachmentId]: bytes.toString('base64url') }, []);
  const full = {
    data: {
      labelIds: ['INBOX'], payload: { mimeType: 'multipart/mixed', headers: [], parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Stable body').toString('base64url') } },
        { mimeType: 'application/octet-stream', filename: 'stable.bin', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId, size: bytes.length } },
      ] },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull(gmail, full, 'stable-manifest-message');
  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  const row = emailRow('stable-manifest-message');
  const before = resolveSourceEvidence(user, 'email_summary', row.id);
  // A later semantic/capture replay without provider attachment fields must
  // not erase the immutable manifest acquired by the first raw capture.
  gmailCapture.captureRawGmailEmail(db.hub(), user, {
    id: email.id, subject: email.subject, fromName: email.fromName, fromEmail: email.fromEmail,
    receivedAt: email.receivedAt, bodyText: email.bodyText, rawHeaders: email.rawHeaders,
    threadId: email.threadId, labelIds: ['Projects/Archive'],
  });
  assert.ok(JSON.parse(emailRow('stable-manifest-message').raw_metadata).attachments[0].sha256);
  db.hub().prepare('UPDATE email_summaries SET raw_metadata = ? WHERE id = ?').run(JSON.stringify({
    provider: 'gmail', direction: 'received', thread_id: null, label_ids: ['Projects/Archive'], headers: [], attachments: email.attachments,
  }), row.id);
  const after = resolveSourceEvidence(user, 'email_summary', row.id);
  assert.equal(after.revision_hash, before.revision_hash);
  assert.equal(after.provenance.attachment_manifest[0].sha256, before.provenance.attachment_manifest[0].sha256);
});

test('attachment-backed text refuses partial capture when provider material is unavailable', async () => {
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [{ mimeType: 'text/plain', body: { attachmentId: 'missing-text', size: 12 } }],
      },
    },
  };
  await assert.rejects(
    gmailProvider.receivedEmailFromFull(providerAttachmentGmail({}, []), full, 'provider-missing-id'),
    /missing attachment missing-text/,
  );
});

function encodedPart(mimeType, body) {
  return { mimeType, body: { data: Buffer.from(body, 'utf8').toString('base64url') } };
}

test('mixed nested MIME preserves an HTML body followed by a plain forwarded tail', async () => {
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [
          {
            mimeType: 'multipart/related',
            parts: [encodedPart('text/html', '<p>HTML body</p>')],
          },
          encodedPart('text/plain', 'Forwarded plain tail'),
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull({}, full, 'mixed-html-then-plain');
  assert.equal(email.bodyText, 'HTML body\n\nForwarded plain tail');
});

test('mixed nested MIME preserves a plain body followed by an HTML-only tail', async () => {
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [
          encodedPart('text/plain', 'Plain body'),
          {
            mimeType: 'multipart/related',
            parts: [encodedPart('text/html', '<div>HTML-only forwarded tail</div>')],
          },
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull({}, full, 'mixed-plain-then-html');
  assert.equal(email.bodyText, 'Plain body\n\nHTML-only forwarded tail');
});

test('multipart alternative deduplicates plain and HTML representations while keeping plain text', async () => {
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/alternative', headers: [],
        parts: [
          encodedPart('text/html', '<p>Same message</p>'),
          encodedPart('text/plain', 'Same message'),
        ],
      },
    },
  };
  const email = await gmailProvider.receivedEmailFromFull({}, full, 'alternative-dedup');
  assert.equal(email.bodyText, 'Same message');
});

test('attachment materialization failures enter the normal Gmail retry source', async () => {
  const messageId = 'provider-materialization-retry';
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [{ mimeType: 'text/plain', body: { attachmentId: 'unavailable-text', size: 10 } }],
      },
    },
  };
  const gmail = {
    users: {
      messages: {
        get: async () => full,
        attachments: { get: async () => { throw new Error('attachment temporarily unavailable'); } },
      },
    },
  };
  const emails = await gmailProvider.fetchReceivedMessages(gmail, [{ id: messageId }], { logPrefix: 'raw-capture-test' });
  assert.deepEqual(emails, []);
  const retry = db.hub().prepare(`
    SELECT source, external_id, resolved_at FROM processing_failures
    WHERE source = 'gmail' AND external_id = ?
  `).get(messageId);
  assert.deepEqual(retry, { source: 'gmail', external_id: messageId, resolved_at: null });
});

test('label cursor materialization failures also leave a Gmail retry receipt', async () => {
  const messageId = 'provider-label-materialization-retry';
  const full = {
    data: {
      payload: {
        mimeType: 'multipart/mixed', headers: [],
        parts: [{ mimeType: 'text/plain', body: { attachmentId: 'label-unavailable-text', size: 10 } }],
      },
    },
  };
  const gmail = {
    users: {
      messages: {
        list: async () => ({ data: { messages: [{ id: messageId }] } }),
        get: async () => full,
        attachments: { get: async () => { throw new Error('label attachment temporarily unavailable'); } },
      },
    },
  };
  const emails = await gmailModule.fetchMessagesByLabelId(gmail, 'LABEL_RETRY', 0);
  assert.deepEqual(emails, []);
  const retry = db.hub().prepare(`
    SELECT source, external_id, resolved_at FROM processing_failures
    WHERE source = 'gmail' AND external_id = ?
  `).get(messageId);
  assert.deepEqual(retry, { source: 'gmail', external_id: messageId, resolved_at: null });
});

test('raw Gmail state remains retryable until a terminal processing mark', () => {
  const hub = db.hub();
  const email = {
    id: 'raw-gmail-state', subject: 'State test', fromName: 'Alex', fromEmail: 'alex@example.test',
    receivedAt: 1771000002, bodyText: rawBody, rawHeaders: [{ name: 'X-State', value: 'one' }],
  };
  gmailCapture.captureRawGmailEmail(hub, user, email);
  gmailCapture.markRawGmailEmail(hub, user, email.id, 'retry');
  assert.equal(emailRow(email.id).ingestion_status, 'retry');

  // Starting a retry returns the row to captured; marking it complete makes
  // it terminal, and a later fetch must not regress that terminal state.
  gmailCapture.captureRawGmailEmail(hub, user, email);
  assert.equal(emailRow(email.id).ingestion_status, 'captured');
  gmailCapture.markRawGmailEmail(hub, user, email.id, 'processed');
  gmailCapture.captureRawGmailEmail(hub, user, email);
  assert.equal(emailRow(email.id).ingestion_status, 'processed');
});

test('AgentMail capture keeps the full body in raw and canonical rows and honors status transitions', () => {
  const hub = db.hub();
  const externalId = 'raw-agentmail-message';
  const full = {
    from: 'Jordan Example <jordan@example.test>',
    subject: 'AgentMail raw evidence',
    thread_id: 'agentmail-thread',
    timestamp: '2026-02-13T10:00:00.000Z',
    text: rawBody,
    headers: [{ name: 'Message-ID', value: '<agentmail@example.test>' }],
    labels: ['received'],
    to: ['douglas@example.test'],
    cc: ['archive@example.test'],
    attachments: [{ filename: 'evidence.pdf' }],
  };
  const email = agentmailCapture.agentmailEmailFromFull(externalId, full);
  assert.equal(agentmailCapture.messageBody(full), rawBody);
  agentmailCapture.captureRawAgentMail(hub, user, externalId, full, email);

  const inbound = hub.prepare(`
    SELECT body_text, raw_metadata, status FROM inbound_email_records
    WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
  `).get(user, externalId);
  const canonical = emailRow(`agentmail:${externalId}`);
  assert.equal(inbound.status, 'captured');
  assert.equal(canonical.ingestion_status, 'captured');
  assert.equal(inbound.body_text, rawBody);
  assert.equal(canonical.body_text, rawBody);
  assert.ok(inbound.body_text.length > 500_000);
  assert.deepEqual(JSON.parse(inbound.raw_metadata).headers, full.headers);
  assert.deepEqual(JSON.parse(canonical.raw_metadata).headers, full.headers);

  agentmailCapture.markRawAgentMail(hub, user, externalId, 'retry');
  assert.equal(hub.prepare("SELECT status FROM inbound_email_records WHERE user = ? AND source = 'agentmail' AND external_message_id = ?").get(user, externalId).status, 'retry');
  assert.equal(emailRow(`agentmail:${externalId}`).ingestion_status, 'retry');
  agentmailCapture.captureRawAgentMail(hub, user, externalId, full, email);
  assert.equal(emailRow(`agentmail:${externalId}`).ingestion_status, 'captured');
  agentmailCapture.markRawAgentMail(hub, user, externalId, 'processed');
  agentmailCapture.captureRawAgentMail(hub, user, externalId, full, email);
  assert.equal(emailRow(`agentmail:${externalId}`).ingestion_status, 'processed');
});

test('AgentMail unsupported attachment capture stays review-incomplete and non-terminal', async () => {
  const hub = db.hub();
  const externalId = 'agentmail-unsupported-review';
  const full = {
    from: 'Sender <sender@example.test>',
    subject: 'Unsupported attachment',
    timestamp: '2026-02-13T12:00:00.000Z',
    text: 'Please review the attached archive.',
    attachments: [{
      attachment_id: 'att-zip-review',
      filename: 'archive.zip',
      content_type: 'application/zip',
      content: Buffer.from('opaque').toString('base64'),
    }],
  };
  const materialized = await agentmailCapture.materializeAgentMailMessage(externalId, full);
  assert.equal(materialized.attachmentReview, true);
  agentmailCapture.captureRawAgentMail(hub, user, externalId, materialized.full, materialized.email);
  agentmailCapture.markRawAgentMail(hub, user, externalId, 'attachment_unextracted');
  const inbound = hub.prepare(`
    SELECT status, raw_metadata FROM inbound_email_records
    WHERE user = ? AND source = 'agentmail' AND external_message_id = ?
  `).get(user, externalId);
  const canonical = emailRow(`agentmail:${externalId}`);
  assert.equal(inbound.status, 'attachment_unextracted');
  assert.equal(canonical.ingestion_status, 'attachment_unextracted');
  assert.equal(JSON.parse(inbound.raw_metadata).attachments[0].extraction_status, 'unextracted');
  assert.equal(JSON.parse(inbound.raw_metadata).attachments[0].sha256.length, 64);
});

test('normal AgentMail semantic compatibility cannot revise canonical evidence or action identity', () => {
  const hub = db.hub();
  const externalId = 'agentmail-identity-stability';
  const full = {
    from: 'Jordan Example <jordan@example.test>',
    subject: 'Canonical identity',
    thread_id: 'agentmail-identity-thread', timestamp: '2026-02-13T11:00:00.000Z',
    text: 'Please send the final source-backed document.',
    headers: [{ name: 'Message-ID', value: '<agentmail-identity@example.test>' }],
  };
  const email = agentmailCapture.agentmailEmailFromFull(externalId, full);
  agentmailCapture.captureRawAgentMail(hub, user, externalId, full, email);
  const canonical = hub.prepare(`
    SELECT id FROM email_summaries WHERE user = ? AND gmail_message_id = ?
  `).get(user, `agentmail:${externalId}`);
  const before = resolveSourceEvidence(user, 'email_summary', canonical.id);
  const action = {
    title: 'Send final source-backed document', actionability: 'explicit_ask', confidence: 0.9,
    evidence: 'Please send the final source-backed document.',
  };
  const beforeKey = knowledgeEngine.actionIdentity(before, action, [], before.chunks[0]).action_key;

  agentmailCapture.recordAgentMailSemanticCompatibility(hub, user, externalId, {
    summary: 'Model-derived compatibility summary', projectSlug: 'model-project', contactId: 'model-contact',
  });
  const normalRow = emailRow(`agentmail:${externalId}`);
  assert.equal(normalRow.summary, '');
  assert.equal(normalRow.project_slug, null);
  assert.equal(normalRow.contact_id, null);
  const afterNormal = resolveSourceEvidence(user, 'email_summary', canonical.id);
  assert.equal(afterNormal.revision_hash, before.revision_hash);
  assert.equal(knowledgeEngine.actionIdentity(afterNormal, action, [], afterNormal.chunks[0]).action_key, beforeKey);

  // Even an explicit legacy compatibility update cannot alter a raw-derived
  // revision or its exact evidence action key.
  hub.prepare(`
    UPDATE email_summaries SET summary = ?, project_slug = ?, contact_id = ? WHERE id = ?
  `).run('Legacy summary', 'legacy-project', 'legacy-contact', canonical.id);
  const afterLegacyFields = resolveSourceEvidence(user, 'email_summary', canonical.id);
  assert.equal(afterLegacyFields.revision_hash, before.revision_hash);
  assert.equal(knowledgeEngine.actionIdentity(afterLegacyFields, action, [], afterLegacyFields.chunks[0]).action_key, beforeKey);
});

test('normal-mode Gmail compatibility leaves model-routed semantic fields unprojected', () => {
  const hub = db.hub();
  const received = {
    id: 'raw-gmail-no-semantic-received', subject: 'No semantic write', fromName: 'Alex', fromEmail: 'alex@example.test',
    receivedAt: 1771000003, bodyText: 'Faithful body', rawHeaders: [{ name: 'From', value: 'Alex <alex@example.test>' }],
  };
  const sent = {
    id: 'raw-gmail-no-semantic-sent', subject: 'No semantic sent write', toName: 'Taylor', toEmail: 'taylor@example.test',
    sentAt: 1771000004, bodyText: 'Faithful sent body', rawHeaders: [{ name: 'To', value: 'Taylor <taylor@example.test>' }],
  };
  gmailCapture.captureRawGmailEmail(hub, user, received);
  gmailCapture.captureRawGmailEmail(hub, user, sent, { direction: 'sent' });
  const projection = { summary: 'Model-derived summary', project_slug: 'model-project', contact_id: 'model-contact' };
  gmailCapture.recordGmailSemanticCompatibility(hub, user, received, projection, {
    projectSlug: projection.project_slug, contactId: projection.contact_id,
  });
  gmailCapture.recordGmailSemanticCompatibility(hub, user, sent, projection, {
    direction: 'sent', projectSlug: projection.project_slug, contactId: projection.contact_id,
  });

  for (const row of [emailRow(received.id), emailRow(sent.id)]) {
    assert.equal(row.ingestion_status, 'processed');
    assert.equal(row.summary, '');
    assert.equal(row.project_slug, null);
    assert.equal(row.contact_id, null);
  }
});

function pagedReceivedGmail(messageIds, { failId = null } = {}) {
  const pages = [messageIds.slice(0, 50), messageIds.slice(50)];
  const calls = [];
  return {
    calls,
    users: {
      messages: {
        list: async options => {
          calls.push({ kind: 'list', options });
          const page = options.pageToken ? 1 : 0;
          return { data: {
            messages: pages[page].map(id => ({ id })),
            ...(page === 0 && pages[1].length ? { nextPageToken: 'page-2' } : {}),
          } };
        },
        get: async ({ id }) => {
          calls.push({ kind: 'get', id });
          if (id === failId) throw new Error(`temporary provider failure for ${id}`);
          return { data: {
            internalDate: '1771000010000', labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'From', value: `Person ${id} <${id}@example.test>` },
                { name: 'Subject', value: `Subject ${id}` },
              ],
              body: { data: Buffer.from(`Body ${id}`).toString('base64url') },
            },
          } };
        },
      },
    },
  };
}

test('received Gmail traversal paginates past 50 and captures every body before checkpoint', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `paged-received-${i}`);
  const oldCursor = '100';
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(`cursor-${user}`, user, oldCursor);
  const gmail = pagedReceivedGmail(ids);
  const result = await gmailModule.fetchNewEmails(user, { gmailClient: gmail });

  assert.equal(result.emails.length, ids.length);
  assert.equal(gmail.calls.filter(call => call.kind === 'list').length, 2);
  assert.equal(gmail.calls.find(call => call.kind === 'list').options.maxResults, 50);
  assert.equal(gmail.calls.find(call => call.kind === 'list').options.q, 'after:100 -in:sent -category:promotions -category:social');
  assert.equal(db.hub().prepare("SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'").get(user).value, String(result.checkpointTs));
  const captured = db.hub().prepare(`
    SELECT COUNT(*) AS n, SUM(CASE WHEN ingestion_status = 'captured' THEN 1 ELSE 0 END) AS captured,
           SUM(CASE WHEN body_text IS NOT NULL AND body_text != '' THEN 1 ELSE 0 END) AS bodies
    FROM email_summaries WHERE user = ? AND gmail_message_id LIKE 'paged-received-%'
  `).get(user);
  assert.deepEqual(captured, { n: 51, captured: 51, bodies: 51 });
});

test('received Gmail acquisition failure leaves the cursor behind the unrecorded message', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `paged-failure-${i}`);
  const oldCursor = '200';
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value) VALUES (?, ?, '_gmail_last_check_ts', ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(`cursor-failure-${user}`, user, oldCursor);
  const gmail = pagedReceivedGmail(ids, { failId: ids[50] });
  const result = await gmailModule.fetchNewEmails(user, { gmailClient: gmail });

  assert.equal(result.emails.length, 50);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(db.hub().prepare("SELECT value FROM crm_context WHERE user = ? AND key = '_gmail_last_check_ts'").get(user).value, oldCursor);
  const failed = db.hub().prepare(`
    SELECT resolved_at FROM processing_failures WHERE source = 'gmail' AND external_id = ?
  `).get(ids[50]);
  assert.equal(failed.resolved_at, null);
  const rows = db.hub().prepare(`
    SELECT COUNT(*) AS n, SUM(CASE WHEN body_text IS NOT NULL AND body_text != '' THEN 1 ELSE 0 END) AS bodies
    FROM email_summaries WHERE user = ? AND gmail_message_id LIKE 'paged-failure-%'
  `).get(user);
  assert.deepEqual(rows, { n: 50, bodies: 50 });
});

test('label move failure is recorded and retried without repeating semantic/provider work', async () => {
  const messageId = 'gmail-label-retry-message';
  const email = {
    id: messageId, subject: 'Label retry', fromName: 'Alex', fromEmail: 'alex@example.test',
    receivedAt: 1771000011, bodyText: 'raw label retry body', rawHeaders: [], labelIds: ['INBOX'],
  };
  gmailCapture.captureRawGmailEmail(db.hub(), user, email);
  gmailCapture.markRawGmailEmail(db.hub(), user, messageId, 'processed');
  db.hub().prepare(`
    UPDATE email_summaries SET gmail_label = ?, gmail_label_source = 'hub', gmail_label_checked_at = NULL
    WHERE user = ? AND gmail_message_id = ?
  `).run('Retry/Label', user, messageId);

  let firstGet = true;
  let modifyCalls = 0;
  const fakeGmail = { users: { labels: {
    list: async () => ({ data: { labels: [{ id: 'retry-label-id', name: 'Retry/Label' }] } }),
  }, messages: {
    get: async () => {
      if (firstGet) {
        firstGet = false;
        throw new Error('label provider temporarily unavailable');
      }
      return { data: { labelIds: [] } };
    },
    modify: async () => { modifyCalls++; return { data: {} }; },
  } } };

  const first = await gmailCapture.retryPendingGmailLabels(user, fakeGmail, ['Retry/Label']);
  assert.equal(first.failed, 1);
  assert.equal(modifyCalls, 0);
  assert.equal(db.hub().prepare(`
    SELECT resolved_at FROM processing_failures WHERE source = 'gmail_label' AND external_id = ?
  `).get(messageId).resolved_at, null);
  assert.equal(db.hub().prepare(`SELECT ingestion_status FROM email_summaries WHERE user = ? AND gmail_message_id = ?`).get(user, messageId).ingestion_status, 'processed');

  const second = await gmailCapture.retryPendingGmailLabels(user, fakeGmail, ['Retry/Label']);
  assert.equal(second.failed, 0);
  assert.equal(second.moved, 1);
  assert.equal(modifyCalls, 1);
  assert.ok(db.hub().prepare(`SELECT gmail_label_checked_at FROM email_summaries WHERE user = ? AND gmail_message_id = ?`).get(user, messageId).gmail_label_checked_at);
  assert.ok(db.hub().prepare(`
    SELECT resolved_at FROM processing_failures WHERE source = 'gmail_label' AND external_id = ?
  `).get(messageId).resolved_at);
});
