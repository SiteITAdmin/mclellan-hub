'use strict';

const db = require('./db');
const { uuid } = require('./id');
const { getCachedTasks, parseTaskTags } = require('./google-tasks');
const { getCalendarClient, createCalendarEvent, toRfc3339 } = require('./google-calendar');
const { upsertMeetingRow } = require('./crm');

const TIME_ZONE = 'Europe/Dublin';
const PLANNER_SOURCE = 'task_planner';
const PLANNER_ORIGIN = 'task-planner:user-action';
const DEFAULT_DURATION_MINUTES = 30;
const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 8 * 60;
const MAX_RANGE_DAYS = 31;
const PLANNER_PREFERENCES_KEY = 'task_planner_preferences';
const DEFAULT_PLANNER_PREFERENCES = Object.freeze({
  workStart: '08:00',
  workEnd: '16:00',
  eveningStart: '18:30',
  eveningEnd: '21:00',
  weekendStart: '10:00',
  weekendEnd: '17:00',
});

function normalisePlannerPreferences(value = {}) {
  const preferences = { ...DEFAULT_PLANNER_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PLANNER_PREFERENCES)) {
    if (value[key] !== undefined) preferences[key] = String(value[key]).trim();
    minutesFromTime(preferences[key], `${key}`);
  }
  for (const [label, startKey, endKey] of [
    ['Work hours', 'workStart', 'workEnd'],
    ['Evening hours', 'eveningStart', 'eveningEnd'],
    ['Weekend hours', 'weekendStart', 'weekendEnd'],
  ]) {
    if (minutesFromTime(preferences[endKey]) - minutesFromTime(preferences[startKey]) < MIN_DURATION_MINUTES) {
      throw new Error(`${label} must be at least ${MIN_DURATION_MINUTES} minutes`);
    }
  }
  return preferences;
}

function getPlannerPreferences(user) {
  const row = db.hub().prepare(
    'SELECT value FROM crm_context WHERE user = ? AND key = ?'
  ).get(user, PLANNER_PREFERENCES_KEY);
  if (!row?.value) return { ...DEFAULT_PLANNER_PREFERENCES };
  try {
    return normalisePlannerPreferences(JSON.parse(row.value));
  } catch (error) {
    console.warn('[task-planner] invalid saved preferences; using defaults:', error.message);
    return { ...DEFAULT_PLANNER_PREFERENCES };
  }
}

function savePlannerPreferences(user, value) {
  const preferences = normalisePlannerPreferences(value);
  db.hub().prepare(`
    INSERT INTO crm_context (id, user, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user, key) DO UPDATE SET value = excluded.value
  `).run(uuid(), user, PLANNER_PREFERENCES_KEY, JSON.stringify(preferences));
  return preferences;
}

function isoDate(value, field = 'date') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${field} is not a valid date`);
  }
  return text;
}

function addIsoDays(value, days) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  return Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000);
}

function validateRange(startValue, endValue) {
  const startDate = isoDate(startValue, 'start');
  const endDate = isoDate(endValue, 'end');
  const span = daysBetween(startDate, endDate);
  if (span <= 0) throw new Error('end must be after start');
  if (span > MAX_RANGE_DAYS) throw new Error(`Planner range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { startDate, endDate, span };
}

