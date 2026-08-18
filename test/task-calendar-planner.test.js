'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateRange,
  zonedDateTimeToIso,
  normaliseDuration,
  computeAutoPlan,
  computeConflictReflow,
  computeReshuffle,
  resolveTaskFloor,
  _test,
} = require('../lib/task-calendar-planner');

test('planner range is bounded and date-safe', () => {
  assert.deepEqual(validateRange('2026-08-10', '2026-08-17'), {
    startDate: '2026-08-10', endDate: '2026-08-17', span: 7,
  });
  assert.throws(() => validateRange('2026-08-17', '2026-08-10'), /after start/);
  assert.throws(() => validateRange('2026-02-30', '2026-03-02'), /valid date/);
  assert.throws(() => validateRange('2026-01-01', '2026-03-01'), /cannot exceed/);
});

test('Dublin wall-clock time is converted with the correct seasonal offset', () => {
  assert.equal(zonedDateTimeToIso('2026-01-12', '09:00'), '2026-01-12T09:00:00.000Z');
  assert.equal(zonedDateTimeToIso('2026-08-10', '09:00'), '2026-08-10T08:00:00.000Z');
});

test('planner rounds effort to quarter hours and bounds unreasonable blocks', () => {
  assert.equal(normaliseDuration(31), 45);
  assert.equal(normaliseDuration(null), 30);
  assert.throws(() => normaliseDuration(5), /between 15 and 480/);
  assert.throws(() => normaliseDuration(600), /between 15 and 480/);
});

test('auto-plan uses due date and priority, then fills around real calendar events', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-10',
    endDate: '2026-08-11',
    workStart: '09:00',
    workEnd: '12:00',
    now: new Date('2026-08-10T06:00:00Z'),
    tasks: [
      { id: 'medium', title: 'Medium task', priority: 'medium', effort_minutes: 30, due: '2026-08-10', created_at: 1 },
      { id: 'high', title: 'High task', priority: 'high', effort_minutes: 60, due: '2026-08-10', created_at: 2 },
    ],
    events: [
      { date: '2026-08-10', endDate: '2026-08-10', time: '09:30', endTime: '10:30', allDay: false, transparency: 'opaque' },
    ],
  });

  assert.deepEqual(result.unplaced, []);
  assert.deepEqual(result.placements.map(item => [item.taskId, item.startAt, item.endAt]), [
    ['high', '2026-08-10T10:30', '2026-08-10T11:30'],
    ['medium', '2026-08-10T09:00', '2026-08-10T09:30'],
  ]);
});

test('auto-plan treats overdue work as urgent instead of making it impossible to place', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-10',
    endDate: '2026-08-12',
    workStart: '09:00',
    workEnd: '10:00',
    now: new Date('2026-08-11T07:15:00Z'),
    tasks: [{ id: 'overdue', title: 'Overdue task', effort_minutes: 30, due: '2026-08-01' }],
    events: [],
  });
  assert.equal(result.placements[0].startAt, '2026-08-11T09:00');
});

test('auto-plan spills a due task into the next free day and marks it late', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-10',
    endDate: '2026-08-12',
    workStart: '09:00',
    workEnd: '10:00',
    now: new Date('2026-08-09T07:00:00Z'),
    tasks: [
      { id: 'due-monday-one', title: 'Due Monday one', effort_minutes: 30, due: '2026-08-10' },
      { id: 'due-monday-two', title: 'Due Monday two', effort_minutes: 30, due: '2026-08-10' },
    ],
    events: [
      { date: '2026-08-10', endDate: '2026-08-10', time: '09:00', endTime: '10:00', allDay: false, transparency: 'opaque' },
    ],
  });

  assert.deepEqual(result.unplaced, []);
  assert.deepEqual(result.placements.map(item => [item.startAt, item.late]), [
    ['2026-08-11T09:00', true],
    ['2026-08-11T09:30', true],
  ]);
});

