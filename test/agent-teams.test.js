const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTokenBurnAudit } = require('../lib/token-burn-auditor');
const {
  CAPOS,
  UNDERBOSSES,
} = require('../lib/hub-agent-roster');

const {
  capoChecks,
  writeUnderbossReceipt,
} = require('../lib/hub-family-agents');

const {
  buildConsigliereAudit,
  sourceFamily,
  subordinateChallenge,
} = require('../lib/hub-consigliere-agent');

const {
  buildResearchChecks,
  buildDraftCriticChecks,
  buildArtifactChecks,
  buildManagingEditorChecks,
} = require('../lib/linkedin-agent-team');

test('token burn auditor fails stale imported data and stale OpenRouter exports', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const summary = {
    importedRows: [
      { date: '2026-07-01', codex_tokens: 10, claude_code_tokens: 20, antigravity_tokens: 0, api_tokens: 5 },
    ],
    firstDate: '2026-07-01',
    lastDate: '2026-07-01',
    importedExact: 35,
    liveExact: 0,
    liveRows: [],
    liveCost: 0,
    openRouterExportAgeDays: 7,
    openRouter: { export_last_at: '2026-07-01T00:00:00Z' },
    openRouterLive: { fetched_at: '2026-07-01T00:00:00Z' },
  };

  const audit = buildTokenBurnAudit('douglas', summary, now);

  assert.equal(audit.verdict, 'fail');
  assert.equal(audit.checks.find(c => c.name === 'latest_import_fresh').verdict, 'fail');
  assert.equal(audit.checks.find(c => c.name === 'openrouter_activity_source_fresh').verdict, 'fail');
  assert.equal(audit.checks.find(c => c.name === 'hub_request_logs_visible').verdict, 'warn');
});

test('token burn auditor accepts fresh OpenRouter management summary over stale CSV export', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const summary = {
    importedRows: [
      { date: '2026-07-08', codex_tokens: 10, claude_code_tokens: 20, antigravity_tokens: 0, api_tokens: 5 },
    ],
    firstDate: '2026-07-08',
    lastDate: '2026-07-08',
    importedExact: 35,
    liveExact: 100,
    liveRows: [{ date: '2026-07-08', tokens_in: 50, tokens_out: 50 }],
    liveCost: 0.01,
    openRouterExportAgeDays: 33,
    openRouter: { export_last_at: '2026-06-05T00:00:00Z' },
    openRouterLive: {
      source: 'openrouter_management_api',
      fetched_at: '2026-07-08T11:00:00Z',
      tokens: 1000,
    },
  };

  const audit = buildTokenBurnAudit('douglas', summary, now);

  assert.equal(audit.verdict, 'pass');
  assert.equal(audit.checks.find(c => c.name === 'openrouter_activity_source_fresh').verdict, 'pass');
});

test('LinkedIn research agent requires primary source preservation and source evidence', () => {
  const checks = buildResearchChecks({
    synthesis: 'x'.repeat(250),
    sourceUrl: 'https://example.com/report',
    sources: [
      { title: 'Report', url: 'https://example.com/report', isPrimary: true, fullContent: 'source text' },
      { title: 'Second', url: 'https://example.com/2', snippet: 'snippet' },
      { title: 'Third', url: 'https://example.com/3', snippet: 'snippet' },
    ],
  });

  assert.equal(checks.find(c => c.name === 'research_synthesis_present').verdict, 'pass');
  assert.equal(checks.find(c => c.name === 'source_list_present').verdict, 'pass');
  assert.equal(checks.find(c => c.name === 'primary_source_preserved').verdict, 'pass');
});

test('LinkedIn draft critic warns on weak refinement but fails missing score', () => {
  const checks = buildDraftCriticChecks({
    draft: 'A'.repeat(250),
    refinedDraft: '',
    scoring: { axis_scores: { demonstrated_expertise: 4 }, top_fixes: [{ problem: 'Too generic' }] },
  });

  assert.equal(checks.find(c => c.name === 'draft_present').verdict, 'pass');
  assert.equal(checks.find(c => c.name === 'score_present').verdict, 'fail');
  assert.equal(checks.find(c => c.name === 'refinement_present').verdict, 'warn');
});

test('LinkedIn artifact agent rejects non-PDF buffers', () => {
  const checks = buildArtifactChecks({
    pdfBuffer: Buffer.from('not a pdf'),
    carouselUrl: '',
    carouselReviewed: false,
  });

  assert.equal(checks.find(c => c.name === 'pdf_header_valid').verdict, 'fail');
  assert.equal(checks.find(c => c.name === 'pdf_size_sane').verdict, 'fail');
  assert.equal(checks.find(c => c.name === 'drive_url_present').verdict, 'warn');
});

test('LinkedIn managing editor fails missing core stages and warns on optional artifacts', () => {
  const checks = buildManagingEditorChecks({
    post: {
      research: 'research',
      draft: 'draft',
      score_json: '{}',
      refined_draft: '',
      carousel_url: '',
      sheet_url: '',
    },
  });

  assert.equal(checks.find(c => c.name === 'research_present').verdict, 'pass');
  assert.equal(checks.find(c => c.name === 'score_present').verdict, 'fail');
  assert.equal(checks.find(c => c.name === 'carousel_present').verdict, 'warn');
});

