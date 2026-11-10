'use strict';
const { createHash, timingSafeEqual } = require('crypto');
const { admitSource } = require('./sources');
const { split } = require('./documents');
const { crm } = require('./db');

function authenticate(header) {
  const secret = process.env.KRISP_WEBHOOK_SECRET;
  const space = process.env.KRISP_WEBHOOK_SPACE;
  if (!secret || !['work', 'personal'].includes(space)) return { status: 503 };
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(typeof header === 'string' ? header : '');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { space } : { status: 401 };
}
const first = (...xs) => xs.find(x => typeof x === 'string' && x.trim()) || '';
function receive(payload, space) {
  if (!['work', 'personal'].includes(space)) throw new Error('Explicit Krisp space required');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('Expected a JSON object'); err.status = 400; throw err;
  }
  const data = payload.data || {}, body = payload.payload || {};
  const meeting = payload.meeting || data.meeting || body.meeting || {};
  const candidates = [payload, data, body, meeting, payload.generated_content, data.generated_content].filter(Boolean);
  // These string fields come from the retired receiver, not a published Krisp schema.
  const text = first(...candidates.flatMap(x => [x.transcript_text, x.transcriptText, x.transcript])).trim();
  const raw = JSON.stringify(payload);
  const digest = createHash('sha256').update(raw).digest('hex');
  const meetingId = first(meeting.id, meeting.meeting_id, meeting.meetingId, data.meeting_id, body.meeting_id);
  const title = first(meeting.title, meeting.name, payload.title, data.title, body.title, 'Krisp telephone recording');
  const date = first(meeting.started_at, meeting.start_time, meeting.start_date, data.started_at, payload.created_at);
  const parsed = Date.parse(date);
  const readable = text.replace(/\s/g, '').length >= 40;
  // Content identity ignores delivery event IDs; corrected transcripts remain separate evidence.
  const key = `${space}:${createHash('sha256').update(JSON.stringify([meetingId, text || raw])).digest('hex')}`;
  const parts = readable ? split(text) : [text];
  return crm().transaction(() => {
    const results = parts.map((part, i) => admitSource({
      space, kind: 'meeting', origin: 'krisp', externalId: `${key}:${i + 1}`,
      title: parts.length > 1 ? `${title} (part ${i + 1} of ${parts.length})` : title,
      text: part, fresh: part, occurredAt: Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null,
      rawRef: raw, readable,
      unreadableReason: readable ? '' : `Krisp transcript empty, too short or unsupported payload; inspect original JSON (${digest.slice(0, 12)})`,
    }));
    return { created: results.some(r => r.created), readable, sources: results.map(r => r.source.id) };
  })();
}
module.exports = { authenticate, receive };
