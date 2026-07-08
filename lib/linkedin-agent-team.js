'use strict';

const { writeAgentReceipt } = require('./agent-receipts');

const SOURCE_KIND = 'linkedin_post';

function check(name, verdict, evidence, details = {}) {
  return { name, verdict, evidence, details };
}

function overallVerdict(checks) {
  if (checks.some(c => c.verdict === 'fail')) return 'fail';
  if (checks.some(c => c.verdict === 'warn')) return 'warn';
  return 'pass';
}

function stageSummary(agentName, verdict, checks) {
  const issues = checks.filter(c => c.verdict !== 'pass').length;
  return `${agentName}: ${verdict.toUpperCase()} (${issues} issue(s))`;
}

function writeLinkedInReceipt(user, postId, stage, agentName, checks, extra = {}) {
  const verdict = overallVerdict(checks);
  const payload = {
    agent: agentName,
    post_id: postId,
    verdict,
    run_at: new Date().toISOString(),
    checks,
    ...extra,
  };
  let id = null;
  try {
    id = writeAgentReceipt({
      user,
      sourceKind: SOURCE_KIND,
      sourceId: postId,
      stage,
      status: verdict,
      summary: stageSummary(agentName, verdict, checks),
      payload,
    });
  } catch (err) {
    console.warn(`[linkedin-agent-team] ${stage} receipt failed:`, err.message);
  }
  return { id, receipt: payload };
}

function buildResearchChecks({ synthesis = '', sources = [], sourceUrl = null } = {}) {
  const sourceList = Array.isArray(sources) ? sources : [];
  const fetchedSources = sourceList.filter(s => s?.fullContent || s?.snippet || s?.isPrimary);
  const primary = sourceUrl ? sourceList.find(s => s?.isPrimary || s?.url === sourceUrl) : null;
  return [
    check(
      'research_synthesis_present',
      String(synthesis || '').trim().length >= 200 ? 'pass' : 'fail',
      `${String(synthesis || '').trim().length} synthesis character(s)`,
    ),
    check(
      'source_list_present',
      sourceList.length >= 3 ? 'pass' : sourceList.length > 0 ? 'warn' : 'fail',
      `${sourceList.length} source(s) attached`,
      { source_count: sourceList.length },
    ),
    check(
      'source_content_available',
      fetchedSources.length > 0 ? 'pass' : 'warn',
      `${fetchedSources.length} source(s) have fetched content, snippet, or primary-source marker`,
    ),
    check(
      'primary_source_preserved',
      sourceUrl ? (primary ? 'pass' : 'fail') : 'pass',
      sourceUrl ? (primary ? `Primary source preserved: ${sourceUrl}` : `Primary source missing: ${sourceUrl}`) : 'No primary source supplied',
      { source_url: sourceUrl || null },
    ),
  ];
}

function writeResearchReceipt({ user, postId, topic, synthesis, sources, sourceUrl }) {
  const checks = buildResearchChecks({ synthesis, sources, sourceUrl });
  return writeLinkedInReceipt(user, postId, 'agent:linkedin_research', 'LinkedIn Research Agent', checks, {
    topic,
    source_url: sourceUrl || null,
    source_count: Array.isArray(sources) ? sources.length : 0,
    sources: (Array.isArray(sources) ? sources : []).slice(0, 20).map(s => ({
      title: s.title || '',
      url: s.url || '',
      is_primary: Boolean(s.isPrimary),
      has_full_content: Boolean(s.fullContent),
    })),
  });
}

function buildDraftCriticChecks({ draft = '', refinedDraft = '', scoring = {} } = {}) {
  const axis = scoring?.axis_scores || {};
  const overall = Number(scoring?.overall_score || 0);
  const topFixes = Array.isArray(scoring?.top_fixes) ? scoring.top_fixes : [];
  return [
    check(
      'draft_present',
      String(draft || '').trim().length >= 100 ? 'pass' : 'fail',
      `${String(draft || '').trim().length} draft character(s)`,
    ),
    check(
      'score_present',
      overall > 0 ? 'pass' : 'fail',
      overall > 0 ? `overall_score=${overall}` : 'No overall score present',
    ),
    check(
      'top_fixes_specific',
      topFixes.length >= 1 ? 'pass' : 'warn',
      `${topFixes.length} top fix(es) returned`,
    ),
    check(
      'expertise_signal',
      Number(axis.demonstrated_expertise || 0) >= 3 ? 'pass' : 'warn',
      `demonstrated_expertise=${axis.demonstrated_expertise || 'missing'}`,
    ),
    check(
      'refinement_present',
      String(refinedDraft || '').trim().length >= 100 ? 'pass' : 'warn',
      refinedDraft ? `${String(refinedDraft).trim().length} refined character(s)` : 'Refinement skipped or unavailable',
    ),
  ];
}

