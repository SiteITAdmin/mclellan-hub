'use strict';

const db = require('./db');
const { writeAgentReceipt } = require('./agent-receipts');
const { CAPOS, UNDERBOSSES } = require('./hub-agent-roster');

const NAKAI_EXCLUDED_TARGETS = ['nakai_daily_briefing'];

const GENERIC_PHRASES = [
  'game changer',
  'rapidly evolving landscape',
  'ever-evolving landscape',
  'unlock',
  'delve',
  'at the end of the day',
  'in today\'s world',
  'this really made me think',
  'what do you think',
];

const CRM_QUALITY_SECTIONS = [
  'crm:people',
  'crm:meeting_intake',
  'crm:tasks',
  'crm:project_context',
];

const NICKNAME_GROUPS = [
  ['robert', 'rob', 'robbie', 'bob', 'bobby'],
  ['william', 'will', 'bill', 'billy'],
  ['richard', 'rick', 'ricky', 'dick'],
  ['michael', 'mike', 'mick'],
  ['james', 'jim', 'jimmy'],
  ['johnathan', 'jonathan', 'john', 'jon', 'johnny'],
  ['christopher', 'chris'],
  ['patricia', 'pat', 'tricia'],
  ['katherine', 'catherine', 'kate', 'katie', 'katy', 'cathy'],
  ['elizabeth', 'liz', 'lizzie', 'beth'],
  ['margaret', 'meg', 'maggie'],
  ['anthony', 'tony'],
  ['andrew', 'andy'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave'],
  ['thomas', 'tom', 'tommy'],
];

function now() { return Math.floor(Date.now() / 1000); }

function check(persona, name, verdict, evidence, details = {}, blocksShip = false) {
  return { persona, name, verdict, evidence, details, blocks_ship: Boolean(blocksShip) };
}

function verdictFor(checks) {
  if (checks.some(c => c.verdict === 'fail')) return 'fail';
  if (checks.some(c => c.verdict === 'warn')) return 'warn';
  return 'pass';
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch (_) { return fallback; }
}

function safeGet(sql, params = []) {
  try { return db.hub().prepare(sql).get(...params); } catch (err) { return { __error: err.message }; }
}

function safeAll(sql, params = []) {
  try { return db.hub().prepare(sql).all(...params); } catch (err) { return [{ __error: err.message }]; }
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function latestReceipt({ user = 'douglas', sourceKind, sourceId, stage = null }) {
  const params = [user, sourceKind, sourceId];
  const stageClause = stage ? 'AND stage = ?' : '';
  if (stage) params.push(stage);
  return safeGet(`
    SELECT *
    FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id = ?
      ${stageClause}
    ORDER BY created_at DESC
    LIMIT 1
  `, params);
}

function stageReceiptMap(user, postId) {
  let rows = [];
  try {
    rows = db.hub().prepare(`
      SELECT *
      FROM knowledge_receipts
      WHERE user = ? AND source_kind = 'linkedin_post' AND source_id = ?
        AND stage LIKE 'agent:linkedin_%'
      ORDER BY created_at DESC
    `).all(user, postId);
  } catch (_) {
    rows = [];
  }
  const map = {};
  for (const row of rows) {
    if (!map[row.stage]) map[row.stage] = row;
  }
  return map;
}

function textStats(text) {
  const body = String(text || '').trim();
  const lower = body.toLowerCase();
  const phrases = GENERIC_PHRASES.filter(phrase => lower.includes(phrase));
  return {
    chars: body.length,
    words: body ? body.split(/\s+/).length : 0,
    generic_phrases: phrases,
  };
}

function normalizedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameParts(value) {
  const parts = normalizedName(value).split(/\s+/).filter(Boolean);
  return {
    normalized: parts.join(' '),
    first: parts[0] || '',
    last: parts.length > 1 ? parts[parts.length - 1] : '',
    parts,
  };
}

function nicknameRoot(name) {
  const first = nameParts(name).first;
  if (!first) return '';
  const group = NICKNAME_GROUPS.find(names => names.includes(first));
  return group ? group[0] : first;
}

function areNicknameVariants(a, b) {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (!pa.first || !pb.first || pa.first === pb.first) return false;
  return nicknameRoot(pa.first) === nicknameRoot(pb.first);
}

function levenshtein(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const dp = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j++) dp[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[left.length][right.length];
}

function likelyAudioNameVariant(a, b) {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (!pa.first || !pb.first || pa.first === pb.first) return false;
  if (areNicknameVariants(a, b)) return false;
  if (pa.first[0] !== pb.first[0]) return false;
  if (Math.min(pa.first.length, pb.first.length) < 4) return false;
  // A transcript that mishears a first name keeps the surname (or has no surname
  // at all, e.g. a bare "Trina" for the mononym contact "Triona"). Two contacts
  // with clearly different surnames — "Alan Garland" vs "Alec Hirst" — are
  // separate people who merely share a project, not one person the audio spelled
  // two ways. Without this guard the near-name heuristic fired nightly on real
  // colleagues and got projected into a "possible duplicate contact" task. Only
  // treat as an audio variant when the surnames match or at least one side has
  // no surname to compare.
  if (pa.last && pb.last && pa.last !== pb.last) return false;
  const distance = levenshtein(pa.first, pb.first);
  return distance > 0 && distance <= 2;
}

function parseAliases(contact) {
  const aliases = parseJson(contact.aliases, []);
  return Array.isArray(aliases) ? aliases.filter(Boolean) : [];
}

function projectSetFor(contactId, projectEvidence = []) {
  return new Set(projectEvidence
    .filter(row => row.contact_id === contactId && row.project_slug)
    .map(row => row.project_slug));
}

function sharedProjects(a, b, projectEvidence = []) {
  const left = projectSetFor(a.id, projectEvidence);
  const right = projectSetFor(b.id, projectEvidence);
  return [...left].filter(slug => right.has(slug));
}

function contactDisplayNames(contact) {
  return [contact.name, ...parseAliases(contact)].filter(Boolean);
}

function findProjectScopedPersonIssues(contacts = [], projectEvidence = []) {
  const duplicateCandidates = [];
  const transcriptionCandidates = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
      const projects = sharedProjects(a, b, projectEvidence);
      if (!projects.length) continue;
      const aNames = contactDisplayNames(a);
      const bNames = contactDisplayNames(b);
      const aliasOverlap = aNames.some(left => bNames.some(right => normalizedName(left) === normalizedName(right)));
      const nicknameMatch = aNames.some(left => bNames.some(right => areNicknameVariants(left, right)));
      const audioMatch = aNames.some(left => bNames.some(right => likelyAudioNameVariant(left, right)));
      if (aliasOverlap || nicknameMatch) {
        duplicateCandidates.push({
          contacts: [a.name, b.name],
          contact_ids: [a.id, b.id],
          shared_projects: projects,
          reason: aliasOverlap ? 'alias_overlap' : 'nickname_variant_same_project',
        });
      } else if (audioMatch) {
        transcriptionCandidates.push({
          contacts: [a.name, b.name],
          contact_ids: [a.id, b.id],
          shared_projects: projects,
          reason: 'near_name_audio_variant_same_project',
        });
      }
    }
  }
  return {
    duplicateCandidates: dedupeBy(duplicateCandidates, item => `${item.contact_ids.join('|')}|${item.shared_projects.join('|')}`),
    transcriptionCandidates: dedupeBy(transcriptionCandidates, item => `${item.contact_ids.join('|')}|${item.shared_projects.join('|')}`),
  };
}

