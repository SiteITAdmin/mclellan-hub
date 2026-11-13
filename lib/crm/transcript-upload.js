'use strict';

// A transcript file Douglas uploads from a calendar entry waits in krisp_intake
// exactly as a Krisp or Wispr recording does (docs/KRISP-INTAKE.md): outside
// sources, Search and the reader until he names every speaker and releases it.
// Its time is the entry's start, so the released transcript belongs to that entry.

const { createHash } = require('crypto');
const path = require('path');
const { crm } = require('./db');

const sha = x => createHash('sha256').update(x).digest('hex');
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; return e; };

// Exported by meeting apps, Teams, Zoom and Otter; .transcript is a plain-text export.
const TEXT = ['.transcript', '.txt', '.md', '.vtt', '.srt', '.json', '.csv'];
const DOCUMENT = ['.docx', '.pdf', '.html', '.htm'];
const ACCEPT = [...TEXT, ...DOCUMENT];

function decode(buffer) {
  if (buffer.includes(0)) return null;
  const text = buffer.toString('utf8');
  // A binary file decodes to replacement characters; a real transcript has almost none.
  const bad = (text.match(/�/g) || []).length;
  return bad > Math.max(3, text.length / 200) ? null : text.replace(/^﻿/, '');
}

async function textOf(buffer, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (DOCUMENT.includes(ext)) {
    const v = await require('./documents').toText(buffer, name);
    if (!v.readable) throw fail(`${name}: ${v.reason}`);
    return v.text;
  }
  if (!TEXT.includes(ext)) throw fail(`${name}: the Hub reads transcripts saved as ${ACCEPT.join(', ')}`);
  const text = decode(buffer);
  if (text === null) throw fail(`${name} is not a text file, so the Hub can't read it. Export the transcript as text (.txt) and upload that.`);
  return text.replace(/\r\n?/g, '\n');
}

// ── Turning a file into speaker turns ─────────────────────────────────────

const STAMP = String.raw`\(?\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\]?\)?`;
const LEAD_STAMP = new RegExp(`^\\s*${STAMP}\\s*[-–|]?\\s*`);
const LABEL = String.raw`[\p{L}\p{N}][\p{L}\p{N} ,.()'’&_-]{0,59}`;
const SAID = new RegExp(`^(${LABEL}):[ \\t]+(\\S.*)$`, 'u');
const HEADING = new RegExp(`^(${LABEL}?)(?::)?\\s*(?:[|·-]\\s*)?${STAMP}\\s*$`, 'u');
const STAMP_FIRST = new RegExp(`^${STAMP}\\s*[|·-]?\\s*(${LABEL})\\s*:?\\s*$`, 'u');
const LONE = new RegExp(`^(${LABEL}):\\s*$`, 'u');
const CONNECTOR = /^(de|da|di|du|del|della|der|den|van|von|la|le|mac|of|bin|ibn|al|el|y)$/i;

// "So the plan is: we go" must not become a speaker called "So the plan is":
// a label written inline looks like a name, with every word capitalised.
function looksLikeName(label) {
  const words = label.replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every(w => /^[\p{Lu}\p{N}]/u.test(w) || CONNECTOR.test(w));
}

function cueLines(text) {
  const out = [];
  for (const block of text.replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter(l => l.trim());
    if (!lines.length || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const at = lines.findIndex(l => l.includes('-->'));
    if (at < 0) { out.push(...lines); continue; }
    let cue = lines.slice(at + 1).join(' ');
    cue = cue.replace(/<v(?:\.[^ >]*)?\s+([^>]+)>/g, '\n$1: ').replace(/<\/?[^>]+>/g, '');
    out.push(...cue.split('\n').map(l => l.trim()).filter(Boolean));
  }
  return out;
}

function plainTurns(lines) {
  const turns = [], preamble = [];
  let current = null;
  const start = (speaker, text) => { current = { speaker: speaker.trim(), text: text || '' }; turns.push(current); };
  const speaker = label => /\p{L}/u.test(label) && (looksLikeName(label) || turns.some(t => t.speaker === label.trim()));
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let m;
    if ((m = HEADING.exec(raw.trim())) && speaker(m[1])) { start(m[1]); continue; }
    if ((m = STAMP_FIRST.exec(raw.trim())) && speaker(m[1])) { start(m[1]); continue; }
    const line = raw.replace(LEAD_STAMP, '');
    if ((m = SAID.exec(line)) && speaker(m[1])) { start(m[1], m[2]); continue; }
    if ((m = LONE.exec(line.trim())) && speaker(m[1])) { start(m[1]); continue; }
    if (current) current.text += (current.text ? '\n' : '') + line.trim();
    else preamble.push(line.trim());
  }
  return { turns, preamble };
}

const SPEAKER_KEYS = ['speaker', 'speaker_name', 'speakerName', 'speaker_label', 'speakerLabel', 'participant', 'author', 'name', 'user'];
const TEXT_KEYS = ['text', 'content', 'transcript', 'utterance', 'sentence', 'words'];
const LIST_KEYS = ['content', 'segments', 'transcript', 'utterances', 'results', 'entries', 'items', 'monologues', 'turns', 'messages', 'data'];

