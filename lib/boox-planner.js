'use strict';

/**
 * Boox reference planner — a navigable PDF of the live Hub, built for a 13.3"
 * Onyx e-ink tablet.
 *
 * Why a separate artifact from `print-today`: an e-ink device keeps handwriting
 * in a layer keyed to the file it was drawn on, so a document that is
 * regenerated every night is not a safe writing surface. This planner is
 * therefore explicitly read-only — the thing you tap through, not the thing you
 * write on (a normal Boox notebook stays the writing surface, and comes back
 * through the Boox → Drive ingest path). That split is the whole reason the
 * pages can be rebuilt nightly without ever destroying a note.
 *
 * It is a derived view over the same live sources the planner screen uses
 * (Google Tasks mirror, live Calendar, compiled project atoms). It stores no
 * planner state of its own and creates nothing: everything on a page already
 * exists somewhere in the Hub, and every row links back to the screen that owns
 * it. Do not give this module a table.
 *
 * Page geometry matches the Note Max panel (4:3) so the PDF fills the screen
 * rather than letterboxing.
 */

const { addIsoDays, TIME_ZONE } = require('./task-calendar-planner');
const { splitDayEvents } = require('./task-planner-pdf');
const { hubBaseUrl } = require('./consigliere-links');

const DEFAULT_DAYS = 90;

// Onyx Note Max: 13.3" 4:3 panel. Full-bleed at these dimensions.
const PAGE_SIZES = {
  portrait: { width: '7.98in', height: '10.64in' },
  landscape: { width: '10.64in', height: '7.98in' },
};

// Page-fill caps. A reference page that overflows would spill into an unstyled
// extra page and break the fixed layout, so each list is bounded here and says
// how many rows it did not show.
const LIMITS = {
  daySchedule: 16,
  dayDue: 10,
  monthCell: 3,
  weekColumn: 9,
  indexRows: 18,
  projectPages: 40,
  projectTasks: 14,
  projectAtoms: 8,
  peopleTasks: 4,
  meetingNotes: 60,
  adhocNotes: 20,
};

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function isoToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TIME_ZONE });
}

function dateValue(date) {
  return new Date(`${date}T12:00:00Z`);
}

function fmt(date, options) {
  return new Intl.DateTimeFormat('en-IE', { ...options, timeZone: 'UTC' }).format(dateValue(date));
}

function monthKey(date) {
  return date.slice(0, 7);
}

// ISO weeks start Monday; the Hub's week views do too.
function mondayOf(date) {
  const value = dateValue(date);
  const weekday = (value.getUTCDay() + 6) % 7;
  return addIsoDays(date, -weekday);
}

function dueDateOf(task) {
  return task?.effective_due || (task?.due ? String(task.due).slice(0, 10) : null);
}

function taskIsOverdue(task, today) {
  if (typeof task?.is_overdue === 'boolean') return task.is_overdue;
  const due = dueDateOf(task);
  return Boolean(due && due < today);
}

function taskUrl(base, task) {
  return `${base}/crm/tasks/${encodeURIComponent(task.id)}`;
}

function eventTimeLabel(event) {
  if (event.allDay) return 'All day';
  return event.endTime ? `${event.time}–${event.endTime}` : (event.time || '');
}

// ── Data assembly ────────────────────────────────────────────────────────────
// Pure: everything it needs is passed in, so the model can be built and
// inspected without Google or the database.