test('auto-plan does not let its own placements overlap and skips weekends by default', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-15',
    endDate: '2026-08-18',
    workStart: '09:00',
    workEnd: '10:00',
    now: new Date('2026-08-14T07:00:00Z'),
    tasks: [
      { id: 'one', title: 'One', effort_minutes: 30 },
      { id: 'two', title: 'Two', effort_minutes: 30 },
    ],
    events: [],
  });
  assert.deepEqual(result.placements.map(item => item.startAt), [
    '2026-08-17T09:00',
    '2026-08-17T09:30',
  ]);
});

test('a new appointment moves the conflicting task and cascades later task blocks', () => {
  const tasks = [
    { id: 'first', title: 'First task', planner_lane: 'work', effort_minutes: 30, due: '2026-08-10' },
    { id: 'second', title: 'Second task', planner_lane: 'work', effort_minutes: 30, due: '2026-08-10' },
    { id: 'safe', title: 'Safe task', planner_lane: 'work', effort_minutes: 30, due: '2026-08-10' },
  ];
  const taskEvent = (taskId, time, endTime) => ({
    id: `event-${taskId}`, taskId, isTask: true, date: '2026-08-10', endDate: '2026-08-10',
    time, endTime, durationMinutes: 30, allDay: false, transparency: 'opaque',
    task: tasks.find(task => task.id === taskId),
  });
  const result = computeConflictReflow({
    tasks,
    startDate: '2026-08-10',
    endDate: '2026-08-12',
    preferences: { workStart: '08:00', workEnd: '12:00' },
    now: new Date('2026-08-10T06:00:00Z'),
    events: [
      { id: 'appointment', title: 'New appointment', date: '2026-08-10', endDate: '2026-08-10', time: '09:00', endTime: '10:00', allDay: false, transparency: 'opaque' },
      taskEvent('first', '09:00', '09:30'),
      taskEvent('second', '10:00', '10:30'),
      taskEvent('safe', '11:30', '12:00'),
    ],
  });

  assert.deepEqual(result.moved.map(item => [item.taskId, item.fromAt, item.startAt, item.late]), [
    ['first', '2026-08-10T09:00', '2026-08-10T10:00', false],
    ['second', '2026-08-10T10:00', '2026-08-10T10:30', false],
  ]);
  assert.deepEqual(result.unchanged.map(item => item.taskId), ['safe']);
  assert.deepEqual(result.unplaced, []);
});

test('automatic conflict reflow rolls into the next work day and marks the task late', () => {
  const task = { id: 'late', title: 'Late task', planner_lane: 'work', effort_minutes: 60, due: '2026-08-10' };
  const result = computeConflictReflow({
    tasks: [task],
    startDate: '2026-08-10',
    endDate: '2026-08-12',
    preferences: { workStart: '15:00', workEnd: '16:00' },
    now: new Date('2026-08-10T06:00:00Z'),
    events: [
      { id: 'appointment', date: '2026-08-10', endDate: '2026-08-10', time: '15:00', endTime: '16:00', allDay: false, transparency: 'opaque' },
      { id: 'task', taskId: task.id, isTask: true, task, date: '2026-08-10', endDate: '2026-08-10', time: '15:00', endTime: '16:00', allDay: false, transparency: 'opaque' },
    ],
  });
  assert.equal(result.moved[0].startAt, '2026-08-11T15:00');
  assert.equal(result.moved[0].late, true);
});

test('automatic conflict reflow leaves an observable item when no later slot exists', () => {
  const task = { id: 'boxed-in', title: 'Boxed in', planner_lane: 'work', effort_minutes: 60 };
  const result = computeConflictReflow({
    tasks: [task],
    startDate: '2026-08-10',
    endDate: '2026-08-11',
    preferences: { workStart: '15:00', workEnd: '16:00' },
    now: new Date('2026-08-10T06:00:00Z'),
    events: [
      { id: 'appointment', date: '2026-08-10', endDate: '2026-08-10', time: '15:00', endTime: '16:00', allDay: false, transparency: 'opaque' },
      { id: 'task', taskId: task.id, isTask: true, task, date: '2026-08-10', endDate: '2026-08-10', time: '15:00', endTime: '16:00', allDay: false, transparency: 'opaque' },
    ],
  });
  assert.equal(result.moved.length, 0);
  assert.equal(result.unplaced[0].taskId, task.id);
});

