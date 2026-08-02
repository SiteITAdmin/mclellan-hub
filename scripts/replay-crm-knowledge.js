#!/usr/bin/env node
'use strict';

/*
 * Safe CRM knowledge replay preparation.
 *
 * This command never deletes receipts, atoms, tasks, events, or outcomes.  A
 * dry run opens SQLite read-only and only reports the present evidence/outcome
 * picture.  `--apply` queues the normal versioned crm_knowledge_engine job;
 * it deliberately does not run a model or create an external side effect in
 * this process.
 */

const path = require('path');
const Database = require('better-sqlite3');
const {
  SOURCE_EVIDENCE_KINDS,
  rowsForSourceKind,
  sourceRevisionFromRow,
} = require('../lib/source-evidence');
const {
  isExcludedEvidence,
  sourceCoverageState,
} = require('../lib/crm-knowledge-health');
const { queueCrmKnowledgeEngine } = require('../lib/crm-knowledge-queue');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIndex = args.indexOf('--user');
const dbIndex = args.indexOf('--db');
const user = userIndex >= 0 ? String(args[userIndex + 1] || '').trim() || 'douglas' : 'douglas';
const defaultDb = path.join(__dirname, '..', 'data', 'hub.db');
const targetDb = dbIndex >= 0
  ? path.resolve(args[dbIndex + 1] || '')
  : process.env.HUB_DB_PATH
    ? path.resolve(process.env.HUB_DB_PATH)
    : defaultDb;

if (args.includes('--help')) {
  console.log('Usage: node scripts/replay-crm-knowledge.js [--db PATH] [--user USER] [--apply]');
  console.log('Dry-run is the default. --apply only queues the normal crm_knowledge_engine job and requires an explicit --db or HUB_DB_PATH.');
  process.exit(0);
}

if (apply && dbIndex < 0 && !process.env.HUB_DB_PATH) {
  console.error('Refusing --apply against the implicit default database. Pass --db to an audited temporary/copy database or set HUB_DB_PATH explicitly.');
  process.exit(2);
}

function rows(database, sql, params = []) {
  try { return database.prepare(sql).all(...params); }
  catch (_) { return []; }
}

// This is the one canonical, filtered evidence enumeration used for both the
// eligible total and revision map.  Passing the direct SQLite handle keeps the
// dry run read-only and mirrors engine/health exclusions and task predicates.
function canonicalSources(database, targetUser) {
  const sources = [];
  for (const sourceKind of SOURCE_EVIDENCE_KINDS) {
    let sourceRows = [];
    try { sourceRows = rowsForSourceKind(targetUser, sourceKind, database); }
    catch (_) { continue; }
    for (const row of sourceRows) {
      const evidence = { source_kind: sourceKind, row };
      if (isExcludedEvidence(evidence)) continue;
      const revision = sourceRevisionFromRow(sourceKind, row);
      if (revision) {
        sources.push({
          source_kind: sourceKind,
          source_id: String(row.id),
          revision,
          revision_hash: revision,
          row,
        });
      }
    }
  }
  return sources;
}

function counts(database, targetUser) {
  const sources = canonicalSources(database, targetUser);
  const receiptRows = rows(database, `
    SELECT rowid AS receipt_order, source_kind, source_id, stage, status, payload, created_at
    FROM knowledge_receipts WHERE user = ?
  `, [targetUser]);
  const outcomeRows = rows(database, `
    SELECT source_kind, source_id, source_revision, pipeline_version, action_key,
           disposition, payload, reason, updated_at
    FROM crm_action_outcomes WHERE user = ?
  `, [targetUser]);
  const states = sources.map(evidence => sourceCoverageState(evidence, receiptRows, outcomeRows));
  const current = states.filter(state => state.state === 'complete').length;
  const errors = states.filter(state => state.state === 'error').length;
  const review = states.filter(state => state.state === 'review').length;
  const incomplete = states.filter(state => state.state === 'incomplete').length;
  return {
    eligible: sources.length,
    current,
    errors,
    review,
    incomplete,
  };
}

function print(label, value) {
  console.log(`${label}: eligible=${value.eligible} current=${value.current} error=${value.errors} review=${value.review} incomplete=${value.incomplete}`);
}

let database;
try {
  database = new Database(targetDb, { readonly: !apply, fileMustExist: true });
  const before = counts(database, user);
  print('before', before);
  if (!apply) {
    console.log(`dry-run: no writes performed (${targetDb})`);
    print('after', before);
    database.close();
    process.exit(0);
  }

  const queued = queueCrmKnowledgeEngine({
    user,
    requestedBy: 'replay-crm-knowledge',
  }, database);
  if (queued.existing) {
    console.log(`apply: existing versioned replay path already queued as ${queued.jobId}`);
  } else {
    console.log(`apply: queued crm_knowledge_engine job ${queued.jobId}`);
  }
  const after = counts(database, user);
  print('after', after);
  console.log('apply: queued only; no tasks, calendar events, atoms, receipts, or existing outcomes were deleted or created by this command.');
  database.close();
} catch (err) {
  try { database?.close(); } catch (_) {}
  console.error(`replay-crm-knowledge failed: ${err.message}`);
  process.exit(1);
}