function assemblePlannerModel({
  snapshot,
  today = isoToday(),
  projects = [],
  atomsByProjectId = new Map(),
  contactsByEmail = new Map(),
  adhocNotePages = LIMITS.adhocNotes,
  baseUrl = hubBaseUrl(),
  generatedAt = new Date(),
  orientation = 'portrait',
}) {
  if (!snapshot) throw new Error('Planner snapshot is required');
  const startDate = snapshot.startDate;
  const endDate = snapshot.endDate;
  const dayCount = (snapshot.days || []).length;
  const openTasks = (snapshot.tasks || []).filter(task => task.status === 'needsAction' && !task.deleted_at);
  const mine = openTasks.filter(task => !task.assignee);
  const assigned = openTasks.filter(task => task.assignee);

  const scheduledTaskIds = new Set(
    (snapshot.events || []).filter(event => event.taskId).map(event => event.taskId)
  );

  const days = (snapshot.days || []).map(day => {
    const { calendarEvents, tasks } = splitDayEvents(snapshot, day.date);
    const due = mine
      .filter(task => dueDateOf(task) === day.date && !scheduledTaskIds.has(task.id))
      .sort((a, b) => (({ high: 0, medium: 1, low: 2 })[a.priority] ?? 3) - (({ high: 0, medium: 1, low: 2 })[b.priority] ?? 3));
    const overdue = day.date === today
      ? mine.filter(task => {
        return taskIsOverdue(task, today) && !scheduledTaskIds.has(task.id);
      })
      : [];
    return {
      ...day,
      calendarEvents,
      taskBlocks: tasks,
      due,
      overdue,
      isToday: day.date === today,
      isPast: day.date < today,
      weekday: fmt(day.date, { weekday: 'long' }),
      longLabel: fmt(day.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      shortLabel: fmt(day.date, { weekday: 'short', day: 'numeric', month: 'short' }),
      count: calendarEvents.length + tasks.length + due.length,
    };
  });
  const dayByDate = new Map(days.map(day => [day.date, day]));

  const months = [];
  for (const day of days) {
    const key = monthKey(day.date);
    if (!months.some(month => month.key === key)) {
      months.push({
        key,
        label: fmt(`${key}-01`, { month: 'long', year: 'numeric' }),
        shortLabel: fmt(`${key}-01`, { month: 'short' }),
        weeks: [],
      });
    }
  }
  for (const month of months) {
    const first = `${month.key}-01`;
    const daysInMonth = new Date(Date.UTC(Number(month.key.slice(0, 4)), Number(month.key.slice(5, 7)), 0)).getUTCDate();
    let cursor = mondayOf(first);
    const last = `${month.key}-${String(daysInMonth).padStart(2, '0')}`;
    while (cursor <= last) {
      month.weeks.push(Array.from({ length: 7 }, (_, index) => {
        const date = addIsoDays(cursor, index);
        return {
          date,
          dayNumber: Number(date.slice(8, 10)),
          inMonth: monthKey(date) === month.key,
          day: dayByDate.get(date) || null,
        };
      }));
      cursor = addIsoDays(cursor, 7);
    }
  }

  const weeks = [];
  for (const day of days) {
    const start = mondayOf(day.date);
    if (!weeks.some(week => week.start === start)) {
      const columns = Array.from({ length: 7 }, (_, index) => {
        const date = addIsoDays(start, index);
        return { date, day: dayByDate.get(date) || null, label: fmt(date, { weekday: 'short', day: 'numeric' }) };
      });
      weeks.push({
        start,
        end: addIsoDays(start, 6),
        label: `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(addIsoDays(start, 6), { day: 'numeric', month: 'short', year: 'numeric' })}`,
        columns,
      });
    }
  }

  const byDueThenPriority = (a, b) => String(dueDateOf(a) || '9999-12-31').localeCompare(String(dueDateOf(b) || '9999-12-31'))
    || (({ high: 0, medium: 1, low: 2 })[a.priority] ?? 3) - (({ high: 0, medium: 1, low: 2 })[b.priority] ?? 3);
  const open = [...mine].sort(byDueThenPriority);
  // Every dashboard number must have a page to land on, so the time-blocked
  // count is a real list of blocks, not just a tally of events.
  const blocked = days
    .flatMap(day => day.taskBlocks.map(event => ({ ...(event.task || {}), id: event.task?.id || event.taskId, blockDate: day.date, blockTime: eventTimeLabel(event), isLate: event.isLate })))
    .filter(entry => entry.id);
  const inbox = (snapshot.unscheduledTasks || []).map(task => ({ ...task, dueDate: dueDateOf(task) }));
  const overdueAll = mine
    .filter(task => {
      return taskIsOverdue(task, today) && !scheduledTaskIds.has(task.id);
    })
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));

  const projectPages = projects.slice(0, LIMITS.projectPages).map(project => {
    const tasks = mine.filter(task => task.project_slug === project.slug);
    const atoms = (atomsByProjectId.get(project.id) || []).slice(0, LIMITS.projectAtoms);
    const nextDue = tasks.map(dueDateOf).filter(Boolean).sort()[0] || null;
    return { ...project, tasks, atoms, openCount: tasks.length, nextDue };
  }).sort((a, b) => b.openCount - a.openCount || String(a.name).localeCompare(String(b.name)));

  // Note pages exist for genuine appointments only. A task block is already a
  // task with its own record — writing "notes" against one would be inventing a
  // second place for something the Hub already owns.
  const meetingNotes = days
    .flatMap(day => day.calendarEvents
      .filter(event => !event.allDay && !event.isTask)
      .map(event => ({
        id: event.id,
        noteId: `n-${String(event.id).replace(/[^A-Za-z0-9_-]/g, '')}`,
        date: day.date,
        dayLabel: day.longLabel,
        title: event.title,
        location: event.location,
        time: eventTimeLabel(event),
        attendees: (event.attendees || []).map(attendee => {
          const known = contactsByEmail.get(String(attendee.email || '').toLowerCase()) || null;
          return {
            name: attendee.name || known?.name || attendee.email,
            email: attendee.email,
            contact: known,
            openCount: known ? mine.filter(task => task.contact_id === known.id).length : 0,
          };
        }),
      })))
    .slice(0, LIMITS.meetingNotes);

  const peopleByKey = new Map();
  for (const task of mine) {
    if (!task.contact_id && !task.company_id) continue;
    const key = task.contact_id ? `c:${task.contact_id}` : `co:${task.company_id}`;
    if (!peopleByKey.has(key)) {
      peopleByKey.set(key, {
        key,
        name: task.contact_name || task.company_name,
        kind: task.contact_id ? 'contact' : 'company',
        url: task.contact_id
          ? `${baseUrl}/crm/contacts/${encodeURIComponent(task.contact_id)}`
          : `${baseUrl}/crm/companies/${encodeURIComponent(task.company_id)}`,
        tasks: [],
      });
    }
    peopleByKey.get(key).tasks.push(task);
  }
  const people = [...peopleByKey.values()]
    .map(person => ({
      ...person,
      openCount: person.tasks.length,
      nextDue: person.tasks.map(dueDateOf).filter(Boolean).sort()[0] || null,
    }))
    .sort((a, b) => b.openCount - a.openCount || String(a.name).localeCompare(String(b.name)));

  return {
    orientation: PAGE_SIZES[orientation] ? orientation : 'portrait',
    baseUrl,
    today,
    todayLabel: fmt(today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    startDate,
    endDate,
    dayCount,
    days,
    months,
    weeks,
    inbox,
    open,
    blocked,
    meetingNotes,
    noteIdByEvent: new Map(meetingNotes.map(meeting => [meeting.id, meeting.noteId])),
    adhocNotes: Array.from({ length: Math.max(0, adhocNotePages) }, (_, index) => index + 1),
    overdue: overdueAll,
    assigned,
    projects: projectPages,
    people,
    counts: {
      open: open.length,
      scheduled: blocked.length,
      inbox: inbox.length,
      overdue: overdueAll.length,
      assigned: assigned.length,
      projects: projectPages.length,
      people: people.length,
      meetingNotes: meetingNotes.length,
    },
    generatedLabel: new Intl.DateTimeFormat('en-IE', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: TIME_ZONE,
    }).format(generatedAt),
  };
}


// ── Rendering ────────────────────────────────────────────────────────────────
// Chrome's PDF export preserves in-document anchors as named destinations and
// http links as URI actions, which is what makes the tab rail and every day
// cell tappable on the device. Verified against pdfjs annotations before this
// was built; keep hrefs as plain `#id` / absolute URLs rather than JS handlers.