const STALE_IDENTITY_WARNING = /(not (present|found|listed|a known)|could not be (confidently )?matched|not in the known|is only identified by|unknown (name|speaker|contact)|no (known )?crm match|not a (known )?crm)/i;

// True when a model warning is an identity complaint ("X is not in the known CRM
// people list") about a name that now resolves to a known contact or alias.
function isResolvedIdentityWarning(warning, knownNames = []) {
  const text = String(warning || '');
  if (!STALE_IDENTITY_WARNING.test(text)) return false;
  const normalizedText = normalizedName(text);
  return knownNames.some(name => {
    const norm = normalizedName(name);
    return norm.length >= 3 && normalizedText.includes(norm);
  });
}

function extractionNames(extraction = {}) {
  const names = [];
  for (const attendee of extraction.meeting?.attendees || []) {
    names.push(attendee.name, attendee.matched_contact);
  }
  for (const update of extraction.crm_updates || []) {
    names.push(update.subject, update.matched_contact, ...(update.linked_people || []));
  }
  for (const action of extraction.action_register || []) {
    names.push(action.owner, action.matched_contact);
  }
  return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function intakeClarificationIssues(intakes = [], contacts = []) {
  const issues = [];
  const knownNames = contacts.flatMap(contact => contactDisplayNames(contact));
  // The first name of every known person. A transcript name whose first name is
  // already a known contact's first name ("Alan", when Alan Garland exists) is
  // that person, not a mishearing of a same-initial colleague ("Alec Hirst") —
  // flagging it re-asked "Alan may be Alec?" on every meeting. A genuinely
  // unknown near-name ("Trina" when only "Triona" is known) still flags.
  const knownFirstNames = new Set(knownNames.map(name => nameParts(name).first).filter(Boolean));
  for (const intake of intakes) {
    const extraction = parseJson(intake.extraction, {});
    const speakerReview = (() => {
      try { return require('./meeting-intake').speakerReviewForTranscript(intake.transcript); }
      catch (_) { return null; }
    })();
    // New intakes cannot be processed until every placeholder is mapped.
    // Processed legacy transcripts pre-date that gate and no longer have an
    // editable speaker-review step, so re-scanning their raw labels creates an
    // unresolvable nightly warning even after an identity question is answered.
    if (intake.status === 'needs_speaker_review' && speakerReview?.speakers?.length) {
      issues.push({
        intake_id: intake.id,
        title: intake.title,
        project_slug: intake.project_slug || null,
        type: 'generic_speaker_labels',
        evidence: `${speakerReview.speakers.length} generic speaker label(s) need mapping`,
        samples: speakerReview.speakers.slice(0, 4),
      });
    }
    const extractedNames = extractionNames(extraction);
    for (const extracted of extractedNames) {
      // The transcript name is already a known person (by first name) — treat it
      // as that person, not a near-name of someone else.
      if (knownFirstNames.has(nameParts(extracted).first)) continue;
      for (const known of knownNames) {
        if (normalizedName(extracted) === normalizedName(known)) continue;
        if (!likelyAudioNameVariant(extracted, known)) continue;
        issues.push({
          intake_id: intake.id,
          title: intake.title,
          project_slug: intake.project_slug || null,
          type: 'near_name_audio_variant',
          evidence: `${extracted} may be ${known}; ask for clarification before linking facts/actions`,
          names: [extracted, known],
        });
      }
    }
    for (const question of extraction.open_questions || []) {
      issues.push({
        intake_id: intake.id,
        title: intake.title,
        project_slug: intake.project_slug || null,
        type: 'model_open_question',
        evidence: String(question).slice(0, 300),
      });
    }
    for (const warning of extraction.warnings || []) {
      // A model warning that a name "could not be matched" or is "not in the
      // known CRM" is false once that name resolves to a contact — usually
      // because it is now an alias. Surfacing it anyway re-asked an answered
      // identity question on every intake forever. Drop the warning when it is
      // an identity complaint about a name we can now resolve.
      if (isResolvedIdentityWarning(warning, knownNames)) continue;
      issues.push({
        intake_id: intake.id,
        title: intake.title,
        project_slug: intake.project_slug || null,
        type: 'model_warning',
        evidence: String(warning).slice(0, 300),
      });
    }
  }
  return dedupeBy(issues, item => `${item.intake_id}|${item.type}|${item.evidence}`);
}

function taskActionIssues({ tasks = [], intakes = [], contacts = null } = {}) {
  const missingSource = tasks.filter(task => !task.source || (task.source !== 'manual' && !task.source_id));
  const missingContext = tasks.filter(task =>
    ['meeting-transcript', 'document', 'agentmail', 'email'].includes(task.source)
    && !task.project_slug
    && !task.contact_id
    && !task.company_id
  );
  // The extraction froze owner_type at processing time. Once "Nick" is a known
  // person — usually because Douglas answered one of these questions and the
  // name became an alias — every other action he owns is resolved too, and
  // re-asking about each one is noise.
  const knownNames = new Set();
  for (const contact of contacts || []) {
    for (const name of contactDisplayNames(contact)) knownNames.add(normalizedName(name));
  }

  const unknownOwnerActions = [];
  for (const intake of intakes) {
    const extraction = parseJson(intake.extraction, {});
    for (const action of extraction.action_register || []) {
      if (knownNames.has(normalizedName(action.owner || ''))) continue;
      if (['unknown_speaker', 'unknown'].includes(action.owner_type) || /^unassigned$/i.test(action.owner || '')) {
        unknownOwnerActions.push({
          intake_id: intake.id,
          title: intake.title,
          project_slug: action.project_slug || intake.project_slug || null,
          owner: action.owner || 'Unassigned',
          task: action.task || action.text || '',
        });
      }
    }
  }
  return {
    missingSource: missingSource.slice(0, 20),
    missingContext: missingContext.slice(0, 20),
    unknownOwnerActions: unknownOwnerActions.slice(0, 20),
  };
}

// A question Douglas has already answered is not an open issue. `answered` holds
// the stable clarification keys from crm_clarification_answers; without this the
// boards re-ask the same thing every night forever.
function dropAnswered(items, answered, kind) {
  if (!answered || !answered.size) return items;
  const { clarificationKey } = require('./crm-clarifications');
  return items.filter(item => !answered.has(clarificationKey({ ...item, kind })));
}

function buildCrmPeopleQualityReview({ contacts = [], projectEvidence = [], answered = null } = {}) {
  const issues = findProjectScopedPersonIssues(contacts, projectEvidence);
  const duplicateCandidates = dropAnswered(issues.duplicateCandidates, answered, 'person_alias');
  const transcriptionCandidates = dropAnswered(issues.transcriptionCandidates, answered, 'person_alias');
  const checks = [
    check(
      'Identity Resolution Reviewer',
      'project_scoped_duplicate_person_candidates',
      duplicateCandidates.length ? 'warn' : 'pass',
      duplicateCandidates.length
        ? `${duplicateCandidates.length} possible duplicate person pair(s) share project evidence`
        : 'No project-scoped nickname/alias duplicate candidates found',
      { candidates: duplicateCandidates },
    ),
    check(
      'Audio Name Clarifier',
      'project_scoped_near_name_ambiguities',
      transcriptionCandidates.length ? 'warn' : 'pass',
      transcriptionCandidates.length
        ? `${transcriptionCandidates.length} near-name pair(s) share project evidence and need confirmation`
        : 'No project-scoped near-name ambiguities found',
      { candidates: transcriptionCandidates },
    ),
    check(
      'Evidence Auditor',
      'people_review_has_context',
      contacts.length ? 'pass' : 'warn',
      `${contacts.length} contact(s), ${projectEvidence.length} project-evidence row(s)`,
    ),
  ];
  return {
    board: 'CRM People Quality Board',
    target: 'crm:people',
    verdict: verdictFor(checks),
    clarification_requests: [...duplicateCandidates, ...transcriptionCandidates],
    checks,
    run_at: new Date().toISOString(),
  };
}

function buildMeetingIntakeQualityReview({ intakes = [], contacts = [], answered = null } = {}) {
  const failed = intakes.filter(intake => intake.status === 'error');
  const emptyExtraction = intakes.filter(intake => intake.status === 'processed' && !String(intake.extraction || '').trim());
  const clarifications = dropAnswered(intakeClarificationIssues(intakes, contacts), answered, 'meeting_question');
  const checks = [
    check(
      'Meeting Intake Auditor',
      'recent_intakes_processed',
      failed.length ? 'fail' : emptyExtraction.length ? 'warn' : 'pass',
      `${failed.length} failed intake(s), ${emptyExtraction.length} processed intake(s) missing extraction`,
      { failed: failed.map(i => ({ id: i.id, title: i.title, error: i.error })), empty_extraction: emptyExtraction.map(i => i.id) },
      failed.length > 0,
    ),
    check(
      'Audio Name Clarifier',
      'transcription_clarifications_needed',
      clarifications.length ? 'warn' : 'pass',
      clarifications.length
        ? `${clarifications.length} meeting intake clarification(s) needed`
        : 'No recent meeting-intake clarification flags found',
      { clarifications },
    ),
  ];
  return {
    board: 'CRM Meeting Intake Quality Board',
    target: 'crm:meeting_intake',
    verdict: verdictFor(checks),
    clarification_requests: clarifications,
    checks,
    run_at: new Date().toISOString(),
  };
}

function buildTaskActionQualityReview({ tasks = [], intakes = [], contacts = null, answered = null } = {}) {
  const issues = taskActionIssues({ tasks, intakes, contacts });
  issues.unknownOwnerActions = dropAnswered(issues.unknownOwnerActions, answered, 'task_owner');
  const checks = [
    check(
      'Action Owner Reviewer',
      'meeting_actions_have_clear_owners',
      issues.unknownOwnerActions.length ? 'warn' : 'pass',
      issues.unknownOwnerActions.length
        ? `${issues.unknownOwnerActions.length} meeting action(s) have unknown/unassigned owners`
        : 'Recent meeting actions have clear-enough owners',
      { actions: issues.unknownOwnerActions },
    ),
    check(
      'Task Provenance Reviewer',
      'tasks_have_source_provenance',
      issues.missingSource.length ? 'warn' : 'pass',
      issues.missingSource.length
        ? `${issues.missingSource.length} task(s) missing source/source_id`
        : 'Tasks have source provenance',
      { tasks: issues.missingSource.map(t => ({ id: t.id, title: t.title })) },
    ),
    check(
      'Project Context Reviewer',
      'source_projected_tasks_have_context',
      issues.missingContext.length ? 'warn' : 'pass',
      issues.missingContext.length
        ? `${issues.missingContext.length} source-projected task(s) lack project/contact/company context`
        : 'Source-projected tasks have CRM context',
      { tasks: issues.missingContext.map(t => ({ id: t.id, title: t.title, source: t.source, source_id: t.source_id })) },
    ),
  ];
  return {
    board: 'CRM Task / Action Quality Board',
    target: 'crm:tasks',
    verdict: verdictFor(checks),
    clarification_requests: issues.unknownOwnerActions,
    checks,
    run_at: new Date().toISOString(),
  };
}

function buildProjectContextQualityReview({ danglingRefs = [] } = {}) {
  const checks = [
    check(
      'Project Context Reviewer',
      'project_references_resolve',
      danglingRefs.length ? 'warn' : 'pass',
      danglingRefs.length
        ? `${danglingRefs.length} CRM source row(s) reference unknown project slugs`
        : 'CRM project references resolve to known projects',
      { dangling_refs: danglingRefs.slice(0, 30) },
    ),
  ];
  return {
    board: 'CRM Project Context Quality Board',
    target: 'crm:project_context',
    verdict: verdictFor(checks),
    clarification_requests: danglingRefs,
    checks,
    run_at: new Date().toISOString(),
  };
}

function buildLinkedInQualityReview({ post = {}, receipts = {}, minScore = 3.5 } = {}) {
  const score = parseJson(post.score_json, {});
  const axis = score.axis_scores || {};
  const draftText = (post.refined_draft || post.draft || '').trim();
  const stats = textStats(draftText);
  const researchReceipt = receipts['agent:linkedin_research'];
  const criticReceipt = receipts['agent:linkedin_draft_critic'];
  const artifactReceipt = receipts['agent:linkedin_artifact'];
  const managingReceipt = receipts['agent:linkedin_managing_editor'];
  const overallScore = Number(score.overall_score || 0);
  const scoreBar = Number.isFinite(minScore) ? minScore : 3.5;

  const checks = [
    check(
      'Evidence Auditor',
      'research_is_source_backed',
      post.research && String(post.research).trim().length >= 200 && researchReceipt?.status !== 'fail' ? 'pass' : 'fail',
      post.research
        ? `Research stored (${String(post.research).trim().length} chars); research receipt=${researchReceipt?.status || 'missing'}`
        : 'No stored research for this post',
      { research_receipt: researchReceipt?.id || null },
      true,
    ),
    check(
      'Douglas Voice Guardian',
      'post_has_specific_voice',
      stats.chars >= 400 && overallScore >= scoreBar ? 'pass' : 'fail',
      `${stats.chars} chars; overall_score=${overallScore || 'missing'} (bar ${scoreBar.toFixed(1)}/5 = ${Math.round(scoreBar / 5 * 100)}% for ${post.content_type || 'default'})`,
      { words: stats.words, overall_score: overallScore || null, min_score: scoreBar },
      true,
    ),
    check(
      'Douglas Voice Guardian',
      'generic_phrase_scan',
      stats.generic_phrases.length ? 'warn' : 'pass',
      stats.generic_phrases.length
        ? `Generic phrase(s) found: ${stats.generic_phrases.join(', ')}`
        : 'No obvious generic filler phrases found',
      { generic_phrases: stats.generic_phrases },
    ),
    check(
      'Skeptical Senior Peer',
      'expertise_signal_is_visible',
      Number(axis.demonstrated_expertise || 0) >= 3 && criticReceipt?.status !== 'fail' ? 'pass' : 'fail',
      `demonstrated_expertise=${axis.demonstrated_expertise || 'missing'}; critic receipt=${criticReceipt?.status || 'missing'}`,
      { critic_receipt: criticReceipt?.id || null },
      true,
    ),
    check(
      'Hiring Manager Persona',
      'recruiter_perspective_exists',
      score.recruiter_perspective ? 'pass' : 'warn',
      score.recruiter_perspective || 'No recruiter perspective in score JSON',
    ),
    check(
      'Artifact Accessibility Reader',
      'artifact_is_usable_when_present',
      artifactReceipt?.status === 'fail'
        ? 'fail'
        : post.carousel_url || artifactReceipt?.status === 'pass'
          ? 'pass'
          : 'warn',
      artifactReceipt?.status === 'fail'
        ? 'Carousel/PDF artifact receipt failed'
        : post.carousel_url
          ? 'Carousel URL stored for review/download'
          : 'No carousel URL; post can exist as text but artifact workflow needs attention',
      { artifact_receipt: artifactReceipt?.id || null, carousel_url: post.carousel_url || '' },
      artifactReceipt?.status === 'fail',
    ),
    check(
      'Managing Editor',
      'pipeline_completed_cleanly',
      managingReceipt?.status === 'fail' ? 'fail' : managingReceipt ? 'pass' : 'warn',
      managingReceipt ? `Managing editor receipt=${managingReceipt.status}` : 'No managing editor receipt found yet',
      { managing_receipt: managingReceipt?.id || null },
      managingReceipt?.status === 'fail',
    ),
  ];

  const verdict = verdictFor(checks);
  const blocking = checks.filter(c => c.verdict === 'fail' && c.blocks_ship);
  return {
    board: 'LinkedIn Quality Board',
    target: 'linkedin_post',
    verdict,
    quality_veto: blocking.length > 0,
    blocking_checks: blocking.map(c => c.name),
    personas: [...new Set(checks.map(c => c.persona))],
    checks,
    run_at: new Date().toISOString(),
  };
}

function writeLinkedInQualityReview({ user = 'douglas', postId, post = null } = {}) {
  if (!postId) throw new Error('postId is required');
  const row = post || safeGet('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?', [postId, user]);
  if (!row || row.__error) throw new Error(row?.__error || `LinkedIn post ${postId} not found`);
  const { getMinScoreForType } = require('./content-taxonomy');
  const minScore = getMinScoreForType(user, row.content_type);
  const receipt = buildLinkedInQualityReview({ post: row, receipts: stageReceiptMap(user, postId), minScore });
  const id = writeAgentReceipt({
    user,
    sourceKind: 'linkedin_post',
    sourceId: postId,
    stage: 'agent:linkedin_quality_board',
    status: receipt.verdict,
    summary: `LinkedIn Quality Board: ${receipt.verdict.toUpperCase()}${receipt.quality_veto ? ' - VETO' : ''} (${receipt.checks.filter(c => c.verdict !== 'pass').length} issue(s))`,
    payload: receipt,
  });
  return { id, receipt };
}

function latestLinkedInQualityReceipt(user, postId) {
  const row = latestReceipt({
    user,
    sourceKind: 'linkedin_post',
    sourceId: postId,
    stage: 'agent:linkedin_quality_board',
  });
  if (!row || row.__error) return null;
  return { ...row, payload_json: parseJson(row.payload, {}) };
}

// True when Douglas has explicitly overridden the veto for this post.
function qualityOverrideActive(user, postId) {
  const row = safeGet('SELECT quality_override FROM linkedin_posts WHERE id = ? AND user = ?', [postId, user]);
  return Boolean(row && !row.__error && row.quality_override);
}

// The single source of truth for "is this post blocked from shipping": an active
// veto that Douglas has NOT overridden. artifactOnlyOk=true ignores blockers that
// only concern the PDF/artifact (those are retryable and shouldn't block text).
function qualityVetoBlocks(user, postId, { artifactOnlyOk = false } = {}) {
  const latest = latestLinkedInQualityReceipt(user, postId);
  if (!latest?.payload_json?.quality_veto) return false;
  if (qualityOverrideActive(user, postId)) return false;
  if (artifactOnlyOk) {
    const retryableArtifactBlockers = new Set(['artifact_is_usable_when_present', 'pipeline_completed_cleanly']);
    return (latest.payload_json.blocking_checks || []).some(name => !retryableArtifactBlockers.has(name));
  }
  return true;
}

function capoQualityTarget(capo) {
  if (capo.key !== 'briefings') return { ...capo, originalKey: capo.key, scopeExclusions: [] };
  return {
    ...capo,
    key: 'briefings_non_nakai',
    originalKey: 'briefings',
    title: 'Briefings Capo (excluding Nakai daily briefing)',
    soldiers: capo.soldiers.filter(s => !/nakai/i.test(s)),
    scopeExclusions: NAKAI_EXCLUDED_TARGETS,
  };
}

function buildCapoQualityReview(capo, latestCapo) {
  const payload = parseJson(latestCapo?.payload, {});
  const receiptAgeHours = latestCapo?.created_at ? Math.round(((now() - latestCapo.created_at) / 3600) * 10) / 10 : null;
  const failedChecks = Array.isArray(payload.checks) ? payload.checks.filter(c => c.verdict === 'fail') : [];
  const warnedChecks = Array.isArray(payload.checks) ? payload.checks.filter(c => c.verdict === 'warn') : [];
  const checks = [
    check(
      'Freshness Auditor',
      'capo_report_is_current',
      latestCapo ? (receiptAgeHours <= 30 ? 'pass' : 'warn') : 'fail',
      latestCapo ? `Latest capo receipt is ${receiptAgeHours} hour(s) old` : 'No capo receipt found',
      { receipt_id: latestCapo?.id || null, receipt_age_hours: receiptAgeHours },
      !latestCapo,
    ),
    check(
      'Source Skeptic',
      'capo_checks_are_not_failing',
      latestCapo?.status === 'fail' || failedChecks.length ? 'fail' : warnedChecks.length || latestCapo?.status === 'warn' ? 'warn' : 'pass',
      `${failedChecks.length} failing check(s), ${warnedChecks.length} warning check(s)`,
      { failed_checks: failedChecks.map(c => c.name), warning_checks: warnedChecks.map(c => c.name) },
      latestCapo?.status === 'fail' || failedChecks.length > 0,
    ),
    check(
      'Reporting Chain Reviewer',
      'soldiers_and_associates_declared',
      capo.soldiers.length && capo.associates.length && capo.reportsTo ? 'pass' : 'fail',
      `${capo.soldiers.length} soldier(s), ${capo.associates.length} associate(s), reports_to=${capo.reportsTo || 'missing'}`,
      { soldiers: capo.soldiers, associates: capo.associates, reports_to: capo.reportsTo },
      true,
    ),
    check(
      'Consigliere Utility Reviewer',
      'summary_is_actionable',
      latestCapo?.summary ? 'pass' : 'warn',
      latestCapo?.summary || 'No human-readable summary on latest receipt',
    ),
  ];
  if (capo.scopeExclusions?.length) {
    checks.push(check(
      'Nakai Exclusion Guard',
      'nakai_daily_briefing_is_out_of_scope',
      'pass',
      `Excluded target(s): ${capo.scopeExclusions.join(', ')}`,
      { excluded_targets: capo.scopeExclusions },
    ));
  }
  const verdict = verdictFor(checks);
  const blocking = checks.filter(c => c.verdict === 'fail' && c.blocks_ship);
  return {
    board: 'Hub Capo Quality Board',
    target: capo.key,
    original_target: capo.originalKey,
    title: capo.title,
    verdict,
    quality_veto: blocking.length > 0,
    blocking_checks: blocking.map(c => c.name),
    scope_exclusions: capo.scopeExclusions || [],
    checks,
    run_at: new Date().toISOString(),
  };
}

function writeCapoQualityReview(capo, user = 'douglas') {
  const target = capoQualityTarget(capo);
  const latestCapo = latestReceipt({
    user,
    sourceKind: 'hub_module',
    sourceId: target.originalKey,
    stage: `agent:capo:${target.originalKey}`,
  });
  const receipt = buildCapoQualityReview(target, latestCapo?.__error ? null : latestCapo);
  const id = writeAgentReceipt({
    user,
    sourceKind: 'hub_quality',
    sourceId: `capo:${target.key}`,
    stage: `agent:quality_board:${target.key}`,
    status: receipt.verdict,
    summary: `${target.title} Quality Board: ${receipt.verdict.toUpperCase()}${receipt.quality_veto ? ' - VETO' : ''}`,
    payload: receipt,
  });
  return { id, receipt };
}

function buildUnderbossQualityReview(underboss, reports) {
  const missing = reports.filter(r => !r.latest);
  const failing = reports.filter(r => r.status === 'fail');
  const warnings = reports.filter(r => r.status === 'warn');
  const checks = [
    check(
      'Underboss Reviewer',
      'all_capos_have_quality_review',
      missing.length ? 'fail' : 'pass',
      `${missing.length} missing capo quality review(s)`,
      { missing: missing.map(r => r.capo) },
      true,
    ),
    check(
      'Consigliere Utility Reviewer',
      'quality_vetoes_escalate',
      failing.length ? 'fail' : warnings.length ? 'warn' : 'pass',
      `${failing.length} failing board(s), ${warnings.length} warning board(s)`,
      { failing: failing.map(r => r.capo), warnings: warnings.map(r => r.capo) },
      failing.length > 0,
    ),
  ];
  const verdict = verdictFor(checks);
  return {
    board: 'Hub Underboss Quality Board',
    target: underboss.key,
    title: underboss.title,
    verdict,
    quality_veto: checks.some(c => c.verdict === 'fail' && c.blocks_ship),
    checks,
    reports,
    run_at: new Date().toISOString(),
  };
}

function writeUnderbossQualityReview(underboss, user = 'douglas') {
  const reports = underboss.capos.map(capoKey => {
    const sourceId = capoKey === 'briefings' ? 'capo:briefings_non_nakai' : `capo:${capoKey}`;
    const latest = latestReceipt({
      user,
      sourceKind: 'hub_quality',
      sourceId,
    });
    return {
      capo: capoKey === 'briefings' ? 'briefings_non_nakai' : capoKey,
      status: latest?.__error ? 'missing' : latest?.status || 'missing',
      summary: latest?.summary || '',
      latest: latest && !latest.__error ? latest.id : null,
    };
  });
  if (underboss.key === 'crm_underboss') {
    for (const section of CRM_QUALITY_SECTIONS) {
      const latest = latestReceipt({
        user,
        sourceKind: 'hub_quality',
        sourceId: section,
      });
      reports.push({
        capo: section,
        status: latest?.__error ? 'missing' : latest?.status || 'missing',
        summary: latest?.summary || '',
        latest: latest && !latest.__error ? latest.id : null,
      });
    }
  }
  const receipt = buildUnderbossQualityReview(underboss, reports);
  const id = writeAgentReceipt({
    user,
    sourceKind: 'hub_quality',
    sourceId: `underboss:${underboss.key}`,
    stage: `agent:quality_board:${underboss.key}`,
    status: receipt.verdict,
    summary: `${underboss.title} Quality Board: ${receipt.verdict.toUpperCase()}${receipt.quality_veto ? ' - VETO' : ''}`,
    payload: receipt,
  });
  return { id, receipt };
}

function recentMeetingIntakes(user = 'douglas', days = 45) {
  return safeAll(`
    SELECT id, user, meeting_id, project_slug, title, transcript, summary, extraction,
           created_counts, status, error, created_at
    FROM meeting_intakes
    WHERE user = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 80
  `, [user, now() - days * 86400]).filter(row => !row.__error);
}

function crmContacts(user = 'douglas') {
  return safeAll(`
    SELECT id, name, aliases, email, notes, created_at
    FROM contacts
    WHERE user = ?
    ORDER BY name
  `, [user]).filter(row => !row.__error);
}

function crmProjectEvidence(user = 'douglas') {
  return safeAll(`
    SELECT c.id AS contact_id, c.name AS contact_name, p.slug AS project_slug, p.name AS project_name, 'contact_projects' AS source
    FROM contact_projects cp
    JOIN contacts c ON c.id = cp.contact_id
    JOIN projects p ON p.id = cp.project_id
    WHERE c.user = ?
    UNION ALL
    SELECT c.id AS contact_id, c.name AS contact_name, f.project_slug AS project_slug, f.project_slug AS project_name, 'crm_facts' AS source
    FROM crm_facts f
    JOIN contacts c ON c.id = f.contact_id
    WHERE f.user = ? AND COALESCE(f.project_slug, '') != ''
    UNION ALL
    SELECT c.id AS contact_id, c.name AS contact_name, t.project_slug AS project_slug, t.project_slug AS project_name, 'google_tasks' AS source
    FROM google_tasks t
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.user = ? AND COALESCE(t.project_slug, '') != ''
    UNION ALL
    SELECT c.id AS contact_id, c.name AS contact_name, mi.project_slug AS project_slug, mi.project_slug AS project_name, 'meeting_intakes' AS source
    FROM meeting_intakes mi
    JOIN meeting_attendees ma ON ma.meeting_id = mi.meeting_id
    JOIN contacts c ON c.id = ma.contact_id
    WHERE mi.user = ? AND COALESCE(mi.project_slug, '') != ''
  `, [user, user, user, user]).filter(row => !row.__error);
}

function crmTasks(user = 'douglas', days = 90) {
  return safeAll(`
    SELECT id, title, notes, status, source, source_id, contact_id, company_id, project_slug, due, created_at
    FROM google_tasks
    WHERE user = ? AND (created_at >= ? OR status = 'needsAction')
    ORDER BY created_at DESC
    LIMIT 200
  `, [user, now() - days * 86400]).filter(row => !row.__error);
}

function danglingProjectRefs(user = 'douglas') {
  return safeAll(`
    SELECT 'crm_facts' AS source, id, project_slug
    FROM crm_facts
    WHERE user = ? AND COALESCE(project_slug, '') != ''
      AND project_slug NOT IN (SELECT slug FROM projects WHERE user = ?)
    UNION ALL
    SELECT 'google_tasks' AS source, id, project_slug
    FROM google_tasks
    WHERE user = ? AND COALESCE(project_slug, '') != ''
      AND project_slug NOT IN (SELECT slug FROM projects WHERE user = ?)
    UNION ALL
    SELECT 'meeting_intakes' AS source, id, project_slug
    FROM meeting_intakes
    WHERE user = ? AND COALESCE(project_slug, '') != ''
      AND project_slug NOT IN (SELECT slug FROM projects WHERE user = ?)
    LIMIT 100
  `, [user, user, user, user, user, user]).filter(row => !row.__error);
}

function writeCrmSectionQualityReceipt(user, section, receipt) {
  const id = writeAgentReceipt({
    user,
    sourceKind: 'hub_quality',
    sourceId: section,
    stage: `agent:quality_board:${section}`,
    status: receipt.verdict,
    summary: `${receipt.board}: ${receipt.verdict.toUpperCase()} (${receipt.checks.filter(c => c.verdict !== 'pass').length} issue(s))`,
    payload: receipt,
  });
  return { id, receipt };
}

function runCrmQualityBoards(user = 'douglas') {
  const contacts = crmContacts(user);
  const projectEvidence = crmProjectEvidence(user);
  const intakes = recentMeetingIntakes(user);
  const tasks = crmTasks(user);
  const answered = (() => {
    try { return require('./crm-clarifications').answeredKeys(user); } catch (_) { return null; }
  })();
  const receipts = [
    writeCrmSectionQualityReceipt(user, 'crm:people', buildCrmPeopleQualityReview({ contacts, projectEvidence, answered })).receipt,
    writeCrmSectionQualityReceipt(user, 'crm:meeting_intake', buildMeetingIntakeQualityReview({ intakes, contacts, answered })).receipt,
    writeCrmSectionQualityReceipt(user, 'crm:tasks', buildTaskActionQualityReview({ tasks, intakes, contacts, answered })).receipt,
    writeCrmSectionQualityReceipt(user, 'crm:project_context', buildProjectContextQualityReview({ danglingRefs: danglingProjectRefs(user) })).receipt,
  ];
  return receipts;
}

function runHubQualityBoards(user = 'douglas') {
  const capoReceipts = CAPOS.map(capo => writeCapoQualityReview(capo, user).receipt);
  const crmSectionReceipts = runCrmQualityBoards(user);
  const underbossReceipts = UNDERBOSSES.map(underboss => writeUnderbossQualityReview(underboss, user).receipt);
  return {
    excluded_targets: NAKAI_EXCLUDED_TARGETS,
    capoReceipts,
    crmSectionReceipts,
    underbossReceipts,
  };
}

module.exports = {
  CRM_QUALITY_SECTIONS,
  NAKAI_EXCLUDED_TARGETS,
  buildCapoQualityReview,
  buildCrmPeopleQualityReview,
  buildLinkedInQualityReview,
  buildMeetingIntakeQualityReview,
  buildProjectContextQualityReview,
  buildTaskActionQualityReview,
  buildUnderbossQualityReview,
  crmContacts,
  crmProjectEvidence,
  crmTasks,
  danglingProjectRefs,
  findProjectScopedPersonIssues,
  intakeClarificationIssues,
  recentMeetingIntakes,
  latestLinkedInQualityReceipt,
  qualityOverrideActive,
  qualityVetoBlocks,
  runCrmQualityBoards,
  runHubQualityBoards,
  taskActionIssues,
  writeCapoQualityReview,
  writeCrmSectionQualityReceipt,
  writeLinkedInQualityReview,
  writeUnderbossQualityReview,
};
