'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyError, errorSignature } = require('../lib/repair-reproducer');
const { triageDeterministic, withinAllowedScope } = require('../lib/repair-triage');

function reproducerFixture(overrides = {}) {
  return {
    id: 'repair-test-fixture',
    error_class: 'response_shape_guard',
    error_signature: 'response_shape_guard::Email classifier response',
    error: { message: 'Email classifier response must be a JSON object' },
    triggering_input: { label: 'Email classifier response' },
    model_usage: [
      { model_key: 'email-classifier', model_id: 'z-ai/glm-5.2', calls: 40 },
    ],
    classification: { fixable: true, verdict_hint: null },
    history: { everFixed: false, failedRecently: false, attempts: 0 },
    reproduction: { deterministic: false, synthetic_test: 'data/repair-queue/x.gate1.test.js' },
    constraints: {
      max_files_changed: 3,
      allowed_paths: ['lib/email-processor.js'],
      forbidden: ['package.json', 'lib/db.js', 'config/', 'data/', '.env'],
    },
    ...overrides,
  };
}

test('classifyError recognises the fixable-narrow classes', () => {
  assert.equal(classifyError('Email classifier response must be a JSON object').error_class, 'response_shape_guard');
  assert.equal(classifyError("Cannot read properties of null (reading 'replace')").error_class, 'undefined_field_access');
  assert.equal(classifyError('rows.map is not a function').error_class, 'missing_null_guard');
});

test('classifyError routes model garbage and infra noise away from code repair', () => {
  const garbage = classifyError('Newsletter extraction response was not valid JSON: Unterminated string in JSON at position 16250');
  assert.equal(garbage.error_class, 'json_parse_failure');
  assert.equal(garbage.verdictHint, 'config_fix');

  const schema = classifyError('no such column: google_task_list_id');
  assert.equal(schema.error_class, 'schema_error');
  assert.equal(schema.verdictHint, 'escalate');

  const timeout = classifyError('The operation was aborted due to timeout');
  assert.equal(timeout.verdictHint, 'skip');
});

test('errorSignature collapses log-line wrappers onto the bare failure', () => {
  const bare = classifyError('Email classifier response must be a JSON object');
  const wrapped = classifyError('[email] classify error for message 19f4226905401617: Email classifier response must be a JSON object');
  assert.equal(
    errorSignature(bare.error_class, 'Email classifier response must be a JSON object', bare.label),
    errorSignature(wrapped.error_class, '[email] classify error for message 19f4226905401617: Email classifier response must be a JSON object', wrapped.label),
  );
});

test('triage marks the email classifier shape error fixable-narrow', () => {
  const verdict = triageDeterministic(reproducerFixture());
  assert.equal(verdict.verdict, 'fixable-narrow');
  // Only one model has served the slot — triage must flag shared blame.
  assert.match(verdict.reason, /config_suspect/);
});

test('triage sends model garbage to config_fix, not code repair', () => {
  const verdict = triageDeterministic(reproducerFixture({
    error_class: 'json_parse_failure',
    classification: { fixable: false, verdict_hint: 'config_fix' },
  }));
  assert.equal(verdict.verdict, 'config_fix');
});

test('triage escalates judgment-shaped and schema errors', () => {
  const schema = triageDeterministic(reproducerFixture({
    error_class: 'schema_error',
    classification: { fixable: false, verdict_hint: 'escalate' },
  }));
  assert.equal(schema.verdict, 'escalate');

  const unclassified = triageDeterministic(reproducerFixture({
    error_class: 'unclassified',
    classification: { fixable: false, verdict_hint: 'escalate' },
  }));
  assert.equal(unclassified.verdict, 'escalate');
});

test('triage escalates on recurrence — a fixed error that returns means the fix was wrong', () => {
  const verdict = triageDeterministic(reproducerFixture({
    history: { everFixed: true, failedRecently: false, attempts: 1 },
  }));
  assert.equal(verdict.verdict, 'escalate');
  assert.match(verdict.reason, /recurred/);
});

test('triage escalates when scope cannot be confined', () => {
  const noFiles = triageDeterministic(reproducerFixture({
    constraints: { max_files_changed: 3, allowed_paths: [], forbidden: [] },
  }));
  assert.equal(noFiles.verdict, 'escalate');

  const forbidden = triageDeterministic(reproducerFixture({
    constraints: { max_files_changed: 3, allowed_paths: ['lib/db.js'], forbidden: ['lib/db.js'] },
  }));
  assert.equal(forbidden.verdict, 'escalate');

  const outsideLib = triageDeterministic(reproducerFixture({
    constraints: { max_files_changed: 3, allowed_paths: ['routes/hub-admin.js'], forbidden: [] },
  }));
  assert.equal(outsideLib.verdict, 'escalate');
});

test('triage escalates when there is no reproduction path', () => {
  const verdict = triageDeterministic(reproducerFixture({
    reproduction: { deterministic: false, synthetic_test: null },
  }));
  assert.equal(verdict.verdict, 'escalate');
  assert.match(verdict.reason, /reproduction/);
});

test('triage skips transient infra noise', () => {
  const verdict = triageDeterministic(reproducerFixture({
    error_class: 'transient_network',
    classification: { fixable: false, verdict_hint: 'skip' },
  }));
  assert.equal(verdict.verdict, 'skip');
});

test('withinAllowedScope enforces the file budget', () => {
  const over = withinAllowedScope(reproducerFixture({
    constraints: {
      max_files_changed: 3,
      allowed_paths: ['lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/d.js'],
      forbidden: [],
    },
  }));
  assert.equal(over.ok, false);
});