function plannerCss(orientation) {
  const size = PAGE_SIZES[orientation] || PAGE_SIZES.portrait;
  return `
@page { size: ${size.width} ${size.height}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000;
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10pt; }
a { color: #000; text-decoration: none; }
.page { position: relative; width: ${size.width}; height: ${size.height};
  padding: 0.34in 0.78in 0.34in 0.4in; page-break-after: always; overflow: hidden; }
.body { position: absolute; left: 0.4in; right: 0.78in; top: 1.42in; bottom: 0.42in; overflow: hidden; }
.page:last-child { page-break-after: auto; }
.nav { display: flex; gap: 0.06in; border-bottom: 2px solid #000; padding-bottom: 0.06in; }
.nav a { flex: 1; text-align: center; padding: 0.07in 0.02in; font-size: 8.5pt;
  font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; border: 1px solid #000; }
.nav a.on { background: #000; color: #fff; }
.head { display: flex; align-items: flex-end; justify-content: space-between; margin: 0.14in 0 0.1in; }
.head h1 { margin: 0; font-size: 19pt; line-height: 1.05; }
.head .kicker { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.09em; color: #444; }
.head .meta { font-size: 9pt; color: #333; text-align: right; }
.rail { position: absolute; top: 0.34in; right: 0.16in; width: 0.5in;
  display: flex; flex-direction: column; gap: 0.035in; }
.rail a { display: block; border: 1px solid #000; text-align: center; padding: 0.05in 0;
  font-size: 7.5pt; font-weight: 600; text-transform: uppercase; }
.rail a.on { background: #000; color: #fff; }
.rail a.jump { border-style: dashed; }
.foot { position: absolute; left: 0.4in; right: 0.78in; bottom: 0.16in;
  display: flex; justify-content: space-between; font-size: 7.5pt; color: #444;
  border-top: 1px solid #999; padding-top: 0.05in; }
.cols { display: flex; gap: 0.24in; height: 100%; }
.col-main, .col-side { display: flex; flex-direction: column; }
.col-main { flex: 1.55; min-width: 0; }
.col-side { flex: 1; min-width: 0; }
h2.sec { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em;
  margin: 0 0 0.06in; padding-bottom: 0.03in; border-bottom: 1px solid #000; }
.row { display: flex; gap: 0.1in; border-bottom: 1px solid #ccc; padding: 0.055in 0; min-height: 0.3in; }
.row .when { width: 0.86in; flex: none; font-size: 8.5pt; font-weight: 500; }
.row .what { flex: 1; min-width: 0; }
.row .what .t { font-size: 10.5pt; font-weight: 400; line-height: 1.25; }
.row .what .s { font-size: 8pt; color: #444; margin-top: 0.01in; }
.row.task .what .t::before { content: "\\25A2\\00A0\\00A0"; }
.row.late { border-left: 3px solid #000; padding-left: 0.06in; }
.badge { display: inline-block; border: 1px solid #000; padding: 0 0.04in; font-size: 7pt;
  font-weight: 600; text-transform: uppercase; margin-left: 0.05in; vertical-align: 1px; }
.badge.solid { background: #000; color: #fff; }
.empty { font-size: 9pt; color: #555; padding: 0.08in 0; }
.more { font-size: 8pt; color: #444; padding-top: 0.05in; }
table.month { width: 100%; height: 100%; border-collapse: collapse; table-layout: fixed; }
table.month th { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em;
  border-bottom: 1px solid #000; padding-bottom: 0.03in; }
table.month td { border: 1px solid #bbb; vertical-align: top; padding: 0.03in; }
table.month td.out { background: #ededed; }
table.month td.off { background: #fafafa; }
table.month td.off .n { color: #999; }
table.month td.today { border: 2px solid #000; }
table.month .n { font-size: 9.5pt; font-weight: 600; }
table.month .n .c { float: right; font-size: 7.5pt; font-weight: 400; color: #444; }
table.month .i { font-size: 7pt; line-height: 1.25; margin-top: 0.02in;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.week { display: flex; gap: 0.06in; height: 100%; }
.week .wd { flex: 1; min-width: 0; border: 1px solid #bbb; padding: 0.05in; overflow: hidden; }
.week .wd.today { border: 2px solid #000; }
.week .wd h3 { margin: 0 0 0.04in; font-size: 8.5pt; font-weight: 600; border-bottom: 1px solid #000; padding-bottom: 0.02in; }
.week .wd .i { font-size: 7pt; line-height: 1.3; margin-bottom: 0.035in; }
.week .wd .i b { display: block; font-weight: 500; }
.stats { display: flex; gap: 0.1in; margin: 0.12in 0; }
.stats a { flex: 1; border: 1px solid #000; padding: 0.07in; text-align: center; }
.stats .v { font-size: 18pt; font-weight: 600; line-height: 1; }
.stats .l { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #333; margin-top: 0.03in; }
.atoms li { font-size: 8.5pt; margin-bottom: 0.04in; line-height: 1.35; }
.atoms li b { font-weight: 600; }
.atoms { margin: 0.04in 0 0 0.16in; padding: 0; }
.note { font-size: 8pt; color: #444; margin-top: 0.06in; line-height: 1.3; }
/* A dot grid rather than rules: it guides handwriting without fighting a
   diagram or a list drawn over it. */
.write { flex: 1; min-height: 2in; border: 1px solid #999; margin-top: 0.08in;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Ccircle cx='7' cy='7' r='0.6' fill='%23c4c4c4'/%3E%3C/svg%3E"); }
.write.full { height: 100%; margin-top: 0; }
.note-head { display: flex; gap: 0.16in; border-bottom: 1px solid #000; padding-bottom: 0.06in; }
.note-head .who { flex: 1; font-size: 8.5pt; line-height: 1.4; }
.note-head .when { width: 1.9in; flex: none; font-size: 8.5pt; line-height: 1.4; }
.note-title { border-bottom: 1px solid #999; height: 0.34in; margin-bottom: 0.06in; }
.subnav { display: flex; flex-wrap: wrap; gap: 0.05in; margin-bottom: 0.1in; }
.subnav a { border: 1px solid #999; padding: 0.035in 0.07in; font-size: 8pt; }
.subnav a.on { border-color: #000; background: #000; color: #fff; }
.parts { margin: 0 0 0.08in; font-size: 8pt; color: #444; }
.parts a { border: 1px solid #000; color: #000; padding: 0.01in 0.06in; margin-left: 0.04in; }
.parts a.on { background: #000; color: #fff; }
`;
}

