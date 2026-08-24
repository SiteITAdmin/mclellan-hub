'use strict';

function hhmm(value) {
  const text = value?.local || value?.utc || '';
  const match = String(text).match(/[T\s](\d{2}:\d{2})(?::\d{2})?/)
    || String(text).match(/^(\d{2}:\d{2})(?::\d{2})?/);
  return match?.[1] || '';
}

const MAX_PLAUSIBLE_DELAY_MINUTES = 6 * 60;

function delayMinutes(scheduled, actual) {
  const scheduledMatch = String(scheduled || '').match(/^(\d{1,2}):(\d{2})$/);
  const actualMatch = String(actual || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!scheduledMatch || !actualMatch) return null;
  const scheduledMins = Number(scheduledMatch[1]) * 60 + Number(scheduledMatch[2]);
  const actualMins = Number(actualMatch[1]) * 60 + Number(actualMatch[2]);
  let diff = actualMins - scheduledMins;
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return diff;
}

// A 1-hour hop cannot be 10 hours "early". That pattern is the live lookup
// answering a different day's FR812 after a check-in reminder was imported
// as if it were the flight.
function actualsMatchSchedule(scheduledDep, actualDep, scheduledArr, actualArr) {
  const depDelay = delayMinutes(scheduledDep, actualDep);
  const arrDelay = delayMinutes(scheduledArr, actualArr);
  if (depDelay !== null && Math.abs(depDelay) > MAX_PLAUSIBLE_DELAY_MINUTES) return false;
  if (arrDelay !== null && Math.abs(arrDelay) > MAX_PLAUSIBLE_DELAY_MINUTES) return false;
  return true;
}

function extractFlightState(record, fallbackStatus = 'scheduled') {
  const rawStatus = String(record?.status || '').toLowerCase();
  const landed = rawStatus.includes('landed') || rawStatus.includes('arrived');
  const cancelled = rawStatus.includes('cancel');
  const diverted = rawStatus.includes('diverted');
  const departed = landed
    || diverted
    || rawStatus.includes('departed')
    || rawStatus.includes('en route')
    || rawStatus.includes('enroute');

  const status = landed ? 'completed'
    : cancelled ? 'cancelled'
    : diverted ? 'diverted'
    : fallbackStatus;

  const departureActual = record?.departure?.actualTime
    || record?.departure?.runway?.actualTime
    || record?.departure?.runwayTime
    || (departed ? record?.departure?.revisedTime : null);
  const arrivalActual = record?.arrival?.actualTime
    || record?.arrival?.runway?.actualTime
    || record?.arrival?.runwayTime
    || (landed ? record?.arrival?.revisedTime : null);

  return {
    status,
    resolved: landed || cancelled || diverted,
    actualDep: hhmm(departureActual),
    actualArr: hhmm(arrivalActual),
    scheduledDep: hhmm(record?.departure?.scheduledTime),
    scheduledArr: hhmm(record?.arrival?.scheduledTime),
  };
}

module.exports = {
  extractFlightState,
  hhmm,
  delayMinutes,
  actualsMatchSchedule,
  MAX_PLAUSIBLE_DELAY_MINUTES,
};