test('personal tasks use weekday evenings and then weekend hours', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-14',
    endDate: '2026-08-17',
    preferences: {
      workStart: '09:00', workEnd: '17:30',
      eveningStart: '18:30', eveningEnd: '19:00',
      weekendStart: '10:00', weekendEnd: '10:30',
    },
    now: new Date('2026-08-14T06:00:00Z'),
    tasks: [
      { id: 'personal-one', title: 'Personal one', planner_lane: 'personal', effort_minutes: 30 },
      { id: 'personal-two', title: 'Personal two', planner_lane: 'personal', effort_minutes: 30 },
    ],
    events: [],
  });
  assert.deepEqual(result.placements.map(item => item.startAt), [
    '2026-08-14T18:30',
    '2026-08-15T10:00',
  ]);
});

test('manual planner windows distinguish work from personal time', () => {
  const preferences = {
    workStart: '09:00', workEnd: '17:30',
    eveningStart: '18:30', eveningEnd: '21:30',
    weekendStart: '10:00', weekendEnd: '17:00',
  };
  assert.doesNotThrow(() => _test.assertWithinPlannerWindow(
    'work', { date: '2026-08-10', time: '09:00' }, { date: '2026-08-10', time: '09:30' }, preferences
  ));
  assert.throws(() => _test.assertWithinPlannerWindow(
    'personal', { date: '2026-08-10', time: '09:00' }, { date: '2026-08-10', time: '09:30' }, preferences
  ), /evening hours/);
  assert.doesNotThrow(() => _test.assertWithinPlannerWindow(
    'personal', { date: '2026-08-15', time: '10:00' }, { date: '2026-08-15', time: '10:30' }, preferences
  ));
});

test('transparent events stay free while opaque all-day events block the work day', () => {
  const intervals = _test.eventBusyIntervals([
    { date: '2026-08-10', time: '09:00', endDate: '2026-08-10', endTime: '10:00', allDay: false, transparency: 'transparent' },
    { date: '2026-08-09', endDate: '2026-08-11', allDay: true, transparency: 'opaque' },
    { date: '2026-08-10', time: '10:00', endDate: '2026-08-10', endTime: '10:30', allDay: false, transparency: 'opaque' },
  ], '2026-08-10', 9 * 60, 12 * 60);
  assert.deepEqual(intervals, [[540, 720], [600, 630]]);
});

test('reshuffle pushes a block stranded on an earlier day into the earliest free future slot', () => {
  // Monday 14:00 block; now it is Tuesday morning. It can never be worked at its
  // Monday time, so it must move forward to the first free permitted slot today.
  const result = computeReshuffle({
    startDate: '2026-08-09',
    endDate: '2026-08-16',
    preferences: { workStart: '09:00', workEnd: '17:00' },
    now: new Date('2026-08-11T06:00:00Z'), // Tuesday 07:00 local
    appointments: [
      { date: '2026-08-11', endDate: '2026-08-11', time: '09:00', endTime: '10:00', allDay: false, transparency: 'opaque' },
    ],
    scheduled: [
      { task: { id: 'stranded', title: 'Stranded', priority: 'medium', effort_minutes: 30, planner_lane: 'work' }, date: '2026-08-10', time: '14:00' },
    ],
  });
  assert.equal(result.moves.length, 1);
  assert.deepEqual(
    [result.moves[0].fromAt, result.moves[0].startAt],
    ['2026-08-10T14:00', '2026-08-11T10:00'], // Tuesday, just after the fixed 09:00–10:00 appointment
  );
});

test('reshuffle leaves future blocks exactly where they are', () => {
  const result = computeReshuffle({
    startDate: '2026-08-09',
    endDate: '2026-08-16',
    preferences: { workStart: '09:00', workEnd: '17:00' },
    now: new Date('2026-08-11T06:00:00Z'), // Tuesday 07:00 local
    appointments: [],
    scheduled: [
      // Both sit in the future relative to now; reshuffle must not touch them.
      { task: { id: 'a', title: 'A', effort_minutes: 30, planner_lane: 'work' }, date: '2026-08-11', time: '14:00' },
      { task: { id: 'b', title: 'B', effort_minutes: 30, planner_lane: 'work' }, date: '2026-08-12', time: '09:00' },
    ],
  });
  assert.deepEqual(result.moves, []);
  assert.equal(result.unchanged, 0);
});