function navHtml(model, active) {
  // Every nav target must be a page that exists — there is no back button on a
  // PDF, so a dead tab is a dead end. "Weeks" lands on the current week.
  const items = [
    ['today', 'Today', 'today'],
    ['weeks', 'Week', `w-${mondayOf(model.today)}`],
    ['months', 'Month', `m-${monthKey(model.today)}`],
    ['tasks', 'Tasks', 't-open'],
    ['projects', 'Projects', 'projects'],
    ['people', 'People', 'people'],
    ['notes', 'Notes', 'notes'],
  ];
  const links = items.map(([key, label, target]) =>
    `<a href="#${target}" class="${active === key ? 'on' : ''}">${label}</a>`).join('');
  return `<div class="nav">${links}<a href="${escHtml(model.baseUrl)}/crm/planner">Open Hub</a></div>`;
}

function railHtml(model, activeMonthKey) {
  const tabs = model.months.map(month =>
    `<a href="#m-${month.key}" class="${month.key === activeMonthKey ? 'on' : ''}">${escHtml(month.shortLabel)}</a>`).join('');
  return `<div class="rail">${tabs}<a href="#today" class="jump">Now</a></div>`;
}

function pageHtml(model, { id, kicker, title, meta, active, activeMonthKey, footLeft, body }) {
  return `<section class="page"${id ? ` id="${id}"` : ''}>
${navHtml(model, active)}
${railHtml(model, activeMonthKey)}
<div class="head">
  <div><div class="kicker">${escHtml(kicker || '')}</div><h1>${escHtml(title)}</h1></div>
  <div class="meta">${meta || ''}</div>
</div>
<div class="body">${body}</div>
<div class="foot"><span>${escHtml(footLeft || `McLellan Hub · planner for ${model.today}`)}</span><span>Built ${escHtml(model.generatedLabel)} Dublin</span></div>
</section>`;
}

function eventRowHtml(model, event) {
  const task = event.isTask ? event.task : null;
  const late = event.isLate ? '<span class="badge">Late</span>' : '';
  // A task block reads as its title and nothing else: the lane, project and
  // person tags are Hub routing metadata, not something Douglas needs on the
  // page (they are one tap away on the linked task). Appointments keep their
  // own context line.
  const sub = task
    ? ''
    : [event.location, event.allDay ? null : 'Appointment'].filter(Boolean).join(' · ');
  const title = escHtml(event.title || '(untitled)');
  const noteId = task ? null : model.noteIdByEvent?.get(event.id);
  const notes = noteId ? ` <a href="#${noteId}" class="badge">Notes</a>` : '';
  const inner = `<div class="what"><div class="t">${task ? `<a href="${escHtml(taskUrl(model.baseUrl, task))}">${title}</a>` : title}${late}${notes}</div>${sub ? `<div class="s">${escHtml(sub)}</div>` : ''}</div>`;
  return `<div class="row ${task ? 'task' : ''} ${event.isLate ? 'late' : ''}"><div class="when">${escHtml(eventTimeLabel(event))}</div>${inner}</div>`;
}

function taskRowHtml(model, task, { when = null, showAssignee = false } = {}) {
  // Title only, same reason as eventRowHtml. The one exception is the
  // "Assigned to others" section, where the person IS the row's meaning.
  const bits = showAssignee && task.assignee ? `with ${task.assignee}` : '';
  const due = when === null ? (dueDateOf(task) ? fmt(dueDateOf(task), { day: 'numeric', month: 'short' }) : '—') : when;
  const overdue = taskIsOverdue(task, model.today) ? '<span class="badge">Overdue</span>' : '';
  return `<div class="row task"><div class="when">${escHtml(due)}</div><div class="what"><div class="t"><a href="${escHtml(taskUrl(model.baseUrl, task))}">${escHtml(task.title || '(untitled)')}</a>${overdue}</div>${bits ? `<div class="s">${escHtml(bits)}</div>` : ''}</div></div>`;
}

function listOrEmpty(items, emptyText, total = null) {
  if (!items.length) return `<div class="empty">${escHtml(emptyText)}</div>`;
  const extra = total !== null && total > items.length
    ? `<div class="more">+ ${total - items.length} more in the Hub</div>` : '';
  return items.join('') + extra;
}

function coverPage(model) {
  const day = model.days.find(d => d.date === model.today) || model.days[0];
  const schedule = day ? [...day.calendarEvents, ...day.taskBlocks]
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.time || '').localeCompare(String(b.time || '')))
    : [];
  const shown = schedule.slice(0, LIMITS.daySchedule);
  const focus = [...(day?.overdue || []), ...(day?.due || [])].slice(0, LIMITS.dayDue);
  const body = `
<div class="stats">
  ${[
    ['t-open', model.counts.open, 'Open tasks'],
    ['t-blocked', model.counts.scheduled, 'Time-blocked'],
    ['t-overdue', model.counts.overdue, 'Overdue'],
    ['t-unplanned', model.counts.inbox, 'Unplanned'],
    ['projects', model.counts.projects, 'Live projects'],
  ].map(([target, value, label]) => `<a href="#${target}"><div class="v">${value}</div><div class="l">${label}</div></a>`).join('')}
</div>
<div class="cols">
  <div class="col-main">
    <h2 class="sec">Today · ${escHtml(day ? day.longLabel : model.todayLabel)}</h2>
    ${listOrEmpty(shown.map(event => eventRowHtml(model, event)), 'Nothing in the calendar today.', schedule.length)}
  </div>
  <div class="col-side">
    <h2 class="sec">Needs a decision</h2>
    ${listOrEmpty(focus.map(task => taskRowHtml(model, task)), 'Nothing due or overdue.', (day?.overdue.length || 0) + (day?.due.length || 0))}
    <div class="note">A snapshot, not a live screen: tap any title to open the real record in the Hub. This file is yours to write on — it is built once for ${escHtml(model.today)} and never rebuilt, so tomorrow's notes go in tomorrow's file. <a href="#notes">Note pages</a> are at the back.</div>
  </div>
</div>`;
  return pageHtml(model, {
    id: 'today',
    kicker: `${model.startDate} → ${model.endDate} · ${model.dayCount} days`,
    title: model.todayLabel,
    meta: `<b>McLellan Hub</b><br>Reference planner`,
    active: 'today',
    activeMonthKey: monthKey(model.today),
    body,
  });
}

