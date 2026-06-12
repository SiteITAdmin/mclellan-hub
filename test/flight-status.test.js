'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractFlightState } = require('../lib/flight-status');

const time = value => ({ local: `2026-06-13 ${value}+01:00` });

test('scheduled revised times are not stored as actual times', () => {
  const state = extractFlightState({
    status: 'Scheduled',
    departure: { scheduledTime: time('21:55'), revisedTime: time('22:10') },
    arrival: { scheduledTime: time('23:05'), revisedTime: time('23:20') },
  });
  assert.equal(state.actualDep, '');
  assert.equal(state.actualArr, '');
  assert.equal(state.status, 'scheduled');
});

test('landed flight uses verified actual fields and resolved revised fallback', () => {
  const state = extractFlightState({
    status: 'Arrived',
    departure: { scheduledTime: time('06:10'), runwayTime: time('06:11') },
    arrival: { scheduledTime: time('07:20'), revisedTime: time('06:58') },
  });
  assert.equal(state.actualDep, '06:11');
  assert.equal(state.actualArr, '06:58');
  assert.equal(state.status, 'completed');
  assert.equal(state.resolved, true);
});

test('departed flight may record departure but not estimated arrival', () => {
  const state = extractFlightState({
    status: 'En route',
    departure: { revisedTime: time('06:11') },
    arrival: { revisedTime: time('06:58') },
  });
  assert.equal(state.actualDep, '06:11');
  assert.equal(state.actualArr, '');
  assert.equal(state.resolved, false);
});
