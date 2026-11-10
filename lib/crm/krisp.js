'use strict';
const { createHash, timingSafeEqual } = require('crypto');
const { admitSource } = require('./sources');
const { split } = require('./documents');
const { crm } = require('./db');

function authenticate(header) {
  const secret = process.env.KRISP_WEBHOOK_SECRET;
  if (!secret) return { status: 503 };
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(typeof header === 'string' ? header : '');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? {} : { status: 401 };
}
const timestamp = value => {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) { const n = Number(value); return n > 1e11 ? n : n * 1000; }
  return Date.parse(value);
};
const first = (...xs) => xs.find(x => typeof x === 'string' && x.trim()) || '';
function receive(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('Expected a JSON object'); err.status = 400; throw err;
  }
  if ([payload, payload.data, payload.payload, payload.meeting].some(x => x && Object.hasOwn(x, 'space'))) {
    const err = new Error('Choose Work or Personal in the signed-in Hub, not the webhook body'); err.status = 400; throw err;
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
  const date = [meeting.started_at, meeting.start_time, meeting.start_date, data.started_at, payload.created_at].find(x => x !== undefined && x !== null && x !== '');
  const parsed = timestamp(date);
  const readable = text.length > 0;
  // Content identity ignores delivery event IDs; corrected transcripts remain separate evidence.
  const key = createHash('sha256').update(JSON.stringify([meetingId, text || raw])).digest('hex');
  const result = crm().prepare(`INSERT OR IGNORE INTO krisp_intake
    (id, raw_json, title, transcript, occurred_at, readable) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(key, raw, title, text, Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null, readable ? 1 : 0);
  return { created: !!result.changes, id: key, readable, status: crm().prepare('SELECT status FROM krisp_intake WHERE id = ?').get(key).status };
}
function list() { return crm().prepare('SELECT * FROM krisp_intake ORDER BY received_at DESC, id').all(); }
function classify(id, choice) {
  if (!['work', 'personal', 'ignore'].includes(choice)) { const e = new Error('Choose Work, Personal or Ignore'); e.status = 400; throw e; }
  return crm().transaction(() => {
    const row = crm().prepare('SELECT * FROM krisp_intake WHERE id = ?').get(id);
    if (!row) { const e = new Error('Transcript not found'); e.status = 404; throw e; }
    if (row.status !== 'pending') {
      if ((choice === 'ignore' && row.status === 'ignored') || choice === row.space) return JSON.parse(row.source_ids);
      const e = new Error('Transcript already decided'); e.status = 409; throw e;
    }
    if (choice === 'ignore') { crm().prepare("UPDATE krisp_intake SET status = 'ignored' WHERE id = ?").run(id); return []; }
    const space = choice, key = row.id, title = row.title, text = row.transcript, raw = row.raw_json, readable = !!row.readable;
    const digest = createHash('sha256').update(raw).digest('hex');
    const parts = readable ? split(text) : [text];
    const results = parts.map((part, i) => admitSource({
      space, kind: 'meeting', origin: 'krisp', externalId: `${key}:${i + 1}`,
      title: parts.length > 1 ? `${title} (part ${i + 1} of ${parts.length})` : title,
      text: part, fresh: part, occurredAt: row.occurred_at,
      rawRef: `krisp-intake:${row.id}`, readable,
      unreadableReason: readable ? '' : `Krisp transcript empty, too short or unsupported payload; inspect original JSON (${digest.slice(0, 12)})`,
    }));
    const ids = results.map(r => r.source.id);
    crm().prepare("UPDATE krisp_intake SET status = 'classified', space = ?, source_ids = ? WHERE id = ?").run(space, JSON.stringify(ids), id);
    return ids;
  })();
}
function rawForSource(s) {
  const match = /^krisp-intake:([a-f0-9]{64})$/.exec(s.raw_ref || '');
  if (!match) return null;
  const row = crm().prepare("SELECT * FROM krisp_intake WHERE id = ? AND status = 'classified' AND space = ?").get(match[1], s.space);
  return row && JSON.parse(row.source_ids).includes(s.id) ? row.raw_json : null;
}
module.exports = { authenticate, receive, list, classify, rawForSource };
