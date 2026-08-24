'use strict';

// Planner task blocks are cached in `meetings` so `/crm/planner` can treat
// them as calendar occupancy. They are not CRM meetings. Keep this file free
// of other Hub requires so crm.js and the planner can both use it.

const TASK_PLANNER_SOURCE = 'task_planner';
const TASK_PLANNER_NOTES_PREFIX = 'Scheduled from McLellan Hub task';

function isTaskPlannerMeetingSource(source) {
  return String(source || '') === TASK_PLANNER_SOURCE;
}

function plannerTaskIdFromNotes(notes) {
  const match = String(notes || '').match(/^Scheduled from McLellan Hub task ([^\s.]+)/);
  return match?.[1] || null;
}

function isTaskPlannerMeetingRow(row) {
  if (!row) return false;
  if (isTaskPlannerMeetingSource(row.source)) return true;
  return String(row.notes || '').startsWith(TASK_PLANNER_NOTES_PREFIX);
}

function plannerTaskIdFromMeeting(row) {
  if (!row) return null;
  if (isTaskPlannerMeetingSource(row.source) && row.source_id) return row.source_id;
  return plannerTaskIdFromNotes(row.notes);
}

function isTaskPlannerCalendarEvent(event) {
  if (!event) return false;
  if (event.isTask) return true;
  if (isTaskPlannerMeetingSource(event.hubSource || event.source)) return true;
  const privateProps = event.extendedProperties?.private || {};
  if (isTaskPlannerMeetingSource(privateProps.hubSource)) return true;
  return String(event.notes || event.description || '').startsWith(TASK_PLANNER_NOTES_PREFIX);
}

function crmMeetingSql(alias = 'm') {
  const col = alias ? `${alias}.` : '';
  return `COALESCE(${col}source, '') != '${TASK_PLANNER_SOURCE}' AND COALESCE(${col}notes, '') NOT LIKE '${TASK_PLANNER_NOTES_PREFIX}%'`;
}

module.exports = {
  TASK_PLANNER_SOURCE,
  TASK_PLANNER_NOTES_PREFIX,
  isTaskPlannerMeetingSource,
  isTaskPlannerMeetingRow,
  isTaskPlannerCalendarEvent,
  plannerTaskIdFromMeeting,
  crmMeetingSql,
};
