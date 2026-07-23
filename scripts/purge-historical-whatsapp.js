#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');

function parseArgs(argv) {
  const options = {
    db: process.env.HUB_DB_PATH || 'data/hub.db',
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--db') options.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function chunks(values, size = 400) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function placeholders(values) {
  return values.map(() => '?').join(',');
}

function countForIds(db, sqlPrefix, ids) {
  let count = 0;
  for (const batch of chunks(ids)) {
    count += Number(db.prepare(`${sqlPrefix} (${placeholders(batch)})`).get(...batch).n || 0);
  }
  return count;
}

function deleteForIds(db, sqlPrefix, ids) {
  let changes = 0;
  for (const batch of chunks(ids)) {
    changes += db.prepare(`${sqlPrefix} (${placeholders(batch)})`).run(...batch).changes;
  }
  return changes;
}

function historicalMessageIds(db) {
  return db.prepare('SELECT id, raw_json FROM messaging_messages').all()
    .filter(row => parseJson(row.raw_json, {})?.raw?.historical_backfill === true)
    .map(row => row.id);
}

function sourceIdFromProjection(value) {
  const match = String(value || '').match(/^crm-engine:messaging_message:([^:]+):/);
  return match ? match[1] : null;
}

function buildPlan(db, historicalIds) {
  const historicalSet = new Set(historicalIds);
  const affectedAtoms = [];
  for (const atom of db.prepare('SELECT id, source_refs FROM knowledge_atoms').all()) {
    const refs = parseJson(atom.source_refs, null);
    if (!Array.isArray(refs)) continue;
    const remaining = refs.filter(ref => !(
      ref?.kind === 'messaging_message' && historicalSet.has(String(ref.id))
    ));
    if (remaining.length !== refs.length) {
      affectedAtoms.push({
        id: atom.id,
        remaining,
        remove: remaining.length === 0,
      });
    }
  }

  const taskIds = db.prepare(
    "SELECT id, source_id FROM google_tasks WHERE source = 'crm-engine' AND source_id LIKE 'crm-engine:messaging_message:%'"
  ).all()
    .filter(row => historicalSet.has(sourceIdFromProjection(row.source_id)))
    .map(row => row.id);
  const meetingIds = db.prepare(
    "SELECT id, source_id FROM meetings WHERE source = 'crm-engine' AND source_id LIKE 'crm-engine:messaging_message:%'"
  ).all()
    .filter(row => historicalSet.has(sourceIdFromProjection(row.source_id)))
    .map(row => row.id);

  return {
    historicalIds,
    affectedAtoms,
    atomIdsToDelete: affectedAtoms.filter(atom => atom.remove).map(atom => atom.id),
    atomsToUpdate: affectedAtoms.filter(atom => !atom.remove),
    taskIds,
    meetingIds,
    receipts: countForIds(
      db,
      "SELECT count(*) n FROM knowledge_receipts WHERE source_kind = 'messaging_message' AND source_id IN",
      historicalIds
    ),
    synthesisState: countForIds(
      db,
      "SELECT count(*) n FROM synthesis_state WHERE source_kind = 'messaging_message' AND source_id IN",
      historicalIds
    ),
    directEmbeddings: countForIds(
      db,
      "SELECT count(*) n FROM embeddings WHERE source_kind = 'messaging_message' AND source_id IN",
      historicalIds
    ),
    opportunitySignals: countForIds(
      db,
      "SELECT count(*) n FROM opportunity_signals WHERE source_kind = 'messaging_message' AND source_id IN",
      historicalIds
    ),
  };
}

function summary(plan) {
  return {
    historical_messages: plan.historicalIds.length,
    knowledge_receipts: plan.receipts,
    synthesis_state: plan.synthesisState,
    atoms_deleted: plan.atomIdsToDelete.length,
    atoms_provenance_updated: plan.atomsToUpdate.length,
    projected_tasks: plan.taskIds.length,
    projected_meetings: plan.meetingIds.length,
    direct_embeddings: plan.directEmbeddings,
    opportunity_signals: plan.opportunitySignals,
  };
}

function applyPlan(db, plan) {
  if (plan.taskIds.length || plan.meetingIds.length) {
    throw new Error(
      'Historical sources have projected Google tasks or calendar events; external deletion must be handled before local purge.'
    );
  }

  return db.transaction(() => {
    const deletedAtomEmbeddings = deleteForIds(
      db,
      "DELETE FROM embeddings WHERE source_kind = 'atom' AND source_id IN",
      plan.atomIdsToDelete
    );
    const deletedAtoms = deleteForIds(db, 'DELETE FROM knowledge_atoms WHERE id IN', plan.atomIdsToDelete);
    const updateAtom = db.prepare(
      'UPDATE knowledge_atoms SET source_refs = ?, updated_at = unixepoch() WHERE id = ?'
    );
    let updatedAtoms = 0;
    for (const atom of plan.atomsToUpdate) {
      updatedAtoms += updateAtom.run(JSON.stringify(atom.remaining), atom.id).changes;
    }

    const deletedDirectEmbeddings = deleteForIds(
      db,
      "DELETE FROM embeddings WHERE source_kind = 'messaging_message' AND source_id IN",
      plan.historicalIds
    );
    const deletedSignals = deleteForIds(
      db,
      "DELETE FROM opportunity_signals WHERE source_kind = 'messaging_message' AND source_id IN",
      plan.historicalIds
    );
    const deletedReceipts = deleteForIds(
      db,
      "DELETE FROM knowledge_receipts WHERE source_kind = 'messaging_message' AND source_id IN",
      plan.historicalIds
    );
    const deletedState = deleteForIds(
      db,
      "DELETE FROM synthesis_state WHERE source_kind = 'messaging_message' AND source_id IN",
      plan.historicalIds
    );
    const deletedMessages = deleteForIds(
      db,
      'DELETE FROM messaging_messages WHERE id IN',
      plan.historicalIds
    );

    return {
      deleted_messages: deletedMessages,
      deleted_receipts: deletedReceipts,
      deleted_synthesis_state: deletedState,
      deleted_atoms: deletedAtoms,
      updated_atoms: updatedAtoms,
      deleted_atom_embeddings: deletedAtomEmbeddings,
      deleted_direct_embeddings: deletedDirectEmbeddings,
      deleted_opportunity_signals: deletedSignals,
    };
  })();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = new Database(options.db);
  try {
    db.pragma('foreign_keys = ON');
    const historicalIds = historicalMessageIds(db);
    const plan = buildPlan(db, historicalIds);
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'dry-run', db: options.db, plan: summary(plan) }, null, 2));
    if (!options.apply) return;

    const result = applyPlan(db, plan);
    const remainingHistorical = historicalMessageIds(db).length;
    if (remainingHistorical !== 0) {
      throw new Error(`Purge verification failed: ${remainingHistorical} historical messages remain`);
    }
    console.log(JSON.stringify({ result, remaining_historical_messages: remainingHistorical }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
