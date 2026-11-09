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

function build(space, t = now()) {
  const promises = require('./promises').ledger(space);
  const day = require('./calendar').day(space, planner.local(t).date);
  const drift = require('./keepintouch').drifting(space, t);
  const dates = require('./dates');
  const soon = dates.upcoming(space, 7, t);
  const waiting = require('./review').openCount(space);
  const problems = require('./views').health(space).filter(h => h.level === 'bad');
  const sections = [];
  const add = (title, lines) => { if (lines.length) sections.push({ title, lines }); };
  const due = p => (p.due ? ` (due ${p.due_label}${p.overdue ? ', overdue' : ''})` : '');
  add(`You owe (${promises.mine.length})`, promises.mine.slice(0, 6).map(p => `${p.action.charAt(0).toUpperCase()}${p.action.slice(1)}${p.who ? `, to ${p.person_name || p.who}` : ''}${due(p)}`));
  add(`Owed to you (${promises.owed.length})`, promises.owed.slice(0, 6).map(p => `${p.person_name || p.who || 'Someone'} will ${p.action}${due(p)}`));
  add('Today', day.items.filter(i => i.end > t).slice(0, 10).map(i => `${clock(i.start)} ${i.title}${i.type === 'task' ? ' (task)' : ''}`));
  add('Drifting', drift.slice(0, 6).map(d => `${d.person.name}: last in touch ${Math.round(d.sinceDays / 7)} weeks ago`));
  add('Dates this week', soon.slice(0, 6).map(d => `${dates.label(d)}: ${d.statement}`));
  add('Waiting for you', waiting ? [`${waiting} in Who is this?`] : []);
  add('Not working', problems.slice(0, 5).map(h => h.text));
  const name = space === 'work' ? 'Work' : 'Personal';
  const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: planner.TZ, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  const dateLine = `${part.weekday} ${part.day} ${part.month}`;
  const counts = [promises.mine.length && `${promises.mine.length} you owe`, promises.owed.length && `${promises.owed.length} owed to you`, drift.length && `${drift.length} drifting`].filter(Boolean).join(', ');
  const link = `${baseUrl()}/crm/${space}`;
  return {
    empty: !sections.length,
    subject: `${name}, ${dateLine}${counts ? `: ${counts}` : ': nothing waiting'}`,
    text: [...sections.map(s => `${s.title}\n${s.lines.map(l => `- ${l}`).join('\n')}`), `Today: ${link}`].join('\n\n'),
    html: `<div style="font:15px/22px system-ui,sans-serif;color:#1f201d;max-width:560px">${sections.map(s => `<p style="margin:0 0 4px;font-weight:600">${esc(s.title)}</p><ul style="margin:0 0 16px;padding-left:20px">${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')}<p><a href="${link}">Open ${name} Today</a></p></div>`,
  };
}

function transport() {
  const user = process.env.GMAIL_SMTP_USER, pass = process.env.GMAIL_SMTP_APP_PASSWORD;
  if (!user || !pass) throw new Error('Morning email has no mail account set (GMAIL_SMTP_USER)');
  return { user, mailer: require('nodemailer').createTransport({ service: 'gmail', auth: { user, pass } }) };
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

module.exports = { build, send, run, nextRun };