function monthsIndexPage(model) {
  const rows = model.months.map(month => {
    const days = model.days.filter(day => monthKey(day.date) === month.key);
    const items = days.reduce((sum, day) => sum + day.count, 0);
    return `<div class="row"><div class="when"><a href="#m-${month.key}">${escHtml(month.shortLabel)}</a></div><div class="what"><div class="t"><a href="#m-${month.key}">${escHtml(month.label)}</a></div><div class="s">${days.length} days in range · ${items} scheduled item${items === 1 ? '' : 's'}</div></div></div>`;
  });
  const weekRows = model.weeks.map(week =>
    `<div class="row"><div class="when"><a href="#w-${week.start}">${escHtml(fmt(week.start, { day: 'numeric', month: 'short' }))}</a></div><div class="what"><div class="t"><a href="#w-${week.start}">Week of ${escHtml(week.label)}</a></div></div></div>`);
  const body = `<div class="cols">
  <div class="col-main"><h2 class="sec">Months</h2>${listOrEmpty(rows, 'No months in range.')}</div>
  <div class="col-side"><h2 class="sec">Weeks</h2>${listOrEmpty(weekRows.slice(0, 20), 'No weeks in range.', weekRows.length)}</div>
</div>`;
  return pageHtml(model, {
    id: 'months', kicker: 'Navigation', title: 'Months and weeks',
    meta: `${model.dayCount} days`, active: 'months', activeMonthKey: null, body,
  });
}

