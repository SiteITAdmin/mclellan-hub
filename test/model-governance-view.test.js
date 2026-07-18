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
    effectivenessReportPath: '/app/data/model-effectiveness-review.json',
    effectivenessReport: {
      generated_at: '2026-07-18T13:00:00.000Z',
      month: '2026-07',
      reason: 'test',
      primary_reviewer: { key: 'luna', label: 'OpenAI GPT-5.6 Luna', resolvedModelId: 'openai/gpt-5.6-luna' },
      secondary_reviewers: [
        { key: 'grok', label: 'xAI Grok 4.5', resolvedModelId: 'x-ai/grok-4.5' },
        { key: 'sonnet', label: 'Anthropic Claude Sonnet 5', resolvedModelId: 'anthropic/claude-sonnet-5' },
      ],
      benchmark_dossier: { status: 'available', sources: [{ title: 'Independent benchmark', url: 'https://artificialanalysis.ai/test', checked_at: '2026-07-18T12:00:00.000Z' }] },
      email: { status: 'sent' },
      summary: { scored_count: 1, mean_score: 68, appeal_count: 1, unanimous_recommendation_count: 1, insufficient_evidence_count: 0 },
      evidence: [{
        feature: 'worker', label: 'Worker', group: { label: 'Workers' }, model_id: 'acme/old',
        observed: { direct_call_count: 12, receipt_count: 4 },
        admin_links: { system_slot: '/admin/models/system#sys-worker', prompt: '/admin/models/prompts#prompt-worker' },
      }],
      reviews: [{
        feature: 'worker', evidence_status: 'sufficient', total_score: 68, band: 'needs review',
        rationale: 'Retries are too frequent.', recommendation: 'Tighten the output contract.',
      }],
      appeals: [{
        feature: 'worker', unanimous: true, agreed_failure_category: 'reliability', agreed_remedy_class: 'prompt_revision',
        primary: { total_score: 68, reviewer: { label: 'OpenAI GPT-5.6 Luna' }, recommendation: 'Tighten the output contract.' },
        secondary: [
          { total_score: 67, reviewer: { label: 'xAI Grok 4.5' } },
          { total_score: 66, reviewer: { label: 'Anthropic Claude Sonnet 5' } },
        ],
      }],
    },
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
  assert.match(html, /OpenAI GPT-5\.6 Luna/);
  assert.match(html, /Unanimous recommendations/);
  assert.match(html, /68\/100/);
});
