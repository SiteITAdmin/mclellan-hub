const test = require('node:test');
const assert = require('node:assert/strict');

const { assemblePlannerModel, renderPlannerHtml, plannerFileName } = require('../lib/boox-planner');
const { addIsoDays } = require('../lib/task-calendar-planner');

const TODAY = '2026-08-20';

function task(id, overrides = {}) {
  return {
    id,
    title: overrides.title || `Task ${id}`,
    status: 'needsAction',
    deleted_at: null,
    due: overrides.due || null,
    effective_due: overrides.effectiveDue || null,
    is_overdue: overrides.isOverdue,
    priority: overrides.priority || null,
    planner_lane: overrides.lane || 'work',
    assignee: overrides.assignee || null,
    project_slug: overrides.project || null,
    project_name: overrides.projectName || null,
    contact_id: overrides.contactId || null,
    contact_name: overrides.contactName || null,
    company_id: null,
    company_name: null,
    notes: '',
  };
}

function snapshotFor(tasks, events, span = 30) {
  return {
    startDate: TODAY,
    endDate: addIsoDays(TODAY, span),
    span,
    days: Array.from({ length: span }, (_, index) => {
      const date = addIsoDays(TODAY, index);
      return { date, label: 'X', dayNumber: Number(date.slice(8, 10)), monthLabel: 'X' };
    }),
    events,
    tasks,
    selectedTasks: tasks.filter(item => !item.assignee),
    unscheduledTasks: tasks.filter(item => !item.assignee && !events.some(event => event.taskId === item.id)),
  };
}

test('overdue counts exclude tasks that already hold a time block', () => {
  const stranded = task('t1', { due: '2026-08-01' });
  const blocked = task('t2', { due: '2026-08-02' });
  const events = [{
    id: 'e1', date: TODAY, time: '10:00', endTime: '10:30', allDay: false,
    title: blocked.title, isTask: true, taskId: 't2', task: blocked, isLate: true,
  }];
  const model = assemblePlannerModel({ snapshot: snapshotFor([stranded, blocked], events), today: TODAY });
  assert.deepEqual(model.overdue.map(item => item.id), ['t1']);
  assert.equal(model.counts.scheduled, 1);
});

test('overdue counts use a dependency-adjusted due date', () => {
  const deferred = task('t-deferred', { due: '2026-08-01', effectiveDue: '2026-10-05' });
  const model = assemblePlannerModel({ snapshot: snapshotFor([deferred], []), today: TODAY });
  assert.deepEqual(model.overdue, []);
  assert.equal(model.counts.overdue, 0);
});

test('overdue counts honour the derived reminder deadline state', () => {
  const reminderOverdue = task('t-reminder-overdue', { due: '2026-08-25', isOverdue: true });
  const model = assemblePlannerModel({ snapshot: snapshotFor([reminderOverdue], []), today: TODAY });
  assert.deepEqual(model.overdue.map(item => item.id), ['t-reminder-overdue']);
});

test('a task assigned to someone else is tracked, never planned', () => {
  const mine = task('t1', { due: TODAY });
  const theirs = task('t2', { due: TODAY, assignee: 'Ken Murray' });
  const model = assemblePlannerModel({ snapshot: snapshotFor([mine, theirs], []), today: TODAY });
  assert.deepEqual(model.assigned.map(item => item.id), ['t2']);
  assert.deepEqual(model.days[0].due.map(item => item.id), ['t1']);
});

test('days, months and weeks cover the whole window', () => {
  const model = assemblePlannerModel({ snapshot: snapshotFor([], [], 90), today: TODAY });
  assert.equal(model.days.length, 90);
  assert.equal(model.days.at(-1).date, addIsoDays(TODAY, 89));
  assert.deepEqual(model.months.map(month => month.key), ['2026-08', '2026-09', '2026-10', '2026-11']);
  assert.equal(model.weeks[0].start, '2026-08-17');
  assert.ok(model.weeks.length >= 13);
});