function dateTimeParts(value, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function formatDateInZone(value, timeZone = TIME_ZONE) {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatTimeInZone(value, timeZone = TIME_ZONE) {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

function zonedDateTimeToIso(dateValue, timeValue = '00:00', timeZone = TIME_ZONE) {
  const date = isoDate(dateValue);
  const time = String(timeValue || '').trim();
  const match = time.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error('time must be HH:MM');
  const [year, month, day] = date.split('-').map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error('time is not valid');

  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  for (let i = 0; i < 3; i += 1) {
    const parts = dateTimeParts(guess, timeZone);
    const represented = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = desired - represented;
    guess += correction;
    if (!correction) break;
  }
  return new Date(guess).toISOString();
}

function normaliseDuration(value, fallback = DEFAULT_DURATION_MINUTES) {
  const parsed = Number.parseInt(value, 10);
  const duration = Number.isFinite(parsed) ? parsed : fallback;
  if (duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    throw new Error(`durationMinutes must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`);
  }
  return Math.ceil(duration / 15) * 15;
}

function parseLocalStart(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/);
  if (!match) throw new Error('startAt must be YYYY-MM-DDTHH:MM');
  const date = isoDate(match[1], 'startAt date');
  zonedDateTimeToIso(date, match[2]);
  return { date, time: match[2], value: `${date}T${match[2]}` };
}

function localEndFor(start, durationMinutes) {
  const utc = zonedDateTimeToIso(start.date, start.time);
  const end = new Date(new Date(utc).getTime() + durationMinutes * 60000);
  return {
    date: formatDateInZone(end),
    time: formatTimeInZone(end),
    value: `${formatDateInZone(end)}T${formatTimeInZone(end)}`,
  };
}

function isNotFoundError(error) {
  return error?.code === 404 || error?.response?.status === 404
    || /not\s*found/i.test(String(error?.message || ''));
}

function recordPlannerEffect(user, task, action, details = {}, status = 'done') {
  try {
    db.hub().prepare(`
      INSERT INTO knowledge_receipts
        (id, user, source_kind, source_id, stage, status, summary, payload, model_key, model_id, created_at)
      VALUES (?, ?, 'google_task', ?, 'calendar_planner_effect', ?, ?, ?, NULL, NULL, unixepoch())
    `).run(
      uuid(), user, task.id, status,
      `${PLANNER_ORIGIN} ${action}: ${String(task.title || '').slice(0, 160)}`,
      JSON.stringify({
        origin: PLANNER_ORIGIN,
        action,
        task_id: task.id,
        google_task_id: task.google_task_id,
        title: task.title,
        ...details,
      }),
    );
  } catch (error) {
    console.error('[task-planner] receipt failed:', error.message);
  }
}

function plannerMeetingForTask(user, taskId) {
  return db.hub().prepare(`
    SELECT * FROM meetings
     WHERE user = ? AND source = ? AND source_id = ?
     ORDER BY created_at DESC LIMIT 1
  `).get(user, PLANNER_SOURCE, taskId);
}

function openPlannerTask(user, taskId) {
  return db.hub().prepare(`
    SELECT * FROM google_tasks
     WHERE id = ? AND user = ? AND status = 'needsAction' AND deleted_at IS NULL
  `).get(taskId, user);
}

function normaliseCalendarEvent(event, meeting = null) {
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  const privateProperties = event.extendedProperties?.private || {};
  const taskId = meeting?.source === PLANNER_SOURCE
    ? meeting.source_id
    : (privateProperties.hubSource === PLANNER_SOURCE ? privateProperties.hubTaskId : null);
  const startAt = allDay ? null : new Date(event.start.dateTime).toISOString();
  const endAt = allDay ? null : new Date(event.end?.dateTime || event.start.dateTime).toISOString();
  const date = allDay ? event.start.date : formatDateInZone(startAt);
  const endDate = allDay ? (event.end?.date || addIsoDays(date, 1)) : formatDateInZone(endAt);
  const time = allDay ? null : formatTimeInZone(startAt);
  const endTime = allDay ? null : formatTimeInZone(endAt);
  return {
    id: event.id,
    title: event.summary || '(untitled)',
    description: event.description || '',
    location: event.location || '',
    date,
    endDate,
    time,
    endTime,
    startAt,
    endAt,
    durationMinutes: allDay ? null : Math.max(15, Math.round((new Date(endAt) - new Date(startAt)) / 60000)),
    allDay,
    transparency: event.transparency || 'opaque',
    taskId: taskId || null,
    isTask: Boolean(taskId),
    htmlLink: event.htmlLink || '',
  };
}

async function findRemotePlannerEvent(calendar, taskId) {
  const response = await calendar.events.list({
    calendarId: 'primary',
    privateExtendedProperty: `hubTaskId=${taskId}`,
    showDeleted: false,
    singleEvents: true,
    maxResults: 10,
  });
  return (response.data.items || []).find(event =>
    event.status !== 'cancelled'
    && event.extendedProperties?.private?.hubSource === PLANNER_SOURCE
    && event.extendedProperties?.private?.hubTaskId === taskId
  ) || null;
}

function mirrorPlannerEvent(user, task, event) {
  const normalised = normaliseCalendarEvent(event, { source: PLANNER_SOURCE, source_id: task.id });
  upsertPlannerMeeting(user, {
    title: task.title,
    date: normalised.date,
    time: normalised.time,
    durationMins: normalised.durationMinutes,
    location: normalised.location,
    notes: normalised.description,
    calendarEventId: event.id,
    source: PLANNER_SOURCE,
    sourceId: task.id,
  });
  return normalised;
}

function upsertPlannerMeeting(user, event) {
  const meetingId = upsertMeetingRow(user, {
    ...event,
    source: PLANNER_SOURCE,
  });
  db.hub().prepare(`
    UPDATE meetings SET source = ?, source_id = ? WHERE id = ? AND user = ?
  `).run(PLANNER_SOURCE, event.sourceId, meetingId, user);
  return meetingId;
}

async function listPlannerCalendarEvents(user, { startDate, endDate }, { calendarClient = null, reconcileCache = true } = {}) {
  const range = validateRange(startDate, endDate);
  const calendar = calendarClient || getCalendarClient(user);
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: zonedDateTimeToIso(range.startDate, '00:00'),
    timeMax: zonedDateTimeToIso(range.endDate, '00:00'),
    timeZone: TIME_ZONE,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });
  const rawEvents = (response.data.items || []).filter(event => event.status !== 'cancelled' && (event.start?.dateTime || event.start?.date));
  const hub = db.hub();
  const meetingRows = hub.prepare(`
    SELECT id, calendar_event_id, source, source_id
      FROM meetings
     WHERE user = ? AND meeting_date >= ? AND meeting_date < ?
       AND calendar_event_id IS NOT NULL
  `).all(user, range.startDate, range.endDate);
  const meetingsByEvent = new Map(meetingRows.map(row => [row.calendar_event_id, row]));
  const events = rawEvents.map(event => normaliseCalendarEvent(event, meetingsByEvent.get(event.id)));
  if (reconcileCache) {
    const remoteIds = new Set(rawEvents.map(event => event.id));
    const rowsToDelete = [];
    const eventsToMirror = events.filter(event => event.isTask && event.taskId);
    for (const row of meetingRows) {
      if (row.source !== PLANNER_SOURCE || remoteIds.has(row.calendar_event_id)) continue;
      try {
        const response = await calendar.events.get({ calendarId: 'primary', eventId: row.calendar_event_id });
        if (response.data.status === 'cancelled') rowsToDelete.push(row);
        else eventsToMirror.push(normaliseCalendarEvent(response.data, row));
      } catch (error) {
        if (isNotFoundError(error)) rowsToDelete.push(row);
        else throw error;
      }
    }
    hub.transaction(() => {
      for (const row of rowsToDelete) {
        hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(row.id);
        hub.prepare('DELETE FROM meetings WHERE id = ? AND user = ? AND source = ?').run(row.id, user, PLANNER_SOURCE);
      }
      for (const event of eventsToMirror) {
        upsertPlannerMeeting(user, {
          title: event.title, date: event.date, time: event.time,
          durationMins: event.durationMinutes, location: event.location,
          notes: event.description, calendarEventId: event.id,
          sourceId: event.taskId,
        });
      }
    })();
  }
  return events;
}

