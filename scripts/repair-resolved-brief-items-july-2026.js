#!/usr/bin/env node
'use strict';

// The 26 July Consigliere brief repeated items Douglas had already resolved:
// ordinary questions from one processed meeting, and task references to the
// deliberately retired Second Brain project. Preserve the source evidence,
// close the questions without inventing answers, and restore the deleted
// project identity as closed compiled knowledge.
//
// Idempotent. Run with --apply to write; default is a dry run.

const path = require('path');

function options(argv) {
  const out = {
    apply: false,
    db: process.env.HUB_DB_PATH || path.join(__dirname, '..', 'data', 'hub.db'),
    user: 'douglas',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i].startsWith('--user=')) out.user = argv[i].slice('--user='.length);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  out.db = path.resolve(out.db);
  return out;
}

const config = options(process.argv.slice(2));
process.env.HUB_DB_PATH = config.db;

const db = require('../lib/db');
const { uuid } = require('../lib/id');
const {
  clarificationKey,
  discardClarification,
} = require('../lib/crm-clarifications');
const { intakeClarificationIssues } = require('../lib/hub-quality-board');

const TARGET_INTAKE_ID = 'ba788f1f-1bbd-4fc1-ba79-e43c5e656633';
const HISTORICAL_SLUG = 'second-brain';
const HISTORICAL_NAME = 'Second Brain';

function meetingRepairPlan(hub, user) {
  const intake = hub.prepare('SELECT * FROM meeting_intakes WHERE id = ? AND user = ?')
    .get(TARGET_INTAKE_ID, user);
  if (!intake) return { intake: null, open: [] };
  const contacts = hub.prepare('SELECT id, name, aliases FROM contacts WHERE user = ?').all(user);
  const answered = new Set(hub.prepare(
    'SELECT question_key FROM crm_clarification_answers WHERE user = ?'
  ).all(user).map(row => row.question_key));
  const open = intakeClarificationIssues([intake], contacts)
    .filter(issue => issue.type !== 'generic_speaker_labels')
    .map(issue => ({
      ...issue,
      key: clarificationKey({ ...issue, kind: 'meeting_question' }),
    }))
    .filter(issue => !answered.has(issue.key));
  return {
    intake: { id: intake.id, title: intake.title, status: intake.status },
    open,
  };
}

function projectRepairPlan(hub, user) {
  const tasks = hub.prepare(
    'SELECT id, title, status, source_id FROM google_tasks WHERE user = ? AND project_slug = ? ORDER BY created_at'
  ).all(user, HISTORICAL_SLUG);
  const sourceDocumentIds = [...new Set(tasks.map(task =>
    String(task.source_id || '').match(/^doc:([^:]+):/)?.[1]
  ).filter(Boolean))];
  const sourceDocuments = sourceDocumentIds.length
    ? hub.prepare(`
        SELECT id, filename, project_id FROM documents
        WHERE user = ? AND id IN (${sourceDocumentIds.map(() => '?').join(',')})
      `).all(user, ...sourceDocumentIds)
    : [];
  const recoveredIds = [...new Set(sourceDocuments.map(doc => doc.project_id).filter(Boolean))];
  const existing = hub.prepare('SELECT * FROM projects WHERE user = ? AND slug = ?')
    .get(user, HISTORICAL_SLUG);
  return { tasks, sourceDocuments, recoveredIds, existing };
}

function restoreClosedProject(hub, user, plan) {
  if (!plan.tasks.length) return null;
  if (plan.recoveredIds.length !== 1) {
    throw new Error(`Expected one source-backed project id for ${HISTORICAL_SLUG}; found ${plan.recoveredIds.length}`);
  }
  const projectId = plan.existing?.id || plan.recoveredIds[0];
  const idCollision = hub.prepare('SELECT slug FROM projects WHERE user = ? AND id = ?')
    .get(user, projectId);
  if (idCollision && idCollision.slug !== HISTORICAL_SLUG) {
    throw new Error(`Recovered project id ${projectId} already belongs to ${idCollision.slug}`);
  }
  if (!plan.existing) {
    hub.prepare(`
      INSERT INTO projects (id, user, name, slug, project_kind)
      VALUES (?, ?, ?, ?, 'workspace')
    `).run(projectId, user, HISTORICAL_NAME, HISTORICAL_SLUG);
  }

  const existingStatus = hub.prepare(`
    SELECT id FROM knowledge_atoms
    WHERE user = ? AND subject_kind = 'project' AND subject_id = ?
      AND predicate = 'status' AND derived_by = 'manual'
  `).get(user, projectId);
  if (existingStatus) {
    hub.prepare(`
      UPDATE knowledge_atoms
      SET subject_label = ?, value = 'closed', status = 'active', confidence = 1.0,
          last_confirmed = unixepoch(), updated_at = unixepoch()
      WHERE id = ?
    `).run(HISTORICAL_NAME, existingStatus.id);
  } else {
    hub.prepare(`
      INSERT INTO knowledge_atoms
        (id, user, subject_kind, subject_id, subject_label, predicate, value,
         source_refs, confidence, status, derived_by)
      VALUES (?, ?, 'project', ?, ?, 'status', 'closed', ?, 1.0, 'active', 'manual')
    `).run(
      uuid(),
      user,
      projectId,
      HISTORICAL_NAME,
      JSON.stringify(plan.sourceDocuments.map(doc => ({ kind: 'document', id: doc.id }))),
    );
  }
  return projectId;
}

function main() {
  const hub = db.hub();
  const meeting = meetingRepairPlan(hub, config.user);
  const project = projectRepairPlan(hub, config.user);
  const report = {
    apply: config.apply,
    db: config.db,
    meeting: {
      intake: meeting.intake,
      questions_to_close: meeting.open.map(item => ({ type: item.type, question: item.evidence })),
    },
    project: {
      slug: HISTORICAL_SLUG,
      task_count: project.tasks.length,
      task_statuses: project.tasks.reduce((out, task) => {
        out[task.status] = (out[task.status] || 0) + 1;
        return out;
      }, {}),
      source_documents: project.sourceDocuments,
      recovered_project_ids: project.recoveredIds,
      already_exists: Boolean(project.existing),
    },
  };

  if (!config.apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  hub.transaction(() => {
    for (const item of meeting.open) {
      discardClarification(config.user, {
        key: item.key,
        kind: 'meeting_question',
        question: item.evidence,
        sourceKind: 'meeting_intake',
        sourceId: item.intake_id,
      });
    }
    report.project.project_id = restoreClosedProject(hub, config.user, project);
  })();

  report.meeting.closed = meeting.open.length;
  console.log(JSON.stringify(report, null, 2));
}

main();