function monthPage(model, month) {
  const headers = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map(label => `<th>${label}</th>`).join('');
  const rows = month.weeks.map(week => `<tr>${week.map(cell => {
    const day = cell.day;
    const classes = [cell.inMonth ? (day ? '' : 'off') : 'out', day?.isToday ? 'today' : ''].filter(Boolean).join(' ');
    if (!day) {
      return `<td class="${classes}"><div class="n">${cell.dayNumber}</div></td>`;
    }
    const items = [...day.calendarEvents, ...day.taskBlocks].slice(0, LIMITS.monthCell)
      .map(event => `<div class="i">${escHtml(event.allDay ? '' : `${event.time} `)}${escHtml(event.title || '')}</div>`).join('');
    const extra = day.count > LIMITS.monthCell ? `<div class="i">+${day.count - LIMITS.monthCell} more</div>` : '';
    const dueMark = day.due.length ? `<span class="c">${day.due.length} due</span>` : '';
    return `<td class="${classes}"><a href="#d-${day.date}"><div class="n">${cell.dayNumber}${dueMark}</div>${items}${extra}</a></td>`;
  }).join('')}</tr>`).join('');
  const body = `<table class="month"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  return pageHtml(model, {
    id: `m-${month.key}`, kicker: 'Month', title: month.label,
    meta: 'Tap a day · <a href="#months">all months and weeks</a>',
    active: 'months', activeMonthKey: month.key, body,
  });
}

function weekPage(model, week) {
  const columns = week.columns.map(column => {
    const day = column.day;
    const items = day
      ? [...day.calendarEvents, ...day.taskBlocks].slice(0, LIMITS.weekColumn).map(event =>
        `<div class="i"><b>${escHtml(eventTimeLabel(event))}</b>${escHtml(event.title || '')}</div>`).join('')
      : '<div class="i">—</div>';
    const extra = day && day.count > LIMITS.weekColumn ? `<div class="i">+${day.count - LIMITS.weekColumn} more</div>` : '';
    const due = day && day.due.length ? `<div class="i"><b>Due</b>${escHtml(day.due.map(task => task.title).join(' · ').slice(0, 90))}</div>` : '';
    const heading = day
      ? `<a href="#d-${day.date}">${escHtml(column.label)}</a>`
      : escHtml(column.label);
    return `<div class="wd ${day?.isToday ? 'today' : ''}"><h3>${heading}</h3>${items}${extra}${due}</div>`;
  }).join('');
  return pageHtml(model, {
    id: `w-${week.start}`, kicker: 'Week', title: week.label,
    meta: `Tap a day · <a href="#months">all weeks</a>`,
    active: 'weeks', activeMonthKey: monthKey(week.start),
    body: `<div class="week">${columns}</div>`,
  });
}

function dayPage(model, day) {
  const schedule = [...day.calendarEvents, ...day.taskBlocks]
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || String(a.time || '').localeCompare(String(b.time || '')));
  const shown = schedule.slice(0, LIMITS.daySchedule);
  const due = [...day.overdue, ...day.due].slice(0, LIMITS.dayDue);
  const body = `<div class="cols">
  <div class="col-main">
    <h2 class="sec">Schedule</h2>
    ${listOrEmpty(shown.map(event => eventRowHtml(model, event)), 'Nothing scheduled.', schedule.length)}
  </div>
  <div class="col-side">
    <h2 class="sec">${day.overdue.length ? 'Overdue and due' : 'Due this day'}</h2>
    ${listOrEmpty(due.map(task => taskRowHtml(model, task)), 'Nothing due.', day.overdue.length + day.due.length)}
  </div>
</div>`;
  return pageHtml(model, {
    id: `d-${day.date}`, kicker: day.isToday ? 'Today' : day.weekday,
    title: day.longLabel,
    meta: `<a href="#w-${mondayOf(day.date)}">Week</a> · <a href="#m-${monthKey(day.date)}">Month</a>`,
    active: 'weeks', activeMonthKey: monthKey(day.date), body,
  });
}

// Nothing may be stranded: a section that spills onto a second page carries
// links to its own parts, and the task sections cross-link to each other.
function partsNav(idFor, count, current) {
  if (count < 2) return '';
  const links = Array.from({ length: count }, (_, index) =>
    `<a href="#${idFor(index)}" class="${index === current ? 'on' : ''}">${index + 1}</a>`).join('');
  return `<div class="parts">Pages ${links}</div>`;
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out.length ? out : [[]];
}

const TASK_SECTIONS = [
  { slug: 'open', heading: 'All open tasks', list: 'open' },
  { slug: 'overdue', heading: 'Overdue', list: 'overdue' },
  { slug: 'unplanned', heading: 'Unplanned · no time block', list: 'inbox' },
  { slug: 'blocked', heading: 'Time-blocked', list: 'blocked', blocks: true },
  { slug: 'assigned', heading: 'Assigned to others', list: 'assigned', assignees: true },
];

function taskSectionNav(model, active) {
  const links = TASK_SECTIONS.map(section =>
    `<a href="#t-${section.slug}" class="${section.slug === active ? 'on' : ''}">${escHtml(section.heading)} ${(model[section.list] || []).length}</a>`).join('');
  return `<div class="subnav">${links}</div>`;
}

function tasksPages(model) {
  const pages = [];
  for (const section of TASK_SECTIONS) {
    const items = model[section.list] || [];
    const groups = chunk(items, LIMITS.indexRows);
    const idFor = index => (index === 0 ? `t-${section.slug}` : `t-${section.slug}-${index + 1}`);
    groups.forEach((group, index) => {
      const rows = group.map(task => taskRowHtml(model, task, {
        showAssignee: Boolean(section.assignees),
        ...(section.blocks
          ? { when: `${fmt(task.blockDate, { day: 'numeric', month: 'short' })} ${String(task.blockTime || '').split('–')[0]}` }
          : {}),
      }));
      const body = `${taskSectionNav(model, section.slug)}<h2 class="sec">${escHtml(section.heading)}${groups.length > 1 ? ` · part ${index + 1} of ${groups.length}` : ''}</h2>${partsNav(idFor, groups.length, index)}
${listOrEmpty(rows, 'Nothing here — good.')}`;
      pages.push(pageHtml(model, {
        id: idFor(index),
        kicker: 'Tasks', title: section.heading,
        meta: `${items.length} task${items.length === 1 ? '' : 's'}`,
        active: 'tasks', activeMonthKey: null, body,
      }));
    });
  }
  return pages;
}

function projectsPages(model) {
  const groups = chunk(model.projects, LIMITS.indexRows);
  const index = groups.map((group, position) => {
    const rows = group.map(project =>
      `<div class="row"><div class="when">${project.openCount} open</div><div class="what"><div class="t"><a href="#p-${escHtml(project.slug)}">${escHtml(project.name)}</a></div><div class="s">${project.nextDue ? `Next due ${escHtml(fmt(project.nextDue, { day: 'numeric', month: 'short' }))}` : 'No dated work'}${project.atoms.length ? ` · ${project.atoms.length} known fact${project.atoms.length === 1 ? '' : 's'}` : ''}</div></div></div>`);
    return pageHtml(model, {
      id: position === 0 ? 'projects' : `projects-${position}`,
      kicker: 'Live projects', title: 'Projects',
      meta: `${model.projects.length} live`, active: 'projects', activeMonthKey: null,
      body: `<h2 class="sec">Live projects${groups.length > 1 ? ` · part ${position + 1} of ${groups.length}` : ''}</h2>${partsNav(index => (index === 0 ? 'projects' : `projects-${index}`), groups.length, position)}${listOrEmpty(rows, 'No live projects.')}`,
    });
  });
  const detail = model.projects.map(project => {
    const tasks = project.tasks.slice(0, LIMITS.projectTasks).map(task => taskRowHtml(model, task));
    const atoms = project.atoms.map(atom =>
      `<li><b>${escHtml(atom.predicate)}:</b> ${escHtml(String(atom.value).slice(0, 220))}</li>`).join('');
    const body = `<div class="cols">
  <div class="col-main"><h2 class="sec">Open work</h2>${listOrEmpty(tasks, 'No open tasks.', project.tasks.length)}</div>
  <div class="col-side">
    <h2 class="sec">What the Hub knows</h2>
    ${atoms ? `<ul class="atoms">${atoms}</ul>` : '<div class="empty">No compiled knowledge yet.</div>'}
    <div class="note">Compiled from source evidence by the knowledge engine, not typed in by hand.</div>
  </div>
</div>`;
    return pageHtml(model, {
      id: `p-${project.slug}`, kicker: 'Project', title: project.name,
      meta: `<a href="${escHtml(model.baseUrl)}/crm/projects/${encodeURIComponent(project.slug)}">Open in Hub</a>`,
      active: 'projects', activeMonthKey: null, body,
    });
  });
  return [...index, ...detail];
}

function peoplePages(model) {
  const groups = chunk(model.people, LIMITS.indexRows);
  return groups.map((group, position) => {
    const rows = group.map(person => {
      const titles = person.tasks.slice(0, LIMITS.peopleTasks).map(task => task.title).join(' · ');
      return `<div class="row"><div class="when">${person.openCount} open</div><div class="what"><div class="t"><a href="${escHtml(person.url)}">${escHtml(person.name)}</a>${person.kind === 'company' ? '<span class="badge">Org</span>' : ''}</div><div class="s">${person.nextDue ? `Next due ${escHtml(fmt(person.nextDue, { day: 'numeric', month: 'short' }))} · ` : ''}${escHtml(titles.slice(0, 150))}</div></div></div>`;
    });
    return pageHtml(model, {
      id: position === 0 ? 'people' : `people-${position}`,
      kicker: 'Open actions by person', title: 'People',
      meta: `${model.people.length} with open work`, active: 'people', activeMonthKey: null,
      body: `<h2 class="sec">Who you owe, and who owes you${groups.length > 1 ? ` · part ${position + 1} of ${groups.length}` : ''}</h2>${partsNav(index => (index === 0 ? 'people' : `people-${index}`), groups.length, position)}${listOrEmpty(rows, 'No open tasks are linked to a person or company.')}`,
    });
  });
}

function notesPages(model) {
  const meetingRows = model.meetingNotes.map(meeting =>
    `<div class="row"><div class="when">${escHtml(fmt(meeting.date, { day: 'numeric', month: 'short' }))} ${escHtml(String(meeting.time).split('–')[0])}</div><div class="what"><div class="t"><a href="#${meeting.noteId}">${escHtml(meeting.title)}</a></div>${meeting.attendees.length ? `<div class="s">${escHtml(meeting.attendees.map(person => person.name).join(', ').slice(0, 110))}</div>` : ''}</div></div>`);
  const adhocRows = model.adhocNotes.map(number =>
    `<div class="row"><div class="when"><a href="#note-${number}">${number}</a></div><div class="what"><div class="t"><a href="#note-${number}">Blank page ${number}</a></div></div></div>`);
  const index = pageHtml(model, {
    id: 'notes', kicker: 'Write here', title: 'Notes',
    meta: `${model.meetingNotes.length} meeting${model.meetingNotes.length === 1 ? '' : 's'} · ${model.adhocNotes.length} blank`,
    active: 'notes', activeMonthKey: null,
    body: `<div class="cols">
  <div class="col-main"><h2 class="sec">Meeting notes</h2>${listOrEmpty(meetingRows, 'No appointments in the window.')}</div>
  <div class="col-side"><h2 class="sec">Ad-hoc</h2>${listOrEmpty(adhocRows, 'No blank pages.')}
  <div class="note">Handwriting belongs to the file you wrote it in. Today's file is yours to write on; tomorrow's is a new one, so nothing you write is ever overwritten.</div></div>
</div>`,
  });

  const meetings = model.meetingNotes.map(meeting => {
    const attendees = meeting.attendees.length
      ? meeting.attendees.map(person => {
        const owed = person.openCount ? ` — ${person.openCount} open task${person.openCount === 1 ? '' : 's'}` : '';
        const name = person.contact
          ? `<a href="${escHtml(model.baseUrl)}/crm/contacts/${encodeURIComponent(person.contact.id)}">${escHtml(person.name)}</a>`
          : escHtml(person.name || '');
        return `${name}${escHtml(owed)}`;
      }).join(' · ')
      : 'No attendees listed.';
    return pageHtml(model, {
      id: meeting.noteId, kicker: 'Meeting notes', title: meeting.title,
      meta: `<a href="#d-${meeting.date}">Day</a> · <a href="#notes">All notes</a>`,
      active: 'notes', activeMonthKey: monthKey(meeting.date),
      body: `<div class="note-head">
  <div class="when"><b>${escHtml(meeting.dayLabel)}</b><br>${escHtml(meeting.time)}${meeting.location ? `<br>${escHtml(meeting.location)}` : ''}</div>
  <div class="who">${attendees}</div>
</div>
<div class="write" style="height: calc(100% - 0.9in)"></div>`,
    });
  });

  const adhoc = model.adhocNotes.map((number, index) => {
    const previous = model.adhocNotes[index - 1];
    const next = model.adhocNotes[index + 1];
    const links = [
      previous ? `<a href="#note-${previous}">Previous</a>` : null,
      `<a href="#notes">All notes</a>`,
      next ? `<a href="#note-${next}">Next</a>` : null,
    ].filter(Boolean).join(' · ');
    return pageHtml(model, {
      id: `note-${number}`, kicker: 'Ad-hoc notes', title: `Blank page ${number}`,
      meta: links, active: 'notes', activeMonthKey: null,
      body: `<div class="note-title"></div><div class="write" style="height: calc(100% - 0.4in)"></div>`,
    });
  });

  return [index, ...meetings, ...adhoc];
}

function renderPlannerHtml(model) {
  const pages = [
    coverPage(model),
    monthsIndexPage(model),
    ...model.months.map(month => monthPage(model, month)),
    ...model.weeks.map(week => weekPage(model, week)),
    ...model.days.map(day => dayPage(model, day)),
    ...tasksPages(model),
    ...projectsPages(model),
    ...peoplePages(model),
    ...notesPages(model),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>McLellan Hub planner — ${escHtml(model.todayLabel)}</title>
<style>${plannerCss(model.orientation)}</style></head>
<body>${pages.join('\n')}</body></html>`;
}