function taskPriorityRank(task) {
  return ({ high: 0, medium: 1, low: 2 })[task.priority] ?? 3;
}

function taskPlanningDuration(task) {
  return normaliseDuration(task.effort_minutes || DEFAULT_DURATION_MINUTES);
}

function scheduledTaskIds(user) {
  return new Set(db.hub().prepare(`
    SELECT source_id FROM meetings
     WHERE user = ? AND source = ? AND source_id IS NOT NULL
  `).all(user, PLANNER_SOURCE).map(row => row.source_id));
}

async function getPlannerSnapshot(user, { startDate, endDate }, options = {}) {
  const range = validateRange(startDate, endDate);
  const tasks = getCachedTasks(user, {}, false);
  const selectedTasks = tasks.filter(task => ['work', 'personal'].includes(task.planner_lane));
  const events = await listPlannerCalendarEvents(user, range, options);
  const scheduledIds = scheduledTaskIds(user);
  for (const event of events) if (event.taskId) scheduledIds.add(event.taskId);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  for (const event of events) {
    if (!event.taskId) continue;
    event.task = taskById.get(event.taskId) || null;
    event.durationMinutes = event.task ? taskPlanningDuration(event.task) : event.durationMinutes;
  }
  const unscheduledTasks = selectedTasks
    .filter(task => !scheduledIds.has(task.id))
    .sort((a, b) => {
      const aDue = a.due ? String(a.due).slice(0, 10) : '9999-12-31';
      const bDue = b.due ? String(b.due).slice(0, 10) : '9999-12-31';
      return aDue.localeCompare(bDue)
        || taskPriorityRank(a) - taskPriorityRank(b)
        || (a.created_at || 0) - (b.created_at || 0);
    })
    .map(task => ({ ...task, planningDurationMinutes: taskPlanningDuration(task) }));
  const days = Array.from({ length: range.span }, (_, index) => {
    const date = addIsoDays(range.startDate, index);
    const value = new Date(`${date}T12:00:00Z`);
    return {
      date,
      label: new Intl.DateTimeFormat('en-IE', { weekday: 'short', timeZone: 'UTC' }).format(value),
      dayNumber: Number(date.slice(8, 10)),
      monthLabel: new Intl.DateTimeFormat('en-IE', { month: 'short', timeZone: 'UTC' }).format(value),
    };
  });
  return {
    ...range,
    days,
    events,
    tasks,
    selectedTasks,
    unscheduledTasks,
    scheduledCount: selectedTasks.length - unscheduledTasks.length,
    preferences: getPlannerPreferences(user),
  };
}