test("reshuffle rescues a block whose slot already ended earlier today, but not one still ahead today", () => {
  const result = computeReshuffle({
    startDate: '2026-08-09',
    endDate: '2026-08-16',
    preferences: { workStart: '09:00', workEnd: '17:00' },
    now: new Date('2026-08-11T11:00:00Z'), // Tuesday 12:00 local
    appointments: [],
    scheduled: [
      { task: { id: 'done-slot', title: 'Ended', effort_minutes: 30, planner_lane: 'work' }, date: '2026-08-11', time: '09:00' }, // ended 09:30, in the past
      { task: { id: 'ahead', title: 'Ahead', effort_minutes: 30, planner_lane: 'work' }, date: '2026-08-11', time: '15:00' }, // still ahead, untouched
    ],
  });
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].taskId, 'done-slot');
  assert.equal(result.moves[0].startAt, '2026-08-11T12:00'); // earliest free slot from noon
});

test('reshuffle marks a rescued block late when its due date is already behind it', () => {
  const result = computeReshuffle({
    startDate: '2026-08-09',
    endDate: '2026-08-16',
    preferences: { workStart: '09:00', workEnd: '17:00' },
    now: new Date('2026-08-11T06:00:00Z'),
    appointments: [],
    scheduled: [
      { task: { id: 'overdue', title: 'Overdue', effort_minutes: 30, due: '2026-08-10', planner_lane: 'work' }, date: '2026-08-10', time: '14:00' },
    ],
  });
  assert.equal(result.moves[0].startAt, '2026-08-11T09:00');
  assert.equal(result.moves[0].late, true); // landed Tuesday, due Monday
});

test('resolveTaskFloor floors on the linked event end, lapses when the event is gone', () => {
  const eventsById = new Map([
    ['evt1', { id: 'evt1', allDay: false, endDate: '2026-08-11', endTime: '15:30', title: 'Tuesday sync' }],
  ]);
  assert.deepEqual(
    resolveTaskFloor({ after: 'cal:evt1' }, eventsById),
    { atLocal: '2026-08-11T15:30', date: '2026-08-11', minute: 930, title: 'Tuesday sync' },
  );
  assert.equal(resolveTaskFloor({ after: 'cal:missing' }, eventsById), null);
  assert.equal(resolveTaskFloor({ after: null }, eventsById), null);
  assert.equal(resolveTaskFloor({ after: '2026-08-11T15:30' }, new Map()).atLocal, '2026-08-11T15:30');
});

test('auto-plan honours an after-dependency and will not place before the floor', () => {
  const result = computeAutoPlan({
    startDate: '2026-08-10',
    endDate: '2026-08-13',
    workStart: '09:00',
    workEnd: '17:00',
    now: new Date('2026-08-10T06:00:00Z'),
    tasks: [
      { id: 'dep', title: 'After meeting', effort_minutes: 30, due: '2026-08-11', planner_lane: 'work', notBefore: '2026-08-11T15:30' },
    ],
    events: [],
  });
  // Monday is free but blocked by the floor; lands Tuesday at/after 15:30.
  assert.equal(result.placements[0].startAt, '2026-08-11T15:30');
});

test('reshuffle will not rescue a dependent block earlier than its linked meeting floor', () => {
  const result = computeReshuffle({
    startDate: '2026-08-09',
    endDate: '2026-08-16',
    preferences: { workStart: '09:00', workEnd: '17:00' },
    now: new Date('2026-08-11T06:00:00Z'), // Tuesday morning
    appointments: [],
    scheduled: [
      // Stranded on Monday, but its floor sits on Tuesday 15:30; the free Tuesday
      // morning must be skipped and the block placed no earlier than the floor.
      { task: { id: 'dep', title: 'After meeting', effort_minutes: 30, planner_lane: 'work', notBefore: '2026-08-11T15:30' }, date: '2026-08-10', time: '10:00' },
    ],
  });
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].startAt, '2026-08-11T15:30');
});
