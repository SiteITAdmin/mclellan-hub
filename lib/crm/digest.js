'use strict';

// The 07:30 morning email, one per space: short, and a link to Today. Work
// goes on weekdays only. A run that starts after 10:00 sends nothing: a
// morning email nobody will read in the morning is noise.

const { crm, now, setting, setSetting } = require('./db');
const { uuid } = require('../id');
const planner = require('./planner');
const runs = require('./runs');

const SEND_AT = [7, 30];
const TOO_LATE = 10 * 60;
const baseUrl = () => (process.env.CRM_PUBLIC_URL || 'https://douglas.mclellan.scot').replace(/\/$/, '');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = ts => { const m = planner.local(ts).minutes; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function previousDay(space, t) {
  const local = planner.local(t);
  const endDate = local.date;
  const date = planner.addDays(endDate, space === 'work' && local.weekday === 'Mon' ? -3 : -1);
  const start = planner.epoch(date), end = planner.epoch(endDate);
  // updated_at also tracks duplicate evidence and filing; only the extractor's
  // explicit supersession is evidence of a knowledge update.
  // Keep SQLite on fact-specific lookups even before it has planner statistics;
  // scanning a whole space per candidate stalls this synchronous morning job.
  const rows = crm().prepare(`
    SELECT a.id, a.statement, COUNT(*) OVER () AS total,
      (SELECT old.statement FROM atoms old INDEXED BY idx_atoms_replacement WHERE old.space = a.space
        AND old.superseded_by = a.id AND old.status = 'superseded'
        ORDER BY old.created_at DESC, old.id LIMIT 1) AS old_statement,
      EXISTS (SELECT 1 FROM atom_sources evidence CROSS JOIN sources s ON s.id = evidence.source_id
        WHERE evidence.atom_id = a.id AND s.space = a.space AND s.readable = 1
          AND s.kind != 'calendar') AS non_calendar,
      EXISTS (SELECT 1 FROM atoms old INDEXED BY idx_atoms_replacement WHERE old.space = a.space
        AND old.superseded_by = a.id AND old.status = 'superseded') AS replacement,
      (SELECT s.id FROM atom_sources evidence CROSS JOIN sources s ON s.id = evidence.source_id
        WHERE evidence.atom_id = a.id AND s.space = a.space AND s.readable = 1
        ORDER BY (s.kind != 'calendar') DESC, s.occurred_at DESC, s.id LIMIT 1) AS source_id
    FROM atoms a
    WHERE a.space = ? AND a.status = 'active' AND a.created_at >= ? AND a.created_at < ?
      AND EXISTS (SELECT 1 FROM atom_sources evidence CROSS JOIN sources s ON s.id = evidence.source_id
        WHERE evidence.atom_id = a.id AND s.space = a.space AND s.readable = 1)
    ORDER BY non_calendar DESC, replacement DESC, a.created_at DESC, a.id
    LIMIT 8
  `).all(space, start, end);
  const clip = text => `${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
  const lines = rows.map(a => ({
    text: `${a.replacement ? 'Updated' : 'Learned'}: ${clip(a.statement)}${a.old_statement ? ` (Previously: ${clip(a.old_statement)})` : ''}`,
    links: [
      { label: 'Fact', url: `${baseUrl()}/crm/${space}/facts/${encodeURIComponent(a.id)}` },
      { label: 'Source', url: `${baseUrl()}/crm/${space}/sources/${encodeURIComponent(a.source_id)}` },
    ],
  }));
  const omitted = (rows[0]?.total || 0) - rows.length;
  if (omitted) lines.push(`${omitted} more facts learned or updated in this period are not shown.`);
  if (!lines.length) lines.push('No source-backed knowledge learned or updated in this period.');
  const lastDate = planner.addDays(endDate, -1);
  return { empty: !rows.length, title: `CRM briefing — ${date}${date !== lastDate ? ` to ${lastDate}` : ''} (Dublin)`, lines: [
    'What the CRM learned in this period, including older sources read then. Updates show replaced knowledge.',
    ...lines,
  ] };
}

function build(space, t = now()) {
  const promises = require('./promises').ledger(space);
  const day = require('./calendar').day(space, planner.local(t).date);
  const drift = require('./keepintouch').drifting(space, t);
  const dates = require('./dates');
  const soon = dates.upcoming(space, 7, t);
  const waiting = require('./review').openCount(space);
  const problems = require('./views').health(space).filter(h => h.level === 'bad');
  const sections = [previousDay(space, t)];
  const add = (title, lines) => { if (lines.length) sections.push({ title, lines }); };
  const due = p => (p.due ? ` (due ${p.due_label}${p.overdue ? ', overdue' : ''})` : '');
  add(`You owe (${promises.mine.length})`, promises.mine.slice(0, 6).map(p => `${p.action.charAt(0).toUpperCase()}${p.action.slice(1)}${p.who ? `, to ${p.person_name || p.who}` : ''}${due(p)}`));
  add(`Owed to you (${promises.owed.length})`, promises.owed.slice(0, 6).map(p => `${p.person_name || p.who || 'Someone'} will ${p.action}${due(p)}`));
  add('Today', day.items.filter(i => i.end > t).slice(0, 10).map(i => `${clock(i.start)} ${i.title}${i.type === 'task' ? ' (task)' : ''}`));
  add('Meeting prep', require('./meetings').today(space, t).flatMap(e => e.lines.map(l => `${e.title}: ${l.text}`)).slice(0, 6));
  add('Drifting', drift.slice(0, 6).map(d => `${d.person.name}: last in touch ${Math.round(d.sinceDays / 7)} weeks ago`));
  add('Dates this week', soon.slice(0, 6).map(d => `${dates.label(d)}: ${d.statement}`));
  add('Waiting for you', waiting ? [`${waiting} in Who is this?`] : []);
  add('Not working', problems.slice(0, 5).map(h => h.text));
  const name = space === 'work' ? 'Work' : 'Personal';
  const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: planner.TZ, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  const dateLine = `${part.weekday} ${part.day} ${part.month}`;
  const counts = [sections[0].lines.some(l => l.links) && 'CRM knowledge briefing', promises.mine.length && `${promises.mine.length} you owe`, promises.owed.length && `${promises.owed.length} owed to you`, drift.length && `${drift.length} drifting`].filter(Boolean).join(', ');
  const link = `${baseUrl()}/crm/${space}`;
  return {
    empty: sections[0].empty && sections.length === 1,
    subject: `${name}, ${dateLine}${counts ? `: ${counts}` : ': nothing waiting'}`,
    text: [...sections.map(s => `${s.title}\n${s.lines.map(l => `- ${typeof l === 'string' ? l : `${l.text} — ${l.links.map(a => `${a.label}: ${a.url}`).join(' | ')}`}`).join('\n')}`), `Today: ${link}`].join('\n\n'),
    html: `<div style="font:15px/22px system-ui,sans-serif;color:#1f201d;max-width:560px">${sections.map(s => `<p style="margin:0 0 4px;font-weight:600">${esc(s.title)}</p><ul style="margin:0 0 16px;padding-left:20px">${s.lines.map(l => `<li>${typeof l === 'string' ? esc(l) : `${esc(l.text)} — ${l.links.map(a => `<a href="${esc(a.url)}">${esc(a.label)}</a>`).join(' | ')}`}</li>`).join('')}</ul>`).join('')}<p><a href="${link}">Open ${name} Today</a></p></div>`,
  };
}

// A two-part (plain and HTML) message as Gmail's API wants it. Written out by
// hand because the mail library's composer is not part of its public interface.
function mime({ from, to, subject, text, html }) {
  const boundary = `hub-${uuid()}`;
  const b64 = v => Buffer.from(v, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const part = (type, body) => `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(body)}\r\n`;
  return [`From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`, '', part('text/plain', text) + part('text/html', html) + `--${boundary}--`].join('\r\n');
}

// Sent through the Gmail API on the Hub's own Google connection: the VPS
// cannot reach Gmail's SMTP port, so the app-password route times out.
function transport() {
  const user = require('./config').personalAddresses()[0];
  const gmail = require('./google').gmail();
  return { user, mailer: { sendMail: async message => {
    const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: Buffer.from(mime(message), 'utf8').toString('base64url') } }, { timeout: 30000, retry: false });
    return { messageId: data.id };
  } } };
}

// Both spaces go to Douglas's own mailbox: nothing from the CRM is sent into the work mail system.
async function send(space, { t = now(), mail } = {}) {
  const local = planner.local(t);
  if (space === 'work' && local.weekend) return { skipped: 'weekend' };
  if (setting(`digest_sent:${space}`) === local.date) return { skipped: 'already sent' };
  if (local.minutes > TOO_LATE) return { skipped: 'too late in the day' };
  const message = build(space, t);
  const id = uuid();
  const { user, mailer } = mail || transport();
  crm().prepare("INSERT INTO effects (id, module, entity_id, operation, request, status) VALUES (?, 'crm_morning_digest', ?, 'email.send', ?, 'started')")
    .run(id, space, JSON.stringify({ to: user, subject: message.subject }));
  // Marked before sending: a second email is worse than a missed one.
  setSetting(`digest_sent:${space}`, local.date);
  try {
    const info = await mailer.sendMail({ from: `"Hub" <${user}>`, to: user, subject: message.subject, text: message.text, html: message.html });
    crm().prepare("UPDATE effects SET status = 'done', result = ?, finished_at = ? WHERE id = ?").run(JSON.stringify({ messageId: info?.messageId || '' }), now(), id);
    return { sent: message.subject };
  } catch (err) {
    crm().prepare("UPDATE effects SET status = 'uncertain', result = ?, finished_at = ? WHERE id = ?").run(String(err.message).slice(0, 500), now(), id);
    throw new Error(`${space === 'work' ? 'Work' : 'Personal'} morning email: ${err.message}`);
  }
}

async function run(opts = {}) {
  return runs.track('morning_digest', async () => {
    const detail = {}, errors = [];
    for (const space of ['work', 'personal']) {
      try { detail[space] = await send(space, opts); } catch (err) { errors.push(err.message); }
    }
    if (errors.length) throw new Error(errors.join('; '));
    return detail;
  });
}

function nextRun() { return require('../flights').epochAtNextDublin(...SEND_AT); }

module.exports = { build, send, run, nextRun, mime, transport, previousDay };
