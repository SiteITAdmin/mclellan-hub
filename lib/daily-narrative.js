'use strict';

// "TODAY" section of the Daily Consigliere Report: a short narrative of what
// actually came in and what it means, not a count of rows. The rest of the
// report (Needs you, Hard to place, Self-repairs) is about problems; this is
// the one place the report describes the day's actual content — the whole
// point of the Hub per CLAUDE.md's knowledge-first principle: synthesis over
// row counts. Same shape as consigliere-brief.js — deterministic data pull,
// model prose, deterministic fallback if the model is unavailable.

const db = require('./db');
const { getSystemModelId } = require('./settings');
const { PROMPTS } = require('./prompts');
const { TASK_CODES } = require('./openrouter-attribution');
const { requestModelObject } = require('./model-request');

const NARRATIVE_FEATURE = 'daily_narrative';
const NARRATIVE_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-6';
const MAX_ITEMS_PER_KIND = 25;

function gatherTodayContent(user = 'douglas', sinceSeconds) {
  const hub = db.hub();

  const emails = hub.prepare(`
    SELECT subject, from_name, project_slug, summary
    FROM email_summaries
    WHERE user = ? AND received_at >= ? AND direction != 'sent'
    ORDER BY received_at DESC
    LIMIT ?
  `).all(user, sinceSeconds, MAX_ITEMS_PER_KIND);

  const atoms = hub.prepare(`
    SELECT subject_label, predicate, value
    FROM knowledge_atoms
    WHERE user = ? AND first_seen >= ? AND status = 'active'
    ORDER BY first_seen DESC
    LIMIT ?
  `).all(user, sinceSeconds, MAX_ITEMS_PER_KIND);

  const meetings = hub.prepare(`
    SELECT title, project_slug, summary
    FROM meeting_intakes
    WHERE user = ? AND created_at >= ? AND status = 'processed'
    ORDER BY created_at DESC
    LIMIT 10
  `).all(user, sinceSeconds);

  const documents = hub.prepare(`
    SELECT filename, project_id
    FROM documents
    WHERE user = ? AND uploaded_at >= ?
    ORDER BY uploaded_at DESC
    LIMIT 25
  `).all(user, sinceSeconds);

  return { emails, atoms, meetings, documents };
}

function projectsTouched(content) {
  const slugs = new Set();
  for (const e of content.emails) if (e.project_slug) slugs.add(e.project_slug);
  for (const m of content.meetings) if (m.project_slug) slugs.add(m.project_slug);
  return [...slugs];
}

function buildPrompt(content) {
  const system = PROMPTS.daily_narrative;
  return [
    system,
    '',
    'Today\'s raw content (already de-identified of internal ids):',
    JSON.stringify({
      email_count: content.emails.length,
      emails: content.emails.slice(0, MAX_ITEMS_PER_KIND),
      new_facts_count: content.atoms.length,
      new_facts: content.atoms.slice(0, MAX_ITEMS_PER_KIND),
      meetings: content.meetings,
      documents: content.documents.map(d => ({ filename: d.filename, filed: Boolean(d.project_id) })),
      projects_touched: projectsTouched(content),
    }, null, 2),
  ].join('\n');
}

// No model available: a still-readable, if flatter, version — counts grouped
// by project/topic rather than a narrative paragraph.
function fallbackNarrative(content) {
  if (!content.emails.length && !content.atoms.length && !content.meetings.length && !content.documents.length) {
    return 'Quiet day — nothing new came in.';
  }
  const parts = [];
  if (content.emails.length) {
    const projects = projectsTouched(content);
    parts.push(`${content.emails.length} email(s) came in${projects.length ? `, touching ${projects.slice(0, 5).join(', ')}` : ''}.`);
  }
  if (content.meetings.length) {
    parts.push(`${content.meetings.length} meeting(s) processed: ${content.meetings.map(m => m.title).filter(Boolean).slice(0, 3).join('; ')}.`);
  }
  if (content.atoms.length) {
    parts.push(`${content.atoms.length} new fact(s) learned, e.g. ${content.atoms.slice(0, 3).map(a => `${a.subject_label} ${a.predicate} ${a.value}`).join('; ')}.`);
  }
  if (content.documents.length) {
    const unfiled = content.documents.filter(d => !d.project_id).length;
    parts.push(`${content.documents.length} document(s) uploaded${unfiled ? ` (${unfiled} not yet filed to a project)` : ''}.`);
  }
  return parts.join(' ');
}

async function composeDailyNarrative(user = 'douglas', options = {}) {
  const sinceSeconds = options.since || Math.floor(Date.now() / 1000) - 86400;
  const content = gatherTodayContent(user, sinceSeconds);

  if (process.env.SUBSCRIPTION_AGENT_DISABLED === '1') {
    return { narrative: fallbackNarrative(content), usedModel: false, content };
  }

  const modelId = getSystemModelId(NARRATIVE_FEATURE, 'system', NARRATIVE_FALLBACK_MODEL);
  try {
    const result = await requestModelObject({
      modelId,
      messages: [{ role: 'user', content: buildPrompt(content) }],
      user,
      feature: NARRATIVE_FEATURE,
      modelKey: NARRATIVE_FEATURE,
      taskCode: TASK_CODES.ADMIN,
      temperature: 0.4,
      defaults: { narrative: '' },
      label: 'daily narrative',
    });
    const narrative = String(result.narrative || '').trim();
    if (!narrative) return { narrative: fallbackNarrative(content), usedModel: false, content };
    return { narrative, usedModel: true, modelId, content };
  } catch (_) {
    return { narrative: fallbackNarrative(content), usedModel: false, content };
  }
}

module.exports = {
  gatherTodayContent,
  fallbackNarrative,
  composeDailyNarrative,
  projectsTouched,
};
