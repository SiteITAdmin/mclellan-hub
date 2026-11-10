'use strict';
const { createHash, timingSafeEqual } = require('crypto');
const { admitSource } = require('./sources');
const { crm } = require('./db');
const speakerReview = require('./speaker-review');

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
function parsePayload(payload) {
  const data = payload.data || {}, body = payload.payload || {};
  const meeting = payload.meeting || data.meeting || body.meeting || {};
  const candidates = [payload, data, body, meeting, payload.generated_content, data.generated_content].filter(Boolean);
  let text;
  if (Object.hasOwn(data, 'content')) {
    const segments = data.content;
    // Reject the whole transcript rather than silently dropping malformed turns.
    if (!Array.isArray(segments) || !segments.length || segments.some(x => !x || typeof x !== 'object' || typeof x.text !== 'string' || !x.text.trim() || (x.speaker !== undefined && (typeof x.speaker !== 'string' || !x.speaker.trim())) || (x.speaker === undefined && (!Number.isInteger(x.speakerIndex) || x.speakerIndex < 0)))) text = '';
    else text = segments.map(x => `${x.speaker === undefined ? `Speaker ${x.speakerIndex}` : x.speaker}: ${x.text}`).join('\n\n');
  } else {
    text = first(...candidates.flatMap(x => [x.transcript_text, x.transcriptText, x.transcript])).trim();
  }
  return { text, meeting, data, body };
}
function recoverPending() {
  for (const row of crm().prepare("SELECT id, raw_json FROM krisp_intake WHERE status = 'pending' AND readable = 0").all()) {
    try {
      const { text } = parsePayload(JSON.parse(row.raw_json));
      if (text) crm().prepare("UPDATE krisp_intake SET transcript = ?, readable = 1 WHERE id = ? AND status = 'pending' AND readable = 0").run(text, row.id);
    } catch { /* Unrecognised stored evidence remains available for inspection. */ }
  }
}
function receive(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const err = new Error('Expected a JSON object'); err.status = 400; throw err;
  }
  if ([payload, payload.data, payload.payload, payload.meeting].some(x => x && Object.hasOwn(x, 'space'))) {
    const err = new Error('Choose Work or Personal in the signed-in Hub, not the webhook body'); err.status = 400; throw err;
  }
  // Krisp also delivers generated notes for the same recording; those are not transcripts.
  if (payload.event === 'note_generated') return { created: false, ignored: true, reason: 'Not a transcript event' };
  recoverPending();
  const { text, meeting, data, body } = parsePayload(payload);
  const raw = JSON.stringify(payload);
  const meetingId = first(meeting.id, meeting.meeting_id, meeting.meetingId, data.meeting_id, body.meeting_id);
  const title = first(meeting.title, meeting.name, payload.title, data.title, body.title, 'Krisp telephone recording');
  const date = [meeting.started_at, meeting.start_time, meeting.start_date, data.started_at, payload.created_at].find(x => x !== undefined && x !== null && x !== '');
  const parsed = timestamp(date);
  const readable = text.length > 0;
  // Content identity ignores delivery event IDs; corrected transcripts remain separate evidence.
  const key = createHash('sha256').update(JSON.stringify([meetingId, text || raw])).digest('hex');
  // Recovered records retain their original raw-based ID, including after a decision.
  if (readable) {
    for (const row of crm().prepare("SELECT id, raw_json, status FROM krisp_intake WHERE (readable = 1 AND transcript = ?) OR (readable = 0 AND status != 'pending')").all(text)) {
      let old;
      try { old = JSON.parse(row.raw_json); if (parsePayload(old).text !== text) continue; } catch { continue; }
      const oldData = old.data || {}, oldBody = old.payload || {};
      const oldMeeting = old.meeting || oldData.meeting || oldBody.meeting || {};
      if (first(oldMeeting.id, oldMeeting.meeting_id, oldMeeting.meetingId, oldData.meeting_id, oldBody.meeting_id) === meetingId)
        return { created: false, id: row.id, readable: true, status: row.status };
    }
  }
  const result = crm().prepare(`INSERT OR IGNORE INTO krisp_intake
    (id, raw_json, title, transcript, occurred_at, readable) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(key, raw, title, text, Number.isFinite(parsed) && parsed >= 0 && parsed <= 8640000000000000 ? Math.floor(parsed / 1000) : null, readable ? 1 : 0);
  return { created: !!result.changes, id: key, readable, status: crm().prepare('SELECT status FROM krisp_intake WHERE id = ?').get(key).status };
}
function list() { recoverPending(); return crm().prepare(`SELECT id, title, occurred_at, received_at, readable, status, space, source_ids, CASE WHEN status = 'pending' THEN transcript ELSE '' END AS transcript, CASE WHEN status = 'pending' THEN raw_json ELSE '' END AS raw_json FROM krisp_intake ORDER BY received_at DESC, id`).all().map(row => ({ ...row, review: row.status === 'pending' ? speakerReview.review(JSON.parse(row.raw_json), row.transcript) : null, sources: JSON.parse(row.source_ids).map(id => crm().prepare('SELECT id, space FROM sources WHERE id = ?').get(id)).filter(Boolean) })); }
function classify(id, choice, form) {
  if (!['work', 'personal', 'ignore'].includes(choice)) { const e = new Error('Choose Work, Personal or Ignore'); e.status = 400; throw e; }
  return crm().transaction(() => {
    recoverPending();
    const row = crm().prepare('SELECT * FROM krisp_intake WHERE id = ?').get(id);
    if (!row) { const e = new Error('Transcript not found'); e.status = 404; throw e; }
    if (row.status !== 'pending') {
      if ((choice === 'ignore' && row.status === 'ignored') || choice === row.space) return JSON.parse(row.source_ids);
      const e = new Error('Transcript already decided'); e.status = 409; throw e;
    }
    if (choice === 'ignore') { crm().prepare("UPDATE krisp_intake SET status = 'ignored' WHERE id = ?").run(id); return []; }
    const confirmed = speakerReview.release(speakerReview.review(JSON.parse(row.raw_json), row.transcript), form);
    const space = choice, key = row.id, title = row.title;
    const parts = confirmed.parts;
    const results = parts.map((part, i) => admitSource({
      space, kind: 'meeting', origin: 'krisp', externalId: `${key}:${i + 1}`,
      title: parts.length > 1 ? `${title} (part ${i + 1} of ${parts.length})` : title,
      text: part, fresh: part, occurredAt: row.occurred_at || row.received_at,
      rawRef: `krisp-intake:${row.id}`, readable: true,
    }));
    const ids = results.map(r => r.source.id);
    crm().prepare("UPDATE krisp_intake SET status = 'classified', space = ?, source_ids = ?, speaker_review = ? WHERE id = ?").run(space, JSON.stringify(ids), JSON.stringify({ revision: form.revision, mapping: confirmed.mapping }), id);
    return ids;
  })();
}
function rawForSource(s) {
  const match = /^krisp-intake:([a-f0-9]{64})$/.exec(s.raw_ref || '');
  if (!match) return null;
  const row = crm().prepare("SELECT * FROM krisp_intake WHERE id = ? AND status = 'classified'").get(match[1]);
  const source = crm().prepare('SELECT space, raw_ref FROM sources WHERE id = ?').get(s.id);
  return row && source && source.space === s.space && source.raw_ref === s.raw_ref && JSON.parse(row.source_ids).includes(s.id) ? row.raw_json : null;
}
module.exports = { authenticate, receive, list, classify, rawForSource };