async function scheduleTask(user, taskId, { startAt, durationMinutes }, { calendarClient = null } = {}) {
  const task = openPlannerTask(user, taskId);
  if (!task) throw new Error('Open task not found');
  const taskTags = parseTaskTags(task.notes);
  if (!taskTags.planner_lane) throw new Error('Add this task to the planner before scheduling it');
  const start = parseLocalStart(startAt);
  const duration = normaliseDuration(durationMinutes);
  const end = localEndFor(start, duration);
  assertWithinPlannerWindow(taskTags.planner_lane, start, end, getPlannerPreferences(user));
  let existing = plannerMeetingForTask(user, task.id);
  const calendar = calendarClient || getCalendarClient(user);
  const description = [
    `Scheduled from McLellan Hub task ${task.id}.`,
    task.notes ? String(task.notes) : '',
  ].filter(Boolean).join('\n\n');

  try {
    if (!existing) {
      const remoteExisting = await findRemotePlannerEvent(calendar, task.id);
      if (remoteExisting) {
        mirrorPlannerEvent(user, task, remoteExisting);
        existing = plannerMeetingForTask(user, task.id);
      }
    }
    if (existing?.calendar_event_id) {
      const response = await calendar.events.patch({
        calendarId: 'primary',
        eventId: existing.calendar_event_id,
        requestBody: {
          summary: task.title,
          description,
          start: { dateTime: toRfc3339(start.value), timeZone: TIME_ZONE },
          end: { dateTime: toRfc3339(end.value), timeZone: TIME_ZONE },
          extendedProperties: { private: { hubSource: PLANNER_SOURCE, hubTaskId: task.id } },
        },
      });
      upsertPlannerMeeting(user, {
        title: task.title, date: start.date, time: start.time, durationMins: duration,
        location: '', notes: description, calendarEventId: existing.calendar_event_id,
        sourceId: task.id,
      });
      recordPlannerEffect(user, task, 'rescheduled', {
        calendar_event_id: existing.calendar_event_id,
        start_at: start.value,
        end_at: end.value,
      });
      return { event: normaliseCalendarEvent(response.data, { source: PLANNER_SOURCE, source_id: task.id }), created: false };
    }

    const created = await createCalendarEvent(user, {
      title: task.title,
      description,
      startAt: start.value,
      endAt: end.value,
      source: PLANNER_SOURCE,
      sourceId: task.id,
      extendedProperties: { private: { hubSource: PLANNER_SOURCE, hubTaskId: task.id } },
      calendarClient: calendar,
    });
    if (!created?.id) throw new Error('Calendar did not return an event ID');
    recordPlannerEffect(user, task, 'scheduled', {
      calendar_event_id: created.id,
      start_at: start.value,
      end_at: end.value,
    });
    return { event: normaliseCalendarEvent(created, { source: PLANNER_SOURCE, source_id: task.id }), created: true };
  } catch (error) {
    if (!existing) {
      try {
        const reconciled = await findRemotePlannerEvent(calendar, task.id);
        if (reconciled) {
          const event = mirrorPlannerEvent(user, task, reconciled);
          recordPlannerEffect(user, task, 'scheduled_reconciled', {
            calendar_event_id: reconciled.id,
            start_at: event.date && event.time ? `${event.date}T${event.time}` : start.value,
            provider_error: error.message,
          });
          return { event, created: true, reconciled: true };
        }
      } catch (reconcileError) {
        error.message = `${error.message}; reconciliation failed: ${reconcileError.message}`;
      }
    }
    recordPlannerEffect(user, task, existing ? 'reschedule_failed' : 'schedule_failed', {
      start_at: start.value,
      error: error.message,
    }, 'error');
    throw error;
  }
}