async function renderPlannerPdf(model) {
  const puppeteer = require('puppeteer');
  const html = renderPlannerHtml(model);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    return await page.pdf({ printBackground: true, preferCSSPageSize: true, timeout: 120000 });
  } finally {
    await browser.close();
  }
}

// ── Live build ───────────────────────────────────────────────────────────────

function liveProjectsWithKnowledge(user) {
  const db = require('./db');
  const { listProjects } = require('./project-lifecycle');
  const hub = db.hub();
  const projects = listProjects(hub, user, { columns: 'id, slug, name' });
  const atomsByProjectId = new Map();
  if (projects.length) {
    const placeholders = projects.map(() => '?').join(',');
    const rows = hub.prepare(`
      SELECT subject_id, predicate, value, confidence, updated_at
        FROM knowledge_atoms
       WHERE user = ? AND subject_kind = 'project' AND status = 'active'
         AND subject_id IN (${placeholders})
       ORDER BY confidence DESC, updated_at DESC
    `).all(user, ...projects.map(project => project.id));
    for (const row of rows) {
      if (!atomsByProjectId.has(row.subject_id)) atomsByProjectId.set(row.subject_id, []);
      atomsByProjectId.get(row.subject_id).push(row);
    }
  }
  return { projects, atomsByProjectId };
}

// The planner snapshot is deliberately capped at 31 days (it backs a week view
// and a live Calendar read). A 90-day reference book is therefore assembled from
// consecutive in-range snapshots rather than by loosening that guard.
const SNAPSHOT_CHUNK_DAYS = 28;

async function fetchPlannerWindow(user, today, span, calendarClient = null) {
  const { getPlannerSnapshot } = require('./task-calendar-planner');
  const chunks = [];
  for (let offset = 0; offset < span; offset += SNAPSHOT_CHUNK_DAYS) {
    const startDate = addIsoDays(today, offset);
    const endDate = addIsoDays(today, Math.min(span, offset + SNAPSHOT_CHUNK_DAYS));
    chunks.push(await getPlannerSnapshot(user, { startDate, endDate }, {
      reconcileCache: false,
      ...(calendarClient ? { calendarClient } : {}),
    }));
  }
  const first = chunks[0];
  const eventsById = new Map();
  for (const chunk of chunks) for (const event of chunk.events) eventsById.set(event.id, event);
  const events = [...eventsById.values()];
  // A task blocked out in a later chunk is scheduled, even though the first
  // chunk could not see its event.
  const scheduledIds = new Set(events.filter(event => event.taskId).map(event => event.taskId));
  return {
    ...first,
    startDate: today,
    endDate: addIsoDays(today, span),
    span,
    days: chunks.flatMap(chunk => chunk.days),
    events,
    unscheduledTasks: (first.unscheduledTasks || []).filter(task => !scheduledIds.has(task.id)),
  };
}