function writeDraftCriticReceipt({ user, postId, draft, refinedDraft, scoring }) {
  const checks = buildDraftCriticChecks({ draft, refinedDraft, scoring });
  return writeLinkedInReceipt(user, postId, 'agent:linkedin_draft_critic', 'LinkedIn Draft/Critic Agent', checks, {
    overall_score: scoring?.overall_score || null,
    recruiter_value: scoring?.recruiter_value || null,
  });
}

function inspectPdfBuffer(pdfBuffer) {
  const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer || '');
  return {
    bytes: buffer.length,
    has_pdf_header: buffer.slice(0, 4).toString('utf8') === '%PDF',
    rough_page_count: (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length,
  };
}

function buildArtifactChecks({ pdfBuffer = null, carouselUrl = '', carouselReviewed = false, error = null } = {}) {
  if (error) {
    return [
      check('artifact_generation_error', 'fail', String(error.message || error)),
    ];
  }
  const pdf = inspectPdfBuffer(pdfBuffer);
  return [
    check(
      'pdf_header_valid',
      pdf.has_pdf_header ? 'pass' : 'fail',
      pdf.has_pdf_header ? 'PDF header present' : 'PDF header missing',
      pdf,
    ),
    check(
      'pdf_size_sane',
      pdf.bytes > 1024 ? 'pass' : 'fail',
      `${pdf.bytes} byte(s)`,
      pdf,
    ),
    check(
      'carousel_reviewed',
      carouselReviewed ? 'pass' : 'warn',
      carouselReviewed ? 'Carousel review completed' : 'Carousel review skipped or returned unexpected shape',
    ),
    check(
      'drive_url_present',
      carouselUrl ? 'pass' : 'warn',
      carouselUrl ? `Carousel uploaded: ${carouselUrl}` : 'No carousel Drive URL recorded',
    ),
  ];
}

function writeArtifactReceipt({ user, postId, pdfBuffer, carouselUrl, carouselReviewed, error = null }) {
  const checks = buildArtifactChecks({ pdfBuffer, carouselUrl, carouselReviewed, error });
  return writeLinkedInReceipt(user, postId, 'agent:linkedin_artifact', 'PDF / Artifact Agent', checks, {
    carousel_url: carouselUrl || '',
  });
}

function buildManagingEditorChecks({ post = {}, error = null } = {}) {
  if (error) {
    return [check('pipeline_error', 'fail', String(error.message || error))];
  }
  return [
    check('research_present', post.research ? 'pass' : 'fail', post.research ? 'Research stored' : 'Research missing'),
    check('draft_present', post.draft ? 'pass' : 'fail', post.draft ? 'Draft stored' : 'Draft missing'),
    check('score_present', post.score_json && post.score_json !== '{}' ? 'pass' : 'fail', post.score_json ? 'Score JSON stored' : 'Score missing'),
    check('refined_draft_present', post.refined_draft ? 'pass' : 'warn', post.refined_draft ? 'Refined draft stored' : 'Refinement missing'),
    check('carousel_present', post.carousel_url ? 'pass' : 'warn', post.carousel_url ? 'Carousel URL stored' : 'Carousel missing'),
    check('sheet_present', post.sheet_url ? 'pass' : 'warn', post.sheet_url ? 'Sheet URL stored' : 'Sheet row missing'),
  ];
}

function writeManagingEditorReceipt({ user, postId, post, error = null }) {
  const checks = buildManagingEditorChecks({ post, error });
  return writeLinkedInReceipt(user, postId, 'agent:linkedin_managing_editor', 'LinkedIn Managing Editor Agent', checks, {
    status: post?.status || (error ? 'error' : ''),
  });
}

function buildPublishingChecks({ post = {}, postUrl = '', captureOk = false, error = null } = {}) {
  return [
    check(
      'post_text_present',
      (post.refined_draft || post.draft || '').trim().length >= 100 ? 'pass' : 'fail',
      `${(post.refined_draft || post.draft || '').trim().length} published text character(s)`,
    ),
    check(
      'post_url_valid',
      postUrl ? (/^https:\/\/(www\.)?linkedin\.com\//.test(postUrl) ? 'pass' : 'fail') : 'warn',
      postUrl || 'No LinkedIn URL supplied yet',
    ),
    check(
      'knowledge_capture',
      captureOk ? 'pass' : 'fail',
      captureOk ? 'Published post captured into knowledge bundle' : `Knowledge capture failed${error ? `: ${error.message || error}` : ''}`,
    ),
  ];
}

function writePublishingReceipt({ user, postId, post, postUrl, captureOk, error = null }) {
  const checks = buildPublishingChecks({ post, postUrl, captureOk, error });
  return writeLinkedInReceipt(user, postId, 'agent:linkedin_publishing_archivist', 'Publishing Archivist Agent', checks, {
    post_url: postUrl || '',
  });
}

module.exports = {
  buildResearchChecks,
  buildDraftCriticChecks,
  buildArtifactChecks,
  buildManagingEditorChecks,
  buildPublishingChecks,
  inspectPdfBuffer,
  writeResearchReceipt,
  writeDraftCriticReceipt,
  writeArtifactReceipt,
  writeManagingEditorReceipt,
  writePublishingReceipt,
};
