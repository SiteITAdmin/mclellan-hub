'use strict';

// Purpose-aware ownership for the LinkedIn pipeline. This does not replace the
// pipeline, quality board, remediation queue, or repair venue. It reads their
// evidence as one journey, tells the existing remediation layer which
// reversible job can move an unmet outcome forward, and records what happened.

const db = require('./db');
const { writeAgentReceipt } = require('./agent-receipts');

const PURPOSE = 'Carry every selected LinkedIn topic to a sourced, quality-approved post package with a valid carousel PDF ready for Douglas, a published/captured post, or a visible repair in progress.';
const SOURCE_KIND = 'linkedin_post';
const SUPERVISOR_STAGE = 'agent:linkedin_journey_supervisor';
const ARTIFACT_ONLY_BLOCKERS = new Set(['artifact_is_usable_when_present', 'pipeline_completed_cleanly']);
const PROCESSING_STALL_SECONDS = 45 * 60;

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch (_) { return fallback; }
}

function latestByStage(receipts = []) {
  const map = {};
  for (const receipt of receipts) {
    if (!map[receipt.stage] || Number(receipt.created_at || 0) > Number(map[receipt.stage].created_at || 0)) {
      map[receipt.stage] = receipt;
    }
  }
  return map;
}

function assessLinkedInPost(post = {}, receipts = [], nowTs = Math.floor(Date.now() / 1000)) {
  const byStage = latestByStage(receipts);
  const qualityRow = byStage['agent:linkedin_quality_board'];
  const quality = parseJson(qualityRow?.payload, {});
  const blockers = Array.isArray(quality.blocking_checks) ? quality.blocking_checks : [];
  const contentBlockers = blockers.filter(name => !ARTIFACT_ONLY_BLOCKERS.has(name));
  const overrideActive = Boolean(post.quality_override);
  const status = String(post.status || 'draft');
  const lastActivity = Math.max(
    Number(post.created_at || 0),
    Number(post.quality_override || 0),
    ...receipts.map(r => Number(r.created_at || 0)),
  );
  const base = {
    post_id: String(post.id || ''),
    topic: String(post.topic || ''),
    status,
    purpose: PURPOSE,
    blockers,
    content_blockers: contentBlockers,
    override_active: overrideActive,
    carousel_present: Boolean(post.carousel_url),
    last_activity_at: lastActivity || null,
    achieved: false,
    waiting: false,
    action: null,
    reason: '',
  };

  // Publishing is an explicit human action and therefore a legitimate terminal
  // state for historical text-only posts as well as carousel posts.
  if (status === 'published') {
    return { ...base, achieved: true, reason: 'Post was explicitly published and captured.' };
  }

  if (status === 'processing') {
    if (lastActivity && nowTs - lastActivity <= PROCESSING_STALL_SECONDS) {
      return { ...base, waiting: true, reason: 'Pipeline is actively processing within the stall window.' };
    }
    return { ...base, action: 'regenerate', reason: 'Processing stalled without reaching a terminal outcome.' };
  }

  if (status === 'error') {
    return { ...base, action: 'regenerate', reason: 'Pipeline ended in an error state.' };
  }

  if (status === 'needs_revision') {
    if (overrideActive) {
      return post.carousel_url
        ? { ...base, achieved: true, reason: 'Douglas overrode the veto and the post package has its PDF.' }
        : { ...base, action: 'resume_artifact', reason: 'Douglas overrode the veto, so artifact generation must continue.' };
    }
    if (contentBlockers.length || !qualityRow) {
      return {
        ...base,
        action: 'regenerate',
        reason: contentBlockers.length
          ? `Quality veto requires content repair: ${contentBlockers.join(', ')}.`
          : 'Post needs revision but has no usable quality diagnosis.',
      };
    }
    return { ...base, action: 'resume_artifact', reason: 'Only the artifact leg remains unresolved.' };
  }

  if (['draft', 'scheduled'].includes(status)) {
    if (quality.quality_veto && !overrideActive && contentBlockers.length) {
      return { ...base, action: 'regenerate', reason: `Active content veto requires repair: ${contentBlockers.join(', ')}.` };
    }
    if (!post.carousel_url) {
      return { ...base, action: 'resume_artifact', reason: `${status} post has no carousel PDF.` };
    }
    return {
      ...base,
      achieved: true,
      reason: status === 'scheduled'
        ? 'Quality-approved post package is scheduled and has its PDF.'
        : 'Quality-approved post package is ready for Douglas and has its PDF.',
    };
  }

  return { ...base, action: 'regenerate', reason: `Unknown non-terminal status ${status}.` };
}

