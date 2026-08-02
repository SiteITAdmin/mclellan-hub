const test = require('node:test');
const assert = require('node:assert/strict');

test('AgentMail forwards PDF attachments in the send payload', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.AGENTMAIL_API_KEY;
  const previousInbox = process.env.AGENTMAIL_INBOX_ID;
  let request;

  process.env.AGENTMAIL_API_KEY = 'test-key';
  process.env.AGENTMAIL_INBOX_ID = 'briefings@example.com';
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ message_id: 'test-message' }), { status: 200 });
  };

  try {
    const { sendEmail } = require('../lib/agentmail');
    await sendEmail({
      to: 'reader@example.com',
      subject: 'Anthropic / Claude',
      text: 'Attached.',
      attachments: [{
        filename: 'anthropic-claude.pdf',
        content_type: 'application/pdf',
        content: Buffer.from('%PDF-test').toString('base64'),
      }],
    });

    const body = JSON.parse(request.options.body);
    assert.equal(body.attachments[0].filename, 'anthropic-claude.pdf');
    assert.equal(body.attachments[0].content_type, 'application/pdf');
    assert.equal(Buffer.from(body.attachments[0].content, 'base64').toString(), '%PDF-test');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousKey;
    if (previousInbox === undefined) delete process.env.AGENTMAIL_INBOX_ID;
    else process.env.AGENTMAIL_INBOX_ID = previousInbox;
  }
});

test('AgentMail materializes, hashes, and bounds supported text attachments', async () => {
  const { _test } = require('../lib/agentmail-processor');
  const full = {
    from: 'Sender <sender@example.test>',
    subject: 'Attachment evidence',
    text: 'Message body',
    attachments: [{
      attachment_id: 'att-text',
      filename: 'evidence.txt',
      content_type: 'text/plain',
      content: Buffer.from('Attached source text').toString('base64'),
    }],
  };
  const materialized = await _test.materializeAgentMailMessage('agentmail-text', full);
  assert.equal(materialized.attachmentReview, false);
  assert.match(materialized.email.bodyText, /\[Attachment: evidence\.txt\]/);
  assert.match(materialized.email.bodyText, /Attached source text/);
  assert.match(materialized.email.bodyText, /\[End attachment: evidence\.txt\]/);
  assert.equal(materialized.attachments[0].byte_size, Buffer.byteLength('Attached source text'));
  assert.equal(materialized.attachments[0].sha256,
    require('crypto').createHash('sha256').update('Attached source text').digest('hex'));
  const metadata = JSON.parse(_test.agentmailRawMetadata(materialized.full, materialized.email));
  assert.equal(metadata.attachments[0].sha256, materialized.attachments[0].sha256);
  assert.equal(JSON.stringify(metadata).includes(full.attachments[0].content), false);
});

test('AgentMail unsupported attachments are review-incomplete without base64 metadata', async () => {
  const { _test } = require('../lib/agentmail-processor');
  const full = {
    from: 'Sender <sender@example.test>',
    text: 'Body',
    attachments: [{
      attachment_id: 'att-zip',
      filename: 'archive.zip',
      content_type: 'application/zip',
      content: Buffer.from('opaque bytes').toString('base64'),
    }],
  };
  const materialized = await _test.materializeAgentMailMessage('agentmail-zip', full);
  assert.equal(materialized.attachmentReview, true);
  assert.equal(materialized.attachments[0].extraction_status, 'unextracted');
  const metadata = JSON.stringify(JSON.parse(_test.agentmailRawMetadata(materialized.full, materialized.email)));
  assert.equal(metadata.includes(full.attachments[0].content), false);
});

test('AgentMail unavailable real attachment bytes fail closed before capture', async () => {
  const { _test } = require('../lib/agentmail-processor');
  await assert.rejects(
    () => _test.materializeAgentMailMessage('agentmail-unavailable', {
      from: 'Sender <sender@example.test>',
      text: 'Body',
      attachments: [{ attachment_id: 'att-missing', filename: 'missing.pdf', content_type: 'application/pdf' }],
    }, { downloadAttachment: async () => { throw new Error('temporary unavailable'); } }),
    /temporary unavailable/,
  );
});

test('AgentMail attachment endpoint preserves JSON metadata and raw binary responses', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.AGENTMAIL_API_KEY;
  const previousInbox = process.env.AGENTMAIL_INBOX_ID;
  process.env.AGENTMAIL_API_KEY = 'test-key';
  process.env.AGENTMAIL_INBOX_ID = 'inbox@example.com';
  let mode = 'json';
  globalThis.fetch = async () => mode === 'json'
    ? new Response(JSON.stringify({ attachment_id: 'att-1', download_url: 'https://signed.example/att-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    : new Response(Buffer.from([0, 1, 2, 255]), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
  try {
    const { getAttachment } = require('../lib/agentmail');
    const metadata = await getAttachment('message-1', 'att-1');
    assert.equal(metadata.download_url, 'https://signed.example/att-1');
    mode = 'binary';
    const bytes = await getAttachment('message-1', 'att-1');
    assert.deepEqual([...bytes], [0, 1, 2, 255]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.AGENTMAIL_API_KEY;
    else process.env.AGENTMAIL_API_KEY = previousKey;
    if (previousInbox === undefined) delete process.env.AGENTMAIL_INBOX_ID;
    else process.env.AGENTMAIL_INBOX_ID = previousInbox;
  }
});
