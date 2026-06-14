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
