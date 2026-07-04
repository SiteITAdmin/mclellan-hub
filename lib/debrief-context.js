'use strict';

const db = require('./db');
const { fetchTodayCalendarEvents } = require('./crm');

const TZ = 'Europe/London';

function todayUnixRange() {
  const todayIso = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
  const [y, m, d] = todayIso.split('-').map(Number);
  const start = Math.floor(new Date(y, m - 1, d, 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000);
  return { start, end, todayIso };
}

function section(title, lines) {
  if (!lines.length) return null;
  return `## ${title}\n${lines.join('\n')}`;
}

// Builds the grounding block for the debrief interviewer: what actually
// happened today according to the hub — calendar, work emails forwarded to
// AgentMail, Gmail traffic, active work-radar atoms, and tasks due soon.
async function buildDebriefContext(user) {
  const hub = db.hub();
  const { start, end } = todayUnixRange();

  let events = [];
  try { events = await fetchTodayCalendarEvents(user); } catch (_) {}

  const agentmail = hub.prepare(`
    SELECT subject, from_name, summary FROM inbound_email_records
    WHERE user = ? AND source = 'agentmail' AND received_at BETWEEN ? AND ?
    ORDER BY received_at DESC LIMIT 10
  `).all(user, start, end);

  const emails = hub.prepare(`
    SELECT subject, from_name, direction, summary FROM email_summaries
    WHERE user = ? AND received_at BETWEEN ? AND ?
    ORDER BY received_at DESC LIMIT 10
  `).all(user, start, end);

  const radar = hub.prepare(`
    SELECT value FROM knowledge_atoms
    WHERE user = ? AND status = 'active' AND subject_label = 'work radar'
    ORDER BY updated_at DESC LIMIT 10
  `).all(user);

  const todayAtoms = hub.prepare(`
    SELECT subject_label, predicate, value FROM knowledge_atoms
    WHERE user = ? AND status = 'active' AND subject_label != 'work radar'
      AND updated_at BETWEEN ? AND ?
    ORDER BY updated_at DESC LIMIT 10
  `).all(user, start, end);

  const tasks = hub.prepare(`
    SELECT title, due FROM google_tasks
    WHERE user = ? AND status = 'needsAction' AND deleted_at IS NULL
      AND due IS NOT NULL AND date(due) <= date('now', '+3 days')
    ORDER BY due LIMIT 10
  `).all(user);

  const sections = [
    section("Today's calendar", events.map(ev =>
      `- ${ev.time ? ev.time + ' ' : ''}${ev.summary}`)),
    section('Work emails forwarded to the hub today', agentmail.map(r =>
      `- ${r.subject}${r.summary ? ` — ${String(r.summary).slice(0, 160)}` : ''}`)),
    section('Other email today', emails.map(r =>
      `- [${r.direction === 'sent' ? 'sent' : 'received'}] ${r.subject}${r.from_name ? ` (${r.from_name})` : ''}`)),
    section('Active work topics (radar)', radar.map(r =>
      `- ${String(r.value).slice(0, 160)}`)),
    section('Knowledge updated today', todayAtoms.map(r =>
      `- ${r.subject_label}: ${String(r.value).slice(0, 160)}`)),
    section('Open tasks due in the next 3 days', tasks.map(r =>
      `- ${r.title}${r.due ? ` (due ${String(r.due).slice(0, 10)})` : ''}`)),
  ].filter(Boolean);

  const contextText = sections.length
    ? sections.join('\n\n')
    : 'No calendar events, emails or work items were recorded today — ask him to walk through the day from the start.';

  return { contextText, events };
}

module.exports = { buildDebriefContext };
