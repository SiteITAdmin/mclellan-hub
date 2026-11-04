'use strict';

// WhatsApp through Hermes (CRM-PLAN §8), capture only. The tap inside the
// Hermes bridge on the Mac posts here. Rules enforced in this file, not just
// in the tap:
// - Nothing from a chat is stored until Douglas approves it and gives it a
//   space. Before that only its name and when it was last seen are kept.
// - People are identified by phone number, never by display name.
// - The stop switch refuses everything, and the tap keeps no backlog.
// - A message that arrives more than 7 days after it was sent is history and
//   can never create a promise or a task.
// - A chat is read once it has been quiet for 5 minutes, so a quick follow-up
//   arrives with it, with the earlier part of the chat as context.

const crypto = require('crypto');
const { crm, now, setting, setSetting } = require('./db');
const { admitSource } = require('./sources');
const { normPhone } = require('./text');
const config = require('./config');
const channels = require('./channels');

const SETTLE_SECONDS = 5 * 60;
const CONTEXT_MESSAGES = 15;
const SILENT_AFTER = 30 * 60;
const MAX_BODY = 20000;

function secretOk(header) {
  const want = process.env.HERMES_WEBHOOK_SECRET || '';
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isPaused() { return setting('whatsapp_paused') === '1'; }

function setPaused(on) { setSetting('whatsapp_paused', on ? '1' : '0'); }

function chat(chatId) {
  return crm().prepare('SELECT * FROM whatsapp_chats WHERE chat_id = ?').get(chatId) || null;
}

function approvedIds() {
  return crm().prepare("SELECT chat_id FROM whatsapp_chats WHERE status = 'approved'").all().map(r => r.chat_id);
}

function heartbeat(body = {}) {
  setSetting('hermes_heartbeat', JSON.stringify({
    at: now(),
    whatsapp: String(body.whatsapp || 'unknown').slice(0, 40),
    sent: Number(body.sent) || 0,
    failed: Number(body.failed) || 0,
    last_error: String(body.last_error || '').slice(0, 300),
    last_error_at: Number(body.last_error_at) || null,
    blocked_private: !!body.blocked_private,
  }));
  return { paused: isPaused(), approved: isPaused() ? [] : approvedIds() };
}

function lastHeartbeat() {
  try { return JSON.parse(setting('hermes_heartbeat') || 'null'); } catch { return null; }
}

function clean(v, max = 240) { return String(v || '').trim().slice(0, max); }

// Record that a chat exists; never store its words unless it is approved.
function touchChat(m) {
  const db = crm();
  const existing = chat(m.chat_id);
  const name = clean(m.chat_name);
  if (!existing) {
    db.prepare(`INSERT INTO whatsapp_chats (chat_id, name, is_group, is_self, peer_phone, last_seen, seen_count)
                VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .run(m.chat_id, name, m.is_group ? 1 : 0, m.is_self ? 1 : 0, m.is_group ? '' : normPhone(m.peer_phone || ''), now());
  } else {
    // A DM's name comes from the other person's own messages; Douglas's
    // replies carry his name, so they never rename the chat.
    const rename = name && (m.is_group || !m.from_me) && name !== existing.name;
    db.prepare(`UPDATE whatsapp_chats SET last_seen = ?, seen_count = seen_count + 1, name = CASE WHEN ? THEN ? ELSE name END,
                peer_phone = CASE WHEN peer_phone = '' THEN ? ELSE peer_phone END WHERE chat_id = ?`)
      .run(now(), rename ? 1 : 0, name, m.is_group ? '' : normPhone(m.peer_phone || ''), m.chat_id);
  }
  const c = chat(m.chat_id);
  return c.status === 'waiting' ? preapprove(c) : c;
}

// Exact group name only, and only while the chat is still undecided: once
// Douglas has decided, his decision stands.
function preapprove(c) {
  const rule = config.whatsappPreapproved.find(r => !!r.isGroup === !!c.is_group && r.name.toLowerCase() === String(c.name || '').toLowerCase());
  if (!rule) return c;
  const project = rule.project ? require('./review').createProject(rule.space, rule.project) : null;
  decide(c.chat_id, { action: 'approve', space: rule.space, projectId: project?.id || null });
  return chat(c.chat_id);
}

/**
 * One message from the tap. Returns { stored, reason }. Throws with
 * err.status for a refused request.
 */
function receive(m = {}) {
  if (isPaused()) throw Object.assign(new Error('WhatsApp capture is paused'), { status: 503 });
  const chatId = clean(m.chat_id);
  if (!chatId) throw Object.assign(new Error('chat_id is required'), { status: 400 });
  const c = touchChat({ ...m, chat_id: chatId });
  if (c.status !== 'approved') return { stored: false, reason: c.status === 'ignored' ? 'chat_ignored' : 'chat_waiting' };
  const body = String(m.body || '').trim();
  const messageId = clean(m.message_id);
  if (!body || !messageId) return { stored: false, reason: 'no_text' };
  const sentAt = Number(m.sent_at) > 1e9 ? Math.floor(Number(m.sent_at)) : now();
  const r = crm().prepare(`INSERT OR IGNORE INTO whatsapp_messages (chat_id, message_id, from_me, sender_phone, sender_name, body, sent_at, received_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(chatId, messageId, m.from_me ? 1 : 0, m.from_me ? '' : normPhone(m.sender_phone || ''), m.from_me ? '' : clean(m.sender_name), body.slice(0, MAX_BODY), sentAt, now());
  if (r.changes) setSetting('whatsapp_last_message_at', String(now()));
  return { stored: !!r.changes, reason: r.changes ? 'stored' : 'duplicate' };
}

function dublinStamp(ts) {
  return new Date(ts * 1000).toLocaleString('en-IE', {
    timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function speaker(m) {
  if (m.from_me) return 'Douglas';
  return m.sender_name ? `${m.sender_name} (${m.sender_phone || 'no number'})` : (m.sender_phone || 'Unknown');
}

function lines(msgs) {
  return msgs.map(m => `[${dublinStamp(m.sent_at)}] ${speaker(m)}: ${m.body}`).join('\n');
}

function isLate(m) {
  return m.received_at - m.sent_at > config.captureWindowDays * 86400;
}

function admitBurst(c, msgs, history) {
  const db = crm();
  const first = msgs[0];
  const context = db.prepare(`
    SELECT * FROM whatsapp_messages WHERE chat_id = ? AND source_id IS NOT NULL AND sent_at <= ?
     ORDER BY sent_at DESC LIMIT ?
  `).all(c.chat_id, first.sent_at, CONTEXT_MESSAGES).reverse();
  const fresh = lines(msgs);
  const text = context.length
    ? `${fresh}\n\n--- Earlier in this chat ---\n${lines(context)}`
    : fresh;
  const mine = msgs.filter(m => m.from_me).length;
  const participants = [];
  const seen = new Set();
  for (const m of msgs) {
    if (m.from_me || !m.sender_phone || seen.has(m.sender_phone)) continue;
    seen.add(m.sender_phone);
    participants.push({ role: 'from', phone: m.sender_phone, name: m.sender_name });
  }
  if (!c.is_group && !c.is_self && c.peer_phone && !seen.has(c.peer_phone)) {
    participants.push({ role: 'to', phone: c.peer_phone, name: c.name });
  }
  const where = c.is_group ? `in ${c.name || 'a group'} on WhatsApp` : 'on WhatsApp';
  const { source } = admitSource({
    space: c.space,
    kind: c.is_self ? 'note' : 'whatsapp',
    origin: 'whatsapp',
    externalId: `${c.chat_id}:${first.message_id}`,
    title: c.is_self ? first.body.split('\n')[0].slice(0, 120) : (c.name || c.peer_phone || 'WhatsApp chat'),
    occurredAt: first.sent_at,
    direction: mine === msgs.length ? 'out' : mine === 0 ? 'in' : null,
    text,
    fresh,
    rawRef: c.chat_id,
    participants: c.is_self ? [] : participants,
    proposeFrom: 'all',
    proposeReason: `Messaged ${where}`,
    isHistory: history,
  });
  const mark = db.prepare('UPDATE whatsapp_messages SET source_id = ? WHERE chat_id = ? AND message_id = ?');
  for (const m of msgs) mark.run(source.id, c.chat_id, m.message_id);
  return source;
}

// Approved chats that have been quiet for 5 minutes become sources: one for
// the new messages, and a separate history-only one for any that arrived
// more than 7 days late.
function settle(t = now()) {
  const db = crm();
  const chats = db.prepare(`
    SELECT c.* FROM whatsapp_chats c WHERE c.status = 'approved'
       AND EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.chat_id = c.chat_id AND m.source_id IS NULL)
  `).all();
  let sources = 0;
  for (const c of chats) {
    const waiting = db.prepare('SELECT * FROM whatsapp_messages WHERE chat_id = ? AND source_id IS NULL ORDER BY sent_at, message_id').all(c.chat_id);
    if (Math.max(...waiting.map(m => m.received_at)) > t - SETTLE_SECONDS) continue;
    db.transaction(() => {
      const late = waiting.filter(isLate);
      const current = waiting.filter(m => !isLate(m));
      if (late.length) { admitBurst(c, late, true); sources += 1; }
      if (current.length) { admitBurst(c, current, null); sources += 1; }
    })();
  }
  return { chats: chats.length, sources };
}

function setChatProject(chatId, projectId) {
  const c = chat(chatId);
  if (!c) throw new Error('Chat not found');
  if (projectId) {
    const p = crm().prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!p || p.space !== c.space) throw new Error('Choose a project in the same space as the chat');
  }
  return channels.setProject(`whatsapp:${chatId}`, projectId || null);
}

function decide(chatId, { action, space, projectId = null }) {
  const c = chat(chatId);
  if (!c) throw new Error('Chat not found');
  if (action === 'approve') {
    if (!['work', 'personal'].includes(space)) throw new Error('Choose Work or Personal');
    crm().prepare("UPDATE whatsapp_chats SET status = 'approved', space = ?, decided_at = ? WHERE chat_id = ?").run(space, now(), chatId);
    setChatProject(chatId, projectId || null);
  } else if (action === 'ignore') {
    crm().prepare("UPDATE whatsapp_chats SET status = 'ignored', decided_at = ? WHERE chat_id = ?").run(now(), chatId);
  } else if (action === 'waiting') {
    crm().prepare("UPDATE whatsapp_chats SET status = 'waiting', space = NULL, decided_at = NULL WHERE chat_id = ?").run(chatId);
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
  return chat(chatId);
}

function list() {
  const rows = crm().prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM whatsapp_messages m WHERE m.chat_id = c.chat_id) AS stored,
           cp.project_id, p.name AS project_name
      FROM whatsapp_chats c
      LEFT JOIN channel_projects cp ON cp.channel = 'whatsapp:' || c.chat_id
      LEFT JOIN projects p ON p.id = cp.project_id
     ORDER BY c.last_seen DESC
  `).all();
  return {
    waiting: rows.filter(r => r.status === 'waiting'),
    approved: rows.filter(r => r.status === 'approved'),
    ignored: rows.filter(r => r.status === 'ignored'),
  };
}

function waitingCount() {
  return crm().prepare("SELECT COUNT(*) AS n FROM whatsapp_chats WHERE status = 'waiting'").get().n;
}

// What could be silently wrong with WhatsApp, for both Today screens.
function health(t = now()) {
  const out = [];
  const href = '/crm/whatsapp';
  const hb = lastHeartbeat();
  if (isPaused()) out.push({ level: 'warn', text: 'WhatsApp capture is paused', href });
  else if (!hb) out.push({ level: 'warn', text: "Hermes hasn't checked in yet, so WhatsApp isn't being captured", href });
  else if (hb.at < t - SILENT_AFTER) out.push({ level: 'bad', text: `Hermes hasn't checked in since ${require('./views').ago(hb.at)}. WhatsApp isn't being captured. Check ai.hermes.gateway on the Mac`, href });
  else {
    if (hb.whatsapp !== 'connected') out.push({ level: 'bad', text: `Hermes is running but WhatsApp is ${hb.whatsapp}. It may need linking again with \`hermes whatsapp\``, href });
    if (hb.blocked_private) out.push({ level: 'bad', text: "The private-contacts list couldn't be read, so Hermes is sending nothing until it can", href });
    if (hb.last_error && hb.last_error_at && hb.last_error_at > t - SILENT_AFTER) out.push({ level: 'warn', text: `Hermes couldn't deliver a WhatsApp message to the Hub: ${hb.last_error}`, href });
  }
  const waiting = waitingCount();
  if (waiting) out.push({ level: 'warn', text: `${waiting} WhatsApp chat${waiting === 1 ? '' : 's'} waiting for you to approve or ignore`, href });
  return out;
}

module.exports = {
  secretOk, isPaused, setPaused, heartbeat, lastHeartbeat, receive, settle, decide, setChatProject, list, waitingCount, health, chat,
  SETTLE_SECONDS,
};
