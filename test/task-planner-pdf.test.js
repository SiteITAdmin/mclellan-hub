'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlannerDayPdf, dayEvents } = require('../lib/task-planner-pdf');

const snapshot = {
  events: [
    { id: 'meeting', title: 'Team meeting', date: '2026-08-10', endDate: '2026-08-10', time: '09:00', endTime: '10:00', location: 'Teams', allDay: false, isTask: false },
    { id: 'task', title: 'Finish board paper', date: '2026-08-10', endDate: '2026-08-10', time: '10:00', endTime: '10:30', allDay: false, isTask: true, isLate: true, task: { planner_lane: 'work' } },
    { id: 'tomorrow', title: 'Tomorrow only', date: '2026-08-11', endDate: '2026-08-11', time: '09:00', endTime: '09:30', allDay: false, isTask: true },
  ],
};

test('daily planner PDF includes today calendar events and scheduled task checklist', async () => {
  assert.deepEqual(dayEvents(snapshot, '2026-08-10').map(event => event.id), ['meeting', 'task']);
  const pdf = await createPlannerDayPdf(snapshot, '2026-08-10');
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(pdf.length > 1000);
  assert.match(pdf.toString('latin1'), /Today/);
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
});
