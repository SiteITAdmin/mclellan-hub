'use strict';

// Wispr meetings are held for Douglas exactly as Krisp recordings are
// (docs/KRISP-INTAKE.md): the transcript waits in krisp_intake, outside sources,
// Search and the reader, until he names the speakers and releases it to a space.

const { createHash } = require('crypto');
const { crm, now } = require('./db');
const wispr = require('./wispr');
const runs = require('./runs');

const WINDOW_DAYS = 7, RECHECK_DAYS = 2;
const PAGE = 50, MAX_PAGES = 10;
const RANGE = 40000, MAX_RANGES = 40;
// Wispr wraps every transcript range in guard lines and says where the next one starts.
const HEAD = /^<<<[^\n]*>>>\n/;
const FOOT = /\n?<<<END TRANSCRIPT>>>\s*$/;
const MORE = /\n\n\(\.\.\.truncated, \d+ chars remaining; continue with view_transcript\.start_char=(\d+)\.\.\.\)$/;

const intakeId = meetingId => createHash('sha256').update(`wispr:${meetingId}`).digest('hex');

// Wispr writes one "Name:  words" line per turn. Its names come from calendars
// ("Murray, Ken (IT)"), so any label is kept whole rather than squeezed through
// the plain-transcript label pattern, which would hand that turn to the speaker before.
function turnsOf(text) {
  const turns = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^([^:\n]{1,80}):[ \t]+(\S.*)$/.exec(line);
    if (m && m[1].trim()) turns.push({ speaker: m[1].trim(), text: m[2] });
    else if (turns.length) turns[turns.length - 1].text += `\n${line}`;
    else return null;
  }
  return turns.length ? turns : null;
}

async function fetchMeeting(session, id, size = RANGE) {
  let meeting = null, text = '', start = 0;
  for (let n = 0; n < MAX_RANGES; n++) {
    const r = await session.call('get_meeting', { meeting_id: id, view_content: { char_limit: 1 }, view_transcript: { start_char: start, char_limit: size } });
    if (!r || typeof r !== 'object') throw new Error('Wispr returned a meeting the Hub cannot read');
    if (!meeting) { meeting = { ...r }; delete meeting.transcript; }
    const range = typeof r.transcript === 'string' ? r.transcript : '';
    // An unrecognised wrapper is kept as unreadable evidence, never guessed at.
    if (!HEAD.test(range) || !FOOT.test(range)) return { meeting, text: '', readable: false };
    const body = range.replace(HEAD, '').replace(FOOT, '');
    const more = MORE.exec(body);
    if (!more) {
      // A continuation note in a shape the Hub does not know would otherwise be stored as speech.
      if (/\(\.\.\.truncated\b[^\n]*\)\s*$/.test(body)) return { meeting, text: '', readable: false };
      return { meeting, text: (text + body).trim(), readable: !!(text + body).trim() };
    }
    text += body.slice(0, more.index);
    const next = Number(more[1]);
    if (!(next > start)) return { meeting, text: '', readable: false };
    start = next;
  }
  return { meeting, text: '', readable: false };
}

async function capture() {
  if (!wispr.status('work').connected) return { connected: false };
  const db = crm();
  const session = await wispr.open('work');
  const since = new Date((now() - WINDOW_DAYS * 86400) * 1000).toISOString();
  const detail = { connected: true, seen: 0, held: 0, updated: 0, notReady: 0, unreadable: 0 };
  const errors = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const found = await session.call('search_meetings', { since, limit: PAGE, ...(cursor ? { cursor } : {}) });
    if (!found || !Array.isArray(found.meetings)) throw new Error('Wispr returned a meeting list the Hub cannot read');
    for (const m of found.meetings) {
      if (!m || typeof m.id !== 'string' || !m.id || m.shared) continue;
      detail.seen += 1;
      if (!m.finalized || !m.has_transcript) { detail.notReady += 1; continue; }
      const id = intakeId(m.id), version = String(m.modified_at || '');
      const row = db.prepare('SELECT status, version, raw_json FROM krisp_intake WHERE id = ?').get(id);
      // A decision is final. A held copy is fetched again when Wispr says it changed, and for
      // its first two days regardless, because that is when Douglas corrects speakers there.
      const recent = Date.parse(m.start) / 1000 > now() - RECHECK_DAYS * 86400;
      if (row && (row.status !== 'pending' || (row.version === version && !recent))) continue;
      try {
        const got = await fetchMeeting(session, m.id);
        const turns = got.readable ? turnsOf(got.text) : null;
        const { meeting } = got, readable = !!turns, text = readable ? got.text : '';
        const started = Date.parse(meeting.start || m.start);
        const fields = [JSON.stringify({ origin: 'wispr', meeting, transcript: got.text, ...(turns ? { data: { content: turns } } : {}) }), String(meeting.title || m.title || 'Wispr meeting').slice(0, 500), text,
          Number.isFinite(started) ? Math.floor(started / 1000) : null, readable ? 1 : 0, version];
        if (row && row.raw_json === fields[0]) continue;
        if (row) {
          // Douglas corrected it in Wispr while it waited: the held copy follows, and any open form goes stale.
          detail.updated += db.prepare("UPDATE krisp_intake SET raw_json = ?, title = ?, transcript = ?, occurred_at = ?, readable = ?, version = ? WHERE id = ? AND status = 'pending'").run(...fields, id).changes;
        } else {
          detail.held += db.prepare("INSERT OR IGNORE INTO krisp_intake (raw_json, title, transcript, occurred_at, readable, version, id, origin) VALUES (?, ?, ?, ?, ?, ?, ?, 'wispr')").run(...fields, id).changes;
        }
        if (!readable) detail.unreadable += 1;
      } catch (err) {
        errors.push(`${String(m.title || 'A meeting').slice(0, 80)}: ${err.message}`);
      }
    }
    if (!found.has_more || !found.next_cursor) break;
    cursor = found.next_cursor;
  }
  if (errors.length) throw new Error(`${errors.length} Wispr meeting${errors.length === 1 ? '' : 's'} could not be fetched (${errors[0]})`.slice(0, 400));
  return detail;
}

function run() { return runs.track('wispr_capture', capture); }

function state() {
  const r = runs.all().wispr_capture || null;
  return { run: r, failed: !!(r && r.last_error && (!r.last_ok || r.last_error_at >= r.last_ok)) };
}

function health(space) {
  if (!wispr.status(space).connected) return [];
  const { run: r, failed } = state();
  const href = `/crm/${space}/meetings`;
  if (failed) return [{ level: 'bad', text: `Wispr meetings: ${r.last_error}`, href }];
  if (r && r.last_ok && r.last_ok < now() - 45 * 60) return [{ level: 'bad', text: 'Wispr meetings have not been checked for over 45 minutes', href }];
  return [];
}

module.exports = { run, capture, fetchMeeting, state, health, intakeId };
