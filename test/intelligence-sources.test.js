'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../lib/db');
const { uuid } = require('../lib/id');
const { isApprovedExternalEmail } = require('../lib/newsletter-pipeline');

const USER = `intel-source-test-${Date.now()}`;

test.after(() => {
  db.hub().prepare('DELETE FROM intel_sources WHERE user = ?').run(USER);
});

test('external intelligence requires an approved source or resource label', () => {
  const email = {
    fromName: 'Example Briefing',
    fromEmail: 'briefing@example.com',
    subject: 'Daily briefing',
  };

  assert.equal(isApprovedExternalEmail(USER, email), false);
  assert.equal(isApprovedExternalEmail(USER, email, 'Resources/Newsletters'), true);
  assert.equal(isApprovedExternalEmail(USER, email), true);
});

test('an unrelated daily report is not admitted by subject wording alone', () => {
  assert.equal(isApprovedExternalEmail(USER, {
    fromName: 'Internal System',
    fromEmail: `internal-${uuid()}@example.net`,
    subject: 'Daily Report',
  }), false);
});