async function unscheduleTask(user, taskId, { calendarClient = null } = {}) {
  const task = db.hub().prepare('SELECT * FROM google_tasks WHERE id = ? AND user = ?').get(taskId, user);
  if (!task) throw new Error('Task not found');
  const meeting = plannerMeetingForTask(user, task.id);
  if (!meeting) return { removed: false };
  try {
    if (meeting.calendar_event_id) {
      const calendar = calendarClient || getCalendarClient(user);
      try {
        await calendar.events.delete({ calendarId: 'primary', eventId: meeting.calendar_event_id });
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    const hub = db.hub();
    hub.transaction(() => {
      hub.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(meeting.id);
      hub.prepare('DELETE FROM meetings WHERE id = ? AND user = ? AND source = ?').run(meeting.id, user, PLANNER_SOURCE);
    })();
    recordPlannerEffect(user, task, 'unscheduled', { calendar_event_id: meeting.calendar_event_id });
    return { removed: true };
  } catch (error) {
    recordPlannerEffect(user, task, 'unschedule_failed', {
      calendar_event_id: meeting.calendar_event_id,
      error: error.message,
    }, 'error');
    throw error;
  }
}

function minutesFromTime(value, field = 'time') {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`${field} must be HH:MM`);
  const result = Number(match[1]) * 60 + Number(match[2]);
  if (Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`${field} is not valid`);
  return result;
}

function timeFromMinutes(value) {
  const minutes = Math.max(0, Math.min(1439, Math.round(value)));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function eventBusyIntervals(events, date, workStart, workEnd) {
  return events
    .filter(event => event.transparency !== 'transparent' && (
      (event.allDay && event.date <= date && event.endDate > date)
      || (!event.allDay && event.date === date && event.time)
    ))
    .map(event => {
      if (event.allDay) return [workStart, workEnd];
      const start = Math.max(workStart, minutesFromTime(event.time));
      let end = event.endDate === date && event.endTime
        ? minutesFromTime(event.endTime)
        : workEnd;
      end = Math.min(workEnd, Math.max(start, end));
      return [start, end];
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
}

function firstFreeSlot(intervals, earliest, latest, duration) {
  let cursor = earliest;
  for (const [busyStart, busyEnd] of intervals) {
    if (busyEnd <= cursor) continue;
    if (busyStart - cursor >= duration) return cursor;
    cursor = Math.max(cursor, busyEnd);
  }
  return latest - cursor >= duration ? cursor : null;
}

function plannerWindowForDate(lane, date, preferences) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  if (lane === 'personal') {
    return weekend
      ? [minutesFromTime(preferences.weekendStart), minutesFromTime(preferences.weekendEnd)]
      : [minutesFromTime(preferences.eveningStart), minutesFromTime(preferences.eveningEnd)];
  }
  if (weekend) return null;
  return [minutesFromTime(preferences.workStart), minutesFromTime(preferences.workEnd)];
}

function assertWithinPlannerWindow(lane, start, end, preferences) {
  if (start.date !== end.date) throw new Error('Task blocks must finish on the day they start');
  const window = plannerWindowForDate(lane, start.date, preferences);
  const laneLabel = lane === 'personal' ? 'Personal tasks' : 'Work tasks';
  if (!window) throw new Error(`${laneLabel} cannot be scheduled at weekends`);
  const startMinute = minutesFromTime(start.time);
  const endMinute = minutesFromTime(end.time);
  if (startMinute < window[0] || endMinute > window[1]) {
    const timing = lane === 'personal'
      ? (new Date(`${start.date}T12:00:00Z`).getUTCDay() % 6 === 0 ? 'weekend hours' : 'evening hours')
      : 'working hours';
    throw new Error(`${laneLabel} must fit inside ${timing} (${timeFromMinutes(window[0])}–${timeFromMinutes(window[1])})`);
  }
}

function computeAutoPlan({
  tasks, events, startDate, endDate,
  workStart, workEnd, eveningStart, eveningEnd, weekendStart, weekendEnd,
  preferences: preferenceInput = null,
  now = new Date(),
}) {
  const range = validateRange(startDate, endDate);
  const preferences = normalisePlannerPreferences(preferenceInput || {
    ...(workStart !== undefined && { workStart }),
    ...(workEnd !== undefined && { workEnd }),
    ...(eveningStart !== undefined && { eveningStart }),
    ...(eveningEnd !== undefined && { eveningEnd }),
    ...(weekendStart !== undefined && { weekendStart }),
    ...(weekendEnd !== undefined && { weekendEnd }),
  });
  const nowDate = formatDateInZone(now);
  const nowMinute = Number(formatTimeInZone(now).slice(0, 2)) * 60 + Number(formatTimeInZone(now).slice(3, 5));
  const plannedEvents = [...events];
  const placements = [];
  const unplaced = [];
  const ordered = [...tasks].sort((a, b) => {
    const aDue = a.due ? String(a.due).slice(0, 10) : '9999-12-31';
    const bDue = b.due ? String(b.due).slice(0, 10) : '9999-12-31';
    return aDue.localeCompare(bDue) || taskPriorityRank(a) - taskPriorityRank(b) || (a.created_at || 0) - (b.created_at || 0);
  });

  for (const task of ordered) {
    const duration = taskPlanningDuration(task);
    const lane = task.planner_lane === 'personal' ? 'personal' : 'work';
    const earliestFeasibleDate = nowDate > range.startDate ? nowDate : range.startDate;
    const dueDate = task.due ? String(task.due).slice(0, 10) : null;
    const dueLimit = dueDate && dueDate > earliestFeasibleDate ? dueDate : (dueDate ? earliestFeasibleDate : null);
    let placed = null;
    for (let index = 0; index < range.span; index += 1) {
      const date = addIsoDays(range.startDate, index);
      if (dueLimit && date > dueLimit) continue;
      const window = plannerWindowForDate(lane, date, preferences);
      if (!window) continue;
      const [windowStart, windowEnd] = window;
      let earliest = windowStart;
      if (date < nowDate) continue;
      if (date === nowDate) earliest = Math.max(earliest, Math.ceil(nowMinute / 15) * 15);
      const intervals = eventBusyIntervals(plannedEvents, date, windowStart, windowEnd);
      const slot = firstFreeSlot(intervals, earliest, windowEnd, duration);
      if (slot === null) continue;
      const end = slot + duration;
      placed = {
        taskId: task.id,
        title: task.title,
        startAt: `${date}T${timeFromMinutes(slot)}`,
        endAt: `${date}T${timeFromMinutes(end)}`,
        durationMinutes: duration,
        lane,
      };
      placements.push(placed);
      plannedEvents.push({
        date, endDate: date, time: timeFromMinutes(slot), endTime: timeFromMinutes(end),
        allDay: false, transparency: 'opaque', taskId: task.id,
      });
      break;
    }
    if (!placed) {
      const windowLabel = lane === 'personal' ? 'evening or weekend time' : 'working hours';
      unplaced.push({ taskId: task.id, title: task.title, reason: `No free ${windowLabel} before its due date in this range` });
    }
  }
  return { placements, unplaced };
}

async function autoPlanTasks(user, options = {}, dependencies = {}) {
  const range = validateRange(options.startDate, options.endDate);
  const snapshot = await getPlannerSnapshot(user, range, dependencies);
  const preferences = getPlannerPreferences(user);
  const plan = computeAutoPlan({
    tasks: snapshot.unscheduledTasks,
    events: snapshot.events,
    ...range,
    preferences,
  });
  const scheduled = [];
  const failed = [];
  for (const placement of plan.placements) {
    try {
      await scheduleTask(user, placement.taskId, placement, dependencies);
      scheduled.push(placement);
    } catch (error) {
      failed.push({ ...placement, error: error.message });
    }
  }
  return { scheduled, failed, unplaced: plan.unplaced };
}

module.exports = {
  TIME_ZONE,
  PLANNER_SOURCE,
  DEFAULT_DURATION_MINUTES,
  DEFAULT_PLANNER_PREFERENCES,
  PLANNER_PREFERENCES_KEY,
  addIsoDays,
  validateRange,
  zonedDateTimeToIso,
  normaliseDuration,
  normaliseCalendarEvent,
  findRemotePlannerEvent,
  listPlannerCalendarEvents,
  getPlannerSnapshot,
  getPlannerPreferences,
  savePlannerPreferences,
  normalisePlannerPreferences,
  scheduleTask,
  unscheduleTask,
  computeAutoPlan,
  autoPlanTasks,
  _test: {
    formatDateInZone,
    formatTimeInZone,
    parseLocalStart,
    localEndFor,
    minutesFromTime,
    timeFromMinutes,
    firstFreeSlot,
    eventBusyIntervals,
    taskPlanningDuration,
    plannerWindowForDate,
    assertWithinPlannerWindow,
  },
};
