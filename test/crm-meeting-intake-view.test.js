'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

const view = path.join(__dirname, '..', 'views', 'hub', 'crm-meeting-intake.ejs');

function intake(id, status) {
  return {
    id,
    status,
    title: 'Client transcript',
    transcript: 'The complete preserved meeting transcript.',
    extraction: JSON.stringify({ intake_options: {} }),
    created_counts: '{}',
    created_at: Math.floor(Date.now() / 1000) - 1000,
    meeting_id: null,
    project_slug: null,
    source_filename: null,
    summary: null,
    error: null,
  };
}

async function render(activeIntake, activeIntakeStaleProcessing) {
  return ejs.renderFile(view, {
    nav: [], query: {}, meetings: [], projects: [], companies: [], projectContacts: [], allContacts: [],
    recent: [activeIntake],
    activeIntake,
    staleProcessingIntakeIds: activeIntakeStaleProcessing ? [activeIntake.id] : [],
    activeIntakeStaleProcessing,
  });
}

test('a stale processing meeting intake is reviewable and offers a retry', async () => {
  const stale = intake('stale-processing-intake', 'processing');
  const html = await render(stale, true);
  assert.match(html, /The earlier processing lease expired/);
  assert.match(html, /Retry CRM processing/);
  assert.match(html, new RegExp(`/crm/meeting-intake/${stale.id}/save`));
  assert.match(html, new RegExp(`data-intake-id="${stale.id}"`));
});

test('a live processing meeting intake exposes no retry, edit, or delete controls', async () => {
  const live = intake('live-processing-intake', 'processing');
  const html = await render(live, false);
  assert.doesNotMatch(html, /Retry CRM processing/);
  assert.doesNotMatch(html, new RegExp(`/crm/meeting-intake/${live.id}/update`));
  assert.doesNotMatch(html, new RegExp(`data-intake-id="${live.id}"`));
});
