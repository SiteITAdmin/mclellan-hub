const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTokenBurnAudit } = require('../lib/token-burn-auditor');
const {
  CAPOS,
  UNDERBOSSES,
} = require('../lib/hub-agent-roster');

const {
  capoChecks,
  documentsAwaitingTaskReview,
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

const {
  NAKAI_EXCLUDED_TARGETS,
  buildCapoQualityReview,
  buildCrmPeopleQualityReview,
  buildLinkedInQualityReview,
  buildMeetingIntakeQualityReview,
  buildTaskActionQualityReview,
  buildUnderbossQualityReview,
} = require('../lib/hub-quality-board');

const {
  buildDailyConsigliereReport,
  dailyConsigliereSection,
} = require('../lib/daily-consigliere-report');

test('token burn auditor fails stale imported data and stale OpenRouter exports', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const summary = {
    importedRows: [
      { date: '2026-07-01', codex_tokens: 10, claude_code_tokens: 20, antigravity_tokens: 0, grok_build_tokens: 0, api_tokens: 5 },
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
      { date: '2026-07-08', codex_tokens: 10, claude_code_tokens: 20, antigravity_tokens: 0, grok_build_tokens: 0, api_tokens: 5 },
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

test('LinkedIn quality board vetoes source-light or low-quality posts', () => {
  const review = buildLinkedInQualityReview({
    post: {
      research: '',
      draft: 'Generic thought.',
      refined_draft: 'This is a game changer. What do you think?',
      score_json: JSON.stringify({
        overall_score: 2.5,
        axis_scores: { demonstrated_expertise: 2 },
      }),
      carousel_url: '',
    },
    receipts: {
      'agent:linkedin_research': { id: 'r1', status: 'fail' },
      'agent:linkedin_draft_critic': { id: 'd1', status: 'warn' },
    },
  });

  assert.equal(review.verdict, 'fail');
  assert.equal(review.quality_veto, true);
  assert(review.blocking_checks.includes('research_is_source_backed'));
  assert(review.blocking_checks.includes('post_has_specific_voice'));
});

test('LinkedIn quality board passes strong sourced post with usable artifact', () => {
  const review = buildLinkedInQualityReview({
    post: {
      research: 'Evidence '.repeat(80),
      draft: 'Draft '.repeat(120),
      refined_draft: 'The practical lesson is that platform teams need explicit operating contracts before agent work is trusted in production. The useful move is not more autonomy; it is clearer evidence, ownership, escalation, and rollback paths, so each agent output can be challenged before it reaches customers or colleagues. This is especially true where research, cost, compliance, and public writing share the same workflow.',
      score_json: JSON.stringify({
        overall_score: 4.2,
        axis_scores: { demonstrated_expertise: 4, professional_positioning: 4 },
        recruiter_perspective: 'A hiring manager would see: senior technology leader, credible experience in platform governance, but unclear on team scale. Likely to prompt a conversation if hiring for transformation leadership.',
      }),
      carousel_url: 'https://drive.google.com/file/d/example/view',
    },
    receipts: {
      'agent:linkedin_research': { id: 'r1', status: 'pass' },
      'agent:linkedin_draft_critic': { id: 'd1', status: 'pass' },
      'agent:linkedin_artifact': { id: 'a1', status: 'pass' },
      'agent:linkedin_managing_editor': { id: 'm1', status: 'pass' },
    },
  });

  assert.equal(review.verdict, 'pass');
  assert.equal(review.quality_veto, false);
});

test('LinkedIn quality board allows strong post before artifacts are created', () => {
  const review = buildLinkedInQualityReview({
    post: {
      research: 'Evidence '.repeat(80),
      draft: 'Draft '.repeat(120),
      refined_draft: 'The practical lesson is that public service AI needs explicit evidence of service redesign before it deserves a budget. A strong programme starts with the failure mode, proves the data is good enough, defines the human escalation route, and measures citizen outcomes before scaling. Otherwise the model becomes a more expensive way to expose the same broken process. That is the difference between automation theatre and measurable delivery improvement.',
      score_json: JSON.stringify({
        overall_score: 4.1,
        axis_scores: { demonstrated_expertise: 4, professional_positioning: 4 },
        recruiter_perspective: 'A hiring manager would see: senior technology leader, credible experience in AI governance, but unclear on team scale. Likely to prompt a conversation if hiring for public-sector transformation leadership.',
      }),
      carousel_url: '',
    },
    receipts: {
      'agent:linkedin_research': { id: 'r1', status: 'pass' },
      'agent:linkedin_draft_critic': { id: 'd1', status: 'pass' },
      'agent:linkedin_managing_editor': { id: 'm1', status: 'warn' },
    },
  });

  assert.equal(review.verdict, 'warn');
  assert.equal(review.quality_veto, false);
  assert.equal(review.checks.find(c => c.name === 'artifact_is_usable_when_present').verdict, 'warn');
});

test('CRM people quality board asks about Rob and Robert when project evidence overlaps', () => {
  const review = buildCrmPeopleQualityReview({
    contacts: [
      { id: 'c-rob', name: 'Rob', aliases: '[]' },
      { id: 'c-robert', name: 'Robert', aliases: '[]' },
      { id: 'c-anna', name: 'Anna', aliases: '[]' },
    ],
    projectEvidence: [
      { contact_id: 'c-rob', project_slug: 'wds', source: 'meeting_intakes' },
      { contact_id: 'c-robert', project_slug: 'wds', source: 'google_tasks' },
      { contact_id: 'c-anna', project_slug: 'wds', source: 'meeting_intakes' },
    ],
  });

  assert.equal(review.verdict, 'warn');
  const candidates = review.checks.find(c => c.name === 'project_scoped_duplicate_person_candidates').details.candidates;
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].contacts, ['Rob', 'Robert']);
  assert.deepEqual(candidates[0].shared_projects, ['wds']);
});

test('CRM meeting quality board asks for clarification on Trina and Triona audio ambiguity', () => {
  const review = buildMeetingIntakeQualityReview({
    contacts: [
      { id: 'c-triona', name: 'Triona', aliases: '[]' },
    ],
    intakes: [{
      id: 'intake-wds',
      title: 'WDS planning',
      project_slug: 'wds',
      status: 'processed',
      transcript: 'Trina: We need to check the WDS follow-up.',
      extraction: JSON.stringify({
        meeting: { attendees: [{ name: 'Trina' }] },
        action_register: [{ owner: 'Trina', owner_type: 'external', task: 'Check WDS follow-up' }],
      }),
    }],
  });

  assert.equal(review.verdict, 'warn');
  const clarifications = review.checks.find(c => c.name === 'transcription_clarifications_needed').details.clarifications;
  assert(clarifications.some(item => item.type === 'near_name_audio_variant' && item.evidence.includes('Trina may be Triona')));
});

test('CRM meeting quality board does not reopen speaker mapping for processed legacy transcripts', () => {
  const processed = buildMeetingIntakeQualityReview({
    contacts: [],
    intakes: [{
      id: 'legacy-intake',
      title: 'Already processed',
      status: 'processed',
      transcript: 'Speaker 2 | 00:01\nThe meeting is already in CRM.',
      extraction: '{}',
    }],
  });
  assert.equal(processed.clarification_requests.some(item => item.type === 'generic_speaker_labels'), false);

  const awaitingReview = buildMeetingIntakeQualityReview({
    contacts: [],
    intakes: [{
      id: 'new-intake',
      title: 'Needs mapping',
      status: 'needs_speaker_review',
      transcript: 'Speaker 2 | 00:01\nI will circulate the document.',
      extraction: '{}',
    }],
  });
  assert.equal(awaitingReview.clarification_requests.some(item => item.type === 'generic_speaker_labels'), true);
});

test('document quality distinguishes completed review from a document that produced no tasks', () => {
  const awaiting = documentsAwaitingTaskReview([
    { id: 'reviewed-no-tasks', filename: 'HLD.docx', markdown: 'No actions.', task_extracted_at: 1785000000 },
    { id: 'generated-memory', filename: '_Project Memory.md', markdown: '# Project Memory', task_extracted_at: null },
    { id: 'not-reviewed', filename: 'Actions.docx', markdown: 'Douglas will send the pack.', task_extracted_at: null },
  ]);
  assert.deepEqual(awaiting.map(doc => doc.id), ['not-reviewed']);
});

test('CRM task quality board flags unknown owners from meeting action registers', () => {
  const review = buildTaskActionQualityReview({
    tasks: [
      { id: 'task-1', title: 'Follow up', source: 'meeting-transcript', source_id: 'meeting:m1:Follow up', project_slug: '', contact_id: '', company_id: '' },
    ],
    intakes: [{
      id: 'intake-1',
      title: 'Project call',
      project_slug: 'wds',
      extraction: JSON.stringify({
        action_register: [{ owner: 'Speaker 2', owner_type: 'unknown_speaker', task: 'Send the document', project_slug: 'wds' }],
      }),
    }],
  });

  assert.equal(review.verdict, 'warn');
  assert.equal(review.checks.find(c => c.name === 'meeting_actions_have_clear_owners').details.actions.length, 1);
  assert.equal(review.checks.find(c => c.name === 'source_projected_tasks_have_context').details.tasks.length, 1);
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

test('capo quality board scopes briefings without Nakai daily briefing', () => {
  const briefings = CAPOS.find(c => c.key === 'briefings');
  const review = buildCapoQualityReview({
    ...briefings,
    key: 'briefings_non_nakai',
    originalKey: 'briefings',
    soldiers: briefings.soldiers.filter(s => !/nakai/i.test(s)),
    scopeExclusions: NAKAI_EXCLUDED_TARGETS,
  }, {
    id: 'capo-receipt',
    status: 'pass',
    summary: 'Briefings Capo: PASS',
    created_at: Math.floor(Date.now() / 1000),
    payload: JSON.stringify({ checks: [{ name: 'briefings_present', verdict: 'pass' }] }),
  });

  assert.equal(review.verdict, 'pass');
  assert.deepEqual(review.scope_exclusions, ['nakai_daily_briefing']);
  assert(!review.checks.find(c => c.name === 'nakai_daily_briefing_is_out_of_scope').details.excluded_targets.includes('nakai_ref_synthesis'));
});

test('underboss quality board vetoes failing capo quality reviews', () => {
  const review = buildUnderbossQualityReview(UNDERBOSSES[0], [
    { capo: 'email', status: 'pass', latest: 'q1' },
    { capo: 'crm', status: 'fail', latest: 'q2' },
  ]);

  assert.equal(review.verdict, 'fail');
  assert.equal(review.quality_veto, true);
  assert.deepEqual(review.checks.find(c => c.name === 'quality_vetoes_escalate').details.failing, ['crm']);
});

test('Daily Consigliere turns vetoes and clarifications into asks for Douglas', () => {
  const now = 1783526400;
  const report = buildDailyConsigliereReport('douglas', {
    now,
    rows: [
      {
        id: 'receipt-veto',
        user: 'douglas',
        source_kind: 'linkedin_post',
        source_id: 'post-1',
        stage: 'agent:linkedin_quality_board',
        status: 'fail',
        summary: 'LinkedIn Quality Board: FAIL - VETO',
        payload: JSON.stringify({
          board: 'LinkedIn Quality Board',
          quality_veto: true,
          blocking_checks: ['research_is_source_backed'],
        }),
        created_at: now,
      },
      {
        id: 'receipt-clarify',
        user: 'douglas',
        source_kind: 'hub_quality',
        source_id: 'crm:meeting_intake',
        stage: 'agent:quality_board:crm:meeting_intake',
        status: 'warn',
        summary: 'CRM Meeting Intake Quality Board: WARN',
        payload: JSON.stringify({
          board: 'CRM Meeting Intake Quality Board',
          clarification_requests: [{ evidence: 'Trina may be Triona', type: 'near_name_audio_variant' }],
        }),
        created_at: now,
      },
    ],
    historyRows: [],
  });

  assert.equal(report.verdict, 'warn');
  assert.equal(report.counts.asks_douglas, 2);
  assert(report.asks_douglas.some(item => item.reason === 'veto'));
  assert(report.asks_douglas.some(item => item.reason === 'clarification'));
  assert.match(dailyConsigliereSection(report).join('\n'), /Trina may be Triona|clarification request/);
});

test('Daily Consigliere records agent corrections when latest receipt resolves prior issue', () => {
  const now = 1783526400;
  const report = buildDailyConsigliereReport('douglas', {
    now,
    rows: [],
    historyRows: [
      {
        id: 'fixed-pass',
        user: 'douglas',
        source_kind: 'token_burn',
        source_id: 'dashboard',
        stage: 'agent:token_burn_auditor',
        status: 'pass',
        summary: 'Token Burn Auditor: PASS',
        payload: '{}',
        created_at: now,
      },
      {
        id: 'old-warn',
        user: 'douglas',
        source_kind: 'token_burn',
        source_id: 'dashboard',
        stage: 'agent:token_burn_auditor',
        status: 'warn',
        summary: 'Token Burn Auditor: WARN stale export',
        payload: '{}',
        created_at: now - 3600,
      },
    ],
  });

  assert.equal(report.counts.agent_corrections, 1);
  assert.equal(report.agent_corrections[0].receipt_id, 'fixed-pass');
  assert.equal(report.agent_corrections[0].previous_receipt_id, 'old-warn');
});

test('Consigliere challenge covers every subject in a full nightly run (no window truncation)', () => {
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE knowledge_receipts (
      id TEXT PRIMARY KEY, user TEXT, source_kind TEXT, source_id TEXT,
      stage TEXT, status TEXT, summary TEXT, payload TEXT,
      model_key TEXT, model_id TEXT, created_at INTEGER
    )
  `);
  const insert = mem.prepare(`
    INSERT INTO knowledge_receipts (id, user, source_kind, source_id, stage, status, summary, payload, created_at)
    VALUES (?, 'douglas', ?, ?, ?, 'pass', ?, '{}', ?)
  `);
  const nowEpoch = Math.floor(Date.now() / 1000);
  const subjects = [];
  for (let i = 0; i < 45; i++) {
    const sourceId = `module_${i}`;
    subjects.push(sourceId);
    insert.run(`r${i}`, 'hub_module', sourceId, `agent:capo:${sourceId}`, `capo ${i}: PASS`, nowEpoch - i);
  }

  const db = require('../lib/db');
  const originalHub = db.hub;
  db.hub = () => mem;
  try {
    const result = subordinateChallenge('douglas');
    assert.equal(result.recent.length, 45, 'every subordinate subject must appear in the challenge');
    const seen = new Set(result.recent.map(r => r.source_id));
    for (const sourceId of subjects) {
      assert(seen.has(sourceId), `subject ${sourceId} missing from consigliere challenge`);
    }
  } finally {
    db.hub = originalHub;
    mem.close();
  }
});

test('capo job health check fails when the most recent completed run failed', () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  db.hub = () => ({
    prepare: (sql) => ({
      get: () => {
        const text = String(sql);
        if (text.includes("status IN ('pending','running')")) return { ok: 1 };
        if (text.includes("status IN ('done','failed')")) return { status: 'failed' };
        if (text.includes("status = 'failed'")) return { n: 3 };
        return { n: 1 };
      },
      all: () => [],
    }),
  });
  try {
    const checks = capoChecks('reminders', 'douglas', { now: 1783526400 });
    const outcome = checks.find(c => c.name === 'reminder_sweep_outcome');
    assert.equal(outcome.verdict, 'fail');
    assert(outcome.evidence.includes('most recent completed run failed'));
  } finally {
    db.hub = originalHub;
  }
});

test('system report capo warns when no daily report receipt exists and passes when one does', () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  const makeHub = (count) => () => ({
    prepare: () => ({ get: () => ({ n: count }), all: () => [] }),
  });
  try {
    db.hub = makeHub(0);
    const missing = capoChecks('system_report', 'douglas', { now: 1783526400 });
    assert.equal(missing.find(c => c.name === 'daily_report_receipt_recent').verdict, 'warn');

    db.hub = makeHub(1);
    const present = capoChecks('system_report', 'douglas', { now: 1783526400 });
    assert.equal(present.find(c => c.name === 'daily_report_receipt_recent').verdict, 'pass');
  } finally {
    db.hub = originalHub;
  }
});

test('no capo ships a tautological always-pass count check', () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  // Empty tables + no jobs: a healthy-looking green across the board must be impossible.
  db.hub = () => ({
    prepare: (sql) => ({
      get: () => (String(sql).includes('COUNT(') ? { n: 0 } : undefined),
      all: () => [],
    }),
  });
  try {
    for (const capo of CAPOS) {
      if (capo.key === 'token_burn') continue; // file-based audit, not DB counts
      const checks = capoChecks(capo.key, 'douglas', { now: 1783526400 });
      assert(
        checks.some(c => c.verdict !== 'pass'),
        `${capo.key} capo reports all-pass against an empty database — it can never fail`,
      );
    }
  } finally {
    db.hub = originalHub;
  }
});

const {
  clearedRemediationOutcome,
  remediateCheck,
  FIXERS,
  ADVISOR_WHITELIST,
} = require('../lib/hub-remediation');

function remediationTestDb() {
  const Database = require('better-sqlite3');
  const mem = new Database(':memory:');
  mem.exec(`
    CREATE TABLE system_jobs (
      id TEXT PRIMARY KEY, type TEXT, payload TEXT, run_at INTEGER,
      status TEXT, source TEXT, error TEXT, ran_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  return mem;
}

test('remediation sync fixer enqueues the missing job and re-verifies the check passes', async () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  const mem = remediationTestDb();
  db.hub = () => mem;
  try {
    const check = { name: 'reminder_sweep_pending', verdict: 'fail', evidence: 'reminder sweep has no pending/running job' };
    const outcome = await remediateCheck({ capoKey: 'reminders', check, useModel: false, nowTs: 1783526400 });
    assert.equal(outcome.status, 'resolved');
    assert.equal(outcome.action, 'enqueue_reminder_sweep');
    assert.equal(outcome.after, 'pass');
    const pending = mem.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type='reminder_sweep' AND status='pending'").get();
    assert.equal(pending.n, 1);
  } finally {
    db.hub = originalHub;
    mem.close();
  }
});

test('remediation deferred fixer dispatches a backfill and reports verify-next-cycle', async () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  const mem = remediationTestDb();
  db.hub = () => mem;
  try {
    const check = { name: 'completed_flights_have_actuals', verdict: 'fail', evidence: '3 completed recent flight(s) missing actual times' };
    const outcome = await remediateCheck({ capoKey: 'flights', check, useModel: false, nowTs: 1783526400 });
    assert.equal(outcome.status, 'dispatched');
    assert.equal(outcome.action, 'enqueue_flight_backfill');
    assert.match(outcome.evidence, /next audit cycle/);
    const jobs = mem.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type='flight_backfill'").get();
    assert.equal(jobs.n, 1);
  } finally {
    db.hub = originalHub;
    mem.close();
  }
});

test('remediation is idempotent — never stacks a duplicate job when one is already pending', async () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  const mem = remediationTestDb();
  db.hub = () => mem;
  mem.prepare("INSERT INTO system_jobs (id, type, payload, run_at, status, source) VALUES ('j1','flight_backfill','{}',1,'pending','system')").run();
  db.hub = () => mem;
  try {
    const check = { name: 'completed_flights_have_actuals', verdict: 'fail', evidence: 'missing actuals' };
    const outcome = await remediateCheck({ capoKey: 'flights', check, useModel: false, nowTs: 1783526400 });
    assert.equal(outcome.status, 'dispatched');
    assert.match(outcome.evidence, /already pending/);
    const jobs = mem.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type='flight_backfill'").get();
    assert.equal(jobs.n, 1, 'must not enqueue a second flight_backfill');
  } finally {
    db.hub = originalHub;
    mem.close();
  }
});

test('remediation escalates to the consigliere when no fixer exists and the model is off', async () => {
  // recent_post_has_agent_receipts has no reversible job that clears it.
  const check = { name: 'recent_post_has_agent_receipts', verdict: 'fail', evidence: 'Latest recent post has 0 agent receipt(s)' };
  const outcome = await remediateCheck({ capoKey: 'linkedin_content', check, useModel: false, nowTs: 1783526400 });
  assert.equal(outcome.status, 'escalate');
  assert.equal(outcome.reason, 'no_fixer');
});

test('remediation advisor whitelist contains only reversible job types from the fixer registry', () => {
  const fixerJobTypes = new Set(Object.values(FIXERS).map(f => f.jobType));
  for (const jobType of ADVISOR_WHITELIST) {
    assert(fixerJobTypes.has(jobType), `advisor whitelist leaked a non-fixer job type: ${jobType}`);
  }
});

test('remediation escalates instead of dispatching forever after repeated unresolved retries', async () => {
  const db = require('../lib/db');
  const originalHub = db.hub;
  const mem = remediationTestDb();
  mem.exec(`
    CREATE TABLE knowledge_receipts (
      id TEXT PRIMARY KEY, user TEXT, source_kind TEXT, source_id TEXT,
      stage TEXT, status TEXT, summary TEXT, payload TEXT,
      model_key TEXT, model_id TEXT, created_at INTEGER
    )
  `);
  const nowTs = 1783526400;
  // Two prior dispatched (warn) retries for the same check within the window.
  const ins = mem.prepare(`INSERT INTO knowledge_receipts (id,user,source_kind,source_id,stage,status,summary,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('d1', 'douglas', 'hub_remediation', 'completed_flights_have_actuals', 'agent:remediation:flights', 'warn', 'retry', '{}', nowTs - 86400);
  ins.run('d2', 'douglas', 'hub_remediation', 'completed_flights_have_actuals', 'agent:remediation:flights', 'warn', 'retry', '{}', nowTs - 2 * 3600);
  db.hub = () => mem;
  try {
    const check = { name: 'completed_flights_have_actuals', verdict: 'fail', evidence: 'missing actuals' };
    const outcome = await remediateCheck({ capoKey: 'flights', check, useModel: false, nowTs });
    assert.equal(outcome.status, 'escalate');
    assert.equal(outcome.reason, 'repeated_dispatch_unresolved');
    const jobs = mem.prepare("SELECT COUNT(*) AS n FROM system_jobs WHERE type='flight_backfill'").get();
    assert.equal(jobs.n, 0, 'must not dispatch another retry once the limit is hit');
  } finally {
    db.hub = originalHub;
    mem.close();
  }
});

test('remediation records recovery when a previously unresolved check now passes', () => {
  const outcome = clearedRemediationOutcome(
    'documents_projects',
    { name: 'recent_documents_have_task_review', verdict: 'pass', evidence: '0 documents awaiting task review' },
    { status: 'fail', summary: 'could not self-heal' },
  );
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.action, 'verified_current_check_passes');
  assert.equal(outcome.before, 'fail');
  assert.equal(outcome.after, 'pass');
  assert.equal(clearedRemediationOutcome(
    'documents_projects',
    { name: 'recent_documents_have_task_review', verdict: 'pass', evidence: 'clear' },
    { status: 'pass' },
  ), null, 'a recorded recovery must not be written again on every cycle');
});

const {
  renderBriefMarkdown,
  fallbackBrief,
  summarizeForModel,
  isCircularGovernanceAsk,
} = require('../lib/consigliere-brief');

test('consigliere brief drops circular governance self-references', () => {
  assert.equal(isCircularGovernanceAsk({ source_kind: 'hub_governance', source_id: 'boss_layer' }), true);
  assert.equal(isCircularGovernanceAsk({ source_kind: 'hub_governance', source_id: 'daily_consigliere' }), true);
  assert.equal(isCircularGovernanceAsk({ source_kind: 'hub_quality', source_id: 'crm:tasks' }), false);
  const input = summarizeForModel({
    asks_douglas: [
      { source_kind: 'hub_governance', source_id: 'boss_layer', summary: 'meta', severity: 'blocker' },
      { source_kind: 'hub_quality', source_id: 'crm:tasks', summary: 'real ask', severity: 'question' },
    ],
  }, {});
  assert.equal(input.asks.length, 1);
  assert.equal(input.asks[0].concern, 'real ask');
});

test('consigliere brief flattens clarification JSON into human strings, no raw objects', () => {
  const input = summarizeForModel({
    asks_douglas: [{
      source_kind: 'hub_quality', source_id: 'crm:tasks', summary: 'Task board', severity: 'question',
      clarification_requests: [{ owner: 'Speaker 2', task: "Confirm access to Rob's folder", title: 'Roadmap' }],
    }],
  }, {});
  const serialized = JSON.stringify(input.asks[0].samples);
  assert(!serialized.includes('{'), 'samples must be flat strings, not nested objects');
  assert(input.asks[0].samples[0].includes("Rob's folder"));
});

test('consigliere fallback brief renders readable markdown with no UUIDs and promotes runtime errors', () => {
  const report = {
    asks_douglas: [{ source_kind: 'hub_quality', source_id: 'crm:people', summary: 'Possible duplicate', severity: 'question', clarification_requests: ['nickname_variant_same_project'] }],
    agent_corrections: [{ source_kind: 'hub_module', source_id: 'linkedin_content', previous_summary: 'FAIL', summary: 'PASS' }],
    monitoring: [],
  };
  const { markdown } = fallbackBrief(report, {
    runtimeErrors: ['[email] classify error abc123: response must be a JSON object'],
    remediation: { fixed: ['fixed reminders'], dispatched: ['retry documents'], counts: {} },
    activityLine: '21 emails, 36 facts',
  });
  assert(markdown.includes('Needs you'));
  assert(markdown.includes('needs code'), 'runtime error should be tagged needs code');
  assert(markdown.includes('LinkedIn'), 'correction should surface in handled');
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}/.test(markdown), 'no UUIDs in the rendered brief');
});

const { buildLinkIndex, linksForBriefItem } = require('../lib/consigliere-brief');
const { fixLinksForItem } = require('../lib/consigliere-links');

const LINKED_REPORT = {
  user: 'douglas',
  asks_douglas: [
    {
      source_kind: 'hub_quality', source_id: 'crm:meeting_intake', severity: 'question',
      summary: '2 meeting intake clarification(s) needed',
      clarification_requests: [
        { intake_id: 'intake-1', title: 'PST Migration', type: 'model_open_question', evidence: 'Is the E3 mailbox limit 50GB or 100GB?' },
      ],
    },
    {
      source_kind: 'hub_quality', source_id: 'crm:people', severity: 'question',
      summary: '1 possible duplicate person pair(s)',
      clarification_requests: [
        { contacts: ['Nick F', 'Nicholas F'], contact_ids: ['contact-a', 'contact-b'], reason: 'alias_overlap' },
      ],
    },
  ],
  agent_corrections: [], monitoring: [],
};

test('every needs_you item carries a clickable Hub link to where the fix happens', () => {
  const index = buildLinkIndex(LINKED_REPORT);
  const { markdown } = fallbackBrief(LINKED_REPORT, {});
  assert(markdown.includes('Go here:'), 'brief must offer a link line');
  assert(markdown.includes('](https://dchat.mclellan.scot/crm/meeting-intake?intake=intake-1)'),
    'meeting intake ask must deep-link to that intake');
  assert(markdown.includes('[Nick F](https://dchat.mclellan.scot/crm/contact/contact-a)'),
    'duplicate-person ask must link each contact record');
  assert.equal(Object.keys(index).length, 2);
});

test('brief links come from the escalation payload, not from model text', () => {
  const index = buildLinkIndex(LINKED_REPORT);
  // Model invented a ref that was never issued: no link rather than a wrong one.
  assert.deepEqual(linksForBriefItem({ title: 'Something else', detail: '', refs: ['A9'] }, index), []);
  // Model dropped refs but named the area: fall back to that area's links.
  const recovered = linksForBriefItem({ title: 'CRM people need merging', detail: '', refs: [] }, index);
  assert(recovered.some(link => link.url.endsWith('/crm/contact/contact-a')));
});

test('link resolver never points at a project slug that no longer exists', () => {
  // The project-context board flags rows whose slug is dangling; link the row.
  const links = fixLinksForItem({
    source_kind: 'hub_quality', source_id: 'crm:project_context',
    clarification_requests: [{ source: 'google_tasks', id: 'task-9', project_slug: 'ghost-project' }],
  });
  assert(!links.some(link => link.url.includes('/crm/project/ghost-project')), 'must not link a dangling slug');
  assert(links.some(link => link.url.endsWith('/crm/tasks/task-9')), 'must link the row that needs re-tagging');
});

const { getMinScoreForType } = require('../lib/content-taxonomy');

test('LinkedIn quality board respects a per-type score bar', () => {
  const basePost = {
    research: 'r'.repeat(260),
    refined_draft: 'd'.repeat(460),
    score_json: JSON.stringify({ overall_score: 3.0, axis_scores: { demonstrated_expertise: 4 } }),
    carousel_url: 'https://drive.google.com/file/d/x/view',
    content_type: 'AI News',
  };
  const receipts = {
    'agent:linkedin_research': { id: 'r1', status: 'pass' },
    'agent:linkedin_draft_critic': { id: 'd1', status: 'pass' },
    'agent:linkedin_artifact': { id: 'a1', status: 'pass' },
    'agent:linkedin_managing_editor': { id: 'm1', status: 'pass' },
  };
  // A 3.0 post is BELOW the default 3.5 bar → vetoed.
  const strict = buildLinkedInQualityReview({ post: basePost, receipts, minScore: 3.5 });
  assert.equal(strict.quality_veto, true);
  assert(strict.blocking_checks.includes('post_has_specific_voice'));
  // Same post CLEARS a 50% (2.5/5) bar → no veto.
  const lenient = buildLinkedInQualityReview({ post: basePost, receipts, minScore: 2.5 });
  assert.equal(lenient.quality_veto, false);
});

test('per-type min score maps percentages and falls back to default', () => {
  const dbMod = require('../lib/db');
  const originalHub = dbMod.hub;
  dbMod.hub = () => ({
    prepare: () => ({
      get: () => ({ value: JSON.stringify([{ name: 'AI News', minScorePct: 50 }, { name: 'M365' }]) }),
    }),
  });
  try {
    assert.equal(getMinScoreForType('douglas', 'AI News'), 2.5);   // 50% of 5
    assert.equal(getMinScoreForType('douglas', 'M365'), 3.5);       // unset → default 70%
    assert.equal(getMinScoreForType('douglas', 'Unknown'), 3.5);    // not in taxonomy → default
    assert.equal(getMinScoreForType('douglas', ''), 3.5);           // no type → default
  } finally {
    dbMod.hub = originalHub;
  }
});