function jsonList(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object' || depth > 2) return null;
  for (const k of LIST_KEYS) {
    const found = jsonList(value[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function jsonTurns(value) {
  const list = jsonList(value);
  if (!list || !list.length) return null;
  const turns = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') return null;
    let who = SPEAKER_KEYS.map(k => x[k]).find(v => (typeof v === 'string' && v.trim()) || Number.isInteger(v));
    if (who && typeof who === 'object') who = who.name;
    const said = TEXT_KEYS.map(k => x[k]).find(v => typeof v === 'string');
    // A turn with no speaker cannot be attributed; the whole file is refused rather than part dropped.
    if (who === undefined || said === undefined) return null;
    if (!said.trim()) continue;
    turns.push({ speaker: typeof who === 'number' ? `Speaker ${who}` : who.trim(), text: said.trim() });
  }
  return turns;
}

function turnsFrom(text) {
  const body = text.trim();
  let turns = null, preamble = [];
  if (/^[[{]/.test(body)) {
    try { turns = jsonTurns(JSON.parse(body)); } catch { turns = null; }
  }
  if (!turns) {
    const lines = /^WEBVTT/.test(body) || /^\d+\n[\d:,.]+ --> /m.test(body) ? cueLines(body) : body.split('\n');
    ({ turns, preamble } = plainTurns(lines));
  }
  const merged = [];
  for (const t of turns || []) {
    if (!t.text.trim() || /[\r\n\u2028\u2029\x00-\x1f]/.test(t.speaker)) continue;
    const last = merged[merged.length - 1];
    if (last && last.speaker === t.speaker) last.text += `\n${t.text.trim()}`;
    else merged.push({ speaker: t.speaker, text: t.text.trim() });
  }
  return { turns: merged, preamble };
}

// ── Holding it for Douglas ───────────────────────────────────────────────

async function hold({ eventId, buffer, name }) {
  const db = crm();
  const e = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(String(eventId || ''));
  if (!e) throw fail('That calendar entry is no longer in the Hub. Open the calendar again and retry.', 404);
  if (e.all_day) throw fail('An all-day entry has no meeting time to attach a transcript to.');
  if (!buffer || !buffer.length) throw fail('Choose the transcript file to upload.');
  const file = String(name || 'transcript').slice(0, 200);
  const text = await textOf(buffer, file);
  const { turns, preamble } = turnsFrom(text);
  if (!turns.length) throw fail(`${file} has no speaker names the Hub can find. Each turn needs to start with who spoke, like “Douglas: …” or a “Speaker 1  00:01” heading.`);
  const speakers = new Set(turns.map(t => t.speaker));
  if (speakers.size > 50) throw fail(`${file} names ${speakers.size} different speakers, so its labels are probably not names. Check the file.`);

  const fileHash = sha(buffer);
  const id = sha(`transcript:${e.id}:${fileHash}`);
  const existing = db.prepare('SELECT status, space FROM krisp_intake WHERE id = ?').get(id);
  if (existing?.status === 'pending') return { id, event: e, status: 'pending', created: false };
  if (existing?.status === 'classified') return { id, event: e, status: 'classified', space: existing.space, created: false };

  const attendees = JSON.parse(e.attendees || '[]').map(a => a && (a.name || a.email)).filter(x => typeof x === 'string' && x);
  const raw = JSON.stringify({ origin: 'transcript', file, event: { id: e.id, title: e.title, space: e.space, start_at: e.start_at, end_at: e.end_at },
    meeting: { attendees: attendees.map(n => ({ name: n })) }, ...(preamble.length ? { preamble: preamble.join('\n') } : {}), data: { content: turns } });
  const transcript = turns.map(t => `${t.speaker}: ${t.text}`).join('\n\n');
  const title = String(e.title || file).slice(0, 500);
  db.transaction(() => {
    // Uploading again after Ignore is a deliberate choice, unlike a repeated webhook delivery.
    if (existing) db.prepare("UPDATE krisp_intake SET status = 'pending', raw_json = ?, title = ?, transcript = ?, occurred_at = ?, readable = 1, received_at = unixepoch() WHERE id = ?").run(raw, title, transcript, e.start_at, id);
    else db.prepare("INSERT INTO krisp_intake (id, origin, raw_json, title, transcript, occurred_at, readable) VALUES (?, 'transcript', ?, ?, ?, ?, 1)").run(id, raw, title, transcript, e.start_at);
    // The same file added earlier on Add a note but never read only blocked it with "already here".
    db.prepare("UPDATE sources SET atomise_status = 'ignored' WHERE origin = 'upload' AND readable = 0 AND external_id IN (?, ?)").run(`work:${fileHash}`, `personal:${fileHash}`);
  })();
  return { id, event: e, status: 'pending', created: !existing, reopened: !!existing, speakers: speakers.size, turns: turns.length, preamble: preamble.length };
}

module.exports = { hold, turnsFrom, ACCEPT };