test('every navigation target the pages link to actually exists', () => {
  const model = assemblePlannerModel({
    snapshot: snapshotFor([task('t1', { due: TODAY, project: 'beacon', projectName: 'Beacon' })], [], 40),
    today: TODAY,
    projects: [{ id: 'p1', slug: 'beacon', name: 'Beacon' }],
    atomsByProjectId: new Map([['p1', [{ predicate: 'status', value: 'Awaiting signature' }]]]),
  });
  const html = renderPlannerHtml(model);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const targets = new Set([...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]));
  for (const target of targets) assert.ok(ids.has(target), `dangling planner link: #${target}`);
  // A page nothing links to cannot be reached: a PDF has no back button.
  for (const id of ids) {
    if (id === 'today') continue;
    assert.ok(targets.has(id), `orphaned planner page: #${id}`);
  }
  for (const tile of ['t-open', 't-blocked', 't-overdue', 't-unplanned']) {
    assert.ok(targets.has(tile), `dashboard tile does not link anywhere: #${tile}`);
  }
  assert.ok(ids.has(`d-${TODAY}`));
  assert.ok(ids.has('p-beacon'));
  assert.ok(html.includes('Awaiting signature'));
});

test('planner pages never leak raw html from task titles', () => {
  const nasty = task('t1', { due: TODAY, title: '<script>alert(1)</script>' });
  const model = assemblePlannerModel({ snapshot: snapshotFor([nasty], []), today: TODAY });
  const html = renderPlannerHtml(model);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('a section that spills onto extra pages still links to all of them', () => {
  const many = Array.from({ length: 40 }, (_, index) => task(`t${index}`, { due: addIsoDays(TODAY, index % 20) }));
  const model = assemblePlannerModel({ snapshot: snapshotFor(many, []), today: TODAY });
  const html = renderPlannerHtml(model);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const targets = new Set([...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]));
  assert.ok(ids.has('t-open-2'), 'expected a second page of open tasks');
  for (const id of ids) {
    if (id === 'today') continue;
    assert.ok(targets.has(id), `orphaned planner page: #${id}`);
  }
});

test('note pages exist for appointments, never for task blocks', () => {
  const blocked = task('t1');
  const events = [
    {
      id: 'evt-1', date: TODAY, time: '09:30', endTime: '10:15', allDay: false,
      title: 'Beacon steering call', location: 'Google Meet', isTask: false,
      attendees: [{ name: 'Alan Reid', email: 'alan@example.com' }],
    },
    {
      id: 'evt-2', date: TODAY, time: '14:00', endTime: '14:30', allDay: false,
      title: blocked.title, isTask: true, taskId: 't1', task: blocked,
    },
    { id: 'evt-3', date: addIsoDays(TODAY, 2), allDay: true, endDate: addIsoDays(TODAY, 3), title: 'Bank holiday', isTask: false },
  ];
  const model = assemblePlannerModel({
    snapshot: snapshotFor([blocked], events),
    today: TODAY,
    contactsByEmail: new Map([['alan@example.com', { id: 'c1', name: 'Alan Reid', email: 'alan@example.com' }]]),
    adhocNotePages: 3,
  });
  assert.deepEqual(model.meetingNotes.map(meeting => meeting.id), ['evt-1']);
  assert.equal(model.meetingNotes[0].attendees[0].contact.id, 'c1');

  const html = renderPlannerHtml(model);
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  const targets = new Set([...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1]));
  assert.ok(ids.has('notes'));
  assert.ok(ids.has(model.meetingNotes[0].noteId));
  assert.ok(ids.has('note-3'), 'expected the requested blank pages');
  assert.ok(targets.has(model.meetingNotes[0].noteId), 'the day page must link to the meeting note page');
  for (const id of ids) {
    if (id === 'today') continue;
    assert.ok(targets.has(id), `orphaned planner page: #${id}`);
  }
});

test('each day gets its own Drive file so handwriting is never overwritten', () => {
  assert.equal(plannerFileName('2026-08-21'), 'Hub Planner 2026-08-21.pdf');
  assert.notEqual(plannerFileName('2026-08-21'), plannerFileName('2026-08-22'));
});
