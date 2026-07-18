const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');

test('prompt and model review admin page renders a compiled report', async () => {
  const view = path.join(__dirname, '..', 'views', 'hub-admin', 'models-review.ejs');
  const html = await ejs.renderFile(view, {
    user: 'douglas',
    message: 'Review completed.',
    error: null,
    reportPath: '/app/data/model-governance-review.json',
    report: {
      generated_at: '2026-07-18T12:00:00.000Z',
      catalog_model_count: 439,
      admin_locations: {},
      summary: { slot_count: 1, error_count: 1, warning_count: 0, auto_installable_count: 1 },
      run: {
        reason: 'test', inserted_disabled_count: 1,
        installations: [{ model_id: 'acme/new', action: 'inserted_disabled' }],
      },
      issues: [{
        severity: 'error', feature: 'worker', message: 'Model unavailable',
        recommendations: [{ id: 'acme/new', score: 0.9, confidence: 'high' }],
        admin_links: { system_slot: '/admin/models/system#sys-worker', prompt: '/admin/models/prompts#prompt-worker', catalogue: '/admin/models' },
      }],
      slots: [{
        feature: 'worker', group: { label: 'Workers' }, effective_model_id: 'acme/old', live_health: 'unavailable',
        admin_links: { system_slot: '/admin/models/system#sys-worker', prompt: '/admin/models/prompts#prompt-worker' },
      }],
    },
  });
  assert.match(html, /Prompt &amp; model review/);
  assert.match(html, /Review completed\./);
  assert.match(html, /acme\/new/);
  assert.match(html, /added disabled/);
});