test('Consigliere treats stale legacy source as superseded when fresh authoritative source exists', () => {
  const family = sourceFamily({
    name: 'openrouter_activity',
    label: 'OpenRouter activity',
    versions: [
      {
        name: 'management_api_live',
        label: 'OpenRouter management API live summary',
        present: true,
        authoritative: true,
        age_days: 0,
        evidence: 'fetched today',
      },
      {
        name: 'legacy_export',
        label: 'Legacy OpenRouter export',
        present: true,
        authoritative: false,
        age_days: 33,
        evidence: 'exported last month',
      },
    ],
  });

  assert.equal(family.verdict, 'pass');
  assert.equal(family.chosen_version, 'management_api_live');
  assert.deepEqual(family.superseded_stale_versions, ['legacy_export']);
  assert.equal(family.stale_only, false);
});

test('Consigliere fails stale-only source families and failed subordinate receipts', () => {
  const staleFamily = sourceFamily({
    name: 'daily_rows',
    label: 'Daily rows',
    versions: [
      {
        name: 'daily_burn_json',
        label: 'Daily burn JSON',
        present: true,
        authoritative: true,
        age_days: 10,
        evidence: 'latest row is old',
      },
    ],
  });
  const audit = buildConsigliereAudit('douglas', {
    nowMs: Date.parse('2026-07-08T12:00:00Z'),
    families: [staleFamily],
    subordinate: {
      name: 'subordinate_agent_receipts',
      label: 'Subordinate agent receipts',
      verdict: 'fail',
      evidence: '1 subordinate failed',
      recent: [],
    },
  });

  assert.equal(staleFamily.verdict, 'fail');
  assert.equal(audit.verdict, 'fail');
  assert.deepEqual(audit.stale_only_families, ['daily_rows']);
});

test('Consigliere challenges latest subordinate receipt per stage/source only', () => {
  const originalHub = require('../lib/db').hub;
  const db = require('../lib/db');
  db.hub = () => ({
    prepare: () => ({
      all: () => [
        {
          stage: 'agent:token_burn_auditor',
          source_kind: 'token_burn',
          source_id: 'dashboard',
          status: 'fail',
          summary: 'old failure',
          created_at: 100,
        },
        {
          stage: 'agent:token_burn_auditor',
          source_kind: 'token_burn',
          source_id: 'dashboard',
          status: 'pass',
          summary: 'new pass',
          created_at: 200,
        },
      ],
    }),
  });
  try {
    const result = subordinateChallenge('douglas');
    assert.equal(result.verdict, 'pass');
    assert.equal(result.recent.length, 1);
    assert.equal(result.recent[0].summary, 'new pass');
  } finally {
    db.hub = originalHub;
  }
});

test('agent family roster has CRM underboss and capos with soldiers and associates', () => {
  const crmUnderboss = UNDERBOSSES.find(u => u.key === 'crm_underboss');
  assert(crmUnderboss);
  assert(crmUnderboss.capos.includes('crm'));
  assert(crmUnderboss.capos.includes('knowledge'));
  assert(CAPOS.length >= 12);
  for (const capo of CAPOS) {
    assert(capo.key);
    assert(capo.title);
    assert(capo.reportsTo);
    assert(capo.soldiers.length > 0, `${capo.key} has no soldiers`);
    assert(capo.associates.length > 0, `${capo.key} has no associates`);
  }
});

test('capo checks report missing soldiers as failures', () => {
  const originalHub = require('../lib/db').hub;
  const db = require('../lib/db');
  db.hub = () => ({
    prepare: (sql) => ({
      get: (...params) => {
        if (String(sql).includes('system_jobs')) return null;
        if (String(sql).includes('email_summaries')) return { n: 0 };
        return { n: 0 };
      },
      all: () => [],
    }),
  });
  try {
    const checks = capoChecks('email', 'douglas', { now: 1783526400 });
    assert.equal(checks.find(c => c.name === 'email_process_pending').verdict, 'fail');
  } finally {
    db.hub = originalHub;
  }
});

test('CRM underboss receipt fails when one of its capos has not reported', () => {
  const originalHub = require('../lib/db').hub;
  const db = require('../lib/db');
  const writes = [];
  db.hub = () => ({
    prepare: (sql) => ({
      get: (...params) => {
        if (String(sql).includes('FROM knowledge_receipts')) {
          const capoKey = params[1];
          if (capoKey === 'email') return {
            status: 'pass',
            summary: 'Email Capo: PASS',
            created_at: 200,
          };
          return null;
        }
        return null;
      },
      run: (...params) => writes.push(params),
    }),
  });
  try {
    const underboss = UNDERBOSSES.find(u => u.key === 'crm_underboss');
    const { receipt } = writeUnderbossReceipt(underboss, 'douglas', { now: 1783526400 });
    assert.equal(receipt.verdict, 'fail');
    assert(receipt.checks.find(c => c.name === 'all_capos_reported').details.missing.includes('crm'));
    assert.equal(writes.length, 1);
  } finally {
    db.hub = originalHub;
  }
});
