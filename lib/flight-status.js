'use strict';

function hhmm(value) {
  const text = value?.local || value?.utc || '';
  const match = String(text).match(/[T\s](\d{2}:\d{2})(?::\d{2})?/)
    || String(text).match(/^(\d{2}:\d{2})(?::\d{2})?/);
  return match?.[1] || '';
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

module.exports = { extractFlightState, hhmm };