function receiptsForPosts(hub, user, postIds) {
  if (!postIds.length) return new Map();
  const placeholders = postIds.map(() => '?').join(',');
  const rows = hub.prepare(`
    SELECT * FROM knowledge_receipts
    WHERE user = ? AND source_kind = ? AND source_id IN (${placeholders})
      AND stage LIKE 'agent:linkedin_%'
    ORDER BY created_at DESC, rowid DESC
  `).all(user, SOURCE_KIND, ...postIds);
  const map = new Map(postIds.map(id => [String(id), []]));
  for (const row of rows) {
    const key = String(row.source_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function auditLinkedInJourneys(user = 'douglas', { nowTs = Math.floor(Date.now() / 1000) } = {}) {
  const hub = db.hub();
  let posts = [];
  try {
    posts = hub.prepare(`
      SELECT * FROM linkedin_posts
      WHERE user = ? AND status != 'published'
      ORDER BY created_at ASC
      LIMIT 200
    `).all(user);
  } catch (err) {
    return { purpose: PURPOSE, issues: [], waiting: [], achieved: [], error: err.message };
  }
  const receiptMap = receiptsForPosts(hub, user, posts.map(p => String(p.id)));
  const assessments = posts.map(post => assessLinkedInPost(post, receiptMap.get(String(post.id)) || [], nowTs));
  return {
    purpose: PURPOSE,
    issues: assessments.filter(a => a.action),
    waiting: assessments.filter(a => a.waiting),
    achieved: assessments.filter(a => a.achieved),
    assessments,
  };
}

function writeSupervisorReceipt(user, assessment, status, summary, payload = {}) {
  return writeAgentReceipt({
    user,
    sourceKind: SOURCE_KIND,
    sourceId: assessment.post_id,
    stage: SUPERVISOR_STAGE,
    status,
    summary,
    payload: {
      agent: 'linkedin_journey_supervisor',
      purpose: PURPOSE,
      assessment,
      ...payload,
      run_at: new Date().toISOString(),
    },
  });
}

async function repairLinkedInJourneys(user = 'douglas', { limit = 3, nowTs = Math.floor(Date.now() / 1000), onStatus = () => {} } = {}) {
  const hub = db.hub();
  const audit = auditLinkedInJourneys(user, { nowTs });
  if (audit.error) throw new Error(`LinkedIn journey audit failed: ${audit.error}`);
  const targets = audit.issues.slice(0, limit);
  const outcomes = [];

  for (const before of targets) {
    writeSupervisorReceipt(user, before, 'warn', `LinkedIn journey repair starting: ${before.action} — ${before.reason}`, {
      intended_action: before.action,
    });
    try {
      const post = hub.prepare('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?').get(before.post_id, user);
      if (!post) throw new Error(`LinkedIn post ${before.post_id} disappeared before repair`);
      onStatus(`${before.post_id}: ${before.action} — ${before.reason}`);
      if (before.action === 'regenerate') {
        hub.prepare(`
          UPDATE linkedin_posts
             SET status = 'processing', quality_override = NULL, quality_override_reason = '',
                 carousel_url = '', sheet_url = '', image_url = ''
           WHERE id = ? AND user = ?
        `).run(before.post_id, user);
        await require('./linkedin-pipeline').runPipeline(
          user,
          post.topic,
          message => onStatus(`${before.post_id}: ${message}`),
          before.post_id,
          null,
          post.spiciness || 'professional',
        );
      } else if (before.action === 'resume_artifact') {
        await require('./linkedin-pipeline').resumePost(
          before.post_id,
          user,
          message => onStatus(`${before.post_id}: ${message}`),
          { originalStatus: post.status },
        );
      } else {
        throw new Error(`Unsupported LinkedIn journey repair action ${before.action}`);
      }

      const refreshed = hub.prepare('SELECT * FROM linkedin_posts WHERE id = ? AND user = ?').get(before.post_id, user);
      const receipts = hub.prepare(`
        SELECT * FROM knowledge_receipts
        WHERE user = ? AND source_kind = ? AND source_id = ? AND stage LIKE 'agent:linkedin_%'
        ORDER BY created_at DESC, rowid DESC
      `).all(user, SOURCE_KIND, before.post_id);
      const after = assessLinkedInPost(refreshed, receipts, Math.floor(Date.now() / 1000));
      const resolved = after.achieved || after.waiting;
      writeSupervisorReceipt(
        user,
        after,
        resolved ? 'pass' : 'fail',
        resolved
          ? `LinkedIn journey advanced after ${before.action}: ${after.reason}`
          : `LinkedIn journey remains unmet after ${before.action}: ${after.reason}`,
        { intended_action: before.action, before, resolved },
      );
      outcomes.push({ post_id: before.post_id, action: before.action, resolved, before, after });
    } catch (err) {
      writeSupervisorReceipt(user, before, 'error', `LinkedIn journey repair crashed during ${before.action}: ${err.message}`, {
        intended_action: before.action,
        error: err.message,
      });
      // A crashed repair job is a code/runtime failure. Let system_jobs record
      // it so the existing snapshot reproducer and repair venue can mine it.
      throw err;
    }
  }

  return {
    purpose: PURPOSE,
    considered: audit.issues.length,
    attempted: outcomes.length,
    resolved: outcomes.filter(o => o.resolved).length,
    unresolved: outcomes.filter(o => !o.resolved).length,
    outcomes,
  };
}

module.exports = {
  PURPOSE,
  SUPERVISOR_STAGE,
  assessLinkedInPost,
  auditLinkedInJourneys,
  repairLinkedInJourneys,
};