// An attendee is only a name until the Hub recognises the address; then the
// meeting note page can say what is already open with that person.
function contactsByEmailFor(user, snapshot) {
  const db = require('./db');
  const emails = [...new Set((snapshot.events || [])
    .flatMap(event => event.attendees || [])
    .map(attendee => String(attendee.email || '').trim().toLowerCase())
    .filter(Boolean))];
  const map = new Map();
  if (!emails.length) return map;
  const rows = db.hub().prepare(`
    SELECT id, name, email FROM contacts
     WHERE user = ? AND lower(trim(email)) IN (${emails.map(() => '?').join(',')})
  `).all(user, ...emails);
  for (const row of rows) map.set(String(row.email).trim().toLowerCase(), row);
  return map;
}

async function buildBooxPlannerModel(user, { days = DEFAULT_DAYS, orientation = 'portrait', today = isoToday(), calendarClient = null } = {}) {
  const span = Math.max(7, Math.min(370, Number(days) || DEFAULT_DAYS));
  const snapshot = await fetchPlannerWindow(user, today, span, calendarClient);
  const { projects, atomsByProjectId } = liveProjectsWithKnowledge(user);
  const contactsByEmail = contactsByEmailFor(user, snapshot);
  return assemblePlannerModel({ snapshot, today, projects, atomsByProjectId, contactsByEmail, orientation });
}

async function createBooxPlannerPdf(user, options = {}) {
  const model = await buildBooxPlannerModel(user, options);
  const pdf = await renderPlannerPdf(model);
  return { pdf, model };
}

// ── Delivery ─────────────────────────────────────────────────────────────────
// The device pulls, so the Hub pushes into the Drive folder the Boox syncs.
// The same Drive file is updated in place every night: a new file each day
// would leave the tablet with a folder of stale planners and no clue which is
// current. The file id is operational plumbing, not knowledge — it lives in
// crm_context beside the other planner settings.

const DRIVE_FILE_KEY = 'boox_planner_drive_file';

// One file per day, named for its date. This is what makes the planner safe to
// write on: today's file is created once and never rewritten, so handwriting
// synced back from the tablet can never be clobbered by tomorrow's build.
// Overwriting an existing day is therefore an explicit, forced action.
function plannerFileName(date) {
  const prefix = String(process.env.BOOX_PLANNER_NAME_PREFIX || 'Hub Planner').trim();
  return `${prefix} ${date}.pdf`;
}

function driveFolderSegments() {
  const configured = String(process.env.BOOX_PLANNER_DRIVE_FOLDER_PATH || 'onyx/NoteMax/Hub Planner').trim();
  return configured.split('/').map(part => part.trim()).filter(Boolean);
}

function readDriveState(user) {
  const db = require('./db');
  const row = db.hub().prepare('SELECT value FROM crm_context WHERE user = ? AND key = ?').get(user, DRIVE_FILE_KEY);
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

function writeDriveState(user, state) {
  const db = require('./db');
  const { uuid } = require('./id');
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, DRIVE_FILE_KEY, JSON.stringify(state));
}

async function findDriveFileByName(drive, folderId, name) {
  const response = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,size,modifiedTime)',
    spaces: 'drive',
  });
  return response.data.files?.[0] || null;
}

async function publishBooxPlannerToDrive(user, options = {}) {
  const { Readable } = require('stream');
  const { getDriveClient, resolveFolderPath } = require('./google-drive');
  const date = options.today || isoToday();
  const name = plannerFileName(date);
  const drive = await getDriveClient(user);
  const folderId = await resolveFolderPath(drive, driveFolderSegments());
  const existing = await findDriveFileByName(drive, folderId, name);
  const folderPath = driveFolderSegments().join('/');

  if (existing && !options.force) {
    return {
      fileId: existing.id,
      folderId,
      name,
      date,
      folderPath,
      bytes: Number(existing.size) || 0,
      skipped: 'already_published',
      publishedAt: Math.floor(new Date(existing.modifiedTime || Date.now()).getTime() / 1000),
    };
  }

  const { pdf, model } = await createBooxPlannerPdf(user, { ...options, today: date });
  // Readable.from(buffer) would stream the Buffer byte by byte as numbers, which
  // the upload stream rejects; wrap it so each attempt gets one whole chunk —
  // and a fresh stream, because a retry cannot re-read a consumed one.
  const media = () => ({ mimeType: 'application/pdf', body: Readable.from([pdf]) });

  let fileId = existing?.id || null;
  if (fileId) {
    try {
      await drive.files.update({ fileId, media: media(), fields: 'id' });
    } catch (error) {
      // A file deleted or unshared on the device must not stop today's push.
      console.warn('[boox-planner] update failed, recreating Drive file:', error.message);
      fileId = null;
    }
  }
  if (!fileId) {
    const created = await drive.files.create({
      requestBody: { name, parents: [folderId], mimeType: 'application/pdf' },
      media: media(),
      fields: 'id',
    });
    fileId = created.data.id;
  }

  const state = {
    fileId,
    folderId,
    name,
    date,
    folderPath,
    bytes: pdf.length,
    days: model.dayCount,
    replaced: Boolean(existing),
    publishedAt: Math.floor(Date.now() / 1000),
  };
  writeDriveState(user, state);
  return state;
}

// A push that quietly stopped working would leave Douglas reading a planner
// from three weeks ago without knowing it, so the last failure is kept beside
// the file state and shown on the planner screen.
async function runBooxPlannerPublish(user, options = {}) {
  try {
    const state = await publishBooxPlannerToDrive(user, options);
    if (!state.skipped) writeDriveState(user, { ...state, lastError: null });
    return state;
  } catch (error) {
    const previous = readDriveState(user) || {};
    writeDriveState(user, {
      ...previous,
      lastError: String(error.message || error).slice(0, 300),
      lastErrorAt: Math.floor(Date.now() / 1000),
    });
    throw error;
  }
}

module.exports = {
  DEFAULT_DAYS,
  DRIVE_FILE_KEY,
  LIMITS,
  PAGE_SIZES,
  assemblePlannerModel,
  buildBooxPlannerModel,
  createBooxPlannerPdf,
  driveFolderSegments,
  plannerFileName,
  fetchPlannerWindow,
  isoToday,
  publishBooxPlannerToDrive,
  readDriveState,
  runBooxPlannerPublish,
  renderPlannerHtml,
  renderPlannerPdf,
};
